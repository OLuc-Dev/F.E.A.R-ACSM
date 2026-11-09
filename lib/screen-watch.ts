import { useEffect, useRef } from "react";

// F.E.A.R. looking at the screen: off; "ask", the screen goes along with what
// you ask; "watch", it also glances by itself and speaks up when it's worth it.
export type ScreenMode = "off" | "ask" | "watch";

const MODE_KEY = "fear.screen";
// How often the commentator glances. Each glance keeps the graphics card busy
// for a few seconds, so not more often than this.
export const GLANCE_EVERY_MS = 20_000;

export const SCREEN_MODE_LABEL: Record<ScreenMode, string> = {
  off: "desligada",
  ask: "quando você pergunta",
  watch: "comentando",
};

/** Off, ask, watch, and around again (the dock button). */
export function nextScreenMode(mode: ScreenMode): ScreenMode {
  return mode === "off" ? "ask" : mode === "ask" ? "watch" : "off";
}

export function loadScreenMode(): ScreenMode {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    return saved === "ask" || saved === "watch" ? saved : "off";
  } catch {
    return "off";
  }
}

export function saveScreenMode(mode: ScreenMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}

/**
 * The commentator: every so often, while `active`, a glance at the screen;
 * a remark worth saying comes back through `onRemark`. It waits its turn —
 * never while `hold` (F.E.A.R. answering or talking, you talking) — and one
 * glance at a time.
 */
export function useScreenCommentator({
  active,
  hold,
  glance,
  onRemark,
  everyMs = GLANCE_EVERY_MS,
}: {
  active: boolean;
  hold: boolean;
  glance: (signal: AbortSignal) => Promise<string>;
  onRemark: (remark: string) => void;
  everyMs?: number;
}) {
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const callbacks = useRef({ glance, onRemark });
  callbacks.current = { glance, onRemark };

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!holdRef.current) {
        try {
          const remark = (await callbacks.current.glance(controller.signal)).trim();
          // Something else started meanwhile: a remark now would talk over it.
          if (remark && !holdRef.current && !controller.signal.aborted) callbacks.current.onRemark(remark);
        } catch {
          // No model that sees, the screen unavailable: try again next time.
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, everyMs);
    };
    timer = setTimeout(tick, everyMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, everyMs]);
}
