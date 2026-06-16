"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Brain, Mic, Music, NotebookText, RotateCcw, Send, Sparkles } from "lucide-react";

import MacOSDock, { type DockApp } from "@/components/ui/mac-os-dock";
import { Card } from "@/components/ui/card";

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

const API_BASE = process.env.NEXT_PUBLIC_FEAR_API_BASE ?? "http://127.0.0.1:8765";

type Role = "user" | "fear";
type Status = "online" | "thinking" | "speaking" | "error";

interface Message {
  id: number;
  role: Role;
  content: string;
}

// F.E.A.R.'s capabilities as a glass dock of "apps".
const fearApps: DockApp[] = [
  { id: "voice", name: "Voz", icon: <Mic className="h-full w-full text-cyan-200" /> },
  { id: "memory", name: "Memória", icon: <Brain className="h-full w-full text-violet-200" /> },
  { id: "spotify", name: "Spotify", icon: <Music className="h-full w-full text-emerald-200" /> },
  { id: "obsidian", name: "Obsidian", icon: <NotebookText className="h-full w-full text-blue-200" /> },
  { id: "reset", name: "Nova conversa", icon: <RotateCcw className="h-full w-full text-rose-200" /> },
];

const STATUS_LABEL: Record<Status, string> = {
  online: "pronto",
  thinking: "pensando",
  speaking: "respondendo",
  error: "atenção",
};

const STATUS_ORB: Record<Status, string> = {
  online: "bg-cyan-300/80 shadow-[0_0_16px_4px_rgba(34,211,238,0.45)]",
  thinking: "bg-violet-300/80 shadow-[0_0_16px_4px_rgba(167,139,250,0.5)] animate-pulse",
  speaking: "bg-cyan-200 shadow-[0_0_20px_6px_rgba(34,211,238,0.6)] animate-pulse",
  error: "bg-rose-400/80 shadow-[0_0_16px_4px_rgba(251,113,133,0.5)]",
};

export default function HomePage() {
  const [speaker, setSpeaker] = useState("Lucas");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { id: 0, role: "fear", content: "Estou aqui. Em silêncio, atento. Manda." },
  ]);
  const [status, setStatus] = useState<Status>("online");
  const [isBusy, setIsBusy] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  const idRef = useRef(1);
  const threadRef = useRef<HTMLDivElement>(null);

  const nextId = () => idRef.current++;

  useEffect(() => {
    const el = threadRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/health`)
      .then((response) => {
        if (active) setBackendOnline(response.ok);
      })
      .catch(() => {
        if (active) setBackendOnline(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function pushMessage(role: Role, content: string) {
    setMessages((prev) => [...prev, { id: nextId(), role, content }]);
  }

  function appendToLastFear(chunk: string) {
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last && last.role === "fear") {
        copy[copy.length - 1] = { ...last, content: last.content + chunk };
      }
      return copy;
    });
  }

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isBusy) {
      return;
    }

    setText("");
    setIsBusy(true);
    setStatus("thinking");
    pushMessage("user", trimmed);
    pushMessage("fear", "");

    try {
      const response = await fetch(`${API_BASE}/command/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed, speaker: speaker || "user", speak: false }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      setStatus("speaking");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) {
          appendToLastFear(chunk);
        }
      }
      setStatus("online");
    } catch (error) {
      appendToLastFear(error instanceof Error ? `Erro: ${error.message}` : "Falha ao falar com o backend.");
      setStatus("error");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleAppClick(appId: string) {
    const who = speaker || "user";

    try {
      if (appId === "spotify") {
        setStatus("thinking");
        const response = await fetch(`${API_BASE}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "toggle Spotify playback", speaker: who, speak: false }),
        });
        const data = await response.json();
        pushMessage("fear", data.reply || "Spotify acionado.");
        setStatus("online");
      } else if (appId === "voice") {
        await fetch(`${API_BASE}/voice/capture-once`, { method: "POST" });
        pushMessage("fear", "Escutando um trecho de voz…");
      } else if (appId === "memory") {
        const response = await fetch(`${API_BASE}/memory/${encodeURIComponent(who)}`);
        const data = await response.json();
        const count = Array.isArray(data.memories) ? data.memories.length : 0;
        pushMessage("fear", `Tenho ${count} memória(s) recente(s) sobre ${who}.`);
      } else if (appId === "reset") {
        await fetch(`${API_BASE}/conversation/reset?speaker=${encodeURIComponent(who)}`, { method: "POST" });
        setMessages([{ id: nextId(), role: "fear", content: "Conversa reiniciada. A memória pessoal foi mantida." }]);
      } else if (appId === "obsidian") {
        pushMessage("fear", "Observo seu vault do Obsidian quando OBSIDIAN_VAULT_PATH está configurado.");
      }
    } catch {
      setStatus("error");
      pushMessage("fear", "Não consegui falar com o backend local.");
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_28rem),radial-gradient(circle_at_top_right,rgba(139,92,246,0.14),transparent_26rem)] px-6 pb-32 pt-8 text-foreground">
      <section className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="flex h-[680px] flex-col rounded-[2rem] border bg-card/70 p-6 shadow-2xl backdrop-blur">
          <header className="mb-4 flex items-center justify-between gap-4 border-b border-white/5 pb-4">
            <div className="flex items-center gap-3">
              <span className={`size-3 rounded-full transition-colors ${STATUS_ORB[status]}`} />
              <div>
                <h1 className="text-2xl font-black tracking-[-0.06em]">F.E.A.R.</h1>
                <p className="text-[10px] uppercase tracking-[0.4em] text-cyan-300/70">{STATUS_LABEL[status]}</p>
              </div>
            </div>
            <input
              value={speaker}
              onChange={(event) => setSpeaker(event.target.value)}
              aria-label="Speaker"
              className="h-9 w-32 rounded-full border bg-background/60 px-4 text-sm outline-none ring-cyan-300/30 transition focus:ring-4"
              placeholder="Speaker"
            />
          </header>

          <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={
                    message.role === "user"
                      ? "max-w-[80%] rounded-2xl rounded-br-sm border border-cyan-300/20 bg-cyan-300/10 px-4 py-2.5 text-sm leading-6 backdrop-blur"
                      : "max-w-[85%] rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm leading-6 text-muted-foreground backdrop-blur"
                  }
                >
                  {message.content ? (
                    <span className="whitespace-pre-wrap">{message.content}</span>
                  ) : (
                    <span className="inline-flex gap-1 align-middle">
                      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/70 [animation-delay:-0.2s]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/70 [animation-delay:-0.1s]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/70" />
                    </span>
                  )}
                </div>
              </div>
            ))}
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
              className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border bg-background/60 p-3 text-sm outline-none ring-cyan-300/30 transition focus:ring-4"
              placeholder="Fala com a F.E.A.R.…  (Enter envia, Shift+Enter quebra linha)"
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

        <div className="grid h-[680px] grid-rows-[1fr_auto] gap-6">
          <Card className="relative h-full overflow-hidden border-white/10 bg-black/70">
            <p className="absolute left-5 top-4 z-10 text-[10px] uppercase tracking-[0.4em] text-rose-400/70">
              F.E.A.R. presence
            </p>
            <FearPresence speaking={status === "speaking"} />
          </Card>

          <Card className="border-cyan-300/10 bg-card/60 p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-violet-200/80">
                <Sparkles className="size-4" /> sistema
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={`size-2 rounded-full ${
                    backendOnline === null
                      ? "bg-amber-300/70"
                      : backendOnline
                        ? "bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.5)]"
                        : "bg-rose-400"
                  }`}
                />
                {backendOnline === null ? "verificando" : backendOnline ? "backend online" : "backend offline"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                <Mic className="size-3.5 text-cyan-200" /> Voz
              </span>
              <span className="flex items-center gap-2">
                <Brain className="size-3.5 text-violet-200" /> Memória
              </span>
              <span className="flex items-center gap-2">
                <Music className="size-3.5 text-emerald-200" /> Spotify
              </span>
              <span className="flex items-center gap-2">
                <NotebookText className="size-3.5 text-blue-200" /> Obsidian
              </span>
            </div>
          </Card>
        </div>
      </section>

      <MacOSDock
        apps={fearApps}
        onAppClick={handleAppClick}
        openApps={[]}
        className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
      />
    </main>
  );
}
