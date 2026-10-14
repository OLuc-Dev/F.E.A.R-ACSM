// Decides, from the microphone's loudness, when you started and stopped talking.
// Pure (no DOM, no audio APIs), so every timing rule is unit-tested; the hook
// in use-voice-input.ts feeds it a reading every few dozen milliseconds.

export type ListenMode = "auto" | "hold";

export const VOICE_TUNING = {
  /** The quietest of the first moments sets the room's noise floor. */
  calibrateMs: 300,
  /** Speech must be this many times louder than the room… */
  floorFactor: 3,
  /** …and never quieter than this (RMS, 0–1), even in a silent room. */
  minThreshold: 0.012,
  /** Loud for this long counts as speech, not a click or a cough. */
  speechMs: 150,
  /** In auto mode, this much quiet after speech ends the recording. */
  silenceMs: 1200,
  /** In auto mode, give up when nobody speaks within this. */
  noSpeechMs: 7000,
  /** Nothing said to F.E.A.R. needs longer than this. */
  maxMs: 30000,
} as const;

export type ActivityOutcome = "end" | "timeout" | null;

export class SpeechActivity {
  private start: number | null = null;
  private calibration: number[] = [];
  private floor: number | null = null;
  private loudFor = 0;
  private quietFor = 0;
  private last = 0;
  private heard = false;

  constructor(private mode: ListenMode = "auto") {}

  /** Switch to hold-to-talk: only the person (or the time limit) ends it. */
  hold(): void {
    this.mode = "hold";
  }

  /** Whether real speech was heard at any point. */
  get heardSpeech(): boolean {
    return this.heard;
  }

  /** Feed one loudness reading taken at `t` (ms); returns when the recording should end. */
  update(t: number, rms: number): ActivityOutcome {
    if (this.start === null) {
      this.start = t;
      this.last = t;
    }
    const elapsed = t - this.start;
    const dt = Math.max(0, t - this.last);
    this.last = t;

    // A microphone still waking up reads exactly 0; that's not the room.
    if (elapsed < VOICE_TUNING.calibrateMs) {
      if (rms > 0) this.calibration.push(rms);
      return null;
    }
    // The room is as loud as its quietest moment, not its average: someone
    // already talking when the microphone opened isn't "the room", and the
    // pauses between their words keep bringing the floor down to it.
    if (this.floor === null && this.calibration.length) this.floor = Math.min(...this.calibration);
    if (rms > 0 && (this.floor === null || rms < this.floor)) this.floor = rms;
    const threshold = Math.max(VOICE_TUNING.minThreshold, (this.floor ?? 0) * VOICE_TUNING.floorFactor);

    if (rms >= threshold) {
      this.loudFor += dt;
      this.quietFor = 0;
      if (this.loudFor >= VOICE_TUNING.speechMs) this.heard = true;
    } else {
      this.loudFor = 0;
      // A little below the threshold still counts as the tail of a word.
      if (rms < threshold * 0.7) this.quietFor += dt;
    }

    if (elapsed >= VOICE_TUNING.maxMs) return "end";
    if (this.mode === "hold") return null;
    if (this.heard && this.quietFor >= VOICE_TUNING.silenceMs) return "end";
    if (!this.heard && elapsed >= VOICE_TUNING.noSpeechMs) return "timeout";
    return null;
  }
}

// --- always listening ----------------------------------------------------------

export const LISTEN_TUNING = {
  /** Loud for this long and someone is talking (a little stricter: it hears the whole day). */
  speechMs: 200,
  /** This much quiet and they've finished. Pauses within a sentence are shorter. */
  silenceMs: 1100,
  /** Less speech than this was a click, a cough or a cup set down. */
  minSpeechMs: 300,
  /** Kept from just before speech was noticed, so the first syllable isn't cut. */
  prerollMs: 400,
  /** How slowly the room's floor follows it up (a fan switched on), in ms. */
  floorRiseMs: 8000,
  maxMs: VOICE_TUNING.maxMs,
} as const;

export type SegmentEvent = "start" | "end" | null;

/**
 * Finds sentences in a microphone that never closes: "start" when someone
 * begins talking, "end" once they stop. The room's floor follows the quietest
 * moments down at once and creeps up only slowly, so a long session adapts to
 * a fan or the street without mistaking a voice for the room.
 */
export class SpeechSegmenter {
  private floor: number | null = null;
  private last: number | null = null;
  private loudFor = 0;
  private quietFor = 0;
  private speakingSince: number | null = null;
  private spokeFor = 0;

  /** Whether someone is talking right now (between "start" and "end"). */
  get speaking(): boolean {
    return this.speakingSince !== null;
  }

  /** How much of the last sentence was actually loud (ms). */
  get speechMs(): number {
    return this.spokeFor;
  }

  /** Forget any sentence in progress (the room's floor is kept). */
  reset(): void {
    this.last = null;
    this.loudFor = 0;
    this.quietFor = 0;
    this.speakingSince = null;
    this.spokeFor = 0;
  }

  update(t: number, rms: number): SegmentEvent {
    const dt = this.last === null ? 0 : Math.max(0, t - this.last);
    this.last = t;
    if (rms > 0) {
      if (this.floor === null || rms < this.floor) this.floor = rms;
      // Up slowly even mid-sentence: speech keeps dipping between words (which
      // pulls the floor back down), a fan never does — so a noise that starts
      // and stays ends as a "sentence" within seconds instead of for good.
      else this.floor += (rms - this.floor) * Math.min(1, dt / LISTEN_TUNING.floorRiseMs);
    }
    const threshold = Math.max(VOICE_TUNING.minThreshold, (this.floor ?? 0) * VOICE_TUNING.floorFactor);

    if (rms >= threshold) {
      this.loudFor += dt;
      this.quietFor = 0;
      if (this.speaking) this.spokeFor += dt;
    } else {
      this.loudFor = 0;
      if (rms < threshold * 0.7) this.quietFor += dt;
    }

    if (!this.speaking) {
      if (this.loudFor < LISTEN_TUNING.speechMs) return null;
      this.speakingSince = t - this.loudFor;
      this.spokeFor = this.loudFor;
      this.quietFor = 0;
      return "start";
    }
    const long = t - (this.speakingSince ?? t) >= LISTEN_TUNING.maxMs;
    if (this.quietFor < LISTEN_TUNING.silenceMs && !long) return null;
    this.speakingSince = null;
    this.loudFor = 0;
    this.quietFor = 0;
    return "end";
  }
}
