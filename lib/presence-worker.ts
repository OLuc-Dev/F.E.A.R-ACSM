// Runs MediaPipe's face detector off the page's main thread. The page sends a
// small camera frame now and then; this answers only whether a face is in it.

import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

export type PresenceRequest =
  | { type: "init"; wasmPath: string; modelPath: string }
  | { type: "frame"; bitmap: ImageBitmap; t: number; session: number }
  | { type: "close" };

export type PresenceReply =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; t: number; session: number; face: boolean };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PresenceRequest>) => void) | null;
  postMessage(message: PresenceReply): void;
  close(): void;
};

let detector: FaceDetector | null = null;

scope.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      const fileset = await FilesetResolver.forVisionTasks(message.wasmPath);
      // CPU, like the hand tracker: dependable everywhere, and a couple of
      // tiny frames a second cost next to nothing.
      detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: message.modelPath, delegate: "CPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.6,
      });
      scope.postMessage({ type: "ready" });
    } catch (error) {
      scope.postMessage({ type: "error", message: String(error) });
    }
    return;
  }

  if (message.type === "frame") {
    const { bitmap, t, session } = message;
    let face = false;
    try {
      if (!detector) throw new Error("not ready");
      face = detector.detectForVideo(bitmap, t).detections.length > 0;
    } catch {
      // A bad frame is just a frame without a face.
    } finally {
      bitmap.close();
    }
    scope.postMessage({ type: "result", t, session, face });
    return;
  }

  detector?.close();
  detector = null;
  scope.close();
};
