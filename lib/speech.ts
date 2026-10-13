// How F.E.A.R. speaks its replies: sentence by sentence while the reply is still
// streaming, so it starts talking at once instead of after the whole answer.
// The voice is Piper (the app's own, via the backend) when available, and the
// best voice the browser has otherwise. Every entry point is a no-op where the
// browser lacks what it needs.

export type VoiceStyle = "fear" | "natural" | "system";

export const VOICE_STYLES: { value: VoiceStyle; label: string; hint: string }[] = [
  { value: "fear", label: "F.E.A.R.", hint: "grave e levemente metálica" },
  { value: "natural", label: "Natural", hint: "a mesma voz, sem efeito" },
  { value: "system", label: "Do sistema", hint: "a voz do Windows ou do navegador" },
];

const STYLE_KEY = "fear.voice.style";

export function loadVoiceStyle(): VoiceStyle {
  try {
    const saved = window.localStorage.getItem(STYLE_KEY);
    return saved === "natural" || saved === "system" ? saved : "fear";
  } catch {
    return "fear";
  }
}

export function saveVoiceStyle(style: VoiceStyle): void {
  try {
    window.localStorage.setItem(STYLE_KEY, style);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}

/** Text as it should be heard: no markdown marks, links, code or emoji. */
export function speechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^[\s>]*#{1,6}\s+/gm, "")
    .replace(/^[\s>]*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A period after these is not the end of a sentence.
const ABBREVIATIONS = new Set([
  "sr",
  "sra",
  "srta",
  "dr",
  "dra",
  "prof",
  "profa",
  "ex",
  "etc",
  "vs",
  "obs",
  "aprox",
]);
// Long enough without a full stop: start speaking at a comma rather than wait.
const SOFT_LIMIT = 220;

/** Cuts a reply arriving in pieces into complete sentences, as soon as each ends. */
export class SentenceSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const end = this.nextBoundary();
      if (end === -1) break;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Whatever is left once the reply has finished. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private nextBoundary(): number {
    const text = this.buffer;
    const newline = text.indexOf("\n");
    // Sentence-ending punctuation followed by whitespace (so "3.5" and "F.E.A.R."
    // mid-word never end one).
    const pattern = /[.!?…]+["')\]]*(?=\s)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const end = match.index + match[0].length;
      if (newline !== -1 && newline < end) return newline + 1;
      if (match[0].startsWith(".") && !endsSentence(text.slice(0, match.index))) continue;
      return end;
    }
    if (newline !== -1) return newline + 1;
    if (text.length > SOFT_LIMIT) {
      const comma = Math.max(text.lastIndexOf(", ", SOFT_LIMIT), text.lastIndexOf("; ", SOFT_LIMIT));
      if (comma > 40) return comma + 1;
    }
    return -1;
  }
}

function endsSentence(before: string): boolean {
  const word = /([\p{L}\p{N}.]+)$/u.exec(before)?.[1] ?? "";
  // Initialisms like "F.E.A.R" (letters split by dots) keep going.
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return false;
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/** Speaks sentences in order; `stop` silences it at once and drops the rest. */
export interface Speaker {
  say(sentence: string): void;
  stop(): void;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

let cachedVoice: SpeechSynthesisVoice | null = null;

/** The most natural Portuguese voice installed (Edge/Windows "Natural" voices first). */
export function pickVoice(
  voices: SpeechSynthesisVoice[] = speechSupported() ? window.speechSynthesis.getVoices() : [],
) {
  if (!voices.length) return cachedVoice;
  const brazilian = voices.filter((voice) => /pt[-_]br/i.test(voice.lang));
  const portuguese = brazilian.length ? brazilian : voices.filter((voice) => /^pt/i.test(voice.lang));
  cachedVoice =
    portuguese.find((voice) => /natural|neural/i.test(voice.name)) ??
    portuguese.find((voice) => /online|google/i.test(voice.name)) ??
    portuguese[0] ??
    voices[0];
  return cachedVoice;
}

class BrowserSpeaker implements Speaker {
  say(sentence: string): void {
    if (!speechSupported()) return;
    const text = speechText(sentence);
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = "pt-BR";
    }
    utterance.pitch = 0.85; // a shade lower — cold and even, in character
    // The browser queues utterances itself, so sentences play in order.
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (speechSupported()) window.speechSynthesis.cancel();
  }
}

export type VoiceFetcher = (text: string, style: VoiceStyle, signal: AbortSignal) => Promise<Blob>;

/** Plays the backend's Piper audio, sentence by sentence; each is fetched ahead. */
export class ServerSpeaker implements Speaker {
  private pending: Promise<Blob | null>[] = [];
  private draining = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private audio: HTMLAudioElement | null = null;
  private finishCurrent: (() => void) | null = null;

  constructor(
    private readonly fetchVoice: VoiceFetcher,
    private readonly style: VoiceStyle,
    private readonly fallback: Speaker = new BrowserSpeaker(),
  ) {}

  say(sentence: string): void {
    const text = speechText(sentence);
    if (!text || this.stopped) return;
    // Synthesis starts now, while the previous sentence is still playing.
    const audio = this.fetchVoice(text, this.style, this.controller.signal).catch(() => {
      // The backend voice failed for this sentence: say it anyway, in the browser's.
      if (!this.stopped) this.fallback.say(text);
      return null;
    });
    this.pending.push(audio);
    if (!this.draining) void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    this.pending = [];
    this.audio?.pause();
    this.finishCurrent?.();
    this.fallback.stop();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.pending.length && !this.stopped) {
      const blob = await this.pending.shift();
      if (blob && !this.stopped) await this.play(blob);
    }
    this.draining = false;
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      const done = () => {
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        if (this.audio === audio) this.audio = null;
        this.finishCurrent = null;
        resolve();
      };
      this.finishCurrent = done;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }
}

// --- the app-wide voice: one speaker at a time ------------------------------

let serverVoice: VoiceFetcher | null = null;
let current: Speaker | null = null;

/** Called once the backend reports a voice (Piper); null falls back to the browser. */
export function setServerVoice(fetcher: VoiceFetcher | null): void {
  serverVoice = fetcher;
}

/** A fresh speaker for a new reply, in the chosen style; silences the previous one. */
export function startSpeaking(style: VoiceStyle = loadVoiceStyle()): Speaker {
  stopSpeaking();
  current = serverVoice && style !== "system" ? new ServerSpeaker(serverVoice, style) : new BrowserSpeaker();
  return current;
}

export function stopSpeaking(): void {
  current?.stop();
  current = null;
  if (speechSupported()) window.speechSynthesis.cancel();
}

// Call from a user gesture (e.g. toggling voice on): loads the async voice list
// and unlocks audio on iOS/Safari, which require the first utterance to follow
// a user interaction.
export function primeSpeech(): void {
  if (!speechSupported()) return;
  pickVoice();
  window.speechSynthesis.onvoiceschanged = () => pickVoice();
  const warm = new SpeechSynthesisUtterance(" ");
  warm.volume = 0;
  window.speechSynthesis.speak(warm);
}
