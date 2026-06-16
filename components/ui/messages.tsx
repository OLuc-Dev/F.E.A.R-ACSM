"use client";

import { ReactNode } from "react";

// Message rendering for the F.E.A.R. thread, including a pretty layout for the
// persona's "Conselho Interno" (internal council) strategic replies.

interface Voice {
  name: string;
  text: string;
}

interface Strategic {
  quickRead: string;
  voices: Voice[];
  chairman: string;
  nextStep: string;
}

const VOICE_NAMES = ["Contrarian", "First-Principles", "Expansionist", "Outsider", "Executor"];

const VOICE_ACCENT: Record<string, string> = {
  Contrarian: "border-rose-400/30",
  "First-Principles": "border-cyan-400/30",
  Expansionist: "border-emerald-400/30",
  Outsider: "border-violet-400/30",
  Executor: "border-amber-400/30",
};

// Minimal, XSS-safe inline formatting: **bold** only.
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

export function parseStrategicReply(text: string): Strategic | null {
  const headers = [
    { key: "quickRead", re: /leitura r[áa]pida\s*:?/i },
    { key: "council", re: /conselho interno\s*:?/i },
    { key: "chairman", re: /(?:s[íi]ntese do\s+)?chairman\s*:?/i },
    { key: "nextStep", re: /pr[óo]ximos?\s+passos?\s*:?/i },
  ];

  const found: { key: string; start: number; end: number }[] = [];
  for (const header of headers) {
    const match = header.re.exec(text);
    if (match) found.push({ key: header.key, start: match.index, end: match.index + match[0].length });
  }
  if (found.length < 2) return null;
  found.sort((a, b) => a.start - b.start);

  const sections: Record<string, string> = {};
  found.forEach((current, index) => {
    const next = found[index + 1];
    sections[current.key] = text.slice(current.end, next ? next.start : text.length).trim();
  });

  const voices: Voice[] = [];
  if (sections.council) {
    for (const name of VOICE_NAMES) {
      const pattern = name.replace("-", "[-\\s]?");
      const re = new RegExp(`(?:^|\\n)\\s*[-*]?\\s*${pattern}\\s*:\\s*(.+)`, "i");
      const match = re.exec(sections.council);
      if (match) voices.push({ name, text: match[1].trim() });
    }
  }

  return {
    quickRead: sections.quickRead ?? "",
    voices,
    chairman: sections.chairman ?? "",
    nextStep: sections.nextStep ?? "",
  };
}

function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[10px] font-semibold uppercase tracking-[0.25em] text-violet-200/70 ${className}`}>
      {children}
    </p>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1 align-middle">
      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/70 [animation-delay:-0.2s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/70 [animation-delay:-0.1s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/70" />
    </span>
  );
}

function StrategicReply({ strat }: { strat: Strategic }) {
  return (
    <div className="space-y-3">
      {strat.quickRead && (
        <div>
          <Label>Leitura rápida</Label>
          <p className="mt-1 whitespace-pre-wrap text-foreground/90">{renderInline(strat.quickRead)}</p>
        </div>
      )}

      {strat.voices.length > 0 && (
        <div>
          <Label>Conselho interno</Label>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {strat.voices.map((voice) => (
              <div
                key={voice.name}
                className={`rounded-xl border bg-white/[0.03] p-2.5 backdrop-blur ${VOICE_ACCENT[voice.name] ?? "border-white/10"}`}
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                  {voice.name}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                  {renderInline(voice.text)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {strat.chairman && (
        <div className="rounded-xl border border-cyan-300/30 bg-gradient-to-br from-cyan-300/10 to-transparent p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
          <Label className="text-cyan-200">Síntese do Chairman</Label>
          <p className="mt-1 whitespace-pre-wrap text-foreground">{renderInline(strat.chairman)}</p>
        </div>
      )}

      {strat.nextStep && (
        <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <span className="mt-0.5 select-none text-cyan-300">→</span>
          <div>
            <Label>Próximo passo</Label>
            <p className="mt-1 whitespace-pre-wrap text-foreground/90">{renderInline(strat.nextStep)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-cyan-300/20 bg-cyan-300/10 px-4 py-2.5 text-sm leading-6 backdrop-blur">
        {renderInline(content)}
      </div>
    </div>
  );
}

export function SystemMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-center">
      <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        {content}
      </div>
    </div>
  );
}

export function AssistantMessage({ content }: { content: string }) {
  const strat = content ? parseStrategicReply(content) : null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.04] px-4 py-3 text-sm leading-6 text-muted-foreground backdrop-blur">
        {!content ? (
          <TypingDots />
        ) : strat ? (
          <StrategicReply strat={strat} />
        ) : (
          <p className="whitespace-pre-wrap">{renderInline(content)}</p>
        )}
      </div>
    </div>
  );
}
