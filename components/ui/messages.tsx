"use client";

import { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import {
  AlertTriangle,
  ArrowRight,
  Atom,
  Gavel,
  Telescope,
  TrendingUp,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Message rendering for the F.E.A.R. thread, including a refined layout for the
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

interface VoiceStyle {
  icon: LucideIcon;
  ring: string;
  text: string;
}

// Each council voice carries its own glyph and accent so the synthesis reads at a glance.
const VOICE_META: Record<string, VoiceStyle> = {
  Contrarian: { icon: AlertTriangle, ring: "border-rose-400/25", text: "text-rose-300" },
  "First-Principles": { icon: Atom, ring: "border-cyan-400/25", text: "text-cyan-300" },
  Expansionist: { icon: TrendingUp, ring: "border-emerald-400/25", text: "text-emerald-300" },
  Outsider: { icon: Telescope, ring: "border-violet-400/25", text: "text-violet-300" },
  Executor: { icon: Zap, ring: "border-amber-400/25", text: "text-amber-300" },
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

// Links in a reply always open in a new tab and can never carry the app off to
// a javascript: URL (react-markdown already sanitizes the href; we harden the
// target/rel and add nofollow). No `rehype-raw`, so any raw HTML in a reply is
// rendered as plain text, never executed.
const mdComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

// Safe markdown for F.E.A.R.'s prose replies: lists, links, inline code, code
// blocks and **bold**. `remark-breaks` keeps single newlines as line breaks
// (chat convention); no GFM (CommonMark already covers the scope). It re-parses
// the growing string as tokens stream in, so partial markdown never crashes.
export function ReplyBody({ text }: { text: string }) {
  return (
    <div className="md-body">
      <Markdown remarkPlugins={[remarkBreaks]} components={mdComponents}>
        {text}
      </Markdown>
    </div>
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

function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`text-[10px] font-semibold uppercase tracking-[0.26em] ${className ?? "text-muted-foreground/60"}`}
    >
      {children}
    </p>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1.5 py-0.5 align-middle">
      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/80 [animation-delay:-0.25s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/80 [animation-delay:-0.12s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-cyan-300/80" />
    </span>
  );
}

function StrategicReply({ strat }: { strat: Strategic }) {
  return (
    <div className="space-y-3.5">
      {strat.quickRead && (
        <div className="border-l-2 border-cyan-300/40 pl-3">
          <Label>Leitura rápida</Label>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground/90">
            {renderInline(strat.quickRead)}
          </p>
        </div>
      )}

      {strat.voices.length > 0 && (
        <div>
          <Label className="text-muted-foreground/60">Conselho interno</Label>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {strat.voices.map((voice) => {
              const meta = VOICE_META[voice.name];
              const Icon = meta?.icon;
              return (
                <div
                  key={voice.name}
                  className={`rounded-xl border bg-white/[0.025] p-3 ${meta?.ring ?? "border-white/10"}`}
                >
                  <div className="flex items-center gap-1.5">
                    {Icon && <Icon className={`size-3.5 ${meta.text}`} />}
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${meta?.text ?? "text-foreground/80"}`}
                    >
                      {voice.name}
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                    {renderInline(voice.text)}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {strat.chairman && (
        <div className="relative overflow-hidden rounded-xl border border-cyan-300/30 bg-gradient-to-br from-cyan-300/[0.12] via-cyan-300/[0.03] to-transparent p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="flex items-center gap-1.5">
            <Gavel className="size-3.5 text-cyan-200" />
            <Label className="text-cyan-200">Síntese do Chairman</Label>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-foreground">
            {renderInline(strat.chairman)}
          </p>
        </div>
      )}

      {strat.nextStep && (
        <div className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.025] p-3">
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-cyan-300" />
          <div>
            <Label>Próximo passo</Label>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground/90">
              {renderInline(strat.nextStep)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-cyan-300/20 bg-cyan-300/[0.10] px-4 py-2.5 text-[15px] leading-6 text-foreground">
        {renderInline(content)}
      </div>
    </div>
  );
}

export function SystemMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-center py-1">
      <div className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
        {content}
      </div>
    </div>
  );
}

export function AssistantMessage({ content }: { content: string }) {
  const strat = content ? parseStrategicReply(content) : null;

  return (
    <div className="flex justify-start">
      {/* min-w-0 lets a wide code block scroll inside the bubble instead of
          forcing the whole column (and the page) wider on mobile. */}
      <div className="min-w-0 max-w-[92%] rounded-2xl rounded-bl-md border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-[15px] leading-7 text-foreground/90 shadow-[0_16px_40px_-28px_rgba(0,0,0,0.9)]">
        {!content ? <TypingDots /> : strat ? <StrategicReply strat={strat} /> : <ReplyBody text={content} />}
      </div>
    </div>
  );
}
