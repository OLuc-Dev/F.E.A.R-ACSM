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
  CalendarDays,
  ChevronDown,
  Cpu,
  Crosshair,
  Database,
  KeyRound,
  Loader2,
  Mic,
  Music,
  RotateCcw,
  Send,
  Settings,
  Split,
  Swords,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from "lucide-react";

import { AuthPanel } from "@/components/ui/auth-panel";
import MacOSDock, { type DockApp } from "@/components/ui/mac-os-dock";
import { AssistantMessage, SystemMessage, UserMessage } from "@/components/ui/messages";
import { SettingsPanel, type Tab as SettingsTab } from "@/components/ui/settings-panel";
import { getStatus, type StatusResponse } from "@/lib/api";
import { accountInitial, accountName, keyStatusLabel } from "@/lib/identity";
import { fade, springSnappy, springSoft } from "@/lib/motion";
import { useAuth } from "@/lib/use-auth";
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
  { id: "reset", name: "Nova conversa", icon: <RotateCcw className="h-full w-full text-rose-200" /> },
];

const STATUS_LABEL: Record<Status, string> = {
  online: "pronto",
  listening: "ouvindo",
  thinking: "pensando",
  speaking: "respondendo",
  error: "atenção",
};

// One signal vocabulary: cyan = ready/working, amber = F.E.A.R.'s energy (it is
// speaking), rose = error. Amber only ever appears when F.E.A.R. is the source,
// which is also how the header orb carries the presence on mobile (where the 3D
// core is hidden). Mirrors the 3D core, which flares amber while speaking.
const STATUS_ORB: Record<Status, string> = {
  online: "bg-cyan-400 shadow-[0_0_14px_3px_rgba(34,211,238,0.45)]",
  listening: "bg-sky-300 shadow-[0_0_16px_4px_rgba(56,189,248,0.5)] animate-pulse",
  thinking: "bg-cyan-300 shadow-[0_0_14px_3px_rgba(34,211,238,0.45)] animate-pulse",
  speaking: "bg-amber-300 shadow-[0_0_20px_6px_hsl(var(--energy)/0.6)] animate-pulse",
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
  const [text, setText] = useState("");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [systemStatus, setSystemStatus] = useState<StatusResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("conhecimento");
  const [authOpen, setAuthOpen] = useState(false);
  const [promptedKey, setPromptedKey] = useState(false);
  const [sysOpen, setSysOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [modKey, setModKey] = useState("⌘");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const { user, ready, signIn, signUp, signOut, saveOpenRouterKey } = useAuth();

  // Open the settings drawer on a specific tab (the gear opens Conhecimento,
  // the dock's Memória icon jumps straight to the memory inspector).
  function openSettings(tab: SettingsTab = "conhecimento") {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  const {
    messages,
    status,
    isBusy,
    memoryTick,
    threadRef,
    atBottom,
    handleThreadScroll,
    scrollToLatest,
    voiceOn,
    toggleVoice,
    send,
    retry,
    handleAppAction,
  } = useConversation();

  // F.E.A.R. addresses the person by their account (email local part) — no more
  // free-text "speaker". Only read in the deck, where a user always exists.
  const speaker = user ? accountName(user.email) : "user";

  // Show the right modifier hint per platform (avoids a hydration mismatch by
  // starting from a stable default and correcting after mount).
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    if (!isMac) setModKey("Ctrl");
  }, []);

  // Only mount the 3D presence on real desktop widths (Tailwind's lg). CSS
  // `hidden` alone would still mount <FearPresence>, loading the Three.js chunk
  // and preloading the model on mobile — so we gate the render itself.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
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

  // First run without a key: open the account panel once (AuthPanel focuses the
  // key field). Closing it won't reopen — no nag loop.
  useEffect(() => {
    if (ready && user && !user.has_openrouter_key && !promptedKey) {
      setPromptedKey(true);
      setAuthOpen(true);
    }
  }, [ready, user, promptedKey]);

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
  const backendDot =
    backendTone === "ok"
      ? "bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.5)]"
      : backendTone === "off"
        ? "bg-rose-400"
        : "bg-white/25";
  // The greeting is the only message until the first exchange; show the welcome hero instead.
  const showWelcome = messages.length === 1 && messages[0].id === 0;

  // Login is required. Wait for the session check, then gate the whole app
  // behind the (non-dismissible) account panel until the user signs in.
  if (!ready) {
    return (
      <main className="relative grid min-h-screen place-items-center text-foreground">
        <Backdrop />
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> carregando…
        </span>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="relative grid min-h-screen place-items-center text-foreground">
        <Backdrop />
        <AuthPanel
          open
          mandatory
          onClose={() => {}}
          user={null}
          onSignIn={signIn}
          onSignUp={signUp}
          onSignOut={signOut}
          onSaveKey={saveOpenRouterKey}
        />
      </main>
    );
  }

  // System panel rows, computed once so the panel body stays a tight map. "Sua
  // chave" is per-user; the rest mirror the backend's optional integrations.
  const systemItems: { icon: ReactNode; label: string; value: string; tone: "ok" | "muted" }[] = [
    {
      icon: <Cpu className="size-3.5 text-cyan-200" />,
      label: "Chave",
      value: keyStatusLabel(user.has_openrouter_key),
      tone: user.has_openrouter_key ? "ok" : "muted",
    },
    {
      icon: <Database className="size-3.5 text-violet-200" />,
      label: "Memória",
      ...flag(systemStatus?.memory, "ativa"),
    },
    {
      icon: <Mic className="size-3.5 text-cyan-200" />,
      label: "Voz",
      ...flag(systemStatus?.voice, "ativa"),
    },
    {
      icon: <Music className="size-3.5 text-emerald-200" />,
      label: "Spotify",
      ...flag(systemStatus?.spotify, "ok"),
    },
    {
      icon: <BookOpen className="size-3.5 text-blue-200" />,
      label: "Obsidian",
      ...flag(systemStatus?.obsidian, "ok"),
    },
    {
      icon: <CalendarDays className="size-3.5 text-slate-200" />,
      label: "Agenda",
      ...flag(systemStatus?.calendar, "ok"),
    },
  ];

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
            <button
              onClick={() => setAuthOpen(true)}
              title={user.email}
              aria-label="Sua conta"
              className="tap flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-0 pl-1 pr-3 text-sm text-foreground/90 transition hover:border-cyan-300/40 hover:text-cyan-200"
            >
              <span className="grid size-7 place-items-center rounded-full bg-cyan-300/15 text-[11px] font-semibold text-cyan-200">
                {accountInitial(user.email)}
              </span>
              <span className="max-w-[8rem] truncate">{accountName(user.email)}</span>
            </button>
            <div
              className="flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 text-[11px] text-muted-foreground"
              title={`Backend ${backendValue}`}
            >
              {backendTone === "off" ? (
                <WifiOff className="size-3.5 text-rose-400" />
              ) : (
                <Wifi
                  className={`size-3.5 ${backendTone === "ok" ? "text-cyan-300" : "text-muted-foreground"}`}
                />
              )}
              <span className="hidden sm:inline">{backendValue}</span>
            </div>
            <button
              onClick={toggleVoice}
              aria-label="Voz da F.E.A.R."
              aria-pressed={voiceOn}
              title={voiceOn ? "Voz: ligada" : "Voz: desligada"}
              className={`tap grid size-9 place-items-center rounded-full border transition ${
                voiceOn
                  ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-200"
                  : "border-white/10 bg-white/[0.03] text-muted-foreground hover:border-cyan-300/40 hover:text-cyan-200"
              }`}
            >
              {voiceOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
            <button
              onClick={() => openSettings()}
              aria-label="Configuração"
              title="Configuração"
              className="tap grid size-9 place-items-center rounded-full border border-white/10 bg-white/[0.03] text-muted-foreground hover:border-cyan-300/40 hover:text-cyan-200"
            >
              <Settings className="size-4" />
            </button>
          </div>
        </header>

        {/* Nudge a signed-in user to add their OpenRouter key, without which
            F.E.A.R. can't reply. Disappears the moment the key is saved. */}
        {!user.has_openrouter_key && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-cyan-300/25 bg-cyan-300/[0.06] px-3.5 py-2.5 text-[13px] text-cyan-100/90">
            <span className="flex items-center gap-2">
              <KeyRound className="size-4 shrink-0 text-cyan-300" />
              Cole sua chave do OpenRouter pra F.E.A.R. responder.
            </span>
            <button
              onClick={() => setAuthOpen(true)}
              className="tap shrink-0 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-300/20"
            >
              Adicionar chave
            </button>
          </div>
        )}

        {/* Deck */}
        <section className="grid flex-1 gap-5 pt-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.62fr)] lg:gap-6">
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
              {/* Clear, recoverable error state — the question stays in the
                  thread and one tap re-asks it. */}
              {status === "error" && (
                <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-rose-400/30 bg-rose-400/[0.07] px-3 py-2 text-[13px] text-rose-100/90">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="size-4 shrink-0 text-rose-300" />
                    Algo travou na última resposta.
                  </span>
                  <button
                    type="button"
                    onClick={retry}
                    className="tap inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-400/20"
                  >
                    <RotateCcw className="size-3.5" /> Tentar de novo
                  </button>
                </div>
              )}
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

          {/* Presence + system — the sidebar. Conversation is the focus, so this
              column stays top-aligned and calmer than before. */}
          <div className="flex flex-col gap-4 lg:self-start">
            {/* 3D presence: desktop only. Gated on a client media query (not
                just CSS) so the Three.js chunk never loads on mobile, where the
                header orb already carries the state. Frameless — no panel — so
                the core emanates into the column instead of sitting in a box. */}
            {isDesktop && (
              <div className="relative lg:h-[44vh]">
                {/* Amber floor: the core's light spilling past the frame into the
                    deck, so the presence reads as energy, not a black rectangle. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-6 -bottom-10 blur-2xl [background:radial-gradient(55%_55%_at_50%_46%,hsl(var(--energy)/0.16),transparent_72%)]"
                />
                {/* Melt the hard rectangle with a radial mask so the canvas fades
                    into the deck at its edges instead of ending on a seam. */}
                <div className="absolute inset-0 overflow-hidden rounded-[1.4rem] [-webkit-mask-image:radial-gradient(120%_115%_at_50%_44%,#000_56%,transparent_100%)] [mask-image:radial-gradient(120%_115%_at_50%_44%,#000_56%,transparent_100%)]">
                  <FearPresence status={status} pulse={memoryTick} />
                </div>
              </div>
            )}

            {/* System: compact 2-column readout. Collapsible on mobile, always
                open on desktop. */}
            <div className="panel p-4">
              <button
                type="button"
                onClick={() => setSysOpen((open) => !open)}
                aria-expanded={sysOpen}
                className="tap flex w-full items-center justify-between lg:hidden"
              >
                <span className="label-tn flex items-center gap-2">
                  <Activity className="size-3.5 text-cyan-300/70" /> Sistema
                </span>
                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${backendDot}`} />
                    {backendValue}
                  </span>
                  <ChevronDown className={`size-4 transition-transform ${sysOpen ? "rotate-180" : ""}`} />
                </span>
              </button>
              <div className="hidden items-center justify-between lg:flex">
                <span className="label-tn flex items-center gap-2">
                  <Activity className="size-3.5 text-cyan-300/70" /> Sistema
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={`size-2 rounded-full ${backendDot}`} />
                  backend {backendValue}
                </span>
              </div>
              <div className={`grid-cols-2 gap-x-4 gap-y-0.5 pt-3 lg:grid ${sysOpen ? "grid" : "hidden"}`}>
                {systemItems.map((item) => (
                  <div key={item.label} className="flex items-center gap-2 py-1 text-[12px]">
                    <span className="text-muted-foreground">{item.icon}</span>
                    <span className="text-foreground/70">{item.label}</span>
                    <span
                      className={`ml-auto text-[10px] ${
                        item.tone === "ok" ? "text-cyan-300/80" : "text-muted-foreground/55"
                      }`}
                    >
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

      <MacOSDock
        apps={fearApps}
        onAppClick={(appId) =>
          appId === "memory" ? openSettings("memoria") : handleAppAction(appId, speaker)
        }
        openApps={settingsOpen && settingsTab === "memoria" ? ["memory"] : []}
        className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        status={systemStatus}
        speaker={speaker}
        initialTab={settingsTab}
      />

      <AuthPanel
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        user={user}
        onSignIn={signIn}
        onSignUp={signUp}
        onSignOut={signOut}
        onSaveKey={saveOpenRouterKey}
      />
    </main>
  );
}
