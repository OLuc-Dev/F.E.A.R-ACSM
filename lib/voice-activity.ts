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
