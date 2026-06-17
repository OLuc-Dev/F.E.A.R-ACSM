"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { BookOpen, Brain, Cpu, Database, Mic, Music, RotateCcw, Send } from "lucide-react";

import MacOSDock, { type DockApp } from "@/components/ui/mac-os-dock";
import { Card } from "@/components/ui/card";
import { AssistantMessage, SystemMessage, UserMessage } from "@/components/ui/messages";
import { getStatus, type StatusResponse } from "@/lib/api";
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

// Idle/listening = cyan; speaking = white/cyan; thinking = controlled red; error = strong red.
const STATUS_ORB: Record<Status, string> = {
  online: "bg-cyan-400/80 shadow-[0_0_14px_3px_rgba(34,211,238,0.4)]",
  listening: "bg-sky-300 shadow-[0_0_16px_4px_rgba(56,189,248,0.5)] animate-pulse",
  thinking: "bg-rose-400/60 shadow-[0_0_14px_3px_rgba(251,113,133,0.35)] animate-pulse",
  speaking: "bg-white shadow-[0_0_20px_6px_rgba(186,230,253,0.7)] animate-pulse",
  error: "bg-rose-500 shadow-[0_0_18px_5px_rgba(244,63,94,0.7)]",
};

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
  const dot = tone === "ok" ? "bg-cyan-300" : tone === "off" ? "bg-rose-400/70" : "bg-white/25";
  return (
    <div className="flex items-center justify-between py-1">
      <span className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
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

export default function HomePage() {
  const [speaker, setSpeaker] = useState("Lucas");
  const [text, setText] = useState("");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [systemStatus, setSystemStatus] = useState<StatusResponse | null>(null);

  const { messages, status, isBusy, threadRef, send, handleAppAction } = useConversation();

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
    void send(value, speaker);
  }

  const backendTone = backendOnline === null ? "muted" : backendOnline ? "ok" : "off";
  const backendValue = backendOnline === null ? "verificando" : backendOnline ? "online" : "offline";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_30rem),radial-gradient(circle_at_top_right,rgba(139,92,246,0.12),transparent_28rem),#05060a] px-4 pb-32 pt-6 text-foreground md:px-6 md:pt-8">
      <section className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8">
        {/* Conversation */}
        <div className="flex h-[68vh] min-h-[440px] flex-col rounded-[1.75rem] border bg-card/70 p-5 shadow-2xl backdrop-blur md:p-6 lg:h-[680px]">
          <header className="mb-4 flex items-center justify-between gap-4 border-b border-white/5 pb-4">
            <div className="flex items-center gap-3">
              <span aria-hidden className={`size-3 rounded-full transition-colors ${STATUS_ORB[status]}`} />
              <div>
                <h1 className="text-2xl font-black tracking-[-0.06em]">F.E.A.R.</h1>
                <p
                  role="status"
                  aria-live="polite"
                  className="text-[10px] uppercase tracking-[0.4em] text-cyan-300/70"
                >
                  {STATUS_LABEL[status]}
                </p>
              </div>
            </div>
            <input
              value={speaker}
              onChange={(event) => setSpeaker(event.target.value)}
              aria-label="Nome do interlocutor"
              className="h-9 w-28 rounded-full border bg-background/60 px-4 text-sm outline-none ring-cyan-300/30 transition focus:ring-4 sm:w-32"
              placeholder="Speaker"
            />
          </header>

          <div
            ref={threadRef}
            role="log"
            aria-live="polite"
            aria-label="Conversa com a F.E.A.R."
            className="flex-1 space-y-3 overflow-y-auto pr-1"
          >
            {messages.map((message) =>
              message.role === "user" ? (
                <UserMessage key={message.id} content={message.content} />
              ) : message.role === "system" ? (
                <SystemMessage key={message.id} content={message.content} />
              ) : (
                <AssistantMessage key={message.id} content={message.content} />
              ),
            )}
          </div>

          <form onSubmit={submitCommand} className="mt-4 flex items-end gap-3 border-t border-white/5 pt-4">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              aria-label="Mensagem para a F.E.A.R."
              className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border bg-background/60 p-3 text-sm outline-none ring-cyan-300/30 transition focus:ring-4"
              placeholder="Traga a ideia. Eu encontro as rachaduras."
            />
            <button
              type="submit"
              disabled={isBusy}
              aria-label="Enviar"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-cyan-300 text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Send className="size-4" />
            </button>
          </form>
        </div>

        {/* Presence + system */}
        <div className="flex flex-col gap-6 lg:h-[680px]">
          <Card className="relative h-[320px] overflow-hidden border-white/10 bg-black/70 lg:h-auto lg:flex-1">
            <p className="absolute left-5 top-4 z-10 text-[10px] uppercase tracking-[0.4em] text-rose-400/70">
              F.E.A.R. presence
            </p>
            <FearPresence speaking={status === "speaking"} />
          </Card>

          <Card className="border-cyan-300/10 bg-card/60 p-5">
            <div className="mb-3 flex items-center justify-between border-b border-white/5 pb-3">
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-violet-200/80">
                <Cpu className="size-4" /> sistema
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
            <div className="text-xs">
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
          </Card>
        </div>
      </section>

      <MacOSDock
        apps={fearApps}
        onAppClick={(appId) => handleAppAction(appId, speaker)}
        openApps={[]}
        className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
      />
    </main>
  );
}
