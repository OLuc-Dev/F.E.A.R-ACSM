import { describe, expect, it } from "vitest";

import {
  type ActivityOutcome,
  type ListenMode,
  type SegmentEvent,
  SpeechActivity,
  SpeechSegmenter,
} from "@/lib/voice-activity";

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

describe("SpeechSegmenter (always listening)", () => {
  const BLOCK = 32; // the microphone tap hands over ~32 ms of audio at a time
  // Feeds a loudness timeline and reports each "start"/"end" with its time.
  function stream(segments: [number, number][], segmenter = new SpeechSegmenter()) {
    const events: [SegmentEvent, number][] = [];
    let t = 0;
    for (const [ms, rms] of segments) {
      for (let elapsed = 0; elapsed < ms; elapsed += BLOCK, t += BLOCK) {
        const event = segmenter.update(t, rms);
        if (event) events.push([event, t]);
      }
    }
    return events;
  }

  it("finds each sentence in a microphone that stays open", () => {
    const events = stream([
      [2000, ROOM],
      [1500, VOICE],
      [3000, ROOM],
      [1000, VOICE],
      [2000, ROOM],
    ]);
    expect(events.map(([event]) => event)).toEqual(["start", "end", "start", "end"]);
    const [[, firstStart], [, firstEnd]] = events;
    expect(firstStart).toBeGreaterThanOrEqual(2000 + 200); // speech for 200 ms first
    expect(firstStart).toBeLessThan(2000 + 300);
    expect(firstEnd).toBeGreaterThanOrEqual(2000 + 1500 + 1100); // then 1.1 s of quiet
    expect(firstEnd).toBeLessThan(2000 + 1500 + 1300);
  });

  it("keeps a sentence whole across a pause between words", () => {
    const events = stream([
      [1000, ROOM],
      [800, VOICE],
      [600, ROOM],
      [800, VOICE],
      [2000, ROOM],
    ]);
    expect(events.map(([event]) => event)).toEqual(["start", "end"]);
  });

  it("is not woken by a click or a cup set down", () => {
    expect(
      stream([
        [1000, ROOM],
        [100, 0.3],
        [3000, ROOM],
      ]),
    ).toEqual([]);
  });

  it("hears the real recording, even when it opens on a word", () => {
    const spokenAtOnce = [
      0.08, 0.411, 0.33, 0.327, 0.281, 0.296, 0.341, 0.194, 0.016, 0.017, 0.261, 0.024, 0.011, 0.175, 0.166,
      0.009, 0.051, 0.331, 0.248, 0.073, 0.319, 0.029, 0.031, 0.023, 0.275, 0.276, 0.269, 0.183, 0.034, 0.045,
      0.039, 0.006, 0.013, 0.003, 0.001,
    ].map((rms): [number, number] => [50, rms]);
    const segmenter = new SpeechSegmenter();
    expect(stream([...spokenAtOnce, [2000, 0.002]], segmenter).map(([event]) => event)).toEqual([
      "start",
      "end",
    ]);
    expect(segmenter.speechMs).toBeGreaterThan(300); // a real sentence, worth transcribing
  });

  it("gets used to a fan switched on instead of recording it forever", () => {
    const fan = 0.03;
    const events = stream([
      [2000, ROOM],
      [30000, fan],
    ]);
    // Taken for speech at first, then learned as the room within seconds…
    expect(events.map(([event]) => event)).toEqual(["start", "end"]);
    expect(events[1][1]).toBeLessThan(2000 + 8000);
    // …and a voice over the fan is still heard.
    expect(
      stream(
        [
          [2000, ROOM],
          [30000, fan],
          [1500, 0.2],
          [2000, fan],
        ],
        new SpeechSegmenter(),
      ).map(([event]) => event),
    ).toEqual(["start", "end", "start", "end"]);
  });

  it("forgets a sentence in progress when reset", () => {
    const segmenter = new SpeechSegmenter();
    stream(
      [
        [1000, ROOM],
        [500, VOICE],
      ],
      segmenter,
    );
    expect(segmenter.speaking).toBe(true);
    segmenter.reset(); // F.E.A.R. started talking: whatever it was, it's dropped
    expect(segmenter.speaking).toBe(false);
  });
});
