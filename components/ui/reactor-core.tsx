"use client";

import { type RefObject, useEffect, useMemo, useRef } from "react";

import { isPageShown } from "@/lib/page-visibility";

/** What the core shows: who's talking, or what F.E.A.R. is doing. */
export type CoreMode =
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "paused"
  | "off"
  | "error";

// Cyan while it listens to you, amber when it's F.E.A.R. talking (its own
// colour, like the robot's core), slate when the microphone rests.
const TINT: Record<CoreMode, string> = {
  listening: "103 232 249",
  hearing: "103 232 249",
  transcribing: "125 211 252",
  thinking: "125 211 252",
  speaking: "248 184 48",
  paused: "120 132 150",
  off: "120 132 150",
  error: "251 113 133",
};

export const CORE_WORDS: Record<CoreMode, string> = {
  listening: "Ouvindo",
  hearing: "Ouvindo você",
  transcribing: "Entendendo",
  thinking: "Pensando",
  speaking: "Falando",
  paused: "Pausado",
  off: "Microfone desligado",
  error: "Falha",
};

const BARS = 72;
const TICKS = 72;
const BAR_FROM = 27; // radius where the voice bars start (viewBox units)

/**
 * F.E.A.R.'s reactor: concentric rings that turn while it's alive, and a crown
 * of bars that swells with whoever is talking — your voice in cyan, its own in
 * amber. Animated outside React (no re-render per frame), and idle when the
 * window can't be seen.
 */
export function ReactorCore({
  mode,
  inputLevel,
  outputLevel,
  label,
  pressed,
  onActivate,
}: {
  mode: CoreMode;
  /** Your microphone's loudness (RMS, 0–1), read every frame. */
  inputLevel: RefObject<number>;
  /** F.E.A.R.'s voice loudness (0 where it can't be measured). */
  outputLevel: () => number;
  label: string;
  pressed: boolean;
  onActivate: () => void;
}) {
  const bars = useRef<(SVGLineElement | null)[]>([]);
  const glow = useRef<SVGCircleElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Scattered phases (golden angle), so the crown ripples instead of pulsing as one.
  const phases = useMemo(() => Array.from({ length: BARS }, (_, i) => (i * 2.39996) % (2 * Math.PI)), []);

  useEffect(() => {
    let frame = 0;
    let level = 0;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (!isPageShown()) return;
      const current = modeRef.current;
      const t = now / 1000;
      let target = 0;
      if (current === "speaking") {
        const measured = outputLevel();
        // The browser's own voice can't be measured: a speaking rhythm instead.
        target =
          measured > 0.002
            ? Math.min(1, measured * 5)
            : 0.35 + 0.3 * Math.abs(Math.sin(t * 7.1)) * Math.abs(Math.sin(t * 2.3 + 1));
      } else if (current === "hearing" || current === "listening") {
        target = Math.min(1, (inputLevel.current ?? 0) * 9);
      } else if (current === "thinking" || current === "transcribing") {
        target = 0.14 + 0.08 * Math.sin(t * 3.2);
      }
      level += (target - level) * (target > level ? 0.35 : 0.08); // quick to rise, slow to fall
      for (let i = 0; i < BARS; i++) {
        const bar = bars.current[i];
        if (!bar) continue;
        const ripple = reduced ? 0.7 : 0.55 + 0.45 * Math.sin(t * 6 + phases[i] * 3);
        bar.setAttribute("y2", String(-BAR_FROM - 1.2 - level * 11 * ripple));
        bar.setAttribute("stroke-opacity", String(0.22 + level * 0.78));
      }
      if (glow.current) {
        glow.current.setAttribute("r", String(21 + level * 7));
        glow.current.setAttribute("opacity", String(0.4 + level * 0.6));
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [inputLevel, outputLevel, phases]);

  const busy = mode === "thinking" || mode === "transcribing";
  const resting = mode === "paused" || mode === "off";
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      style={{ ["--core" as string]: TINT[mode] }}
      className="tap group relative grid aspect-square w-full place-items-center rounded-full outline-none transition-[filter] duration-500 focus-visible:ring-2 focus-visible:ring-cyan-300/60"
    >
      <svg viewBox="-50 -50 100 100" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <defs>
          <radialGradient id="fear-core-glow">
            <stop offset="0%" stopColor="rgb(var(--core))" stopOpacity="0.55" />
            <stop offset="55%" stopColor="rgb(var(--core))" stopOpacity="0.14" />
            <stop offset="100%" stopColor="rgb(var(--core))" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* The outer dial: fine ticks, a long one every 30°, turning slowly. */}
        <g
          className={`${resting ? "" : "animate-[spin_90s_linear_infinite]"} motion-reduce:animate-none`}
          style={{ transformOrigin: "0px 0px" }}
        >
          {Array.from({ length: TICKS }, (_, i) => (
            <line
              key={i}
              x1={0}
              y1={-48}
              x2={0}
              y2={i % 6 === 0 ? -44.5 : -46.6}
              transform={`rotate(${(i * 360) / TICKS})`}
              stroke="rgb(var(--core))"
              strokeOpacity={i % 6 === 0 ? 0.55 : 0.22}
              strokeWidth={i % 6 === 0 ? 0.5 : 0.3}
            />
          ))}
        </g>

        {/* Arc segments turning the other way. */}
        <g
          className={`${resting ? "" : "animate-[spin_40s_linear_infinite_reverse]"} motion-reduce:animate-none`}
          style={{ transformOrigin: "0px 0px" }}
        >
          <circle
            r={42}
            fill="none"
            stroke="rgb(var(--core))"
            strokeOpacity={0.5}
            strokeWidth={0.7}
            strokeDasharray="38 6 12 6 22 6 30 8 20 6"
          />
          <circle r={40.2} fill="none" stroke="rgb(var(--core))" strokeOpacity={0.12} strokeWidth={0.3} />
        </g>

        {/* Thinking: a bright arc racing around. */}
        <g
          className={`${busy ? "animate-[spin_1.6s_linear_infinite]" : ""} motion-reduce:animate-none`}
          style={{ transformOrigin: "0px 0px" }}
        >
          <circle
            r={37}
            fill="none"
            stroke="rgb(var(--core))"
            strokeOpacity={busy ? 0.9 : 0.18}
            strokeWidth={busy ? 1.1 : 0.4}
            strokeLinecap="round"
            strokeDasharray={busy ? "26 206" : "2 4"}
          />
        </g>

        {/* The voice: a crown of bars that swells with whoever is talking. */}
        <g>
          {Array.from({ length: BARS }, (_, i) => (
            <line
              key={i}
              ref={(element) => {
                bars.current[i] = element;
              }}
              x1={0}
              y1={-BAR_FROM}
              x2={0}
              y2={-BAR_FROM - 1.2}
              transform={`rotate(${(i * 360) / BARS})`}
              stroke="rgb(var(--core))"
              strokeOpacity={0.22}
              strokeWidth={0.9}
              strokeLinecap="round"
            />
          ))}
        </g>

        {/* The core itself. */}
        <circle ref={glow} r={21} fill="url(#fear-core-glow)" opacity={0.4} />
        <circle
          r={17.5}
          fill="rgb(4 8 14 / 0.85)"
          stroke="rgb(var(--core))"
          strokeOpacity={0.6}
          strokeWidth={0.6}
        />
        <circle r={15.2} fill="none" stroke="rgb(var(--core))" strokeOpacity={0.25} strokeWidth={0.25} />
      </svg>

      <span className="pointer-events-none relative flex flex-col items-center gap-1 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.42em] text-white/45">F.E.A.R.</span>
        <span
          className="max-w-[9rem] font-mono text-[11px] uppercase leading-4 tracking-[0.22em] transition-colors duration-500"
          style={{ color: "rgb(var(--core))" }}
        >
          {CORE_WORDS[mode]}
        </span>
      </span>
    </button>
  );
}
