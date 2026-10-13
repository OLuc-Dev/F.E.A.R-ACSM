import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeAudio } from "@/lib/api";
import { humanizeError } from "@/lib/chat-helpers";
import { stopSpeaking } from "@/lib/speech";
import { type ListenMode, SpeechActivity, VOICE_TUNING } from "@/lib/voice-activity";
import { type Capture, type CaptureFactory, startMicrophoneCapture } from "@/lib/voice-capture";

export type VoiceInputState = "idle" | "starting" | "listening" | "transcribing";

const TICK_MS = 50;
// When loudness can't be measured, listen for this long and let Whisper (which
// drops silence itself) find the words.
const UNMEASURED_MS = 6000;
// Less than this is a click, not a sentence.
const MIN_RECORDING_BYTES = 1000;

export const VOICE_NOTICES = {
  nothing: "Não ouvi nada. Fale logo depois de ativar o microfone.",
  unclear: "Não entendi. Tenta de novo?",
} as const;

/** Plain-language reason the microphone didn't open. */
export function describeMicError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Sem permissão para usar o microfone. Libere em Configurações do Windows → Privacidade → Microfone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhum microfone encontrado.";
  if (name === "NotReadableError" || name === "AbortError")
    return "O microfone está em uso por outro programa.";
  return "Não consegui abrir o microfone.";
}

interface Options {
  /** What was said, once transcribed. */
  onTranscript: (text: string) => void;
  /** A short, human message when nothing usable came of it. */
  onNotice?: (message: string) => void;
  /** Injected in tests. */
  transcribe?: (audio: Blob) => Promise<string>;
  startCapture?: CaptureFactory;
}

/**
 * Talking to F.E.A.R.: `start("auto")` listens until you stop talking;
 * `start("hold")` (or `hold()` mid-way) until `stop()`, for hold-to-talk.
 * The live loudness is in `levelRef`, read without re-rendering anything.
 */
export function useVoiceInput({
  onTranscript,
  onNotice,
  transcribe = transcribeAudio,
  startCapture = startMicrophoneCapture,
}: Options) {
  const [state, setState] = useState<VoiceInputState>("idle");
  const stateRef = useRef<VoiceInputState>("idle");
  const levelRef = useRef(0);
  const captureRef = useRef<Capture | null>(null);
  const activityRef = useRef<SpeechActivity | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Bumped by cancel(): an opening microphone that finds it changed backs out.
  const runRef = useRef(0);
  // stop()/hold() that arrive while the microphone is still opening.
  const pendingRef = useRef({ hold: false, stop: false });
  const callbacks = useRef({ onTranscript, onNotice, transcribe });
  callbacks.current = { onTranscript, onNotice, transcribe };

  const set = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const quiet = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = undefined;
    levelRef.current = 0;
  }, []);

  const stop = useCallback(async () => {
    if (stateRef.current === "starting") {
      pendingRef.current.stop = true;
      return;
    }
    if (stateRef.current !== "listening") return;
    quiet();
    const capture = captureRef.current;
    const activity = activityRef.current;
    captureRef.current = null;
    activityRef.current = null;
    if (!capture) return set("idle");
    set("transcribing");
    const audio = await capture.finish();
    const heard = !capture.measurable || Boolean(activity?.heardSpeech);
    if (!heard || audio.size < MIN_RECORDING_BYTES) {
      set("idle");
      callbacks.current.onNotice?.(VOICE_NOTICES.nothing);
      return;
    }
    try {
      const text = await callbacks.current.transcribe(audio);
      set("idle");
      if (text) callbacks.current.onTranscript(text);
      else callbacks.current.onNotice?.(VOICE_NOTICES.unclear);
    } catch (error) {
      set("idle");
      callbacks.current.onNotice?.(humanizeError(error));
    }
  }, [quiet, set]);

  const cancel = useCallback(() => {
    runRef.current++;
    quiet();
    captureRef.current?.cancel();
    captureRef.current = null;
    activityRef.current = null;
    if (stateRef.current === "listening" || stateRef.current === "starting") set("idle");
  }, [quiet, set]);

  const start = useCallback(
    async (mode: ListenMode = "auto") => {
      if (stateRef.current !== "idle") return;
      const run = ++runRef.current;
      pendingRef.current = { hold: mode === "hold", stop: false };
      set("starting");
      stopSpeaking(); // never transcribe F.E.A.R. talking over you
      let capture: Capture;
      try {
        capture = await startCapture();
      } catch (error) {
        if (run === runRef.current) {
          set("idle");
          callbacks.current.onNotice?.(describeMicError(error));
        }
        return;
      }
      if (run !== runRef.current) {
        capture.cancel(); // cancelled while the microphone was opening
        return;
      }
      const activity = new SpeechActivity(pendingRef.current.hold ? "hold" : "auto");
      captureRef.current = capture;
      activityRef.current = activity;
      set("listening");
      if (pendingRef.current.stop) {
        void stop();
        return;
      }
      const began = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - began;
        if (!capture.measurable) {
          const limit = pendingRef.current.hold ? VOICE_TUNING.maxMs : UNMEASURED_MS;
          if (elapsed >= limit) void stop();
          return;
        }
        const rms = capture.level();
        levelRef.current = rms;
        const outcome = activity.update(elapsed, rms);
        if (outcome === "end") void stop();
        else if (outcome === "timeout") {
          cancel();
          callbacks.current.onNotice?.(VOICE_NOTICES.nothing);
        }
      }, TICK_MS);
    },
    [cancel, set, startCapture, stop],
  );

  const hold = useCallback(() => {
    pendingRef.current.hold = true;
    activityRef.current?.hold();
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  return { state, levelRef, start, stop, hold, cancel };
}

export type VoiceInput = ReturnType<typeof useVoiceInput>;
