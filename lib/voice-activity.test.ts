import { describe, expect, it } from "vitest";

import { type ActivityOutcome, type ListenMode, SpeechActivity } from "@/lib/voice-activity";

const TICK = 50;
const ROOM = 0.004; // a quiet room
const VOICE = 0.08;

// Feeds a loudness timeline (segments of [ms, rms]) and reports when it ended.
function run(segments: [number, number][], mode: ListenMode = "auto", holdAt?: number) {
  const activity = new SpeechActivity(mode);
  let t = 0;
  for (const [ms, rms] of segments) {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK, t += TICK) {
      if (holdAt !== undefined && t === holdAt) activity.hold();
      const outcome: ActivityOutcome = activity.update(t, rms);
      if (outcome) return { outcome, at: t, heard: activity.heardSpeech };
    }
  }
  return { outcome: null, at: t, heard: activity.heardSpeech };
}

describe("SpeechActivity", () => {
  it("ends a little after you stop talking", () => {
    const result = run([
      [400, ROOM],
      [1500, VOICE],
      [3000, ROOM],
    ]);
    expect(result.outcome).toBe("end");
    expect(result.heard).toBe(true);
    // 400 ms of room + 1.5 s of speech + ~1.2 s of quiet.
    expect(result.at).toBeGreaterThanOrEqual(400 + 1500 + 1150);
    expect(result.at).toBeLessThan(400 + 1500 + 1400);
  });

  it("does not cut you off during a short pause between words", () => {
    const result = run([
      [400, ROOM],
      [800, VOICE],
      [600, ROOM],
      [800, VOICE],
      [2000, ROOM],
    ]);
    expect(result.outcome).toBe("end");
    expect(result.at).toBeGreaterThan(400 + 800 + 600 + 800);
  });

  it("gives up when nobody speaks", () => {
    expect(run([[9000, ROOM]])).toMatchObject({ outcome: "timeout", heard: false });
  });

  it("is not fooled by a click or a cough", () => {
    expect(
      run([
        [400, ROOM],
        [100, 0.3],
        [8000, ROOM],
      ]),
    ).toMatchObject({ outcome: "timeout", heard: false });
  });

  it("hears speech over a noisy room by its own floor", () => {
    const fan = 0.03; // louder than the absolute minimum threshold
    expect(
      run([
        [400, fan],
        [8000, fan],
      ]).outcome,
    ).toBe("timeout");
    expect(
      run([
        [400, fan],
        [1000, 0.15],
        [2000, fan],
      ]),
    ).toMatchObject({ outcome: "end", heard: true });
  });

  it("in hold-to-talk, only letting go (or the time limit) ends it", () => {
    const held = run(
      [
        [400, ROOM],
        [1000, VOICE],
        [5000, ROOM],
      ],
      "auto",
      400,
    );
    expect(held.outcome).toBeNull(); // long silence, still held
    expect(held.heard).toBe(true);
    expect(run([[31000, ROOM]], "hold").outcome).toBe("end"); // the 30 s limit
  });
});
