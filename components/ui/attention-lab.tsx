"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { sendCommand } from "@/lib/api";
import type { AttentionTracker, AttentionTrackerFactory } from "@/lib/attention-tracker";
import type { FacePoint } from "@/lib/attention-worker";
import { isPageShown, onPageShownChange } from "@/lib/page-visibility";
import {
  type Calibration,
  extractGazeFeatures,
  fitCalibration,
  predictGaze,
  resolveAttentionTarget,
  validationError,
} from "@/lib/visual-attention";

type Phase =
  | "off"
  | "loading"
  | "ready"
  | "calibrating"
  | "validating"
  | "tracking"
  | "paused"
  | "rejected"
  | "error";
type Sample = { features: number[]; x: number; y: number };
type Viewport = { width: number; height: number };
type Geometry = Viewport & { screenX: number; screenY: number; devicePixelRatio: number };
type GazePoint = { x: number; y: number; t: number };
type Collection = {
  phase: "calibrating" | "validating";
  index: number;
  startedAt: number;
  lastFrameAt: number;
  frames: number[][];
};

const CALIBRATION_POINTS = [
  [0.12, 0.12],
  [0.5, 0.12],
  [0.88, 0.12],
  [0.88, 0.5],
  [0.5, 0.5],
  [0.12, 0.5],
  [0.12, 0.88],
  [0.5, 0.88],
  [0.88, 0.88],
];
// Deliberately different from training points: fitting is not validation.
const VALIDATION_POINTS = [
  [0.3, 0.23],
  [0.73, 0.34],
  [0.32, 0.72],
  [0.72, 0.78],
];
const buttonClass =
  "rounded-xl border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40";

function windowGeometry(): Geometry {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function geometryMatches(a: Geometry, b: Geometry): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.screenX === b.screenX &&
    a.screenY === b.screenY &&
    a.devicePixelRatio === b.devicePixelRatio
  );
}

const loadTracker: AttentionTrackerFactory = async (onFrame, onError) => {
  const { createAttentionTracker } = await import("@/lib/attention-tracker");
  return createAttentionTracker(onFrame, onError);
};

function summarizeFrames(frames: number[][]): number[] | null {
  if (frames.length < 10 || !frames[0]?.length) return null;
  const width = frames[0].length;
  if (frames.some((frame) => frame.length !== width || frame.some((v) => !Number.isFinite(v)))) return null;
  return Array.from({ length: width }, (_, i) => {
    const values = frames.map((frame) => frame[i]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  });
}

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "O acesso à câmera foi bloqueado. Libere a permissão do navegador para tentar novamente.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "Nenhuma câmera disponível foi encontrada.";
  if (name === "NotReadableError" || name === "AbortError")
    return "Não consegui abrir a câmera. Confira se outro aplicativo está usando ela.";
  return "Não consegui iniciar a percepção visual. Confira a câmera e os arquivos locais do modelo.";
}

/** Experimental, explicit opt-in, and confined to marked content on this page. */
export function AttentionLab({ createTracker = loadTracker }: { createTracker?: AttentionTrackerFactory }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<AttentionTracker | null>(null);
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  const focusedRef = useRef(true);
  const phaseRef = useRef<Phase>("off");
  const viewportRef = useRef<Viewport>({ width: 0, height: 0 });
  const geometryRef = useRef<Geometry | null>(null);
  const lastFrameAtRef = useRef(-Infinity);
  const collectionRef = useRef<Collection | null>(null);
  const trainingRef = useRef<Sample[]>([]);
  const validationRef = useRef<Sample[]>([]);
  const calibrationRef = useRef<Calibration | null>(null);
  const errorPixelsRef = useRef<number | null>(null);
  const latestPointRef = useRef<GazePoint | null>(null);
  const clickPointRef = useRef<GazePoint | null>(null);
  const sendingRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("off");
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [faceFound, setFaceFound] = useState(false);
  const [targetIndex, setTargetIndex] = useState(0);
  const [collected, setCollected] = useState(0);
  const [point, setPoint] = useState<GazePoint | null>(null);
  const [errorPixels, setErrorPixels] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearEstimate = useCallback(() => {
    latestPointRef.current = null;
    clickPointRef.current = null;
    setPoint(null);
  }, []);

  const resetCalibration = useCallback(() => {
    calibrationRef.current = null;
    geometryRef.current = null;
    collectionRef.current = null;
    trainingRef.current = [];
    validationRef.current = [];
    errorPixelsRef.current = null;
    setErrorPixels(null);
    setCollected(0);
    clearEstimate();
  }, [clearEstimate]);

  const stop = useCallback(
    (next: Phase = "off") => {
      runRef.current++;
      trackerRef.current?.close();
      trackerRef.current = null;
      resetCalibration();
      setFaceFound(false);
      changePhase(next);
    },
    [changePhase, resetCalibration],
  );

  const checkGeometry = useCallback(() => {
    if (!geometryRef.current) return true;
    const current = windowGeometry();
    if (geometryMatches(geometryRef.current, current)) return true;
    viewportRef.current = current;
    setViewport(current);
    resetCalibration();
    if (trackerRef.current) {
      changePhase("ready");
      setMessage("O tamanho, a posição ou a escala da janela mudou. Calibre novamente para esta janela.");
    }
    return false;
  }, [changePhase, resetCalibration]);

  const receiveFrame = useCallback(
    (t: number, landmarks: FacePoint[] | null) => {
      lastFrameAtRef.current = t;
      if (!focusedRef.current || !checkGeometry()) return;
      if (performance.now() - t > 500) {
        clearEstimate();
        setFaceFound(false);
        return;
      }
      const features = landmarks ? extractGazeFeatures(landmarks) : null;
      setFaceFound(features !== null);
      const collection = collectionRef.current;
      if (!features) {
        clearEstimate();
        if (collection) {
          collection.frames = [];
          collection.startedAt = t;
          setCollected(0);
        }
        return;
      }
      if (collection) {
        collection.lastFrameAt = t;
        // Let the eyes settle after each target change before collecting a batch.
        if (t - collection.startedAt >= 500) {
          collection.frames.push(features);
          if (collection.frames.length > 30) collection.frames.shift();
          setCollected(Math.min(10, collection.frames.length));
        }
        return;
      }
      if (phaseRef.current !== "tracking" || !calibrationRef.current) return;
      const estimate = predictGaze(calibrationRef.current, features);
      const { width, height } = viewportRef.current;
      if (!estimate || estimate.x < 0 || estimate.y < 0 || estimate.x >= width || estimate.y >= height) {
        clearEstimate();
        return;
      }
      const previous = latestPointRef.current;
      const next = {
        x: previous ? previous.x * 0.45 + estimate.x * 0.55 : estimate.x,
        y: previous ? previous.y * 0.45 + estimate.y * 0.55 : estimate.y,
        t,
      };
      latestPointRef.current = next;
      setPoint(next);
    },
    [checkGeometry, clearEstimate],
  );

  const start = useCallback(async () => {
    if (!isPageShown()) return;
    stop("loading");
    setMessage(null);
    setReply(null);
    const run = runRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof Worker === "undefined") {
        throw new Error("Este navegador não oferece câmera e Web Worker.");
      }
      const tracker = await createTracker(
        (t, landmarks) => {
          if (mountedRef.current && run === runRef.current) receiveFrame(t, landmarks);
        },
        (failure) => {
          if (!mountedRef.current || run !== runRef.current) return;
          stop("error");
          setMessage(cameraError(failure));
        },
      );
      if (!mountedRef.current || run !== runRef.current || !isPageShown() || !videoRef.current) {
        tracker.close();
        return;
      }
      trackerRef.current = tracker;
      await tracker.start(videoRef.current);
      if (!mountedRef.current || run !== runRef.current || !isPageShown()) {
        tracker.close();
        return;
      }
      changePhase("ready");
    } catch (failure) {
      if (!mountedRef.current || run !== runRef.current) return;
      stop("error");
      setMessage(cameraError(failure));
    }
  }, [changePhase, createTracker, receiveFrame, stop]);

  const beginCalibration = useCallback(() => {
    if (!focusedRef.current || !isPageShown()) return;
    resetCalibration();
    setMessage(null);
    const size = { width: window.innerWidth, height: window.innerHeight };
    viewportRef.current = size;
    setViewport(size);
    geometryRef.current = windowGeometry();
    collectionRef.current = {
      phase: "calibrating",
      index: 0,
      startedAt: performance.now(),
      lastFrameAt: -Infinity,
      frames: [],
    };
    setTargetIndex(0);
    changePhase("calibrating");
  }, [changePhase, resetCalibration]);

  const advanceTarget = useCallback(() => {
    if (!focusedRef.current || !checkGeometry()) return;
    const collection = collectionRef.current;
    if (!collection || performance.now() - collection.lastFrameAt > 500) return;
    const features = summarizeFrames(collection.frames);
    if (!features) return;
    const targets = collection.phase === "calibrating" ? CALIBRATION_POINTS : VALIDATION_POINTS;
    const [rx, ry] = targets[collection.index];
    const { width, height } = viewportRef.current;
    const sample = { features, x: rx * width, y: ry * height };
    const samples = collection.phase === "calibrating" ? trainingRef.current : validationRef.current;
    if (collection.phase === "calibrating") samples.push(sample);
    else samples.push(...collection.frames.map((frame) => ({ features: frame, x: sample.x, y: sample.y })));
    if (collection.index + 1 < targets.length) {
      collectionRef.current = {
        ...collection,
        index: collection.index + 1,
        startedAt: performance.now(),
        lastFrameAt: -Infinity,
        frames: [],
      };
      setTargetIndex(collection.index + 1);
      setCollected(0);
      return;
    }
    if (collection.phase === "calibrating") {
      const fitted = fitCalibration(trainingRef.current);
      if (!fitted) {
        collectionRef.current = null;
        changePhase("rejected");
        setMessage(
          "Não consegui distinguir os pontos. Ajuste a luz, mantenha a cabeça parada e tente novamente.",
        );
        return;
      }
      calibrationRef.current = fitted;
      collectionRef.current = {
        phase: "validating",
        index: 0,
        startedAt: performance.now(),
        lastFrameAt: -Infinity,
        frames: [],
      };
      setTargetIndex(0);
      setCollected(0);
      changePhase("validating");
      return;
    }
    collectionRef.current = null;
    const rms = calibrationRef.current
      ? validationError(calibrationRef.current, validationRef.current)
      : Infinity;
    errorPixelsRef.current = Number.isFinite(rms) ? rms : null;
    setErrorPixels(errorPixelsRef.current);
    if (!Number.isFinite(rms) || rms > 0.12 * Math.min(width, height)) {
      calibrationRef.current = null;
      changePhase("rejected");
      setMessage(
        "A validação ficou imprecisa demais para indicar conteúdo. Recalibre com boa luz e a cabeça na mesma posição.",
      );
      return;
    }
    changePhase("tracking");
    setMessage("Olhe para um cartão e pressione G para perguntar sobre a região estimada.");
  }, [changePhase, checkGeometry]);

  const ask = useCallback(
    async (frozenPoint?: GazePoint | null) => {
      if (
        sendingRef.current ||
        phaseRef.current !== "tracking" ||
        !isPageShown() ||
        !focusedRef.current ||
        !checkGeometry()
      )
        return;
      const gaze = frozenPoint ?? latestPointRef.current;
      if (!gaze || performance.now() - gaze.t > 500) {
        setMessage("Não há uma estimativa recente. Olhe para um cartão, com o rosto visível, e pressione G.");
        return;
      }
      // Resolve at the instant of the explicit request, never collect the whole page.
      const target = resolveAttentionTarget(document, gaze.x, gaze.y);
      if (!target) {
        setMessage("Essa região não contém um cartão do laboratório. Olhe para um cartão e pressione G.");
        return;
      }
      const run = runRef.current;
      const { width, height } = viewportRef.current;
      sendingRef.current = true;
      setSending(true);
      setMessage(null);
      try {
        const result = await sendCommand({
          text: "O que é isso que estou olhando?",
          speaker: "user",
          speak: false,
          visual_attention: {
            source: "webcam-calibrated",
            coordinate_space: "viewport-css-pixels",
            x: gaze.x,
            y: gaze.y,
            viewport_width: width,
            viewport_height: height,
            captured_at_ms: Date.now(),
            calibration_error_px: errorPixelsRef.current ?? 0,
            target,
          },
        });
        if (mountedRef.current && run === runRef.current) setReply(result.reply);
      } catch {
        if (mountedRef.current && run === runRef.current)
          setMessage(
            "Não consegui consultar o F.E.A.R. Entre na tela principal e confira a conexão com o assistente.",
          );
      } finally {
        sendingRef.current = false;
        if (mountedRef.current) setSending(false);
      }
    },
    [checkGeometry],
  );

  useEffect(() => {
    mountedRef.current = true;
    const size = { width: window.innerWidth, height: window.innerHeight };
    viewportRef.current = size;
    setViewport(size);
    const unsubscribe = onPageShownChange(() => {
      if (!isPageShown() && !["off", "paused", "error"].includes(phaseRef.current)) stop("paused");
    });
    const resize = () => {
      if (!checkGeometry()) return;
      const next = { width: window.innerWidth, height: window.innerHeight };
      if (next.width === viewportRef.current.width && next.height === viewportRef.current.height) return;
      viewportRef.current = next;
      setViewport(next);
      resetCalibration();
      if (trackerRef.current) {
        changePhase("ready");
        setMessage("O tamanho, a posição ou a escala da janela mudou. Calibre novamente para esta janela.");
      }
    };
    const blur = () => {
      focusedRef.current = false;
      clearEstimate();
      setFaceFound(false);
      if (geometryRef.current) {
        resetCalibration();
        changePhase("ready");
        setMessage("A janela perdeu o foco. Calibre novamente antes de usar o olhar.");
      }
    };
    const focus = () => {
      focusedRef.current = true;
      clearEstimate();
    };
    const monitor = setInterval(() => {
      if (!checkGeometry()) return;
      if (performance.now() - lastFrameAtRef.current <= 500 || !trackerRef.current) return;
      clearEstimate();
      setFaceFound(false);
      const collection = collectionRef.current;
      if (collection) {
        collection.frames = [];
        collection.startedAt = performance.now();
        collection.lastFrameAt = -Infinity;
        setCollected(0);
      }
    }, 500);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("scroll", clearEstimate, true);
    return () => {
      mountedRef.current = false;
      runRef.current++;
      trackerRef.current?.close();
      trackerRef.current = null;
      unsubscribe();
      clearInterval(monitor);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("scroll", clearEstimate, true);
    };
  }, [changePhase, checkGeometry, clearEstimate, resetCalibration, stop]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (
        event.repeat ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        element?.closest("input, textarea, select, [contenteditable='true']")
      )
        return;
      if (event.code === "Space" && collectionRef.current) {
        event.preventDefault();
        advanceTarget();
      } else if (event.key.toLowerCase() === "g" && phaseRef.current === "tracking") {
        event.preventDefault();
        void ask(latestPointRef.current ? { ...latestPointRef.current } : null);
      } else if (event.key === "Escape" && collectionRef.current) {
        resetCalibration();
        changePhase("ready");
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [advanceTarget, ask, changePhase, resetCalibration]);

  const collecting = phase === "calibrating" || phase === "validating";
  const targets = phase === "validating" ? VALIDATION_POINTS : CALIBRATION_POINTS;
  const target = targets[targetIndex] ?? targets[0];
  const active = !["off", "paused", "error"].includes(phase);
  const estimatedTarget = point ? resolveAttentionTarget(document, point.x, point.y) : null;

  return (
    <main className="min-h-screen bg-background px-6 py-8 text-foreground">
      <div className="mx-auto max-w-5xl space-y-7">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Voltar ao F.E.A.R.
        </Link>
        <header className="space-y-3">
          <p className="text-xs uppercase tracking-widest text-primary">Visual Attention · experimental</p>
          <h1 className="text-3xl font-semibold">Uma primeira conversa com o olhar</h1>
          <p className="max-w-3xl text-muted-foreground">
            Calibre a webcam para estimar uma região desta página. Depois, olhe para um cartão e pressione{" "}
            <kbd className="rounded border border-border px-1">G</kbd> para perguntar ao F.E.A.R. sobre ele. O
            ponto é uma estimativa e pode errar.
          </p>
        </header>

        <section
          aria-label="Controle da câmera"
          className="flex flex-wrap items-center gap-5 rounded-2xl border border-border bg-card p-5"
        >
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Prévia local da câmera"
            className="h-24 w-32 rounded-lg bg-black object-cover [transform:scaleX(-1)]"
          />
          <div className="flex-1 space-y-3">
            <p role="status" className="text-sm">
              {phase === "loading"
                ? "Preparando o modelo local e a câmera…"
                : phase === "paused"
                  ? "Câmera desligada enquanto a página está oculta. Retome e calibre novamente."
                  : active
                    ? faceFound
                      ? "Rosto e olhos visíveis."
                      : "Mantenha o rosto visível, com boa iluminação."
                    : "A câmera está desligada."}
            </p>
            <div className="flex flex-wrap gap-2">
              {!active ? (
                <button
                  type="button"
                  className={`${buttonClass} bg-primary text-primary-foreground`}
                  onClick={() => void start()}
                >
                  {phase === "paused" ? "Retomar câmera" : "Iniciar câmera"}
                </button>
              ) : (
                <button type="button" className={buttonClass} onClick={() => stop()}>
                  Desligar câmera
                </button>
              )}
              {["ready", "rejected", "tracking"].includes(phase) && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!faceFound}
                  onClick={beginCalibration}
                >
                  {phase === "tracking" ? "Recalibrar" : "Calibrar 9 pontos"}
                </button>
              )}
              {phase === "tracking" && (
                <button
                  type="button"
                  className={`${buttonClass} bg-primary text-primary-foreground`}
                  disabled={!point || sending}
                  onPointerDown={() => {
                    clickPointRef.current = latestPointRef.current ? { ...latestPointRef.current } : null;
                  }}
                  onClick={() => {
                    const frozen = clickPointRef.current;
                    clickPointRef.current = null;
                    void ask(frozen);
                  }}
                >
                  {sending ? "Perguntando…" : "Perguntar (G)"}
                </button>
              )}
            </div>
          </div>
        </section>

        <p className="text-sm text-muted-foreground">
          As imagens são processadas localmente e não são gravadas. Ao pressionar G, apenas a coordenada e o
          texto de um cartão marcado são enviados ao assistente. Esta etapa funciona somente nesta página, sem
          leitura de outras janelas, inferência de emoções ou ações automáticas. Mantenha a cabeça na mesma
          posição; recalibre se mudar de postura, distância ou câmera.
        </p>
        {errorPixels !== null && (
          <p className="text-sm">
            Erro de validação: {Math.round(errorPixels)} px RMS das amostras em 4 pontos novos. Limite:{" "}
            {Math.round(0.12 * Math.min(viewport.width, viewport.height))} px.{" "}
            {phase === "tracking" ? "Calibração aceita para este teste." : "Recalibração necessária."}
          </p>
        )}
        {phase === "tracking" && (
          <p className="text-sm text-primary">
            Região estimada: {estimatedTarget?.label ?? "fora dos cartões"}. Pressione G sem desviar o olhar.
          </p>
        )}
        {message && (
          <p role="status" className="rounded-xl border border-border p-4 text-sm">
            {message}
          </p>
        )}
        {reply && (
          <section
            aria-label="Resposta do F.E.A.R."
            className="rounded-2xl border border-primary/30 bg-card p-5"
          >
            <h2 className="mb-2 font-semibold">F.E.A.R.</h2>
            <p className="whitespace-pre-wrap">{reply}</p>
          </section>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <article
            data-visual-attention-target="Estação lunar"
            aria-label="Estação lunar"
            role="group"
            className="min-h-52 rounded-2xl border border-border bg-card p-7"
          >
            <h2 className="mb-4 text-xl font-semibold">Estação lunar</h2>
            <p className="text-muted-foreground">
              Uma base na Lua precisa de energia, proteção contra radiação e reciclagem de água. Os desafios
              mudam conforme a região, a duração da missão e o número de pessoas.
            </p>
          </article>
          <article
            data-visual-attention-target="Jardim automatizado"
            aria-label="Jardim automatizado"
            role="group"
            className="min-h-52 rounded-2xl border border-border bg-card p-7"
          >
            <h2 className="mb-4 text-xl font-semibold">Jardim automatizado</h2>
            <p className="text-muted-foreground">
              Sensores de umidade ajudam a decidir quando regar as plantas. A luz disponível, o tipo de solo e
              a espécie também influenciam a frequência e a quantidade de água.
            </p>
          </article>
          <article
            data-visual-attention-target="Música e atenção"
            aria-label="Música e atenção"
            role="group"
            className="min-h-52 rounded-2xl border border-border bg-card p-7"
          >
            <h2 className="mb-4 text-xl font-semibold">Música e atenção</h2>
            <p className="text-muted-foreground">
              Uma playlist pode acompanhar estudo, descanso ou exercício. Preferências e contexto variam: o
              usuário pode dizer qual atividade quer fazer e ajustar a seleção.
            </p>
          </article>
          <article
            data-visual-attention-target="Próxima etapa do JARVIS"
            aria-label="Próxima etapa do JARVIS"
            role="group"
            className="min-h-52 rounded-2xl border border-border bg-card p-7"
          >
            <h2 className="mb-4 text-xl font-semibold">Próxima etapa do JARVIS</h2>
            <p className="text-muted-foreground">
              Depois de medir a precisão do olhar neste laboratório, uma integração futura pode relacionar
              regiões a conteúdos autorizados de um navegador ou de uma janela do computador.
            </p>
          </article>
        </div>
      </div>

      {phase === "tracking" && point && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-300 bg-cyan-300/20 shadow-[0_0_18px_#67e8f9]"
          style={{ left: point.x, top: point.y }}
        />
      )}
      {collecting && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={phase === "calibrating" ? "Calibração do olhar" : "Validação do olhar"}
          className="fixed inset-0 z-50 bg-background/95"
        >
          <div className="pointer-events-none absolute left-1/2 top-1/3 w-80 -translate-x-1/2 space-y-2 text-center">
            <p className="font-semibold">
              {phase === "calibrating" ? "Calibrando" : "Validando"}: ponto {targetIndex + 1} de{" "}
              {targets.length}
            </p>
            <p className="text-sm text-muted-foreground">
              Fixe o olhar no círculo. Mantenha a cabeça parada.{" "}
              {collected >= 10
                ? "Pressione Espaço para continuar sem desviar o olhar."
                : `Coletando ${collected}/10 amostras…`}
            </p>
            {!faceFound && (
              <p className="text-sm text-rose-400">
                Rosto não encontrado. A coleta deste ponto foi reiniciada.
              </p>
            )}
          </div>
          <div
            aria-label="Alvo de calibração"
            className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-300 bg-cyan-300/30 shadow-[0_0_30px_#67e8f9]"
            style={{ left: target[0] * viewport.width, top: target[1] * viewport.height }}
          >
            <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
          </div>
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                resetCalibration();
                changePhase("ready");
              }}
            >
              Cancelar (Esc)
            </button>
            <button type="button" className={buttonClass} disabled={collected < 10} onClick={advanceTarget}>
              Próximo (Espaço)
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
