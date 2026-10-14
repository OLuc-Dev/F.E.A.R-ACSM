"use client";

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Camera,
  CameraOff,
  Grab,
  Hand,
  Loader2,
  Pointer,
  X,
} from "lucide-react";

import { HudPanel } from "@/components/ui/hud-panel";
import type { GestureCommand, HandPose, HandSample } from "@/lib/hand-gestures";
import { type GestureStatus, useHandGestures } from "@/lib/use-hand-gestures";

export interface GestureFeedback {
  title: string;
  detail?: string;
  at: number;
}

const POSE_LABEL: Record<HandPose, string> = {
  None: "Mão detectada",
  Open_Palm: "Palma aberta",
  Closed_Fist: "Punho fechado",
  Pointing_Up: "Apontando para cima",
  Thumb_Up: "Joinha",
  Thumb_Down: "Polegar para baixo",
  Victory: "Sinal de vitória",
  ILoveYou: "Sinal de rock",
};

const STATUS_LABEL: Record<GestureStatus, string> = {
  off: "desligado",
  starting: "ligando a câmera…",
  watching: "câmera ligada",
  paused: "pausado com a janela oculta",
  error: "câmera indisponível",
};

const LEGEND: { icon: ReactNode; gesture: string; action: string; music?: boolean; voice?: boolean }[] = [
  { icon: <Hand className="size-3.5" />, gesture: "Acenar", action: "o F.E.A.R. acena de volta" },
  { icon: <Hand className="size-3.5" />, gesture: "Palma parada (1 s)", action: "play/pause", music: true },
  {
    icon: <ArrowRight className="size-3.5" />,
    gesture: "Deslizar para a direita",
    action: "próxima",
    music: true,
  },
  {
    icon: <ArrowLeft className="size-3.5" />,
    gesture: "Deslizar para a esquerda",
    action: "anterior",
    music: true,
  },
  { icon: <Grab className="size-3.5" />, gesture: "Punho fechado (0,7 s)", action: "silencia o F.E.A.R." },
  {
    icon: <Pointer className="size-3.5" />,
    gesture: "Apontar para cima (0,6 s)",
    action: "fala com o F.E.A.R.",
    voice: true,
  },
];

// The same gestures, short enough for the voice interface's narrow column.
const HUD_LEGEND: { icon: ReactNode; gesture: string; action: string; music?: boolean; voice?: boolean }[] = [
  { icon: <Pointer className="size-3.5" />, gesture: "Apontar para cima", action: "falar", voice: true },
  { icon: <Grab className="size-3.5" />, gesture: "Punho fechado", action: "silêncio" },
  { icon: <Hand className="size-3.5" />, gesture: "Acenar", action: "aceno de volta" },
  { icon: <Hand className="size-3.5" />, gesture: "Palma parada", action: "play/pause", music: true },
  {
    icon: <ArrowLeftRight className="size-3.5" />,
    gesture: "Deslizar",
    action: "próxima/anterior",
    music: true,
  },
];

const FEEDBACK_VISIBLE_MS = 4000;

const PRIVACY_NOTE =
  "A imagem da câmera é processada aqui mesmo e não sai deste computador. A câmera desliga sozinha quando a janela fica oculta.";

/** What the camera sees, mirrored like a selfie, with the tracked hand drawn on top. */
function CameraView({
  videoRef,
  canvasRef,
  status,
  error,
  className,
  title,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  canvasRef: RefObject<HTMLCanvasElement>;
  status: GestureStatus;
  error: string | null;
  className: string;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={className} title={title}>
      <video
        ref={videoRef}
        muted
        playsInline
        aria-hidden
        className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
      />
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full object-cover" />
      {status !== "watching" && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-[12px] text-muted-foreground">
          {status === "starting" ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Ligando a câmera…
            </span>
          ) : status === "error" ? (
            <span className="flex flex-col items-center gap-2">
              <CameraOff className="size-5 text-danger" />
              {error}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Camera className="size-4" /> A câmera volta quando a janela estiver visível.
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function GesturePanel({
  onCommand,
  onTurnOff,
  feedback,
  musicAvailable,
  voiceAvailable = false,
  onHand,
  look = "deck",
}: {
  onCommand: (command: GestureCommand) => void;
  onTurnOff: () => void;
  feedback: GestureFeedback | null;
  musicAvailable: boolean;
  voiceAvailable?: boolean;
  onHand?: (hand: HandSample | null) => void;
  /** "hud": framed and compact, for the voice interface. */
  look?: "deck" | "hud";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status, error, pose } = useHandGestures({ enabled: true, onCommand, videoRef, canvasRef, onHand });

  // The last command stays on screen for a few seconds, then fades out.
  const [showFeedback, setShowFeedback] = useState(false);
  useEffect(() => {
    if (!feedback) return;
    setShowFeedback(true);
    const timer = setTimeout(() => setShowFeedback(false), FEEDBACK_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  const live = status === "watching";
  const statusDot = (
    <span
      className={`size-2 rounded-full ${
        live
          ? "bg-brand shadow-[0_0_8px_2px_rgba(34,211,238,0.5)]"
          : status === "error"
            ? "bg-danger"
            : "bg-overlay/25"
      }`}
    />
  );
  const closeButton = (
    <button
      type="button"
      onClick={onTurnOff}
      aria-label="Desligar os gestos"
      className="tap grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-overlay/[0.06] hover:text-foreground"
    >
      <X className="size-3.5" />
    </button>
  );

  if (look === "hud") {
    return (
      <HudPanel
        title="Gestos"
        label="Gestos com as mãos"
        aside={
          <span className="flex items-center">
            <span className="sr-only" role="status" aria-live="polite">
              {STATUS_LABEL[status]}
            </span>
            {closeButton}
          </span>
        }
      >
        {/* Narrower on short windows, so the column still fits without scrolling. */}
        <CameraView
          videoRef={videoRef}
          canvasRef={canvasRef}
          status={status}
          error={error}
          className="relative mx-auto aspect-[4/3] w-full max-w-[28vh] overflow-hidden rounded-md bg-[#02050a]"
          title={PRIVACY_NOTE}
        >
          {live && (
            <span
              aria-hidden
              className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-100/85"
            >
              {statusDot}
              ao vivo
            </span>
          )}
          {live && (
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-1 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-5">
              {feedback && showFeedback && (
                <span
                  key={feedback.at}
                  className="max-w-full truncate rounded border border-amber-300/40 bg-black/50 px-1.5 py-0.5 text-[11px] text-amber-100"
                >
                  {feedback.title}
                  {feedback.detail ? ` · ${feedback.detail}` : ""}
                </span>
              )}
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-100/85">
                {pose ? POSE_LABEL[pose] : "Procurando sua mão…"}
              </span>
            </div>
          )}
        </CameraView>
        <ul className="mt-2.5 space-y-1 [@media(max-height:790px)]:hidden">
          {HUD_LEGEND.map((item) => {
            const unavailable = (item.music && !musicAvailable) || (item.voice && !voiceAvailable);
            return (
              <li
                key={item.gesture}
                className={`flex items-center gap-2 text-[11px] ${unavailable ? "opacity-40" : ""}`}
              >
                <span className="text-cyan-300/70">{item.icon}</span>
                <span className="text-cyan-50/75">{item.gesture}</span>
                <span className="ml-auto text-white/40">{item.action}</span>
              </li>
            );
          })}
        </ul>
      </HudPanel>
    );
  }

  return (
    <section className="panel p-4" aria-label="Gestos com as mãos">
      <div className="flex items-center justify-between">
        <span className="label-tn flex items-center gap-2">
          <Hand className="size-3.5 text-brand/70" /> Gestos
        </span>
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5" role="status" aria-live="polite">
            {statusDot}
            {STATUS_LABEL[status]}
          </span>
          {closeButton}
        </span>
      </div>

      <CameraView
        videoRef={videoRef}
        canvasRef={canvasRef}
        status={status}
        error={error}
        className="relative mt-3 aspect-[4/3] overflow-hidden rounded-xl bg-[hsl(var(--stage))]"
      />

      <div className="mt-2 flex min-h-[1.5rem] items-center justify-between gap-2 text-[12px]">
        <span className="text-foreground/70">
          {live ? (pose ? POSE_LABEL[pose] : "Procurando sua mão…") : null}
        </span>
        {feedback && showFeedback && (
          <span
            key={feedback.at}
            className="truncate rounded-lg border border-brand/30 bg-brand/[0.08] px-2 py-0.5 text-[11px] text-brand"
          >
            {feedback.title}
            {feedback.detail ? ` · ${feedback.detail}` : ""}
          </span>
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {LEGEND.map((item) => {
          const unavailable = (item.music && !musicAvailable) || (item.voice && !voiceAvailable);
          return (
            <li
              key={item.gesture}
              className={`flex items-center gap-2 text-[11px] ${unavailable ? "opacity-45" : ""}`}
            >
              <span className="text-brand/70">{item.icon}</span>
              <span className="text-foreground/75">{item.gesture}</span>
              <span className="ml-auto text-muted-foreground">
                {item.action}
                {item.music ? " na música" : ""}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-[10px] leading-4 text-muted-foreground/60">{PRIVACY_NOTE}</p>
    </section>
  );
}
