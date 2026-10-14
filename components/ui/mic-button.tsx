"use client";

import { useEffect, useRef } from "react";
import { Loader2, Mic } from "lucide-react";

import type { VoiceInput } from "@/lib/use-voice-input";

// Pressed longer than this, it's hold-to-talk: recording ends when let go.
const HOLD_MS = 400;

/**
 * Talk to F.E.A.R. Click: it listens until you stop talking. Press and hold:
 * it records until you let go. Click again while listening to send right away.
 */
export function MicButton({ voice, disabled = false }: { voice: VoiceInput; disabled?: boolean }) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holding = useRef(false);
  const ring = useRef<HTMLSpanElement>(null);
  const active = voice.state === "starting" || voice.state === "listening";

  // The ring follows your voice's loudness, frame by frame, without re-rendering.
  useEffect(() => {
    if (voice.state !== "listening") return;
    let frame = 0;
    const draw = () => {
      const loudness = Math.min(1, voice.levelRef.current * 10);
      if (ring.current) {
        ring.current.style.transform = `scale(${1 + loudness * 0.55})`;
        ring.current.style.opacity = String(0.25 + loudness * 0.6);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [voice.state, voice.levelRef]);

  useEffect(() => () => clearTimeout(holdTimer.current), []);

  function press() {
    if (disabled) return;
    if (active) {
      void voice.stop();
      return;
    }
    if (voice.state !== "idle") return;
    void voice.start("auto");
    holding.current = false;
    holdTimer.current = setTimeout(() => {
      holding.current = true;
      voice.hold();
    }, HOLD_MS);
  }

  function release() {
    clearTimeout(holdTimer.current);
    if (holding.current) {
      holding.current = false;
      void voice.stop();
    }
  }

  const label =
    voice.state === "transcribing"
      ? "Entendendo o que você disse"
      : active
        ? "Ouvindo — clique para enviar"
        : "Falar com o F.E.A.R. (clique, ou segure para falar)";

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        event.preventDefault();
        press();
      }}
      onPointerUp={release}
      onPointerLeave={release}
      // The keyboard works like the pointer: tap to talk, or hold the key while
      // talking. A held key repeats, but that's still one press.
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!event.repeat) press();
      }}
      onKeyUp={(event) => {
        if (event.key === "Enter" || event.key === " ") release();
      }}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`tap relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "border-brand/50 bg-brand/15 text-brand"
          : "border-overlay/15 bg-overlay/[0.06] text-muted-foreground hover:bg-overlay/[0.12] hover:text-foreground"
      }`}
    >
      {voice.state === "listening" && (
        <span
          ref={ring}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl border-2 border-brand/70 transition-transform duration-75"
        />
      )}
      {voice.state === "transcribing" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  );
}
