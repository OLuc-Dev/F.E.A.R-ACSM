// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttentionLab } from "@/components/ui/attention-lab";
import type {
  AttentionFrameListener,
  AttentionTracker,
  AttentionTrackerFactory,
} from "@/lib/attention-tracker";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  fit: vi.fn(),
  predict: vi.fn(),
  error: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ sendCommand: mocks.send }));
vi.mock("@/lib/visual-attention", () => ({
  extractGazeFeatures: (landmarks: { x: number; y: number }[]) =>
    landmarks.length ? [landmarks[0].x, landmarks[0].y, 0, 1] : null,
  fitCalibration: mocks.fit,
  predictGaze: mocks.predict,
  validationError: mocks.error,
  resolveAttentionTarget: mocks.resolve,
}));

class FakeTracker implements AttentionTracker {
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn();
  close = vi.fn();
  constructor(readonly emit: AttentionFrameListener) {}
}

let now: number;
function setVisibility(value: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}
function mount() {
  let tracker: FakeTracker | null = null;
  const factory = vi.fn<AttentionTrackerFactory>(async (onFrame) => {
    tracker = new FakeTracker(onFrame);
    return tracker;
  });
  const view = render(<AttentionLab createTracker={factory} />);
  const emit = (x = 0.4, y = 0.5) => tracker!.emit(now, [{ x, y, z: 0 }]);
  const start = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Iniciar câmera" }));
    });
    act(() => emit());
  };
  const begin = () =>
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Calibrar 9 pontos" }));
    });
  const collect = async (index: number) => {
    await act(async () => {
      now += 600;
      for (let i = 0; i < 10; i++) {
        now += 110;
        emit(index + (i === 0 ? 100 : i === 1 ? -100 : 0), index);
      }
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
  };
  return { ...view, factory, tracker: () => tracker!, emit, start, begin, collect };
}

beforeEach(() => {
  vi.clearAllMocks();
  now = 0;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("Worker", class {});
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
  for (const [property, value] of Object.entries({
    innerWidth: 1024,
    innerHeight: 768,
    screenX: 0,
    screenY: 0,
    devicePixelRatio: 1,
  })) {
    Object.defineProperty(window, property, { configurable: true, value });
  }
  setVisibility("visible");
  mocks.fit.mockReturnValue({ mean: [], scale: [], weightsX: [], weightsY: [], min: [], max: [] });
  mocks.predict.mockReturnValue({ x: 300, y: 250 });
  mocks.error.mockReturnValue(20);
  mocks.resolve.mockReturnValue({
    label: "Estação lunar",
    text: "Uma base na Lua precisa de energia.",
    role: "group",
  });
  mocks.send.mockResolvedValue({
    reply: "Você está olhando para um cartão sobre a Lua.",
    speaker: "fear",
    audio_file: null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("AttentionLab", () => {
  it("stays off without loading a tracker or making assistant requests", async () => {
    const lab = mount();
    await act(async () => {});
    fireEvent.keyDown(window, { key: "g" });
    expect(lab.factory).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("discards the first 500 ms and requires at least ten frames before advancing", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    act(() => {
      for (let i = 0; i < 10; i++) {
        now = i * 40;
        lab.emit();
      }
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(screen.getByText("Calibrando: ponto 1 de 9")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Próximo (Espaço)" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await lab.collect(0);
    expect(screen.getByText("Calibrando: ponto 2 de 9")).toBeTruthy();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fits median batches, validates four new targets, and only sends an explicit fresh G request", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    for (let target = 0; target < 9; target++) await lab.collect(target);
    const samples = mocks.fit.mock.calls[0][0] as { features: number[]; x: number; y: number }[];
    expect(samples).toHaveLength(9);
    expect(samples[0].features).toEqual([0, 0, 0, 1]);
    expect(screen.getByText("Validando: ponto 1 de 4")).toBeTruthy();
    for (let target = 0; target < 4; target++) await lab.collect(target);
    const heldOut = mocks.error.mock.calls[0][1] as { x: number; y: number }[];
    expect(heldOut).toHaveLength(40);
    expect(heldOut.every((p) => !samples.some((s) => s.x === p.x && s.y === p.y))).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
    act(() => {
      now += 110;
      lab.emit();
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "g" });
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "O que é isso que estou olhando?",
        speaker: "user",
        visual_attention: expect.objectContaining({
          source: "webcam-calibrated",
          coordinate_space: "viewport-css-pixels",
          x: 300,
          y: 250,
          calibration_error_px: 20,
          target: expect.objectContaining({ label: "Estação lunar" }),
        }),
      }),
    );
    expect(screen.getByText("Você está olhando para um cartão sobre a Lua.")).toBeTruthy();

    // Old estimates and loss of the face never produce a new request.
    now += 600;
    await act(async () => {
      fireEvent.keyDown(window, { key: "g" });
    });
    act(() => lab.tracker().emit(now, null));
    await act(async () => {
      fireEvent.keyDown(window, { key: "g" });
    });
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("rejects imprecise held-out validation instead of starting gaze tracking", async () => {
    mocks.error.mockReturnValue(500);
    const lab = mount();
    await lab.start();
    lab.begin();
    for (let target = 0; target < 13; target++) await lab.collect(target);
    act(() => lab.emit());
    fireEvent.keyDown(window, { key: "g" });
    expect(screen.getByText(/A validação ficou imprecisa demais/)).toBeTruthy();
    expect(mocks.predict).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("closes the camera and resets calibration when hidden; showing it does not restart", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    act(() => setVisibility("hidden"));
    expect(lab.tracker().close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => setVisibility("visible"));
    expect(lab.factory).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Retomar câmera" })).toBeTruthy();
    lab.unmount();
    expect(lab.tracker().close).toHaveBeenCalledOnce();
  });

  it("closes a model loaded after hiding or leaving the page, before opening its camera", async () => {
    let finish!: (tracker: AttentionTracker) => void;
    let created!: FakeTracker;
    const factory: AttentionTrackerFactory = (onFrame) => {
      created = new FakeTracker(onFrame);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const view = render(<AttentionLab createTracker={factory} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Iniciar câmera" }));
    });
    act(() => setVisibility("hidden"));
    view.unmount();
    await act(async () => {
      finish(created);
    });
    expect(created.start).not.toHaveBeenCalled();
    expect(created.close).toHaveBeenCalledOnce();
  });

  it("invalidates calibration on resize and frees an active camera on unmount", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/O tamanho, a posição ou a escala da janela mudou/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "g" });
    expect(mocks.send).not.toHaveBeenCalled();
    lab.unmount();
    expect(lab.tracker().close).toHaveBeenCalledOnce();
  });

  it("invalidates on window movement or monitor scaling even without a resize event", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    Object.defineProperty(window, "screenX", { configurable: true, value: 200 });
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/a posição ou a escala da janela mudou/)).toBeTruthy();
    lab.begin();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not advance old batches and clears them when frames stop arriving", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    await act(async () => {
      now += 600;
      for (let i = 0; i < 10; i++) {
        now += 110;
        lab.emit();
      }
    });
    now += 600;
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(screen.getByText("Calibrando: ponto 1 de 9")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect((screen.getByRole("button", { name: "Próximo (Espaço)" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("invalidates on blur, so a previously calibrated point cannot be queried", async () => {
    const lab = mount();
    await lab.start();
    lab.begin();
    for (let target = 0; target < 13; target++) await lab.collect(target);
    act(() => {
      now += 110;
      lab.emit();
      window.dispatchEvent(new Event("blur"));
    });
    act(() => lab.emit());
    fireEvent.keyDown(window, { key: "g" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(screen.getByText(/A janela perdeu o foco/)).toBeTruthy();
  });
});
