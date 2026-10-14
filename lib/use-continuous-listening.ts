import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeAudio } from "@/lib/api";
import { humanizeError } from "@/lib/chat-helpers";
import { describeMicError } from "@/lib/use-voice-input";
import {
  AudioNeedsGesture,
  type ContinuousMicrophone,
  type ContinuousMicrophoneFactory,
  openContinuousMicrophone,
} from "@/lib/voice-stream";

export type ListeningState =
  | "off" // not wanted, or the window is hidden
  | "starting" // the microphone is opening
  | "listening" // waiting for you to talk
  | "hearing" // you're talking
  | "transcribing" // turning it into text
  | "waiting" // F.E.A.R. is answering or talking: it'll listen again after
  | "blocked"; // the page needs one click before it may use audio

// After F.E.A.R. stops talking, a beat before listening again: the end of its
// own voice (and the room's echo of it) must not be taken for yours.
const RESUME_AFTER_MS = 500;
// A transcript was handed over: listen again once the answer is done — or
// after this, if no answer came (the message was refused, say).
const ANSWER_GRACE_MS = 8000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export const MICROPHONE_LOST =
  "O microfone foi desligado ou desconectado. Clique no microfone para tentar de novo.";

const ALWAYS_KEY = "fear.voice.always";

/** Whether F.E.A.R. listens as soon as the window opens (yes, unless turned off). */
export function loadAlwaysListen(): boolean {
  try {
    return window.localStorage.getItem(ALWAYS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveAlwaysListen(on: boolean): void {
  try {
    window.localStorage.setItem(ALWAYS_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}

// Sounds, not words: never worth an answer.
const FILLERS = new Set(["hum", "hm", "hmm", "humm", "ah", "ahn", "eh", "uh", "uhm", "hã", "é"]);

/** Whether a transcript is only a hesitation or a noise taken for a word. */
export function isFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length === 0 || words.every((word) => FILLERS.has(word));
}

interface Options {
  /** Listening is wanted right now (the setting is on and the window is shown). */
  active: boolean;
  /** F.E.A.R. is answering or talking, or the microphone is in use another way. */
  hold: boolean;
  /** What was said, once transcribed. */
  onTranscript: (text: string) => void;
  /** Something worth telling the person (the microphone couldn't open). */
  onNotice?: (message: string) => void;
  /** Injected in tests. */
  transcribe?: (audio: Blob, signal: AbortSignal) => Promise<string>;
  openMicrophone?: ContinuousMicrophoneFactory;
}

/**
 * F.E.A.R. listening the whole time the window is open: each sentence you say
 * is transcribed and handed over, one at a time — it stops listening while it
 * answers, so it never hears itself, and starts again right after.
 */
export function useContinuousListening({
  active,
  hold,
  onTranscript,
  onNotice,
  transcribe = transcribeAudio,
  openMicrophone = openContinuousMicrophone,
}: Options) {
  const [state, setState] = useState<ListeningState>("off");
  const stateRef = useRef<ListeningState>("off");
  const levelRef = useRef(0);
  const micRef = useRef<ContinuousMicrophone | null>(null);
  // Bumped whenever a microphone opens or closes: anything still running for
  // an older one (an opening, a transcription) backs out.
  const micGenRef = useRef(0);
  const transcriptionRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef<AbortController | null>(null);
  // A transcript was handed over and its answer hasn't come and gone yet.
  const awaitingRef = useRef(false);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const callbacks = useRef({ onTranscript, onNotice, transcribe });
  callbacks.current = { onTranscript, onNotice, transcribe };
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // When a click or key woke a microphone that was waiting for one.
  const wokenAtRef = useRef(0);

  const set = useCallback((next: ListeningState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Listen again, unless F.E.A.R. is busy or an answer is still due. Never
  // mid-transcription: that one listens again by itself when it's done.
  const listenAgain = useCallback(() => {
    clearTimeout(resumeTimer.current);
    const mic = micRef.current;
    if (!mic || stateRef.current === "transcribing") return;
    if (holdRef.current || awaitingRef.current) {
      mic.pause();
      set("waiting");
      return;
    }
    resumeTimer.current = setTimeout(() => {
      if (micRef.current !== mic || holdRef.current || awaitingRef.current) return;
      if (stateRef.current === "transcribing") return;
      mic.resume();
      set("listening");
    }, RESUME_AFTER_MS);
  }, [set]);

  const handleSentence = useCallback(
    async (audio: Blob, gen: number) => {
      const mic = micRef.current;
      if (!mic || gen !== micGenRef.current || stateRef.current === "transcribing") return;
      mic.pause(); // one thing at a time: what you said is answered first
      set("transcribing");
      const transcription = new AbortController();
      transcriptionRef.current = transcription;
      const timer = setTimeout(() => transcription.abort(), TRANSCRIBE_TIMEOUT_MS);
      let text = "";
      try {
        text = (await callbacks.current.transcribe(audio, transcription.signal)).trim();
      } catch (error) {
        if (!transcription.signal.aborted) callbacks.current.onNotice?.(humanizeError(error));
      } finally {
        clearTimeout(timer);
        if (transcriptionRef.current === transcription) transcriptionRef.current = null;
      }
      if (gen !== micGenRef.current) return; // the microphone closed meanwhile
      if (cancelledRef.current === transcription) return; // cancel() already moved on
      if (text && !isFiller(text)) {
        awaitingRef.current = true;
        clearTimeout(graceTimer.current);
        graceTimer.current = setTimeout(() => {
          awaitingRef.current = false;
          listenAgain();
        }, ANSWER_GRACE_MS);
        callbacks.current.onTranscript(text);
      }
      set("waiting");
      listenAgain();
    },
    [listenAgain, set],
  );

  const close = useCallback(() => {
    micGenRef.current++;
    clearTimeout(resumeTimer.current);
    clearTimeout(graceTimer.current);
    awaitingRef.current = false;
    transcriptionRef.current?.abort();
    transcriptionRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    levelRef.current = 0;
  }, []);

  /** Drop what's being heard or transcribed right now (a fist: "silêncio"). */
  const cancel = useCallback(() => {
    const transcription = transcriptionRef.current;
    if (transcription) {
      cancelledRef.current = transcription;
      transcription.abort();
      transcriptionRef.current = null;
    }
    const mic = micRef.current;
    if (!mic) return;
    mic.pause(); // a sentence being heard is dropped; the microphone stays on
    set("waiting");
    listenAgain();
  }, [listenAgain, set]);

  const open = useCallback(async () => {
    const gen = ++micGenRef.current;
    set("starting");
    let mic: ContinuousMicrophone;
    try {
      mic = await openMicrophone({
        onSpeech: () => {
          if (gen === micGenRef.current && stateRef.current === "listening") set("hearing");
        },
        onSentence: (audio) => void handleSentence(audio, gen),
        onQuiet: () => {
          if (gen === micGenRef.current && stateRef.current === "hearing") set("listening");
        },
        onLost: () => {
          if (gen !== micGenRef.current) return;
          close();
          set("off");
          callbacks.current.onNotice?.(MICROPHONE_LOST);
        },
      });
    } catch (error) {
      if (gen !== micGenRef.current) return;
      if (error instanceof AudioNeedsGesture) {
        set("blocked");
      } else {
        set("off");
        callbacks.current.onNotice?.(describeMicError(error));
      }
      return;
    }
    if (gen !== micGenRef.current) {
      mic.close(); // no longer wanted by the time it opened
      return;
    }
    micRef.current = mic;
    mic.pause();
    set("waiting");
    listenAgain();
  }, [close, handleSentence, listenAgain, openMicrophone, set]);

  // Open while wanted, closed otherwise (the window hidden, the setting off).
  useEffect(() => {
    if (!active) {
      close();
      set("off");
      return;
    }
    void open();
    return () => close();
  }, [active, close, open, set]);

  // F.E.A.R. answering or talking: wait; done: listen again shortly after.
  useEffect(() => {
    if (hold) {
      // The answer came: when it's over, listen again.
      awaitingRef.current = false;
      clearTimeout(graceTimer.current);
    }
    listenAgain();
  }, [hold, listenAgain]);

  // Blocked until a click: the first click or key anywhere starts it.
  useEffect(() => {
    if (state !== "blocked") return;
    const retry = () => {
      wokenAtRef.current = Date.now();
      void open();
    };
    window.addEventListener("pointerdown", retry, { once: true });
    window.addEventListener("keydown", retry, { once: true });
    return () => {
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
    };
  }, [state, open]);

  // The live loudness, for the microphone's ring.
  useEffect(() => {
    if (state !== "listening" && state !== "hearing") return;
    const timer = setInterval(() => {
      levelRef.current = micRef.current?.level() ?? 0;
    }, 50);
    return () => {
      clearInterval(timer);
      levelRef.current = 0;
    };
  }, [state]);

  /** Open the microphone again (it failed, or went away). */
  const retry = useCallback(() => {
    if (!micRef.current) void open();
  }, [open]);

  /** Whether a click just now is the one that woke the microphone up. */
  const justWoken = useCallback(() => Date.now() - wokenAtRef.current < 1500, []);

  return { state, levelRef, cancel, retry, justWoken };
}

export type ContinuousListening = ReturnType<typeof useContinuousListening>;
