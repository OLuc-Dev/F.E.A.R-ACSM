// Turns per-frame hand observations into deliberate commands. Pure and DOM-free
// (the camera and MediaPipe live in hand-tracker.ts), so every rule that keeps
// an ordinary hand movement from pausing your music is unit-tested here.

/** The canned poses MediaPipe's gesture recognizer reports ("None" = unsure). */
export type HandPose =
  | "None"
  | "Open_Palm"
  | "Closed_Fist"
  | "Pointing_Up"
  | "Thumb_Up"
  | "Thumb_Down"
  | "Victory"
  | "ILoveYou";

export type GestureCommand = "wave" | "palm_hold" | "fist_hold" | "point_hold" | "swipe_left" | "swipe_right";

/** One frame's hand, in the person's own (mirrored) view: x 0 = their left. */
export interface HandSample {
  pose: HandPose;
  x: number;
  y: number;
  /** Which hand MediaPipe thinks it is; tells a moving hand from the other one. */
  side?: "Left" | "Right";
}

export const GESTURE_TUNING = {
  /**
   * A hand missing longer than this is gone; its next appearance starts fresh.
   * Above a slow camera's frame gap (~300 ms at 4 fps), or it would never stay tracked.
   */
  lostAfterMs: 400,
  /**
   * A fired hold re-arms only once the pose changes or the hand has really
   * left — not on a brief tracking dropout, or a palm kept up would toggle again.
   */
  releaseAfterMs: 900,
  /** Pause after any command, so one movement can't fire two. */
  cooldownMs: 1200,
  /** How still (in frame fractions) a held pose must be. */
  stillRange: 0.05,
  /** Share of the frames in a hold that must show the pose (tolerates flicker). */
  holdRatio: 0.8,
  /**
   * Frames per second a hold must be seen at. Fewer can't tell a still hand
   * from a wave whose strokes the camera keeps catching at the same point.
   */
  holdMinFps: 5,
  holds: [
    { pose: "Open_Palm", ms: 1000, command: "palm_hold" },
    { pose: "Closed_Fist", ms: 700, command: "fist_hold" },
    { pose: "Pointing_Up", ms: 600, command: "point_hold" },
  ] as const,
  swipe: {
    /** A swipe starts from a hand at rest for this long: entering or reaching never counts. */
    restMs: 200,
    /** …and must cover this much of the frame width… */
    minDistance: 0.28,
    /** …within this long after leaving rest (roomy enough for a 4 fps camera). */
    withinMs: 700,
    maxVerticalRatio: 0.6,
    /** Path no longer than this × the net distance: one direction, not back and forth. */
    maxPathRatio: 1.35,
    /**
     * Faster than this (frame widths per second) is the tracker switching hands
     * or re-acquiring, not a hand moving: a quick real swipe is 1–3, a jump to
     * the other hand at 15 fps is ~8. Speed, not distance per frame, so a slow
     * camera's big steps between frames still count as motion.
     */
    maxSpeed: 4,
  },
  wave: {
    windowMs: 1500,
    /** Side-to-side strokes between these sizes; bigger ones read as swipes. */
    minStroke: 0.035,
    maxStroke: 0.28,
    strokes: 3,
    /** Share of frames that must be an open (or unclassified, mid-motion) hand. */
    openRatio: 0.7,
  },
} as const;

interface TimedSample extends HandSample {
  t: number;
}

export class GestureInterpreter {
  private samples: TimedSample[] = [];
  private lastSeenAt = Number.NEGATIVE_INFINITY;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  private rest: TimedSample | null = null;
  // Holds that already fired and wait for the pose to be released.
  private latched = new Set<HandPose>();

  /** Feed one frame (`hand` null when none is visible); returns a completed command. */
  update(t: number, hand: HandSample | null): GestureCommand | null {
    const gone = t - this.lastSeenAt;
    if (gone > GESTURE_TUNING.lostAfterMs) {
      this.samples = [];
      // A fast swipe can outrun the tracker: the hand vanishes mid-motion and
      // reappears at the end. Remember where it rested, briefly, so that counts.
      if (gone > GESTURE_TUNING.swipe.withinMs) this.rest = null;
    }
    if (gone > GESTURE_TUNING.releaseAfterMs) this.latched.clear();
    if (hand === null) return null;
    this.lastSeenAt = t;

    const sample = { ...hand, t };
    const previous = this.samples.at(-1) ?? this.rest;
    if (previous && sample.side && previous.side && sample.side !== previous.side) {
      // The other hand came into view: nothing tracked so far applies to it.
      this.samples = [];
      this.rest = null;
      this.latched.clear();
    } else if (this.samples.length > 0 && previous && tooFast(previous, sample)) {
      // Re-acquired somewhere else: whatever motion was being tracked is void.
      this.samples = [];
      this.rest = null;
    }
    this.samples.push(sample);
    const keepFrom = t - GESTURE_TUNING.wave.windowMs;
    while (this.samples.length > 0 && this.samples[0].t < keepFrom) this.samples.shift();

    this.releaseLatches(t);
    this.trackRest(t);

    if (t < this.cooldownUntil) return null;
    const command = this.detectSwipe(sample) ?? this.detectWave(t) ?? this.detectHold(t);
    if (command !== null) {
      this.cooldownUntil = t + GESTURE_TUNING.cooldownMs;
      this.samples = [];
      this.rest = null;
    }
    return command;
  }

  reset(): void {
    this.samples = [];
    this.rest = null;
    this.latched.clear();
  }

  private since(t: number, ms: number): TimedSample[] {
    return this.samples.filter((sample) => sample.t >= t - ms);
  }

  /**
   * The frames spanning the whole last `ms`: from the latest one at or before
   * its start through now. Null while the hand hasn't been tracked that long,
   * so a hold or a rest can never be judged on a fraction of its duration,
   * whatever the camera's frame rate.
   */
  private covering(t: number, ms: number): TimedSample[] | null {
    for (let index = this.samples.length - 1; index >= 0; index--) {
      if (this.samples[index].t <= t - ms) return this.samples.slice(index);
    }
    return null;
  }

  private trackRest(t: number): void {
    // Two frames a rest apart suffice: a slow camera still gets to swipe.
    const window = this.covering(t, GESTURE_TUNING.swipe.restMs);
    if (window !== null && window.length >= 2 && isStill(window)) {
      this.rest = window.at(-1) ?? null;
    }
  }

  private releaseLatches(t: number): void {
    if (this.latched.size === 0) return;
    const recent = this.since(t, 300);
    for (const pose of Array.from(this.latched)) {
      if (share(recent, (sample) => sample.pose === pose) < 0.5) this.latched.delete(pose);
    }
  }

  private detectSwipe(now: TimedSample): GestureCommand | null {
    const rule = GESTURE_TUNING.swipe;
    const rest = this.rest;
    if (rest === null || now.t - rest.t > rule.withinMs) return null;
    const dx = now.x - rest.x;
    const dy = now.y - rest.y;
    if (Math.abs(dx) < rule.minDistance || Math.abs(dy) > rule.maxVerticalRatio * Math.abs(dx)) return null;
    if (tooFast(rest, now)) return null;

    const motion = this.samples.filter((sample) => sample.t >= rest.t);
    let path = 0;
    for (let index = 1; index < motion.length; index++) {
      path += Math.abs(motion[index].x - motion[index - 1].x);
    }
    if (path > rule.maxPathRatio * Math.abs(dx)) return null;
    return dx > 0 ? "swipe_right" : "swipe_left";
  }

  private detectWave(t: number): GestureCommand | null {
    const rule = GESTURE_TUNING.wave;
    const window = this.since(t, rule.windowMs);
    if (window.length < 8) return null;
    if (share(window, (sample) => sample.pose === "Open_Palm" || sample.pose === "None") < rule.openRatio) {
      return null;
    }

    // Count completed side-to-side strokes, with hysteresis so jitter isn't one.
    let pivot = window[0].x;
    let extreme = pivot;
    let direction = 0;
    let strokes = 0;
    for (const sample of window.slice(1)) {
      if (direction === 0) {
        if (Math.abs(sample.x - pivot) >= rule.minStroke) {
          direction = Math.sign(sample.x - pivot);
          extreme = sample.x;
        }
        continue;
      }
      if ((sample.x - extreme) * direction > 0) {
        extreme = sample.x;
        continue;
      }
      if (Math.abs(extreme - sample.x) >= rule.minStroke) {
        const stroke = Math.abs(extreme - pivot);
        if (stroke > rule.maxStroke) return null;
        if (stroke >= rule.minStroke) strokes += 1;
        pivot = extreme;
        extreme = sample.x;
        direction = -direction;
      }
    }
    return strokes >= rule.strokes ? "wave" : null;
  }

  private detectHold(t: number): GestureCommand | null {
    for (const hold of GESTURE_TUNING.holds) {
      if (this.latched.has(hold.pose)) continue;
      const window = this.covering(t, hold.ms);
      if (window === null) continue;
      const seen = window.filter((sample) => sample.t > t - hold.ms).length;
      if (seen < Math.floor((hold.ms / 1000) * GESTURE_TUNING.holdMinFps)) continue;
      if (share(window, (sample) => sample.pose === hold.pose) < GESTURE_TUNING.holdRatio) continue;
      if (!isStill(window)) continue;
      this.latched.add(hold.pose);
      return hold.command;
    }
    return null;
  }
}

/** Faster than a hand moves: the tracker jumped, so it isn't motion. */
function tooFast(from: TimedSample, to: TimedSample): boolean {
  const elapsed = Math.max(to.t - from.t, 1);
  return Math.abs(to.x - from.x) > (GESTURE_TUNING.swipe.maxSpeed * elapsed) / 1000;
}

function share(samples: TimedSample[], test: (sample: TimedSample) => boolean): number {
  if (samples.length === 0) return 0;
  return samples.filter(test).length / samples.length;
}

function isStill(samples: TimedSample[]): boolean {
  const xs = samples.map((sample) => sample.x);
  const ys = samples.map((sample) => sample.y);
  const range = (values: number[]) => Math.max(...values) - Math.min(...values);
  return range(xs) <= GESTURE_TUNING.stillRange && range(ys) <= GESTURE_TUNING.stillRange;
}
