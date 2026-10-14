"use client";

import { useEffect, useRef } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";

import type { ContinuousListening, ListeningState } from "@/lib/use-continuous-listening";

export const PAUSED_LABEL = "Microfone pausado — clique para voltar a ouvir";

/** What the microphone is doing, as its button says it. */
export const LISTENING_LABELS: Record<ListeningState, string> = {
  off: "Microfone desligado — clique para ligar",
  starting: "Ligando o microfone…",
  listening: "Ouvindo — é só falar (clique para pausar)",
  hearing: "Ouvindo você…",
  transcribing: "Entendendo o que você disse",
  waiting: "Volto a ouvir assim que terminar de responder",
  blocked: "Clique para eu começar a ouvir",
};

/**
 * The microphone when F.E.A.R. is always listening: it shows what it's doing
 * (listening, hearing you, understanding, answering) and a click pauses it,
 * or brings it back.
 */
export function ListeningButton({
  listening,
  paused,
  onToggle,
}: {
  listening: ContinuousListening;
  /** Paused by the person (this session). */
  paused: boolean;
  onToggle: () => void;
}) {
  const ring = useRef<HTMLSpanElement>(null);
  const { state, levelRef } = listening;
  const live = !paused && (state === "listening" || state === "hearing");

  // The ring breathes with the room and swells with your voice.
  useEffect(() => {
    if (!live) return;
    let frame = 0;
    const draw = () => {
      const loudness = Math.min(1, levelRef.current * 10);
      if (ring.current) {
        ring.current.style.transform = `scale(${1 + loudness * 0.55})`;
        ring.current.style.opacity = String(0.3 + loudness * 0.6);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [live, levelRef]);

  const label = paused ? PAUSED_LABEL : LISTENING_LABELS[state];
  const quiet = paused || state === "off" || state === "blocked";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={!paused}
      title={label}
      className={`tap relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition ${
        quiet
          ? "border-overlay/15 bg-overlay/[0.06] text-muted-foreground hover:bg-overlay/[0.12] hover:text-foreground"
          : state === "waiting" || state === "starting"
            ? "border-brand/25 bg-brand/[0.06] text-brand/60"
            : "border-brand/50 bg-brand/15 text-brand"
      }`}
    >
      {live && (
        <span
          ref={ring}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl border-2 border-brand/70 transition-transform duration-75"
        />
      )}
      {state === "transcribing" && !paused ? (
        <Loader2 className="size-4 animate-spin" />
      ) : quiet ? (
        <MicOff className="size-4" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  );
}
