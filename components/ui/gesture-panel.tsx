"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, CameraOff, Grab, Hand, Loader2, X } from "lucide-react";

import type { GestureCommand, HandPose } from "@/lib/hand-gestures";
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

const LEGEND: { icon: ReactNode; gesture: string; action: string; spotify?: boolean }[] = [
  { icon: <Hand className="size-3.5" />, gesture: "Acenar", action: "o F.E.A.R. acena de volta" },
  { icon: <Hand className="size-3.5" />, gesture: "Palma parada (1 s)", action: "play/pause", spotify: true },
  {
    icon: <ArrowRight className="size-3.5" />,
    gesture: "Deslizar para a direita",
    action: "próxima",
    spotify: true,
  },
  {
    icon: <ArrowLeft className="size-3.5" />,
    gesture: "Deslizar para a esquerda",
    action: "anterior",
    spotify: true,
  },
  { icon: <Grab className="size-3.5" />, gesture: "Punho fechado (0,7 s)", action: "silencia o F.E.A.R." },
];

const FEEDBACK_VISIBLE_MS = 4000;

export function GesturePanel({
  onCommand,
  onTurnOff,
  feedback,
  spotifyAvailable,
}: {
  onCommand: (command: GestureCommand) => void;
  onTurnOff: () => void;
  feedback: GestureFeedback | null;
  spotifyAvailable: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status, error, pose } = useHandGestures({ enabled: true, onCommand, videoRef, canvasRef });

  // The last command stays on screen for a few seconds, then fades out.
  const [showFeedback, setShowFeedback] = useState(false);
  useEffect(() => {
    if (!feedback) return;
    setShowFeedback(true);
    const timer = setTimeout(() => setShowFeedback(false), FEEDBACK_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  const live = status === "watching";

  return (
    <section className="panel p-4" aria-label="Gestos com as mãos">
      <div className="flex items-center justify-between">
        <span className="label-tn flex items-center gap-2">
          <Hand className="size-3.5 text-brand/70" /> Gestos
        </span>
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5" role="status" aria-live="polite">
            <span
              className={`size-2 rounded-full ${
                live
                  ? "bg-brand shadow-[0_0_8px_2px_rgba(34,211,238,0.5)]"
                  : status === "error"
                    ? "bg-danger"
                    : "bg-overlay/25"
              }`}
            />
            {STATUS_LABEL[status]}
          </span>
          <button
            type="button"
            onClick={onTurnOff}
            aria-label="Desligar os gestos"
            className="tap grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-overlay/[0.06] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      </div>

      {/* Mirrored like a selfie camera, with the tracked hand drawn on top. */}
      <div className="relative mt-3 aspect-[4/3] overflow-hidden rounded-xl bg-[hsl(var(--stage))]">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-hidden
          className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
        />
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full object-cover" />
        {!live && (
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
      </div>

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
          const unavailable = item.spotify && !spotifyAvailable;
          return (
            <li
              key={item.gesture}
              className={`flex items-center gap-2 text-[11px] ${unavailable ? "opacity-45" : ""}`}
            >
              <span className="text-brand/70">{item.icon}</span>
              <span className="text-foreground/75">{item.gesture}</span>
              <span className="ml-auto text-muted-foreground">
                {item.action}
                {item.spotify ? " no Spotify" : ""}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-[10px] leading-4 text-muted-foreground/60">
        A imagem da câmera é processada aqui mesmo e não sai deste computador. A câmera desliga sozinha quando
        a janela fica oculta.
      </p>
    </section>
  );
}
