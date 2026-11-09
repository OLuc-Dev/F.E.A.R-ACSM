import { useEffect, useRef, useState } from "react";

import { describeGestureError } from "@/lib/use-hand-gestures";
import { isPageShown, onPageShownChange } from "@/lib/page-visibility";
import { type PresenceEvent, type PresenceState, PresenceWatcher } from "@/lib/presence";
import type { PresenceTracker, PresenceTrackerFactory } from "@/lib/presence-tracker";

export type PresenceStatus = "off" | "starting" | "watching" | "paused" | "error";

const loadTracker: PresenceTrackerFactory = async (onGlance) => {
  const { createPresenceTracker } = await import("@/lib/presence-tracker");
  return createPresenceTracker(onGlance);
};

/**
 * Notices you sitting down at the computer and leaving it, while `enabled` —
 * and, like gestures, only while the window is on screen: hidden, the camera
 * is off.
 */
export function usePresence({
  enabled,
  onEvent,
  createTracker = loadTracker,
  watcher,
}: {
  enabled: boolean;
  onEvent: (event: PresenceEvent) => void;
  /** Injected in tests; defaults to the MediaPipe face detector. */
  createTracker?: PresenceTrackerFactory;
  watcher?: PresenceWatcher;
}) {
  const [status, setStatus] = useState<PresenceStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<PresenceState>("unknown");

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const watcherRef = useRef(watcher ?? new PresenceWatcher());
  const trackerRef = useRef<Promise<PresenceTracker> | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      setError(null);
      setState("unknown");
      return;
    }
    const watch = watcherRef.current;
    const glance = (t: number, face: boolean) => {
      const event = watch.update(t, face);
      setState(watch.state);
      if (event) onEventRef.current(event);
    };
    trackerRef.current ??= createTracker(glance);
    const tracker = trackerRef.current;

    const pause = () => {
      runRef.current++;
      void tracker.then(
        (ready) => ready.stop(),
        () => {},
      );
      watch.reset();
      setState("unknown");
    };
    const resume = async () => {
      const run = ++runRef.current;
      setStatus("starting");
      setError(null);
      try {
        const ready = await tracker;
        if (run !== runRef.current) return;
        await ready.start();
        if (run !== runRef.current) {
          ready.stop();
          return;
        }
        setStatus("watching");
      } catch (failure) {
        if (run !== runRef.current) return;
        // The camera failed: turn it back off. The model failed: try loading it again next time.
        void tracker.then(
          (ready) => ready.stop(),
          () => {
            if (trackerRef.current === tracker) trackerRef.current = null;
          },
        );
        setError(describeGestureError(failure).replace("reconhecimento de mãos", "detector de presença"));
        setStatus("error");
      }
    };
    const sync = () => {
      if (isPageShown()) void resume();
      else {
        pause();
        setStatus("paused");
      }
    };
    sync();
    const stopWatching = onPageShownChange(sync);
    return () => {
      stopWatching();
      pause();
    };
  }, [enabled, createTracker]);

  // Free the model when the page goes away.
  useEffect(
    () => () => {
      runRef.current++;
      void trackerRef.current?.then(
        (ready) => ready.close(),
        () => {},
      );
      trackerRef.current = null;
    },
    [],
  );

  return { status, error, state };
}
