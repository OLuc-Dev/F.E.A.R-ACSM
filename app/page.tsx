"use client";

import { FormEvent, useState } from "react";
import { Brain, Mic, Radio, Send, Sparkles } from "lucide-react";

import AnimatedTextCycle from "@/components/ui/animated-text-cycle";
import DisplayCards from "@/components/ui/display-cards";
import { Card } from "@/components/ui/card";
import { SplineSceneBasic } from "@/components/ui/spline-scene-demo";

const API_BASE = process.env.NEXT_PUBLIC_FEAR_API_BASE ?? "http://127.0.0.1:8765";

const fearCards = [
  {
    icon: <Mic className="size-4 text-cyan-200" />,
    title: "Voice",
    description: "Whisper listener ready",
    date: "Local",
    titleClassName: "text-cyan-200",
    className:
      "[grid-area:stack] hover:-translate-y-10 before:absolute before:left-0 before:top-0 before:h-[100%] before:w-[100%] before:rounded-xl before:bg-background/50 before:bg-blend-overlay before:outline before:outline-1 before:outline-border before:content-[''] before:transition-opacity before:duration-700 hover:before:opacity-0 grayscale-[100%] hover:grayscale-0",
  },
  {
    icon: <Brain className="size-4 text-violet-200" />,
    title: "Memory",
    description: "ChromaDB second brain",
    date: "Persistent",
    titleClassName: "text-violet-200",
    className:
      "[grid-area:stack] translate-x-12 translate-y-10 hover:-translate-y-1 before:absolute before:left-0 before:top-0 before:h-[100%] before:w-[100%] before:rounded-xl before:bg-background/50 before:bg-blend-overlay before:outline before:outline-1 before:outline-border before:content-[''] before:transition-opacity before:duration-700 hover:before:opacity-0 grayscale-[100%] hover:grayscale-0",
  },
  {
    icon: <Radio className="size-4 text-blue-200" />,
    title: "Actions",
    description: "Spotify and gestures",
    date: "Desktop",
    titleClassName: "text-blue-200",
    className: "[grid-area:stack] translate-x-24 translate-y-20 hover:translate-y-10",
  },
];

export default function HomePage() {
  const [speaker, setSpeaker] = useState("Lucas");
  const [text, setText] = useState("");
  const [reply, setReply] = useState("F.E.A.R. está online. Envie um comando para testar.");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("online");

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!text.trim()) {
      setReply("Digite um comando antes de enviar.");
      return;
    }

    setIsLoading(true);
    setStatus("thinking");

    try {
      const response = await fetch(`${API_BASE}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          speaker: speaker || "user",
          speak: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      setReply(data.reply || "Comando recebido.");
      setText("");
      setStatus("online");
    } catch (error) {
      setStatus("error");
      setReply(error instanceof Error ? error.message : "Erro ao falar com o backend.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_28rem),radial-gradient(circle_at_top_right,rgba(139,92,246,0.14),transparent_26rem)] px-6 py-8 text-foreground">
      <section className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="flex min-h-[680px] flex-col justify-between rounded-[2rem] border bg-card/70 p-8 shadow-2xl backdrop-blur">
          <div>
            <div className="mb-10 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.45em] text-cyan-300/80">
                  Desktop presence
                </p>
                <h1 className="mt-4 text-6xl font-black tracking-[-0.08em] md:text-8xl">
                  F.E.A.R.
                </h1>
              </div>
              <div className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-200">
                {status}
              </div>
            </div>

            <h2 className="max-w-3xl text-4xl font-light leading-tight text-muted-foreground md:text-6xl">
              Uma interface para sua{" "}
              <AnimatedTextCycle
                words={["voz", "memória", "rotina", "música", "presença", "máquina"]}
                interval={2600}
                className="font-semibold text-foreground"
              />
              .
            </h2>

            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              Python executa. FastAPI conecta. React mostra. Esta tela conversa com
              o backend local em {API_BASE}.
            </p>
          </div>

          <div className="mt-14 grid gap-6 xl:grid-cols-[1fr_0.95fr]">
            <Card className="border-cyan-300/10 bg-background/50 p-5">
              <form onSubmit={submitCommand} className="space-y-4">
                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                    Speaker
                  </label>
                  <input
                    value={speaker}
                    onChange={(event) => setSpeaker(event.target.value)}
                    className="h-11 rounded-xl border bg-background/70 px-4 outline-none ring-cyan-300/30 transition focus:ring-4"
                    placeholder="Lucas"
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                    Comando
                  </label>
                  <textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    className="min-h-32 rounded-xl border bg-background/70 p-4 outline-none ring-cyan-300/30 transition focus:ring-4"
                    placeholder="Ex.: lembra que eu gosto de interfaces escuras e minimalistas"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-cyan-300 px-5 text-sm font-bold uppercase tracking-[0.2em] text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Send className="size-4" />
                  {isLoading ? "processando" : "enviar"}
                </button>
              </form>
            </Card>

            <Card className="border-violet-300/10 bg-background/50 p-5">
              <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em] text-violet-200">
                <Sparkles className="size-4" /> resposta
              </p>
              <p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
                {reply}
              </p>
            </Card>
          </div>
        </div>

        <div className="grid gap-8">
          <SplineSceneBasic />
          <Card className="min-h-[360px] overflow-hidden border-cyan-300/10 bg-card/60 p-8">
            <DisplayCards cards={fearCards} />
          </Card>
        </div>
      </section>
    </main>
  );
}
