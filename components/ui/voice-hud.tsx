"use client";

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Hand, KeyRound, Settings, Sparkles, UserRound } from "lucide-react";

import { HudPanel } from "@/components/ui/hud-panel";
import { type CoreMode, ReactorCore } from "@/components/ui/reactor-core";

/** One line of the system readout. */
export interface HudReading {
  label: string;
  value: string;
  on: boolean;
}

// After F.E.A.R. stops answering, the subtitles stay this long, then fade.
export const CAPTION_LINGER_MS = 7000;

/**
 * What's on screen as subtitles: the last thing you said, and the sentence
 * F.E.A.R. is saying right now — no history, no log. A new question clears the
 * old answer; once it has gone quiet, both fade after a few seconds.
 */
export function useHudCaptions({
  heard,
  heardId,
  saying,
  notice,
  quiet,
}: {
  /** Your last words, and an id that changes with each thing you say. */
  heard: string;
  heardId: number;
  /** The sentence F.E.A.R. is saying ("" when it isn't). */
  saying: string;
  /** Something F.E.A.R. couldn't say out loud (an error), shown instead. */
  notice: string;
  /** Nothing is being said or answered right now. */
  quiet: boolean;
}) {
  const [you, setYou] = useState<string | null>(null);
  const [fear, setFear] = useState<string | null>(null);

  useEffect(() => {
    if (!heardId) return;
    setYou(heard);
    setFear(null);
  }, [heardId, heard]);

  useEffect(() => {
    const line = saying || notice;
    if (line) setFear(line);
  }, [saying, notice]);

  useEffect(() => {
    if (!quiet || (!you && !fear)) return;
    const timer = setTimeout(() => {
      setYou(null);
      setFear(null);
    }, CAPTION_LINGER_MS);
    return () => clearTimeout(timer);
  }, [quiet, you, fear]);

  return { you, fear };
}

// Scrolls the subtitles to the end of the newest line, and says whether
// anything is cut off above. A line fading out is lifted out of the flow
// (position: absolute) and doesn't count.
function showNewest(box: HTMLElement): boolean {
  let bottom = 0;
  for (const line of Array.from(box.children) as HTMLElement[]) {
    if (getComputedStyle(line).position === "absolute") continue;
    bottom = Math.max(bottom, line.offsetTop + line.offsetHeight);
  }
  box.scrollTop = Math.max(0, bottom - box.clientHeight);
  return box.scrollTop > 0;
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function HudButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="tap grid size-9 place-items-center rounded-full border border-cyan-300/15 bg-cyan-300/[0.04] text-cyan-100/70 transition hover:border-cyan-300/35 hover:text-cyan-50"
    >
      {children}
    </button>
  );
}

/**
 * F.E.A.R. as a voice: the conversation is spoken, not written. The reactor in
 * the middle is the microphone and F.E.A.R.'s voice at once; the subtitles show
 * only what's being said now; around them, the readouts and the presence.
 */
export function VoiceHud({
  mode,
  coreLabel,
  corePressed,
  onCore,
  inputLevel,
  outputLevel,
  hint,
  notice,
  you,
  fear,
  readings,
  backendOnline,
  userName,
  hasKey,
  onAddKey,
  onAccount,
  onSettings,
  update,
  presence,
  gestures,
  onGestures,
}: {
  mode: CoreMode;
  coreLabel: string;
  corePressed: boolean;
  onCore: () => void;
  inputLevel: RefObject<number>;
  outputLevel: () => number;
  /** A short line under the core: what to do now. */
  hint: string;
  /** A voice problem worth saying (it replaces the hint for a while). */
  notice: string | null;
  you: string | null;
  fear: string | null;
  readings: HudReading[];
  backendOnline: boolean | null;
  userName: string;
  hasKey: boolean;
  onAddKey: () => void;
  onAccount: () => void;
  onSettings: () => void;
  update?: { version: string; url: string } | null;
  presence?: ReactNode;
  /** The hand-gesture camera, while it's on. */
  gestures?: ReactNode;
  /** Turns the gestures on: offered where their camera would be, while they're off. */
  onGestures?: () => void;
}) {
  const now = useClock();
  const time = now ? now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "--:--";
  const date = now ? now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }) : "";
  const online = backendOnline === null ? "verificando" : backendOnline ? "online" : "offline";

  // A long answer never pushes the page: the subtitles keep their height and
  // show the newest words, fading out what no longer fits above them.
  const captionsRef = useRef<HTMLDivElement>(null);
  const [captionsClipped, setCaptionsClipped] = useState(false);
  useEffect(() => {
    if (captionsRef.current) setCaptionsClipped(showNewest(captionsRef.current));
  }, [you, fear]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#03060a] text-cyan-50">
      {/* The room: a cold glow behind the core, a faint grid, darker edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(55%_48%_at_50%_44%,rgba(34,211,238,0.11),transparent_70%),linear-gradient(rgba(103,232,249,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(103,232,249,0.035)_1px,transparent_1px)] [background-size:100%_100%,46px_46px,46px_46px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(120%_90%_at_50%_45%,transparent_55%,rgba(0,0,0,0.75))]"
      />

      <div className="relative mx-auto flex min-h-screen max-w-[1500px] flex-col px-5 pb-24 pt-4 lg:px-8">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={`size-2.5 rounded-full ${backendOnline ? "bg-cyan-300 shadow-[0_0_10px_2px_rgba(103,232,249,0.7)]" : backendOnline === false ? "bg-rose-400" : "bg-white/25"}`}
            />
            <div>
              <h1 className="font-mono text-sm font-semibold tracking-[0.38em] text-cyan-50">F.E.A.R.</h1>
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-200/45">
                sistema {online}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="font-mono text-lg leading-5 tracking-[0.12em] text-cyan-50/90">{time}</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-200/45">{date}</p>
            </div>
            <button
              type="button"
              onClick={onAccount}
              className="tap flex h-9 items-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-300/[0.04] px-3 text-[12px] text-cyan-100/75 transition hover:border-cyan-300/35 hover:text-cyan-50"
            >
              <UserRound className="size-3.5" />
              <span className="max-w-[8rem] truncate">{userName}</span>
            </button>
            <HudButton label="Configurações" onClick={onSettings}>
              <Settings className="size-4" />
            </HudButton>
          </div>
        </header>

        {/* Alerts, HUD-style */}
        <div className="mt-4 flex flex-col items-center gap-2">
          {!hasKey && (
            <button
              type="button"
              onClick={onAddKey}
              className="tap flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-300/[0.07] px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-amber-100/85 transition hover:border-amber-300/55"
            >
              <KeyRound className="size-3.5" /> Sem chave do OpenRouter · adicionar
            </button>
          )}
          {update && (
            <a
              href={update.url}
              target="_blank"
              rel="noreferrer"
              className="tap flex items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-300/[0.06] px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-100/85"
            >
              <Sparkles className="size-3.5" /> Versão {update.version} disponível
            </a>
          )}
        </div>

        {/* The deck: readouts · the core · the presence */}
        <div className="grid flex-1 items-center gap-6 py-4 lg:grid-cols-[250px_minmax(0,1fr)_290px]">
          {/* Readouts on the left; on a narrow window only the gesture camera
              stays, floating in the corner (it must never be on unseen). */}
          <div className="fixed left-4 top-[4.5rem] z-30 flex w-[200px] flex-col gap-4 lg:static lg:z-auto lg:w-auto lg:self-center">
            <HudPanel title="Sistema" className="hidden lg:block">
              <ul className="space-y-1.5">
                {readings.map((reading) => (
                  <li key={reading.label} className="flex items-center gap-2 font-mono text-[11px]">
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${reading.on ? "bg-cyan-300 shadow-[0_0_6px_1px_rgba(103,232,249,0.6)]" : "bg-white/20"}`}
                    />
                    <span className="uppercase tracking-[0.16em] text-cyan-100/70">{reading.label}</span>
                    <span className={`ml-auto truncate ${reading.on ? "text-cyan-200/80" : "text-white/30"}`}>
                      {reading.value}
                    </span>
                  </li>
                ))}
              </ul>
            </HudPanel>
            {gestures ??
              (onGestures && (
                <button
                  type="button"
                  onClick={onGestures}
                  className="tap group hidden items-center gap-3 rounded-lg border border-dashed border-cyan-300/20 bg-cyan-300/[0.03] px-3.5 py-3 text-left transition hover:border-cyan-300/45 hover:bg-cyan-300/[0.06] lg:flex"
                >
                  <Hand className="size-4 shrink-0 text-cyan-200/60 transition group-hover:text-cyan-100" />
                  <span>
                    <span className="block font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-100/75">
                      Gestos com as mãos
                    </span>
                    <span className="block text-[11px] text-white/40">
                      desligados · clique para ligar a câmera
                    </span>
                  </span>
                </button>
              ))}
          </div>

          <div className="flex flex-col items-center justify-center gap-5">
            <div className="w-[min(34rem,52vh,78vw,calc(100vh-27rem))]">
              <ReactorCore
                mode={mode}
                inputLevel={inputLevel}
                outputLevel={outputLevel}
                label={coreLabel}
                pressed={corePressed}
                onActivate={onCore}
              />
            </div>
            <p
              role="status"
              aria-live="polite"
              className={`text-center font-mono text-[11px] uppercase tracking-[0.24em] ${notice ? "text-amber-200/85" : "text-cyan-200/45"}`}
            >
              {notice ?? hint}
            </p>

            {/* Subtitles: only what's being said now. */}
            <div
              ref={captionsRef}
              aria-live="polite"
              className={`relative flex h-[8.5rem] w-full max-w-3xl flex-col items-center gap-3 overflow-hidden text-center ${captionsClipped ? "[-webkit-mask-image:linear-gradient(to_bottom,transparent,#000_2.5rem)] [mask-image:linear-gradient(to_bottom,transparent,#000_2.5rem)]" : ""}`}
            >
              <AnimatePresence mode="popLayout">
                {you && (
                  <motion.div
                    key={`you-${you}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.35 }}
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-cyan-300/55">Você</p>
                    <p className="mt-1 text-[15px] leading-6 text-cyan-50/75">{you}</p>
                  </motion.div>
                )}
                {fear && (
                  <motion.div
                    key={`fear-${fear}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.35 }}
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-amber-300/70">
                      F.E.A.R.
                    </p>
                    <p className="mt-1 text-xl font-light leading-8 text-white/90">{fear}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="hidden self-center lg:block">
            {presence && (
              <HudPanel title="Presença">
                <div className="px-3.5 pb-3.5">
                  <div className="relative h-[46vh] max-h-[440px] min-h-[260px] overflow-hidden rounded-md bg-[#02050a]">
                    {presence}
                  </div>
                </div>
              </HudPanel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
