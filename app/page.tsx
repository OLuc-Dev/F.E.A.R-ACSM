"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  BookOpen,
  Brain,
  Cpu,
  Crosshair,
  Database,
  Loader2,
  Mic,
  Music,
  RotateCcw,
  Send,
  Settings,
  Split,
  Swords,
  User,
  Wifi,
  WifiOff,
} from "lucide-react";

import MacOSDock, { type DockApp } from "@/components/ui/mac-os-dock";
import { AssistantMessage, SystemMessage, UserMessage } from "@/components/ui/messages";
import { SettingsPanel } from "@/components/ui/settings-panel";
import { getStatus, type StatusResponse } from "@/lib/api";
import { fade, springSnappy, springSoft } from "@/lib/motion";
import { type Status, useConversation } from "@/lib/use-conversation";

const FearPresence = dynamic(
  () => import("@/components/ui/fear-presence").then((module) => module.FearPresence),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
        carregando presença…
      </div>
    ),
  },
);

const fearApps: DockApp[] = [
  { id: "voice", name: "Voz", icon: <Mic className="h-full w-full text-cyan-200" /> },
  { id: "memory", name: "Memória", icon: <Brain className="h-full w-full text-violet-200" /> },
  { id: "spotify", name: "Spotify", icon: <Music className="h-full w-full text-emerald-200" /> },
  { id: "obsidian", name: "Obsidian", icon: <BookOpen className="h-full w-full text-blue-200" /> },
  { id: "config", name: "Configuração", icon: <Settings className="h-full w-full text-slate-200" /> },
  { id: "reset", name: "Nova conversa", icon: <RotateCcw className="h-full w-full text-rose-200" /> },
];

const STATUS_LABEL: Record<Status, string> = {
  online: "pronto",
  listening: "ouvindo",
  thinking: "pensando",
  speaking: "respondendo",
  error: "atenção",
};

// Idle/listening = cyan; speaking = white/cyan; thinking = controlled red; error = strong red.
const STATUS_ORB: Record<Status, string> = {
  online: "bg-cyan-400 shadow-[0_0_14px_3px_rgba(34,211,238,0.45)]",
  listening: "bg-sky-300 shadow-[0_0_16px_4px_rgba(56,189,248,0.5)] animate-pulse",
  thinking: "bg-rose-400/70 shadow-[0_0_14px_3px_rgba(251,113,133,0.4)] animate-pulse",
  speaking: "bg-white shadow-[0_0_20px_6px_rgba(186,230,253,0.7)] animate-pulse",
  error: "bg-rose-500 shadow-[0_0_18px_5px_rgba(244,63,94,0.7)]",
};

// Strategic openers that show off the council; clicking one sends it immediately.
const SUGGESTIONS: { icon: ReactNode; text: string }[] = [
  { icon: <Crosshair className="size-3.5" />, text: "Critique minha ideia sem dó." },
  { icon: <AlertTriangle className="size-3.5" />, text: "Quais riscos eu não estou enxergando?" },
  { icon: <Split className="size-3.5" />, text: "Me ajude a decidir entre dois caminhos." },
  { icon: <Swords className="size-3.5" />, text: "Desafie minha suposição mais forte." },
];

const chipsContainer = {
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
} satisfies Variants;
const chipItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
} satisfies Variants;

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-background" />
      <div className="bg-grid absolute inset-0 opacity-70" />
      <div className="absolute -left-44 -top-44 h-[34rem] w-[34rem] rounded-full bg-cyan-500/10 blur-[120px]" />
      <div className="absolute -right-40 top-4 h-[30rem] w-[30rem] rounded-full bg-violet-600/10 blur-[130px]" />
      <div className="absolute -bottom-40 left-1/3 h-[26rem] w-[26rem] rounded-full bg-rose-600/[0.07] blur-[130px]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.6))]" />
    </div>
  );
}

function StatusOrb({ status }: { status: Status }) {
  return (
    <span className="relative grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
      <span aria-hidden className={`size-2.5 rounded-full transition-colors ${STATUS_ORB[status]}`} />
    </span>
  );
}

function SystemRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: "ok" | "muted" | "off";
}) {
  const dot =
    tone === "ok"
      ? "bg-cyan-300 shadow-[0_0_8px_1px_rgba(34,211,238,0.6)]"
      : tone === "off"
        ? "bg-rose-400/70"
        : "bg-white/20";
  return (
    <div className="flex items-center justify-between rounded-lg px-2 py-2 transition hover:bg-white/[0.025]">
      <span className="flex items-center gap-2.5 text-[13px] text-foreground/70">
        <span className="grid size-7 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
          {icon}
        </span>
        {label}
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={`size-1.5 rounded-full ${dot}`} />
        {value}
      </span>
    </div>
  );
}

// Map a backend status flag to a row's label + tone (cyan when on, grey otherwise).
function flag(on: boolean | undefined, onLabel: string): { value: string; tone: "ok" | "muted" } {
  if (on === undefined) return { value: "—", tone: "muted" };
  return on ? { value: onLabel, tone: "ok" } : { value: "inativo", tone: "muted" };
}

function WelcomeScreen({ onPick, busy }: { onPick: (prompt: string) => void; busy: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
      <div className="relative grid size-24 place-items-center">
        <div className="absolute inset-0 rounded-full bg-cyan-400/10 blur-2xl" />
        <motion.div
          className="absolute inset-0 rounded-full border border-dashed border-cyan-300/25"
          animate={{ rotate: 360 }}
          transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
        />
        <div className="absolute inset-3 rounded-full border border-white/10" />
        <motion.span
          className="size-3 rounded-full bg-cyan-300 shadow-[0_0_22px_5px_rgba(34,211,238,0.75)]"
          animate={{ opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <h2 className="mt-7 text-xl font-medium tracking-[-0.01em] text-foreground">Presença ativa.</h2>
      <p className="mt-2 max-w-sm text-pretty text-sm leading-6 text-muted-foreground">
        Diga o próximo movimento. Eu encontro as rachaduras antes que elas te encontrem.
      </p>

      <motion.div
        className="mt-8 grid w-full max-w-md gap-2 sm:grid-cols-2"
        variants={chipsContainer}
        initial="hidden"
        animate="show"
      >
        {SUGGESTIONS.map((suggestion) => (
          <motion.button
            key={suggestion.text}
            type="button"
            variants={chipItem}
            onClick={() => onPick(suggestion.text)}
            disabled={busy}
            className="tap group flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.025] px-3.5 py-2.5 text-left text-[13px] leading-5 text-foreground/80 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-cyan-300/70 transition group-hover:text-cyan-300">{suggestion.icon}</span>
            <span>{suggestion.text}</span>
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}

export default function HomePage() {
  const [speaker, setSpeaker] = useState("Lucas");
  const [text, setText] = useState("");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [systemStatus, setSystemStatus] = useState<StatusResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modKey, setModKey] = useState("⌘");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages,
    status,
    isBusy,
    threadRef,
    atBottom,
    handleThreadScroll,
    scrollToLatest,
    send,
    handleAppAction,
  } = useConversation();

  // Show the right modifier hint per platform (avoids a hydration mismatch by
  // starting from a stable default and correcting after mount).
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    if (!isMac) setModKey("Ctrl");
  }, []);

  // macOS-style shortcuts: ⌘K focuses the composer, ⌘, toggles settings.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!settingsOpen) composerRef.current?.focus();
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    let active = true;
    getStatus()
      .then((data) => {
        if (active) {
          setSystemStatus(data);
          setBackendOnline(true);
        }
      })
      .catch(() => {
        if (active) setBackendOnline(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy || !text.trim()) return;
    const value = text;
    setText("");
    // Collapse the auto-grown composer back to one line after sending.
    if (composerRef.current) composerRef.current.style.height = "auto";
    void send(value, speaker);
  }

  const backendTone = backendOnline === null ? "muted" : backendOnline ? "ok" : "off";
  const backendValue = backendOnline === null ? "verificando" : backendOnline ? "online" : "offline";
  // The greeting is the only message until the first exchange; show the welcome hero instead.
  const showWelcome = messages.length === 1 && messages[0].id === 0;

  return (
    <main className="relative min-h-screen text-foreground">
      <Backdrop />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-4 pb-28 md:px-6">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-4 border-b border-white/[0.06] py-4">
          <div className="flex items-center gap-3">
            <StatusOrb status={status} />
            <div>
              <h1 className="text-base font-semibold tracking-[-0.01em] text-foreground">F.E.A.R.</h1>
              <p role="status" aria-live="polite" className="label-tn">
                {STATUS_LABEL[status]}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <label className="flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 transition focus-within:border-cyan-300/40">
              <User className="size-3.5 text-muted-foreground" />
              <input
                value={speaker}
                onChange={(event) => setSpeaker(event.target.value)}
                aria-label="Nome do interlocutor"
                className="w-20 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 sm:w-28"
                placeholder="Interlocutor"
              />
            </label>
            <div
              className="flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 text-[11px] text-muted-foreground"
              title={`Backend ${backendValue}`}
            >
              {backendTone === "off" ? (
                <WifiOff className="size-3.5 text-rose-400" />
              ) : (
                <Wifi
                  className={`size-3.5 ${backendTone === "ok" ? "text-cyan-300" : "text-amber-300/80"}`}
                />
              )}
              <span className="hidden sm:inline">{backendValue}</span>
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Configuração"
              title="Configuração"
              className="tap grid size-9 place-items-center rounded-full border border-white/10 bg-white/[0.03] text-muted-foreground hover:border-cyan-300/40 hover:text-cyan-200"
            >
              <Settings className="size-4" />
            </button>
          </div>
        </header>

        {/* Deck */}
        <section className="grid flex-1 gap-5 pt-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-6">
          {/* Conversation */}
          <div className="panel flex h-[72vh] min-h-[460px] flex-col rounded-[1.4rem] p-3.5 sm:p-4 lg:h-[78vh]">
            {/* No exit-wait here: the thread must mount immediately so a fast first
                reply is pinned to the bottom (it would otherwise stream into a
                not-yet-mounted element). */}
            {showWelcome ? (
              <motion.div
                key="welcome"
                className="flex flex-1 flex-col"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={fade}
              >
                <WelcomeScreen onPick={(prompt) => void send(prompt, speaker)} busy={isBusy} />
              </motion.div>
            ) : (
              <motion.div
                key="thread"
                className="relative flex min-h-0 flex-1 flex-col"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={fade}
              >
                <div
                  ref={threadRef}
                  role="log"
                  aria-live="polite"
                  aria-label="Conversa com a F.E.A.R."
                  onScroll={handleThreadScroll}
                  className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-1"
                >
                  {messages.map((message) => (
                    <motion.div
                      key={message.id}
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={springSnappy}
                    >
                      {message.role === "user" ? (
                        <UserMessage content={message.content} />
                      ) : message.role === "system" ? (
                        <SystemMessage content={message.content} />
                      ) : (
                        <AssistantMessage content={message.content} />
                      )}
                    </motion.div>
                  ))}
                </div>

                <AnimatePresence>
                  {!atBottom && (
                    <motion.button
                      type="button"
                      onClick={scrollToLatest}
                      initial={{ opacity: 0, y: 8, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.9 }}
                      transition={springSoft}
                      className="tap absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-card/85 px-3 py-1.5 text-[11px] font-medium text-foreground/80 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] backdrop-blur"
                    >
                      <ArrowDown className="size-3.5 text-cyan-300" /> Ir ao fim
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {/* Composer */}
            <form onSubmit={submitCommand} className="mt-3 shrink-0">
              <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-2 transition focus-within:border-cyan-300/40 focus-within:bg-white/[0.05] focus-within:shadow-[0_0_0_4px_rgba(34,211,238,0.07)]">
                <textarea
                  ref={composerRef}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onInput={(event) => {
                    // Grow with the content, capped, for a fluid composer.
                    const el = event.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={1}
                  aria-label="Mensagem para a F.E.A.R."
                  className="max-h-36 min-h-[2.5rem] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/55"
                  placeholder="Traga a ideia. Eu encontro as rachaduras."
                />
                <button
                  type="submit"
                  disabled={isBusy || !text.trim()}
                  aria-label="Enviar"
                  className="tap inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300 text-slate-950 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isBusy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between px-1.5">
                <span className="text-[10px] text-muted-foreground/45">
                  Enter envia · Shift+Enter quebra linha
                </span>
                <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/50">
                  {modKey === "⌘" ? "⌘K" : "Ctrl+K"}
                </kbd>
              </div>
            </form>
          </div>

          {/* Presence + system */}
          <div className="flex flex-col gap-5 lg:h-[78vh]">
            <div className="panel relative h-[38vh] overflow-hidden rounded-[1.4rem] lg:h-auto lg:flex-1">
              <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 pt-4">
                <span className="label-tn text-rose-300/70">Presença</span>
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
                  <span
                    className={`size-1.5 rounded-full ${
                      status === "speaking" ? "animate-pulse bg-rose-400" : "bg-rose-400/40"
                    }`}
                  />
                  {status === "speaking" ? "falando" : "latente"}
                </span>
              </div>
              <FearPresence status={status} />
            </div>

            <div className="panel rounded-[1.4rem] p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="label-tn flex items-center gap-2">
                  <Activity className="size-3.5 text-cyan-300/70" /> Sistema
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className={`size-2 rounded-full ${
                      backendTone === "ok"
                        ? "bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.5)]"
                        : backendTone === "off"
                          ? "bg-rose-400"
                          : "bg-amber-300/70"
                    }`}
                  />
                  backend {backendValue}
                </span>
              </div>
              <div className="space-y-0.5">
                <SystemRow
                  icon={<Cpu className="size-3.5 text-cyan-200" />}
                  label="OpenRouter"
                  {...flag(systemStatus?.openrouter, "configurado")}
                />
                <SystemRow
                  icon={<Database className="size-3.5 text-violet-200" />}
                  label="Memória"
                  {...flag(systemStatus?.memory, "ativa")}
                />
                <SystemRow
                  icon={<Mic className="size-3.5 text-cyan-200" />}
                  label="Voz"
                  {...flag(systemStatus?.voice, "ativa")}
                />
                <SystemRow
                  icon={<Music className="size-3.5 text-emerald-200" />}
                  label="Spotify"
                  {...flag(systemStatus?.spotify, "configurado")}
                />
                <SystemRow
                  icon={<BookOpen className="size-3.5 text-blue-200" />}
                  label="Obsidian"
                  {...flag(systemStatus?.obsidian, "configurado")}
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      <MacOSDock
        apps={fearApps}
        onAppClick={(appId) => (appId === "config" ? setSettingsOpen(true) : handleAppAction(appId, speaker))}
        openApps={settingsOpen ? ["config"] : []}
        className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
      />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} status={systemStatus} />
    </main>
  );
}
