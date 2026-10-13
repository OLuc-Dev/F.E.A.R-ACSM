// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pickVoice, SentenceSplitter, ServerSpeaker, type Speaker, speechText } from "@/lib/speech";

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
  afterEach(() => vi.unstubAllGlobals());

  const blob = (label: string) => Object.assign(new Blob([label]), { label });

  it("plays sentences in order, even when a later one is ready first", async () => {
    let releaseFirst: (b: Blob) => void = () => {};
    const fetchVoice = vi.fn((text: string) =>
      text === "Um." ? new Promise<Blob>((resolve) => (releaseFirst = resolve)) : Promise.resolve(blob(text)),
    );
    const speaker = new ServerSpeaker(fetchVoice, "fear");
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
    const speaker = new ServerSpeaker(async (text) => blob(text), "natural");
    speaker.say("Um.");
    speaker.say("Dois.");
    await flush();
    const first = FakeAudio.current;
    speaker.stop();
    await flush();
    expect(first?.paused).toBe(true);
    expect(FakeAudio.played).toEqual(["blob:Um."]);
  });

  it("says a sentence in the browser's voice if the backend can't", async () => {
    const said: string[] = [];
    const fallback: Speaker = { say: (s) => said.push(s), stop: () => {} };
    const speaker = new ServerSpeaker(async () => Promise.reject(new Error("503")), "fear", fallback);
    speaker.say("**Olá.**");
    await flush();
    expect(said).toEqual(["Olá."]);
  });
});
