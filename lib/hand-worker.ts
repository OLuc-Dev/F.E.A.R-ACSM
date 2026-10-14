// Runs MediaPipe's gesture recognizer off the page's main thread, so hand
// tracking never competes with the UI and the robot's animation for it. The
// page sends camera frames as ImageBitmaps; this answers with the hand found.

import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

export type WorkerRequest =
  | { type: "init"; wasmPath: string; modelPath: string }
  | { type: "frame"; bitmap: ImageBitmap; t: number; session: number }
  | { type: "close" };

export type WorkerReply =
  | { type: "ready"; connections: { start: number; end: number }[] }
  | { type: "error"; message: string }
  | {
      type: "result";
      t: number;
      session: number;
      landmarks: { x: number; y: number }[] | null;
      gesture: { name: string; score: number } | null;
      side: string | null;
    };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
  close(): void;
};

let recognizer: GestureRecognizer | null = null;

scope.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      const fileset = await FilesetResolver.forVisionTasks(message.wasmPath);
      // CPU (XNNPACK), not GPU: without real GPU acceleration (VMs, remote
      // desktop, old drivers) WebGL is software-rendered and MediaPipe's GPU path
      // takes seconds per frame. The gesture classifier runs on the CPU anyway.
      recognizer = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: message.modelPath, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      scope.postMessage({ type: "ready", connections: GestureRecognizer.HAND_CONNECTIONS });
    } catch (error) {
      scope.postMessage({ type: "error", message: String(error) });
    }
    return;
  }

  if (message.type === "frame") {
    const { bitmap, t, session } = message;
    // Always answer: the page sends the next frame only after this one's reply.
    let landmarks: { x: number; y: number }[] | null = null;
    let gesture: { name: string; score: number } | null = null;
    let side: string | null = null;
    try {
      if (!recognizer) throw new Error("not ready");
      const result = recognizer.recognizeForVideo(bitmap, t);
      landmarks = result.landmarks[0]?.map(({ x, y }) => ({ x, y })) ?? null;
      const top = result.gestures[0]?.[0];
      gesture = top ? { name: top.categoryName, score: top.score } : null;
      side = result.handedness[0]?.[0]?.categoryName ?? null;
    } catch {
      // A bad frame (e.g. the camera mid-switch) is just a frame without a hand.
    } finally {
      bitmap.close();
    }
    scope.postMessage({ type: "result", t, session, landmarks, gesture, side });
    return;
  }

  recognizer?.close();
  recognizer = null;
  scope.close();
};
