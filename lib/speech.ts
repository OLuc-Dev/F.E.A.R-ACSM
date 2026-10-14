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

/** Whether there's anything to say: letters or digits, not just marks like "---". */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

const FENCE = /^\s*(?:```|~~~)/;
// What could still grow into a fence once the rest of the line arrives.
const MAYBE_FENCE = /^\s*(?:`{1,2}|~{1,2})$/;

/** Cuts a reply arriving in pieces into complete sentences, as soon as each ends. */
export class SentenceSplitter {
  private buffer = "";
  private lineStart = true;
  private inCode = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      if (this.lineStart && this.skipCodeLine()) continue;
      if (this.lineStart && this.lineUndecided()) break;
      const end = this.nextBoundary();
      if (end === -1) break;
      const piece = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      this.lineStart = piece.endsWith("\n");
      const sentence = piece.trim();
      if (hasWords(sentence)) out.push(sentence);
    }
    return out;
  }

  /** Whatever is left once the reply has finished. */
  flush(): string[] {
    const rest = this.inCode || FENCE.test(this.buffer) ? "" : this.buffer.trim();
    this.buffer = "";
    this.lineStart = true;
    this.inCode = false;
    return hasWords(rest) ? [rest] : [];
  }

  // Code is never read aloud: a fence line opens or closes a block, and the
  // lines in between are dropped whole.
  private skipCodeLine(): boolean {
    const newline = this.buffer.indexOf("\n");
    if (newline === -1) return false;
    const fence = FENCE.test(this.buffer.slice(0, newline));
    if (!fence && !this.inCode) return false;
    if (fence) this.inCode = !this.inCode;
    this.buffer = this.buffer.slice(newline + 1);
    return true;
  }

  // A line still arriving that is code, or may yet become a fence, waits.
  private lineUndecided(): boolean {
    if (this.buffer.includes("\n")) return false;
    return this.inCode || FENCE.test(this.buffer) || MAYBE_FENCE.test(this.buffer);
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

// --- whether F.E.A.R. is talking (the always-on microphone must not hear it) ---

const talking = new Set<object>();
const talkingListeners = new Set<() => void>();

function markTalking(speaker: object, on: boolean): void {
  const before = talking.size > 0;
  if (on) talking.add(speaker);
  else talking.delete(speaker);
  if (before !== talking.size > 0) talkingListeners.forEach((listener) => listener());
}

/** Whether F.E.A.R. is saying something right now. */
export function isSpeaking(): boolean {
  return talking.size > 0;
}

/** Called whenever F.E.A.R. starts or stops talking (fits useSyncExternalStore). */
export function subscribeSpeaking(listener: () => void): () => void {
  talkingListeners.add(listener);
  return () => talkingListeners.delete(listener);
}

export class BrowserSpeaker implements Speaker {
  private stopped = false;
  private pending = 0;

  say(sentence: string): void {
    // The browser queues utterances itself, so sentences play in order.
    void this.speak(sentence);
  }

  /** Says one sentence; resolves once it has been said (or won't be). */
  speak(sentence: string): Promise<void> {
    const text = speechText(sentence);
    if (this.stopped || !speechSupported() || !hasWords(text)) return Promise.resolve();
    this.pending++;
    markTalking(this, true);
    return new Promise<void>((done) => {
      let finished = false;
      const resolve = () => {
        if (finished) return;
        finished = true;
        this.pending = Math.max(0, this.pending - 1);
        if (!this.pending) markTalking(this, false);
        done();
      };
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = "pt-BR";
      }
      utterance.pitch = 0.85; // a shade lower — cold and even, in character
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      // Some browsers skip the end event; never wait past what the words could take.
      setTimeout(resolve, 2000 + text.length * 120);
      window.speechSynthesis.speak(utterance);
    });
  }

  /** Silences it for good: later sentences of the same reply are dropped too. */
  stop(): void {
    this.stopped = true;
    this.pending = 0;
    markTalking(this, false);
    if (speechSupported()) window.speechSynthesis.cancel();
  }
}

export type VoiceFetcher = (text: string, style: VoiceStyle, signal: AbortSignal) => Promise<Blob>;

/** Who speaks a sentence when the backend can't: waits until it has been said. */
export type Fallback = Pick<BrowserSpeaker, "speak" | "stop">;

// One sentence playing, the next two synthesizing.
const LOOKAHEAD = 2;
// A sentence that takes longer than this to synthesize, or to play, is given
// up on: a stuck request must never leave F.E.A.R. "talking" (and deaf) for good.
const SYNTHESIS_TIMEOUT_MS = 20_000;
const PLAYBACK_LIMIT_MS = 90_000;

type Spoken = { audio: Blob } | { text: string };

/** Plays the backend's Piper audio, sentence by sentence, each fetched just ahead. */
export class ServerSpeaker implements Speaker {
  // Sentences not asked for yet, then those being synthesized, in order — at
  // most LOOKAHEAD ahead of playback, so an answer cut short leaves no backlog.
  private waiting: string[] = [];
  private requested: Promise<Spoken | null>[] = [];
  private draining = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private audio: HTMLAudioElement | null = null;
  private finishCurrent: (() => void) | null = null;

  constructor(
    private readonly fetchVoice: VoiceFetcher,
    private readonly style: VoiceStyle,
    private readonly fallback: Fallback = new BrowserSpeaker(),
  ) {}

  say(sentence: string): void {
    const text = speechText(sentence);
    if (!hasWords(text) || this.stopped) return;
    this.waiting.push(text);
    this.request();
    if (!this.draining) void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    this.waiting = [];
    this.requested = [];
    this.audio?.pause();
    this.finishCurrent?.();
    this.fallback.stop();
    markTalking(this, false);
  }

  private request(): void {
    while (this.requested.length < LOOKAHEAD && this.waiting.length) {
      const text = this.waiting.shift() as string;
      const request = new AbortController();
      const abort = () => request.abort();
      this.controller.signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Settles even if the request ignores being aborted.
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(new Error("the voice took too long"));
        }, SYNTHESIS_TIMEOUT_MS);
      });
      this.requested.push(
        Promise.race([this.fetchVoice(text, this.style, request.signal), late])
          .then(
            (audio): Spoken => ({ audio }),
            // The backend voice failed for this one: the browser's says it, in its turn.
            (): Spoken | null => (this.stopped ? null : { text }),
          )
          .finally(() => {
            clearTimeout(timer);
            this.controller.signal.removeEventListener("abort", abort);
          }),
      );
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    markTalking(this, true);
    while (this.requested.length && !this.stopped) {
      const next = this.requested.shift() as Promise<Spoken | null>;
      this.request(); // the one after starts synthesizing while this one plays
      const spoken = await next;
      if (!spoken || this.stopped) continue;
      if ("audio" in spoken) await this.play(spoken.audio);
      else await this.fallback.speak(spoken.text);
    }
    this.draining = false;
    markTalking(this, false);
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(limit);
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
      limit = setTimeout(done, PLAYBACK_LIMIT_MS);
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
