// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioNeedsGesture, encodeWav, openContinuousMicrophone } from "@/lib/voice-stream";

const RATE = 16_000;
const BLOCK = 512; // 32 ms at 16 kHz, as the tap hands them over

describe("encodeWav", () => {
  it("writes mono 16-bit PCM any browser and PyAV read", async () => {
    const blob = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-0.5, 1.5])], RATE);
    expect(blob.type).toBe("audio/wav");
    const view = new DataView(await blob.arrayBuffer());
    const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8); // 4 samples
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 16383, -16384, 32767]);
  });
});

// --- the microphone, over fake browser audio --------------------------------

const track = { stop: vi.fn() };
let audioState = "running";

class FakeContext {
  state = audioState;
  sampleRate = RATE;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume = () => (audioState === "running" ? Promise.resolve() : new Promise<void>(() => {}));
  close = vi.fn(async () => undefined);
  createMediaStreamSource = () => ({ connect: (node: unknown) => node, disconnect: () => {} });
  createGain = () => ({ gain: { value: 1 }, connect: (node: unknown) => node, disconnect: () => {} });
}

const taps: FakeTap[] = [];

class FakeTap {
  port = { onmessage: null as ((event: { data: Float32Array }) => void) | null };
  constructor() {
    taps.push(this);
  }
  connect(node: unknown) {
    return node;
  }
  disconnect() {}
}

// Feeds `ms` of audio at this loudness (a steady tone with that RMS).
function feed(ms: number, rms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += (BLOCK / RATE) * 1000) {
    const block = new Float32Array(BLOCK).map((_, i) => rms * Math.SQRT2 * Math.sin(i / 3));
    taps.at(-1)?.port.onmessage?.({ data: block });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  track.stop.mockClear();
  audioState = "running";
  taps.length = 0;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeTap);
  URL.createObjectURL = vi.fn(() => "blob:tap");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openContinuousMicrophone", () => {
  it("hands over each sentence with the moment just before it", async () => {
    const sentences: Blob[] = [];
    const onSpeech = vi.fn();
    const mic = await openContinuousMicrophone({ onSpeech, onSentence: (audio) => sentences.push(audio) });
    feed(1000, 0.004); // the room
    feed(1000, 0.08); // a sentence
    feed(1500, 0.004);
    expect(onSpeech).toHaveBeenCalledTimes(1);
    expect(sentences).toHaveLength(1);
    const seconds = (sentences[0].size - 44) / 2 / RATE;
    // Noticing speech takes 0.2 s, and 0.4 s before that moment is kept: the
    // room just before the first word + the sentence + the quiet that ended it.
    expect(seconds).toBeGreaterThan(0.2 + 1 + 1.0);
    expect(seconds).toBeLessThan(0.2 + 1 + 1.4);
    mic.close();
    expect(track.stop).toHaveBeenCalled();
  });

  it("hears nothing while paused, and listens again on resume", async () => {
    const sentences: Blob[] = [];
    const mic = await openContinuousMicrophone({
      onSpeech: () => {},
      onSentence: (audio) => sentences.push(audio),
    });
    feed(1000, 0.004);
    mic.pause(); // F.E.A.R. talking
    feed(1000, 0.08);
    feed(1500, 0.004);
    expect(sentences).toHaveLength(0);
    mic.resume();
    feed(1000, 0.08);
    feed(1500, 0.004);
    expect(sentences).toHaveLength(1);
  });

  it("says so, and turns the microphone off, when audio waits for a click", async () => {
    audioState = "suspended";
    const opening = openContinuousMicrophone({ onSpeech: () => {}, onSentence: () => {} });
    const failed = expect(opening).rejects.toBeInstanceOf(AudioNeedsGesture);
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    expect(track.stop).toHaveBeenCalled();
  });
});
