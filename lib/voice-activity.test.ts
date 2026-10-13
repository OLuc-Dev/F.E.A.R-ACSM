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

  it("hears someone who starts talking the moment it opens", () => {
    // tests/fixtures/browser-recording.webm as the app's meter reads it (RMS of
    // 1024 samples at 48 kHz, every 50 ms), cut at the first word.
    const spokenAtOnce = [
      0.08, 0.411, 0.33, 0.327, 0.281, 0.296, 0.341, 0.194, 0.016, 0.017, 0.261, 0.024, 0.011, 0.175, 0.166,
      0.009, 0.051, 0.331, 0.248, 0.073, 0.319, 0.029, 0.031, 0.023, 0.275, 0.276, 0.269, 0.183, 0.034, 0.045,
      0.039, 0.006, 0.013, 0.003, 0.001,
    ].map((rms): [number, number] => [TICK, rms]);
    // Its first moments are speech, not the room; the pauses between words show the room.
    expect(run([...spokenAtOnce, [3000, 0]])).toMatchObject({ outcome: "end", heard: true });
    expect(run(spokenAtOnce, "hold").heard).toBe(true);
  });

  it("isn't thrown off by a microphone still waking up", () => {
    const result = run([
      [100, 0], // no samples yet
      [300, ROOM],
      [1000, VOICE],
      [2000, ROOM],
    ]);
    expect(result).toMatchObject({ outcome: "end", heard: true });
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
