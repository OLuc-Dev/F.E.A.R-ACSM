import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { type GestureCommand, GestureInterpreter, type HandPose } from "@/lib/hand-gestures";
import type { HandTracker, HandTrackerFactory } from "@/lib/hand-tracker";

export type GestureStatus = "off" | "starting" | "watching" | "paused" | "error";

const PREFERENCE_KEY = "fear.gestures";

/** Whether the person left gestures on last time (they start off by default). */
export function loadGesturePreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveGesturePreference(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(PREFERENCE_KEY, "on");
    else window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Storage unavailable: the choice just lasts for this session.
  }
}

/** Plain-language reason a camera or model failure stopped gestures. */
export function describeGestureError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Sem permissão para usar a câmera. Libere o acesso nas configurações de privacidade do Windows.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhuma câmera encontrada.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "A câmera está em uso por outro programa.";
  }
  return "Não consegui carregar o reconhecimento de mãos.";
}

const loadTracker: HandTrackerFactory = async (onFrame) => {
  const { createHandTracker } = await import("@/lib/hand-tracker");
  return createHandTracker(onFrame);
};

interface Options {
  enabled: boolean;
  onCommand: (command: GestureCommand) => void;
  videoRef: RefObject<HTMLVideoElement>;
  canvasRef?: RefObject<HTMLCanvasElement>;
  /** Injected in tests; defaults to the MediaPipe tracker. */
  createTracker?: HandTrackerFactory;
}

/**
 * Watches the camera for hand gestures while `enabled` — and only while this
 * window is visible: hiding it (tray, minimize, another tab) turns the camera
 * off, so it never watches a room nobody is looking at the app from.
 */
export function useHandGestures({
  enabled,
  onCommand,
  videoRef,
  canvasRef,
  createTracker = loadTracker,
}: Options) {
  const [status, setStatus] = useState<GestureStatus>("off");
  const [error, setError] = useState<string | null>(null);
  // The pose on screen right now (null: no hand), for the panel's live label.
  const [pose, setPose] = useState<HandPose | null>(null);

  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const trackerRef = useRef<HandTracker | null>(null);
  const trackerPromiseRef = useRef<Promise<HandTracker> | null>(null);
  const interpreterRef = useRef(new GestureInterpreter());
  const poseRef = useRef<HandPose | null>(null);
  // Bumped on every stop: an in-flight start that finds it changed backs out.
  const runRef = useRef(0);

  const onFrame = useCallback((t: number, hand: Parameters<GestureInterpreter["update"]>[1]) => {
    const command = interpreterRef.current.update(t, hand);
    const next = hand?.pose ?? null;
    if (next !== poseRef.current) {
      poseRef.current = next;
      setPose(next);
    }
    if (command) onCommandRef.current(command);
  }, []);

  const tracker = useCallback(() => {
    trackerPromiseRef.current ??= createTracker(onFrame).then((created) => {
      trackerRef.current = created;
      return created;
    });
    return trackerPromiseRef.current;
  }, [createTracker, onFrame]);

  const pause = useCallback(() => {
    runRef.current++;
    trackerRef.current?.stop();
    interpreterRef.current.reset();
    poseRef.current = null;
    setPose(null);
  }, []);

  const resume = useCallback(async () => {
    const run = ++runRef.current;
    setStatus("starting");
    setError(null);
    try {
      const ready = await tracker();
      if (run !== runRef.current || !videoRef.current) return;
      await ready.start(videoRef.current, canvasRef?.current);
      if (run !== runRef.current) {
        ready.stop(); // turned off while the camera was opening
        return;
      }
      setStatus("watching");
    } catch (failure) {
      if (run !== runRef.current) return;
      trackerRef.current?.stop();
      // A model that failed to load is retried on the next attempt.
      if (!trackerRef.current) trackerPromiseRef.current = null;
      setError(describeGestureError(failure));
      setStatus("error");
    }
  }, [tracker, videoRef, canvasRef]);

  useEffect(() => {
    if (!enabled) {
      pause();
      setStatus("off");
      setError(null);
      return;
    }
    const sync = () => {
      if (document.visibilityState === "visible") void resume();
      else {
        pause();
        setStatus("paused");
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      pause();
    };
  }, [enabled, pause, resume]);

  // Free the model when the page goes away.
  useEffect(
    () => () => {
      runRef.current++;
      trackerRef.current?.close();
      trackerRef.current = null;
      trackerPromiseRef.current = null;
    },
    [],
  );

  return { status, error, pose };
}
