// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserSpeaker,
  type Fallback,
  isSpeaking,
  pickVoice,
  SentenceSplitter,
  ServerSpeaker,
  speechText,
  subscribeSpeaking,
} from "@/lib/speech";

function split(chunks: string[]): string[] {
  const splitter = new SentenceSplitter();
  const out = chunks.flatMap((chunk) => splitter.push(chunk));
  return [...out, ...splitter.flush()];
}

describe("SentenceSplitter", () => {
  it("hands over each sentence as soon as the next one starts", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Olá. Eu sou")).toEqual(["Olá."]);
    expect(splitter.push(" o F.E.A.R. e estou aqui. Tudo")).toEqual(["Eu sou o F.E.A.R. e estou aqui."]);
    expect(splitter.flush()).toEqual(["Tudo"]);
  });

  it("does not end a sentence inside numbers or after abbreviations", () => {
    expect(split(["Custa 3.5 reais. Falei com o Dr. Silva hoje. Certo?"])).toEqual([
      "Custa 3.5 reais.",
      "Falei com o Dr. Silva hoje.",
      "Certo?",
    ]);
  });

  it("treats each line of a list as its own sentence", () => {
    expect(split(["Três passos:\n- decidir\n- cortar\n- agir"])).toEqual([
      "Três passos:",
      "- decidir",
      "- cortar",
      "- agir",
    ]);
  });

  it("starts on a long sentence at a comma instead of waiting for its end", () => {
    const long = `${"palavra ".repeat(20)}, ${"outra ".repeat(25)}`;
    const splitter = new SentenceSplitter();
    expect(splitter.push(long)).toHaveLength(1);
  });

  it("keeps question and exclamation marks with their sentence", () => {
    expect(split(["Sério?! Sim… talvez. Ok"])).toEqual(["Sério?!", "Sim…", "talvez.", "Ok"]);
  });

  it("never reads code aloud, however the reply arrives", () => {
    const reply = "Rode isto:\n```python\nimport os\nprint(os.getcwd())\n```\nPronto. Viu?";
    const expected = ["Rode isto:", "Pronto.", "Viu?"];
    expect(split([reply])).toEqual(expected);
    expect(split([...reply])).toEqual(expected); // one character at a time
    expect(split(["Veja:\n```\nsem fim"])).toEqual(["Veja:"]); // a block the reply never closed
  });

  it("skips lines with nothing to say", () => {
    expect(split(["Um.\n---\n| a | b |\n|---|---|\nDois."])).toEqual(["Um.", "| a | b |", "Dois."]);
  });
});

describe("speechText", () => {
  it("drops what should not be read aloud", () => {
    expect(speechText("**Atenção:** veja [o guia](https://exemplo.com) e `isto` 🤖")).toBe(
      "Atenção: veja o guia e isto",
    );
    expect(speechText("## Título\n- item um\n1. item dois\n> citação")).toBe(
      "Título item um item dois citação",
    );
    expect(speechText("```js\ncode()\n```")).toBe("");
  });
});

describe("pickVoice", () => {
  it("prefers Windows' natural Brazilian voices", () => {
    const voices = [
      { name: "Google US English", lang: "en-US" },
      { name: "Microsoft Maria - Portuguese (Brazil)", lang: "pt-BR" },
      { name: "Microsoft Francisca Online (Natural) - Portuguese (Brazil)", lang: "pt-BR" },
    ] as SpeechSynthesisVoice[];
    expect(pickVoice(voices)?.name).toMatch(/Francisca/);
  });

  it("falls back to any Portuguese voice, then any voice", () => {
    const european = [
      { name: "Joana", lang: "pt-PT" },
      { name: "Alex", lang: "en-US" },
    ] as SpeechSynthesisVoice[];
    expect(pickVoice(european)?.name).toBe("Joana");
    expect(pickVoice([{ name: "Alex", lang: "en-US" }] as SpeechSynthesisVoice[])?.name).toBe("Alex");
  });
});

// A stand-in for HTMLAudioElement: records what played and lets the test end it.
class FakeAudio {
  static played: string[] = [];
  static current: FakeAudio | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  constructor(readonly src: string) {}
  play() {
    FakeAudio.played.push(this.src);
    FakeAudio.current = this;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  end() {
    this.onended?.();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ServerSpeaker", () => {
  beforeEach(() => {
    FakeAudio.played = [];
    FakeAudio.current = null;
    vi.stubGlobal("Audio", FakeAudio);
    let id = 0;
    URL.createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as Blob & { label?: string }).label ?? id++}`);
    URL.revokeObjectURL = vi.fn();
  });
  // The talking state is app-wide: each test stops what it started.
  const started: ServerSpeaker[] = [];
  afterEach(() => {
    started.splice(0).forEach((speaker) => speaker.stop());
    vi.unstubAllGlobals();
  });
  const speakerFor = (...args: ConstructorParameters<typeof ServerSpeaker>) => {
    const speaker = new ServerSpeaker(...args);
    started.push(speaker);
    return speaker;
  };

  const blob = (label: string) => Object.assign(new Blob([label]), { label });

  it("plays sentences in order, even when a later one is ready first", async () => {
    let releaseFirst: (b: Blob) => void = () => {};
    const fetchVoice = vi.fn((text: string) =>
      text === "Um." ? new Promise<Blob>((resolve) => (releaseFirst = resolve)) : Promise.resolve(blob(text)),
    );
    const speaker = speakerFor(fetchVoice, "fear");
    speaker.say("Um.");
    speaker.say("Dois.");
    await flush();
    expect(FakeAudio.played).toEqual([]); // "Dois." waits for "Um."
    releaseFirst(blob("Um."));
    await flush();
    expect(FakeAudio.played).toEqual(["blob:Um."]);
    FakeAudio.current?.end();
    await flush();
    expect(FakeAudio.played).toEqual(["blob:Um.", "blob:Dois."]);
    expect(fetchVoice).toHaveBeenCalledWith("Um.", "fear", expect.any(AbortSignal));
  });

  it("stops at once: current audio paused, the rest dropped", async () => {
    const speaker = speakerFor(async (text) => blob(text), "natural");
    speaker.say("Um.");
    speaker.say("Dois.");
    await flush();
    const first = FakeAudio.current;
    speaker.stop();
    await flush();
    expect(first?.paused).toBe(true);
    expect(FakeAudio.played).toEqual(["blob:Um."]);
  });

  it("says a sentence in the browser's voice if the backend can't — in its turn", async () => {
    const order: string[] = [];
    let finishSaying: () => void = () => {};
    const fallback: Fallback = {
      speak: (text) => {
        order.push(`browser:${text}`);
        return new Promise<void>((resolve) => (finishSaying = resolve));
      },
      stop: () => {},
    };
    const fetchVoice = vi.fn(async (text: string) => {
      if (text === "Dois.") throw new Error("503");
      return blob(text);
    });
    const speaker = speakerFor(fetchVoice, "fear", fallback);
    speaker.say("Um.");
    speaker.say("**Dois.**");
    speaker.say("Três.");
    await flush();
    expect(order).toEqual([]); // "Dois." waits for "Um." to finish
    FakeAudio.current?.end();
    await flush();
    expect(order).toEqual(["browser:Dois."]);
    expect(FakeAudio.played).toEqual(["blob:Um."]); // "Três." waits for the browser
    finishSaying();
    await flush();
    expect(FakeAudio.played).toEqual(["blob:Um.", "blob:Três."]);
  });

  it("tells when F.E.A.R. is talking, so the open microphone doesn't hear it", async () => {
    const changes: boolean[] = [];
    const unsubscribe = subscribeSpeaking(() => changes.push(isSpeaking()));
    const speaker = speakerFor(async (text) => blob(text), "fear");
    speaker.say("Um.");
    expect(isSpeaking()).toBe(true); // from the first sentence on, even while it's synthesized
    await flush();
    speaker.say("Dois.");
    FakeAudio.current?.end();
    await flush();
    expect(isSpeaking()).toBe(true); // still: "Dois." is playing
    FakeAudio.current?.end();
    await flush();
    expect(isSpeaking()).toBe(false);
    speaker.say("Três.");
    speaker.stop();
    expect(isSpeaking()).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    unsubscribe();
  });

  it("gives up on a sentence the backend never voices, instead of talking forever", async () => {
    vi.useFakeTimers();
    try {
      const said: string[] = [];
      const fallback: Fallback = { speak: async (text) => void said.push(text), stop: () => {} };
      const speaker = speakerFor(() => new Promise<Blob>(() => {}), "fear", fallback); // hangs
      speaker.say("Um.");
      expect(isSpeaking()).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(said).toEqual(["Um."]); // the browser's voice says it
      expect(isSpeaking()).toBe(false); // and the microphone may listen again
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the backend for only a couple of sentences ahead", async () => {
    const fetchVoice = vi.fn(async (text: string) => blob(text));
    const speaker = speakerFor(fetchVoice, "fear");
    for (const sentence of ["Um.", "Dois.", "Três.", "Quatro.", "Cinco."]) speaker.say(sentence);
    await flush();
    expect(FakeAudio.played).toEqual(["blob:Um."]);
    expect(fetchVoice).toHaveBeenCalledTimes(3); // the one playing and two more
    FakeAudio.current?.end();
    await flush();
    expect(fetchVoice).toHaveBeenCalledTimes(4);
    speaker.stop(); // cut short: the rest is never asked for
    await flush();
    expect(fetchVoice).toHaveBeenCalledTimes(4);
  });
});

describe("BrowserSpeaker", () => {
  const spoken: string[] = [];
  beforeEach(() => {
    spoken.length = 0;
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(readonly text: string) {}
      },
    );
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      cancel: vi.fn(),
      speak: (utterance: { text: string }) => spoken.push(utterance.text),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tells when the browser's voice is talking", () => {
    const utterances: { onend: (() => void) | null }[] = [];
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      cancel: vi.fn(),
      speak: (utterance: { onend: (() => void) | null }) => utterances.push(utterance),
    });
    const speaker = new BrowserSpeaker();
    speaker.say("Um.");
    speaker.say("Dois.");
    expect(isSpeaking()).toBe(true);
    utterances[0].onend?.();
    expect(isSpeaking()).toBe(true); // "Dois." still to say
    utterances[1].onend?.();
    expect(isSpeaking()).toBe(false);
  });

  it("keeps counting as talking through a long answer the browser reads in turn", async () => {
    vi.useFakeTimers();
    try {
      type Utterance = { onstart: (() => void) | null; onend: (() => void) | null };
      const queue: Utterance[] = [];
      const synth = { speaking: false, pending: false, getVoices: () => [], cancel: vi.fn() };
      vi.stubGlobal("speechSynthesis", { ...synth, speak: (utterance: Utterance) => queue.push(utterance) });
      const speaker = new BrowserSpeaker();
      const sentence = "Esta é uma frase longa o bastante para levar uns bons segundos para ser dita em voz.";
      for (let i = 0; i < 5; i++) speaker.say(sentence); // the whole answer, queued at once
      // The browser says them one after the other, ~5 s each.
      for (const utterance of queue) {
        utterance.onstart?.();
        await vi.advanceTimersByTimeAsync(4800);
        expect(isSpeaking()).toBe(true); // never "done" while a sentence is still to come
        utterance.onend?.();
      }
      expect(isSpeaking()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the browser to really go quiet before counting as done", async () => {
    vi.useFakeTimers();
    try {
      const utterances: { onend: (() => void) | null }[] = [];
      const synth = {
        speaking: true,
        pending: false,
        getVoices: () => [],
        cancel: vi.fn(),
        speak: (u: { onend: (() => void) | null }) => utterances.push(u),
      };
      vi.stubGlobal("speechSynthesis", synth);
      const speaker = new BrowserSpeaker();
      speaker.say("Um.");
      utterances[0].onend?.(); // an end event that came early
      await vi.advanceTimersByTimeAsync(1000);
      expect(isSpeaking()).toBe(true); // the browser is still talking
      synth.speaking = false;
      await vi.advanceTimersByTimeAsync(300);
      expect(isSpeaking()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet once stopped, for the rest of that reply", () => {
    const speaker = new BrowserSpeaker();
    speaker.say("Um.");
    speaker.stop();
    speaker.say("Dois."); // still streaming in after the stop
    expect(spoken).toEqual(["Um."]);
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });
});
