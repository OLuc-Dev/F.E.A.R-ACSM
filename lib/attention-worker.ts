// Camera frames stay in this worker. Only face/iris landmarks return to the UI;
// neither images nor face descriptors are sent to the assistant.
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export type FacePoint = { x: number; y: number; z: number };
export type AttentionWorkerRequest =
  | { type: "init"; wasmPath: string; modelPath: string }
  | { type: "frame"; bitmap: ImageBitmap; t: number; session: number }
  | { type: "close" };

export type AttentionWorkerReply =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; t: number; session: number; landmarks: FacePoint[] | null };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AttentionWorkerRequest>) => void) | null;
  postMessage(message: AttentionWorkerReply): void;
  close(): void;
};

let landmarker: FaceLandmarker | null = null;
let closed = false;

scope.onmessage = async ({ data: message }) => {
  if (message.type === "init") {
    try {
      const fileset = await FilesetResolver.forVisionTasks(message.wasmPath);
      const model = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: message.modelPath, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
      if (closed) {
        model.close();
        return;
      }
      landmarker = model;
      scope.postMessage({ type: "ready" });
    } catch (error) {
      if (!closed) scope.postMessage({ type: "error", message: String(error) });
    }
    return;
  }

  if (message.type === "frame") {
    const { bitmap, t, session } = message;
    let landmarks: FacePoint[] | null = null;
    try {
      const face = landmarker?.detectForVideo(bitmap, t).faceLandmarks[0];
      // The attention estimator needs both iris rings (478 landmarks).
      if (face?.length === 478) landmarks = face.map(({ x, y, z }) => ({ x, y, z }));
    } catch {
      // A lost or unreadable frame clears the current gaze estimate.
    } finally {
      bitmap.close();
    }
    if (!closed) scope.postMessage({ type: "result", t, session, landmarks });
    return;
  }

  closed = true;
  landmarker?.close();
  landmarker = null;
  scope.close();
};
