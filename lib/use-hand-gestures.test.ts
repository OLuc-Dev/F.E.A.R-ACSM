// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GestureCommand } from "@/lib/hand-gestures";
import type { FrameListener, HandTracker, HandTrackerFactory } from "@/lib/hand-tracker";
import {
  describeGestureError,
  loadGesturePreference,
  saveGesturePreference,
  useHandGestures,
} from "@/lib/use-hand-gestures";

// A stand-in for the MediaPipe tracker that records whether the camera is on.
class FakeTracker implements HandTracker {
  cameraOn = false;
  starts = 0;
  closed = false;
  startGate: Promise<void> = Promise.resolve();
  failWith: unknown = null;

  constructor(readonly emit: FrameListener) {}

  async start(): Promise<void> {
    this.starts++;
    await this.startGate;
    if (this.failWith) throw this.failWith;
    this.cameraOn = true;
  }

  stop(): void {
    this.cameraOn = false;
  }

  close(): void {
    this.cameraOn = false;
    this.closed = true;
  }
}

function setup(configure: (tracker: FakeTracker) => void = () => {}) {
  let tracker: FakeTracker | null = null;
  const factory: HandTrackerFactory = async (onFrame) => {
    tracker = new FakeTracker(onFrame);
    configure(tracker);
    return tracker;
  };
  const commands: GestureCommand[] = [];
  const videoRef = { current: document.createElement("video") };
  const hook = renderHook(
    ({ enabled }) =>
      useHandGestures({ enabled, onCommand: (c) => commands.push(c), videoRef, createTracker: factory }),
    { initialProps: { enabled: false } },
  );
  return { hook, commands, tracker: () => tracker as FakeTracker | null };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  cleanup();
  setVisibility("visible");
  window.localStorage.clear();
});

describe("useHandGestures", () => {
  it("stays off — no camera, no model — until switched on", async () => {
    const { hook, tracker } = setup();
    await act(async () => {});
    expect(hook.result.current.status).toBe("off");
    expect(tracker()).toBeNull();
  });

  it("switching on opens the camera; switching off closes it", async () => {
    const { hook, tracker } = setup();
    await act(async () => hook.rerender({ enabled: true }));
    expect(hook.result.current.status).toBe("watching");
    expect(tracker()?.cameraOn).toBe(true);

    await act(async () => hook.rerender({ enabled: false }));
    expect(hook.result.current.status).toBe("off");
    expect(tracker()?.cameraOn).toBe(false);
  });

  it("turns the camera off while the window is hidden and back on when shown", async () => {
    const { hook, tracker } = setup();
    await act(async () => hook.rerender({ enabled: true }));

    await act(async () => setVisibility("hidden"));
    expect(tracker()?.cameraOn).toBe(false);
    expect(hook.result.current.status).toBe("paused");

    await act(async () => setVisibility("visible"));
    expect(tracker()?.cameraOn).toBe(true);
    expect(hook.result.current.status).toBe("watching");
  });

  it("starting while hidden (the app booting into the tray) never opens the camera", async () => {
    setVisibility("hidden");
    const { hook, tracker } = setup();
    await act(async () => hook.rerender({ enabled: true }));
    expect(hook.result.current.status).toBe("paused");
    expect(tracker()?.cameraOn ?? false).toBe(false);
  });

  it("switching off while the camera is still opening leaves it off", async () => {
    let openCamera: () => void = () => {};
    const { hook, tracker } = setup((created) => {
      created.startGate = new Promise((resolve) => (openCamera = resolve));
    });
    await act(async () => hook.rerender({ enabled: true }));
    await act(async () => hook.rerender({ enabled: false }));
    await act(async () => openCamera());

    expect(tracker()?.cameraOn).toBe(false);
    expect(hook.result.current.status).toBe("off");
  });

  it("closing the page frees the camera and the model", async () => {
    const { hook, tracker } = setup();
    await act(async () => hook.rerender({ enabled: true }));
    hook.unmount();
    expect(tracker()?.cameraOn).toBe(false);
    expect(tracker()?.closed).toBe(true);
  });

  it("explains a blocked camera in plain words", async () => {
    const { hook } = setup((created) => {
      created.failWith = new DOMException("denied", "NotAllowedError");
    });
    await act(async () => hook.rerender({ enabled: true }));
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toMatch(/permiss[aã]o/i);
  });

  it("turns frames into commands and reports the pose on screen", async () => {
    const { hook, commands, tracker } = setup();
    await act(async () => hook.rerender({ enabled: true }));
    await act(async () => {
      for (let t = 0; t <= 1300; t += 66) tracker()?.emit(t, { pose: "Open_Palm", x: 0.5, y: 0.5 });
    });
    expect(commands).toEqual(["palm_hold"]);
    expect(hook.result.current.pose).toBe("Open_Palm");

    await act(async () => {
      for (let t = 1400; t <= 1800; t += 66) tracker()?.emit(t, null);
    });
    expect(hook.result.current.pose).toBeNull();
  });
});

describe("the robot's gaze", () => {
  it("gets every frame's hand, and none once the camera stops", async () => {
    const seen: ({ x: number } | null)[] = [];
    let tracker: FakeTracker | null = null;
    const factory: HandTrackerFactory = async (onFrame) => (tracker = new FakeTracker(onFrame));
    const videoRef = { current: document.createElement("video") };
    const hook = renderHook(
      ({ enabled }) =>
        useHandGestures({
          enabled,
          onCommand: () => {},
          onHand: (hand) => seen.push(hand),
          videoRef,
          createTracker: factory,
        }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    await act(async () => {
      (tracker as FakeTracker | null)?.emit(0, { pose: "None", x: 0.7, y: 0.4 });
    });
    expect(seen.at(-1)).toEqual({ pose: "None", x: 0.7, y: 0.4 });

    await act(async () => hook.rerender({ enabled: false }));
    expect(seen.at(-1)).toBeNull();
  });
});

describe("gesture helpers", () => {
  it("remembers whether gestures were left on", () => {
    expect(loadGesturePreference()).toBe(false);
    saveGesturePreference(true);
    expect(loadGesturePreference()).toBe(true);
    saveGesturePreference(false);
    expect(loadGesturePreference()).toBe(false);
  });

  it("names the common camera failures", () => {
    expect(describeGestureError(new DOMException("x", "NotFoundError"))).toMatch(/nenhuma c[aâ]mera/i);
    expect(describeGestureError(new DOMException("x", "NotReadableError"))).toMatch(/em uso/i);
    expect(describeGestureError(new Error("wasm"))).toMatch(/reconhecimento/i);
  });
});
