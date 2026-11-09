import type { AttentionWorkerReply, AttentionWorkerRequest, FacePoint } from "@/lib/attention-worker";

export type AttentionFrameListener = (t: number, landmarks: FacePoint[] | null) => void;
export interface AttentionTracker {
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  close(): void;
}
export type AttentionTrackerFactory = (
  onFrame: AttentionFrameListener,
  onError?: (error: Error) => void,
) => Promise<AttentionTracker>;

// This module and its worker are loaded only after an explicit camera request.
export const createAttentionTracker: AttentionTrackerFactory = async (onFrame, onError) => {
  const worker = new Worker(new URL("./attention-worker.ts", import.meta.url));
  const send = (request: AttentionWorkerRequest, transfer: Transferable[] = []) =>
    worker.postMessage(request, transfer);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("O modelo de olhar demorou para carregar.")), 45000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      worker.onmessage = ({ data }: MessageEvent<AttentionWorkerReply>) => {
        if (data.type === "ready") finish();
        else if (data.type === "error") finish(new Error(data.message));
      };
      worker.onerror = (event) => finish(new Error(event.message || "Falha no modelo de olhar."));
      send({
        type: "init",
        wasmPath: new URL("/mediapipe/wasm", window.location.origin).href,
        modelPath: new URL("/mediapipe/face_landmarker.task", window.location.origin).href,
      });
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }

  let session = 0;
  let closed = false;
  let stream: MediaStream | null = null;
  let videoElement: HTMLVideoElement | null = null;
  let frameRequest = 0;
  let lastSent = -Infinity;
  // Includes bitmap creation: slow devices never accumulate a frame queue.
  let pendingSession: number | null = null;

  function release() {
    cancelAnimationFrame(frameRequest);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (videoElement) videoElement.srcObject = null;
    videoElement = null;
  }

  worker.onmessage = ({ data }: MessageEvent<AttentionWorkerReply>) => {
    if (data.type !== "result") return;
    if (data.session === pendingSession) pendingSession = null;
    if (closed || data.session !== session) return;
    onFrame(data.t, data.landmarks);
  };
  worker.onerror = (event) => {
    session++;
    release();
    onError?.(new Error(event.message || "O reconhecimento de olhar foi interrompido."));
  };

  function loop(mySession: number) {
    if (closed || mySession !== session || !videoElement) return;
    const now = performance.now();
    if (pendingSession === null && videoElement.readyState >= 2 && now - lastSent >= 100) {
      pendingSession = mySession;
      lastSent = now;
      createImageBitmap(videoElement).then(
        (bitmap) => {
          if (closed || mySession !== session) {
            bitmap.close();
            if (pendingSession === mySession) pendingSession = null;
            return;
          }
          try {
            send({ type: "frame", bitmap, t: now, session: mySession }, [bitmap]);
          } catch {
            bitmap.close();
            if (pendingSession === mySession) pendingSession = null;
            onFrame(now, null);
          }
        },
        () => {
          if (pendingSession === mySession) pendingSession = null;
          if (!closed && mySession === session) onFrame(now, null);
        },
      );
    }
    frameRequest = requestAnimationFrame(() => loop(mySession));
  }

  return {
    async start(video) {
      if (closed) throw new Error("O rastreador já foi encerrado.");
      const mySession = ++session;
      release();
      lastSent = -Infinity;
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      if (closed || mySession !== session) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      videoElement = video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = media;
      try {
        await video.play();
        if (!closed && mySession === session) loop(mySession);
      } catch (error) {
        if (mySession === session) release();
        throw error;
      }
    },
    stop() {
      session++;
      release();
    },
    close() {
      closed = true;
      session++;
      release();
      // Termination also frees an in-flight WASM call and transferred bitmap.
      worker.terminate();
    },
  };
};
