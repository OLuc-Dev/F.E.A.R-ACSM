// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/speech", () => ({ stopSpeaking: vi.fn() }));

import { stopSpeaking } from "@/lib/speech";
import { useVoiceInput, VOICE_NOTICES } from "@/lib/use-voice-input";
import type { Capture } from "@/lib/voice-capture";

const ROOM = 0.004;
const VOICE = 0.08;
const ticks = (count: number, level: number) => Array<number>(count).fill(level);

// A microphone that plays back a scripted loudness timeline, one reading per 50 ms tick.
class FakeCapture implements Capture {
  measurable = true;
  finished = false;
  cancelled = false;
  constructor(private levels: number[]) {}
  level() {
    return this.levels.length > 1 ? (this.levels.shift() as number) : (this.levels[0] ?? 0);
  }
  finish() {
    this.finished = true;
    return Promise.resolve(new Blob([new Uint8Array(4000)], { type: "audio/webm" }));
  }
  cancel() {
    this.cancelled = true;
  }
}

function setup(capture: FakeCapture | (() => Promise<Capture>), text = "qual é a próxima reunião?") {
  const heard: string[] = [];
  const notices: string[] = [];
  const transcribe = vi.fn(async () => text);
  const startCapture = typeof capture === "function" ? capture : async () => capture;
  const hook = renderHook(() =>
    useVoiceInput({
      onTranscript: (t) => heard.push(t),
      onNotice: (n) => notices.push(n),
      transcribe,
      startCapture,
    }),
  );
  return { hook, heard, notices, transcribe };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useVoiceInput", () => {
  it("listens until you stop talking, then hands over what you said", async () => {
    const mic = new FakeCapture([...ticks(8, ROOM), ...ticks(30, VOICE), ROOM]);
    const { hook, heard, transcribe } = setup(mic);
    await act(async () => {
      await hook.result.current.start("auto");
    });
    expect(hook.result.current.state).toBe("listening");
    expect(stopSpeaking).toHaveBeenCalled(); // F.E.A.R. goes quiet when you talk

    await advance(400 + 1500 + 1300);
    expect(mic.finished).toBe(true);
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob));
    expect(heard).toEqual(["qual é a próxima reunião?"]);
    expect(hook.result.current.state).toBe("idle");
  });

  it("gives up, without sending anything, when nobody speaks", async () => {
    const mic = new FakeCapture([ROOM]);
    const { hook, notices, transcribe } = setup(mic);
    await act(async () => {
      await hook.result.current.start("auto");
    });
    await advance(8000);
    expect(mic.cancelled).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
    expect(notices).toEqual([VOICE_NOTICES.nothing]);
  });

  it("in hold-to-talk, waits through pauses until released", async () => {
    const mic = new FakeCapture([...ticks(8, ROOM), ...ticks(20, VOICE), ROOM]);
    const { hook, heard } = setup(mic);
    await act(async () => {
      await hook.result.current.start("auto");
    });
    act(() => hook.result.current.hold());
    await advance(5000);
    expect(hook.result.current.state).toBe("listening"); // a long pause, still held
    await act(async () => {
      await hook.result.current.stop();
    });
    expect(heard).toEqual(["qual é a próxima reunião?"]);
  });

  it("explains a blocked microphone", async () => {
    const { hook, notices } = setup(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    await act(async () => {
      await hook.result.current.start("auto");
    });
    expect(hook.result.current.state).toBe("idle");
    expect(notices[0]).toMatch(/permiss[aã]o/i);
  });

  it("cancelling while the microphone opens leaves it closed", async () => {
    const mic = new FakeCapture([ROOM]);
    let open: (capture: Capture) => void = () => {};
    const { hook } = setup(() => new Promise<Capture>((resolve) => (open = resolve)));
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = hook.result.current.start("auto");
    });
    act(() => hook.result.current.cancel());
    await act(async () => {
      open(mic);
      await started;
    });
    expect(mic.cancelled).toBe(true);
    expect(hook.result.current.state).toBe("idle");
  });

  it("letting go before the microphone opened still ends the recording", async () => {
    const mic = new FakeCapture([ROOM]);
    let open: (capture: Capture) => void = () => {};
    const { hook, notices } = setup(() => new Promise<Capture>((resolve) => (open = resolve)));
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = hook.result.current.start("hold");
    });
    await act(async () => {
      await hook.result.current.stop();
    });
    await act(async () => {
      open(mic);
      await started;
    });
    expect(mic.finished).toBe(true);
    expect(notices).toEqual([VOICE_NOTICES.nothing]); // released before saying anything
    expect(hook.result.current.state).toBe("idle");
  });

  it("says so when the words couldn't be made out", async () => {
    const mic = new FakeCapture([...ticks(8, ROOM), ...ticks(20, VOICE), ROOM]);
    const { hook, heard, notices } = setup(mic, "");
    await act(async () => {
      await hook.result.current.start("auto");
    });
    await advance(4000);
    expect(heard).toEqual([]);
    expect(notices).toEqual([VOICE_NOTICES.unclear]);
  });

  it("without a way to measure loudness, records a fixed stretch and lets Whisper decide", async () => {
    const mic = new FakeCapture([0]);
    mic.measurable = false;
    const { hook, heard } = setup(mic);
    await act(async () => {
      await hook.result.current.start("auto");
    });
    await advance(5000);
    expect(mic.finished).toBe(false);
    await advance(1500);
    expect(mic.finished).toBe(true);
    expect(heard).toEqual(["qual é a próxima reunião?"]);
  });
});
