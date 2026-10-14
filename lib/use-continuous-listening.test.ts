// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isFiller, MICROPHONE_LOST, useContinuousListening } from "@/lib/use-continuous-listening";
import {
  AudioNeedsGesture,
  type ContinuousMicrophone,
  type ContinuousMicrophoneFactory,
  type MicrophoneHandlers,
} from "@/lib/voice-stream";

// A microphone the test talks into: say() is someone finishing a sentence.
class FakeMicrophone implements ContinuousMicrophone {
  paused = true;
  closed = false;
  handlers: MicrophoneHandlers | null = null;
  level = () => 0.05;
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  close() {
    this.closed = true;
  }
  say() {
    this.handlers?.onSpeech();
    this.handlers?.onSentence(new Blob(["wav"], { type: "audio/wav" }));
  }
  cough() {
    this.handlers?.onSpeech();
    this.handlers?.onQuiet();
  }
  unplug() {
    this.handlers?.onLost();
  }
}

type Props = { active: boolean; hold: boolean };

function setup(
  options: {
    props?: Partial<Props>;
    transcribe?: (audio: Blob, signal: AbortSignal) => Promise<string>;
    open?: ContinuousMicrophoneFactory;
  } = {},
) {
  const mic = new FakeMicrophone();
  const heard: string[] = [];
  const notices: string[] = [];
  const openMicrophone: ContinuousMicrophoneFactory =
    options.open ??
    (async (handlers) => {
      mic.handlers = handlers;
      return mic;
    });
  const transcribe = vi.fn(options.transcribe ?? (async () => "qual é a capital da França?"));
  const hook = renderHook(
    (props: Props) =>
      useContinuousListening({
        ...props,
        onTranscript: (text) => heard.push(text),
        onNotice: (notice) => notices.push(notice),
        transcribe,
        openMicrophone,
      }),
    { initialProps: { active: true, hold: false, ...options.props } },
  );
  return { hook, mic, heard, notices, transcribe };
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

describe("useContinuousListening", () => {
  it("listens on its own as soon as the window opens", async () => {
    const { hook, mic } = setup();
    await advance(600);
    expect(hook.result.current.state).toBe("listening");
    expect(mic.paused).toBe(false);
  });

  it("hands over what you said, and listens again once the answer is over", async () => {
    const { hook, mic, heard } = setup();
    await advance(600);
    await act(async () => mic.say());
    expect(heard).toEqual(["qual é a capital da França?"]);
    expect(hook.result.current.state).toBe("waiting"); // the answer is coming
    expect(mic.paused).toBe(true);

    hook.rerender({ active: true, hold: true }); // F.E.A.R. answers and talks…
    await advance(2000);
    expect(mic.paused).toBe(true); // …never hearing itself
    hook.rerender({ active: true, hold: false }); // …and is done
    await advance(400);
    expect(mic.paused).toBe(true); // a beat for its voice to fade
    await advance(200);
    expect(hook.result.current.state).toBe("listening");
    expect(mic.paused).toBe(false);
  });

  it("stops listening whenever F.E.A.R. starts talking", async () => {
    const { hook, mic } = setup();
    await advance(600);
    hook.rerender({ active: true, hold: true }); // a typed question being answered out loud
    await advance(0);
    expect(hook.result.current.state).toBe("waiting");
    expect(mic.paused).toBe(true);
  });

  it("ignores hesitations and noise taken for words", async () => {
    const { hook, mic, heard, notices } = setup({ transcribe: async () => "Hum..." });
    await advance(600);
    await act(async () => mic.say());
    await advance(600);
    expect(heard).toEqual([]);
    expect(notices).toEqual([]); // quietly: nothing to tell
    expect(hook.result.current.state).toBe("listening");
  });

  it("listens again even if no answer comes", async () => {
    const { hook, mic, heard } = setup();
    await advance(600);
    await act(async () => mic.say());
    expect(heard).toHaveLength(1);
    await advance(8600); // the message was refused, say: nothing answered
    expect(hook.result.current.state).toBe("listening");
  });

  it("turns the microphone off when the window hides, and on again when it shows", async () => {
    const { hook, mic } = setup();
    await advance(600);
    hook.rerender({ active: false, hold: false });
    await advance(0);
    expect(mic.closed).toBe(true);
    expect(hook.result.current.state).toBe("off");
    mic.closed = false;
    hook.rerender({ active: true, hold: false });
    await advance(600);
    expect(hook.result.current.state).toBe("listening");
  });

  it("drops a sentence when told to (a fist) and keeps listening", async () => {
    let finish: (text: string) => void = () => {};
    const { hook, mic, heard } = setup({
      transcribe: () => new Promise<string>((resolve) => (finish = resolve)),
    });
    await advance(600);
    act(() => mic.say());
    expect(hook.result.current.state).toBe("transcribing");
    act(() => hook.result.current.cancel());
    await act(async () => finish("qual é a capital da França?"));
    await advance(600);
    expect(heard).toEqual([]);
    expect(hook.result.current.state).toBe("listening");
    act(() => mic.say()); // and the next sentence still gets through
    await act(async () => finish("e a da Itália?"));
    expect(heard).toEqual(["e a da Itália?"]);
  });

  it("waits for a first click where the page may not use audio before one", async () => {
    const mic = new FakeMicrophone();
    let attempts = 0;
    const { hook } = setup({
      open: async (handlers) => {
        if (attempts++ === 0) throw new AudioNeedsGesture();
        mic.handlers = handlers;
        return mic;
      },
    });
    await advance(0);
    expect(hook.result.current.state).toBe("blocked");
    await act(async () => {
      fireEvent.pointerDown(window);
    });
    await advance(600);
    expect(hook.result.current.state).toBe("listening");
  });

  it("explains a blocked microphone instead of retrying forever", async () => {
    const { hook, notices } = setup({
      open: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    });
    await advance(0);
    expect(hook.result.current.state).toBe("off");
    expect(notices[0]).toMatch(/permiss[aã]o/i);
  });
});

describe("useContinuousListening, when things go sideways", () => {
  it("goes back to listening after a cough that wasn't speech", async () => {
    const { hook, mic } = setup();
    await advance(600);
    act(() => mic.cough());
    expect(hook.result.current.state).toBe("listening"); // not stuck on "hearing you"
  });

  it("says when the microphone goes away, and a retry brings it back", async () => {
    const { hook, mic, notices } = setup();
    await advance(600);
    act(() => mic.unplug());
    expect(hook.result.current.state).toBe("off");
    expect(mic.closed).toBe(true);
    expect(notices).toEqual([MICROPHONE_LOST]);
    mic.closed = false;
    act(() => hook.result.current.retry());
    await advance(600);
    expect(hook.result.current.state).toBe("listening");
  });

  it("knows the click that woke it up", async () => {
    const mic = new FakeMicrophone();
    let attempts = 0;
    const { hook } = setup({
      open: async (handlers) => {
        if (attempts++ === 0) throw new AudioNeedsGesture();
        mic.handlers = handlers;
        return mic;
      },
    });
    await advance(0);
    expect(hook.result.current.justWoken()).toBe(false);
    await act(async () => {
      fireEvent.pointerDown(window);
    });
    expect(hook.result.current.justWoken()).toBe(true); // so that click isn't also a pause
    await advance(2000);
    expect(hook.result.current.justWoken()).toBe(false);
  });
});

describe("isFiller", () => {
  it("knows a hesitation from something said", () => {
    expect(isFiller("Hum.")).toBe(true);
    expect(isFiller("ah, hmm")).toBe(true);
    expect(isFiller("...")).toBe(true);
    expect(isFiller("Sim.")).toBe(false); // a real answer, however short
    expect(isFiller("é verdade")).toBe(false);
  });
});
