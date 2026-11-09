// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAttentionTracker } from "@/lib/attention-tracker";
import type { AttentionWorkerReply, AttentionWorkerRequest } from "@/lib/attention-worker";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<AttentionWorkerReply>) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  requests: AttentionWorkerRequest[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: AttentionWorkerRequest) {
    this.requests.push(request);
    if (request.type === "init") queueMicrotask(() => this.reply({ type: "ready" }));
  }
  reply(data: AttentionWorkerReply) {
    this.onmessage?.({ data } as MessageEvent<AttentionWorkerReply>);
  }
  frames() {
    return this.requests.filter((request) => request.type === "frame");
  }
}

let now: number;
let callbacks: Map<number, FrameRequestCallback>;
let getMedia: ReturnType<typeof vi.fn>;
let stopTrack: ReturnType<typeof vi.fn>;
let media: MediaStream;
let bitmaps: { close: ReturnType<typeof vi.fn> }[];

async function tick(time: number) {
  now = time;
  const pending = [...callbacks.entries()];
  callbacks.clear();
  pending.forEach(([, callback]) => callback(now));
  await Promise.resolve();
}

function videoElement() {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  video.play = vi.fn().mockResolvedValue(undefined);
  return video;
}

beforeEach(() => {
  now = 0;
  callbacks = new Map();
  let next = 0;
  bitmaps = [];
  FakeWorker.instances = [];
  stopTrack = vi.fn();
  media = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  getMedia = vi.fn().mockResolvedValue(media);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: getMedia } });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      const bitmap = { close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("attention tracker", () => {
  it("initializes local assets without opening the camera, then sends at most one frame at ~10 fps", async () => {
    const listener = vi.fn();
    const tracker = await createAttentionTracker(listener);
    const worker = FakeWorker.instances[0];
    expect(getMedia).not.toHaveBeenCalled();
    expect(worker.requests[0]).toMatchObject({
      type: "init",
      modelPath: expect.stringContaining("/mediapipe/face_landmarker.task"),
    });
    await tracker.start(videoElement());
    expect(worker.frames()).toHaveLength(1);
    await tick(200);
    expect(worker.frames()).toHaveLength(1);
    const frame = worker.frames()[0];
    worker.reply({ type: "result", t: frame.t, session: frame.session, landmarks: null });
    expect(listener).toHaveBeenCalledWith(0, null);
    await tick(250);
    expect(worker.frames()).toHaveLength(2);
    const second = worker.frames()[1];
    worker.reply({ type: "result", t: second.t, session: second.session, landmarks: null });
    await tick(300);
    expect(worker.frames()).toHaveLength(2);
    tracker.close();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("stops a camera permission request that resolves after stop", async () => {
    let open!: (stream: MediaStream) => void;
    getMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        open = resolve;
      }),
    );
    const tracker = await createAttentionTracker(vi.fn());
    const video = videoElement();
    const starting = tracker.start(video);
    tracker.stop();
    open(media);
    await starting;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeFalsy();
    expect(FakeWorker.instances[0].frames()).toHaveLength(0);
    tracker.close();
  });

  it("ignores stale replies without releasing a new session's in-flight frame", async () => {
    const listener = vi.fn();
    const tracker = await createAttentionTracker(listener);
    await tracker.start(videoElement());
    const worker = FakeWorker.instances[0];
    const stale = worker.frames()[0];
    tracker.stop();
    await tracker.start(videoElement());
    worker.reply({ type: "result", t: stale.t, session: stale.session, landmarks: [] });
    expect(listener).not.toHaveBeenCalled();
    await tick(200);
    expect(worker.frames()).toHaveLength(2);
    worker.reply({ type: "result", t: stale.t, session: stale.session, landmarks: [] });
    await tick(400);
    expect(worker.frames()).toHaveLength(2);
    tracker.close();
  });

  it("releases a bitmap created after shutdown and camera tracks when video playback fails", async () => {
    let finishBitmap!: (bitmap: ImageBitmap) => void;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            finishBitmap = resolve;
          }),
      ),
    );
    const tracker = await createAttentionTracker(vi.fn());
    await tracker.start(videoElement());
    tracker.stop();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    finishBitmap(bitmap);
    await Promise.resolve();
    expect(bitmap.close).toHaveBeenCalledOnce();
    const video = videoElement();
    video.play = vi.fn().mockRejectedValue(new Error("playback blocked"));
    await expect(tracker.start(video)).rejects.toThrow("playback blocked");
    expect(video.srcObject).toBeNull();
    expect(stopTrack).toHaveBeenCalledTimes(2);
    tracker.close();
  });
});
