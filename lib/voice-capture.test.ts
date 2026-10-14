// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startMicrophoneCapture } from "@/lib/voice-capture";

// Just enough of the browser's audio APIs: a microphone stream, a recorder and
// an audio graph whose resume() behaves like a page that hasn't been clicked.
const track = { stop: vi.fn() };
let resume: () => Promise<void>;
let audioState = "suspended";
let recorderFails = false;

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  constructor() {
    if (recorderFails) throw new DOMException("no encoder", "NotSupportedError");
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.(new Event("stop"));
  }
}

class FakeContext {
  state = audioState;
  resume = () => resume();
  close = vi.fn(async () => undefined);
  createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
  createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: () => {} });
}

beforeEach(() => {
  vi.useFakeTimers();
  track.stop.mockClear();
  recorderFails = false;
  audioState = "suspended";
  resume = () => new Promise<void>(() => {}); // waits for a click that never comes
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startMicrophoneCapture", () => {
  it("records even when the page's audio can't start without a click", async () => {
    const opening = startMicrophoneCapture();
    await vi.advanceTimersByTimeAsync(500);
    const capture = await opening;
    expect(capture.measurable).toBe(false); // no meter: listening runs for a fixed time
    capture.cancel();
    expect(track.stop).toHaveBeenCalled();
  });

  it("measures loudness once the audio graph runs", async () => {
    resume = async () => undefined;
    audioState = "running";
    const capture = await startMicrophoneCapture();
    expect(capture.measurable).toBe(true);
    await capture.finish();
    expect(track.stop).toHaveBeenCalled(); // the microphone goes off with the recording
  });

  it("turns the microphone off if recording can't start", async () => {
    recorderFails = true;
    await expect(startMicrophoneCapture()).rejects.toThrow("no encoder");
    expect(track.stop).toHaveBeenCalled();
  });
});
