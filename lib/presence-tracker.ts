// The camera side of presence. Loaded only when presence is switched on. It
// opens the webcam small (no preview: nothing is drawn on screen) and, twice a
// second, asks the worker whether a face is in view. Frames never leave the
// machine and none is kept.

import type { PresenceReply, PresenceRequest } from "@/lib/presence-worker";

const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/face_detector.tflite";
// Plenty to notice someone sitting down or getting up.
const GLANCE_EVERY_MS = 500;

export type GlanceListener = (t: number, face: boolean) => void;

export interface PresenceTracker {
  start(): Promise<void>;
  /** Turn the camera off (the model stays loaded for a quick restart). */
  stop(): void;
  /** Stop and free the model. */
  close(): void;
}

export type PresenceTrackerFactory = (onGlance: GlanceListener) => Promise<PresenceTracker>;

export const createPresenceTracker: PresenceTrackerFactory = async (onGlance) => {
  const worker = new Worker(new URL("./presence-worker.ts", import.meta.url));
  const send = (message: PresenceRequest, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);

  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<PresenceReply>) => {
        if (event.data.type === "ready") resolve();
        else if (event.data.type === "error") reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || "presence worker failed to start"));
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
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  worker.onmessage = (event: MessageEvent<PresenceReply>) => {
    const reply = event.data;
    if (reply.type !== "result") return;
    inFlight = false;
    if (reply.session === session) onGlance(reply.t, reply.face);
  };

  function release(): void {
    clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
  }

  return {
    async start() {
      const mySession = ++session;
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
        audio: false,
      });
      if (mySession !== session) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      video.srcObject = media;
      await video.play();
      if (mySession !== session) return;
      timer = setInterval(() => {
        if (inFlight || video.readyState < 2) return;
        inFlight = true;
        const t = performance.now();
        createImageBitmap(video).then(
          (bitmap) => {
            if (mySession !== session) {
              bitmap.close();
              inFlight = false;
              return;
            }
            send({ type: "frame", bitmap, t, session: mySession }, [bitmap]);
          },
          () => {
            inFlight = false;
          },
        );
      }, GLANCE_EVERY_MS);
    },
    stop() {
      session++;
      release();
    },
    close() {
      session++;
      release();
      send({ type: "close" });
      setTimeout(() => worker.terminate(), 1000);
    },
  };
};
