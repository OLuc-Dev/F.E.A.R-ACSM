import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttentionWorkerReply, AttentionWorkerRequest } from "@/lib/attention-worker";

const model = vi.hoisted(() => ({ detectForVideo: vi.fn(), close: vi.fn() }));
const sdk = vi.hoisted(() => ({ fileset: vi.fn(), create: vi.fn() }));
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: sdk.fileset },
  FaceLandmarker: { createFromOptions: sdk.create },
}));

let scope: {
  onmessage: ((event: { data: AttentionWorkerRequest }) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn<(reply: AttentionWorkerReply) => void>>;
  close: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  sdk.fileset.mockResolvedValue({});
  sdk.create.mockResolvedValue(model);
  scope = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("@/lib/attention-worker");
});

describe("attention worker", () => {
  it("initializes CPU/video mode without emotion outputs, and returns all 478 landmarks", async () => {
    await scope.onmessage!({ data: { type: "init", wasmPath: "/wasm", modelPath: "/face.task" } });
    expect(sdk.create).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        baseOptions: { modelAssetPath: "/face.task", delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
      }),
    );
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.2, y: 0.3, z: 0.1 }));
    model.detectForVideo.mockReturnValue({ faceLandmarks: [landmarks] });
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    await scope.onmessage!({ data: { type: "frame", bitmap, t: 123, session: 7 } });
    expect(scope.postMessage).toHaveBeenLastCalledWith({ type: "result", landmarks, t: 123, session: 7 });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("always releases bad frames and clears the estimate when irises are absent", async () => {
    await scope.onmessage!({ data: { type: "init", wasmPath: "/wasm", modelPath: "/face.task" } });
    for (const result of [
      new Error("bad frame"),
      { faceLandmarks: [Array(468).fill({ x: 0, y: 0, z: 0 })] },
    ]) {
      model.detectForVideo.mockImplementation(() => {
        if (result instanceof Error) throw result;
        return result;
      });
      const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
      await scope.onmessage!({ data: { type: "frame", bitmap, t: 150, session: 1 } });
      expect(scope.postMessage).toHaveBeenLastCalledWith({
        type: "result",
        landmarks: null,
        t: 150,
        session: 1,
      });
      expect(bitmap.close).toHaveBeenCalledOnce();
    }
  });

  it("reports a missing model and frees a loaded model on close", async () => {
    sdk.create.mockRejectedValueOnce(new Error("missing model"));
    await scope.onmessage!({ data: { type: "init", wasmPath: "/wasm", modelPath: "/face.task" } });
    expect(scope.postMessage).toHaveBeenCalledWith({ type: "error", message: "Error: missing model" });
    await scope.onmessage!({ data: { type: "init", wasmPath: "/wasm", modelPath: "/face.task" } });
    await scope.onmessage!({ data: { type: "close" } });
    expect(model.close).toHaveBeenCalledOnce();
    expect(scope.close).toHaveBeenCalledOnce();
  });
});
