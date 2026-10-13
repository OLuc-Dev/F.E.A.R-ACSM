// The camera side of hand gestures. Loaded only when gestures are switched on
// (keeping MediaPipe off everyone else's page load). The recognizer itself runs
// in a Web Worker (hand-worker.ts) so it never competes with the UI and the
// robot for the main thread. Frames never leave the machine: the model, its
// WASM runtime and the video all stay local.

import type { HandPose, HandSample } from "@/lib/hand-gestures";
import type { WorkerReply, WorkerRequest } from "@/lib/hand-worker";

// Served from public/mediapipe (the model is vendored; the WASM is copied out of
// node_modules by scripts/copy-mediapipe.mjs before dev/build).
const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/gesture_recognizer.task";
// Enough for gestures, at a fraction of the CPU a full 30 fps would take.
const FRAME_INTERVAL_MS = 1000 / 15;
const MIN_POSE_SCORE = 0.6;
// Wrist + the four knuckles: a palm centre steadier than any single landmark.
const PALM_POINTS = [0, 5, 9, 13, 17];

const SKELETON_COLOR = "#67e8f9";
const JOINT_COLOR = "#fbb62d";

type Point = { x: number; y: number };
type Connection = { start: number; end: number };

export type FrameListener = (t: number, hand: HandSample | null) => void;

export interface HandTracker {
  /** Open the camera into `video` and start recognizing; `canvas` gets the skeleton. */
  start(video: HTMLVideoElement, canvas?: HTMLCanvasElement | null): Promise<void>;
  /** Turn the camera off (the model stays loaded for a quick restart). */
  stop(): void;
  /** Stop and free the model. */
  close(): void;
}

export type HandTrackerFactory = (onFrame: FrameListener) => Promise<HandTracker>;

export const createHandTracker: HandTrackerFactory = async (onFrame) => {
  const worker = new Worker(new URL("./hand-worker.ts", import.meta.url));
  const send = (message: WorkerRequest, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);

  let connections: Connection[] = [];
  try {
    connections = await new Promise<Connection[]>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.type === "ready") resolve(event.data.connections);
        else if (event.data.type === "error") reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || "hand worker failed to start"));
      // The worker resolves relative paths against its own script URL, not the page.
      send({
        type: "init",
        wasmPath: new URL(WASM_PATH, window.location.origin).href,
        modelPath: new URL(MODEL_PATH, window.location.origin).href,
      });
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }

  let session = 0;
  let stream: MediaStream | null = null;
  let videoElement: HTMLVideoElement | null = null;
  let canvasElement: HTMLCanvasElement | null = null;
  let frameRequest = 0;
  // One frame in flight at a time: a slow machine skips frames instead of
  // queueing them up behind each other.
  let inFlight = false;
  let lastSent = 0;

  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    if (reply.type !== "result") return;
    inFlight = false;
    if (reply.session !== session) return; // answered after a stop
    onFrame(reply.t, toHandSample(reply.landmarks, reply.gesture, reply.side));
    if (canvasElement && videoElement) drawHand(canvasElement, videoElement, reply.landmarks, connections);
  };

  function loop(mySession: number): void {
    if (mySession !== session || videoElement === null) return;
    const video = videoElement;
    const now = performance.now();
    if (!inFlight && video.readyState >= 2 && now - lastSent >= FRAME_INTERVAL_MS) {
      inFlight = true;
      lastSent = now;
      createImageBitmap(video).then(
        (bitmap) => {
          if (mySession !== session) {
            bitmap.close();
            inFlight = false;
            return;
          }
          send({ type: "frame", bitmap, t: now, session: mySession }, [bitmap]);
        },
        () => {
          inFlight = false;
        },
      );
    }
    frameRequest = requestAnimationFrame(() => loop(mySession));
  }

  function release(): void {
    cancelAnimationFrame(frameRequest);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (videoElement) videoElement.srcObject = null;
    if (canvasElement)
      canvasElement.getContext("2d")?.clearRect(0, 0, canvasElement.width, canvasElement.height);
  }

  return {
    async start(video, canvas) {
      const mySession = ++session;
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      // stop() ran while the camera was opening: hand it straight back.
      if (mySession !== session) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      videoElement = video;
      canvasElement = canvas ?? null;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = media;
      await video.play();
      if (mySession !== session) return;
      loop(mySession);
    },
    stop() {
      session++;
      release();
    },
    close() {
      session++;
      release();
      send({ type: "close" });
      // The worker closes itself after freeing the model; this is the backstop.
      setTimeout(() => worker.terminate(), 1000);
    },
  };
};

/** The worker's answer → the interpreter's view: pose + palm centre, mirrored. */
export function toHandSample(
  landmarks: Point[] | null,
  gesture: { name: string; score: number } | null,
  side: string | null = null,
): HandSample | null {
  if (!landmarks || landmarks.length < 21) return null;
  const pose = (gesture && gesture.score >= MIN_POSE_SCORE ? gesture.name : "None") as HandPose;
  let x = 0;
  let y = 0;
  for (const index of PALM_POINTS) {
    x += landmarks[index].x;
    y += landmarks[index].y;
  }
  // The camera sees you mirrored; flip x so "right" means your right.
  const hand: HandSample = { pose, x: 1 - x / PALM_POINTS.length, y: y / PALM_POINTS.length };
  if (side === "Left" || side === "Right") hand.side = side;
  return hand;
}

function drawHand(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  landmarks: Point[] | null,
  connections: Connection[],
): void {
  const width = video.videoWidth || 640;
  const height = video.videoHeight || 480;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (!landmarks) return;
  // Mirrored like the preview video, so the skeleton sits on your hand.
  const point = (landmark: Point): [number, number] => [(1 - landmark.x) * width, landmark.y * height];
  context.lineWidth = Math.max(2, width / 220);
  context.strokeStyle = SKELETON_COLOR;
  context.beginPath();
  for (const { start, end } of connections) {
    const [ax, ay] = point(landmarks[start]);
    const [bx, by] = point(landmarks[end]);
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
  }
  context.stroke();
  context.fillStyle = JOINT_COLOR;
  for (const landmark of landmarks) {
    const [px, py] = point(landmark);
    context.beginPath();
    context.arc(px, py, Math.max(2.5, width / 160), 0, Math.PI * 2);
    context.fill();
  }
}
