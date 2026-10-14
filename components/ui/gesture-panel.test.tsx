// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GesturePanel } from "@/components/ui/gesture-panel";

// The camera and the hand model stay out of it: the panel shows what the hook reports.
const tracking = vi.hoisted(() => ({
  status: "watching",
  error: null as string | null,
  pose: "Pointing_Up",
}));
vi.mock("@/lib/use-hand-gestures", () => ({ useHandGestures: () => tracking }));

afterEach(cleanup);

function panel(overrides: Partial<Parameters<typeof GesturePanel>[0]> = {}) {
  const props: Parameters<typeof GesturePanel>[0] = {
    onCommand: vi.fn(),
    onTurnOff: vi.fn(),
    feedback: null,
    musicAvailable: false,
    voiceAvailable: true,
    ...overrides,
  };
  render(<GesturePanel {...props} />);
  return props;
}

describe("GesturePanel in the voice interface", () => {
  it("says the camera is on and what hand it sees", () => {
    panel({ look: "hud" });
    expect(screen.getByRole("region", { name: "Gestos com as mãos" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/câmera ligada/);
    expect(screen.getByText("Apontando para cima")).toBeTruthy();
  });

  it("lists the gestures in a few words", () => {
    panel({ look: "hud" });
    expect(screen.getByText("Apontar para cima")).toBeTruthy();
    expect(screen.getByText("falar")).toBeTruthy();
    expect(screen.getByText("Punho fechado")).toBeTruthy();
    expect(screen.queryByText(/Palma parada \(1 s\)/)).toBeNull(); // the long legend is the deck's
  });

  it("shows the last command over the camera", () => {
    panel({ look: "hud", feedback: { title: "Ouvindo", detail: "pode falar", at: 1 } });
    expect(screen.getByText("Ouvindo · pode falar")).toBeTruthy();
  });

  it("turns off from its corner", () => {
    const props = panel({ look: "hud" });
    fireEvent.click(screen.getByRole("button", { name: "Desligar os gestos" }));
    expect(props.onTurnOff).toHaveBeenCalledTimes(1);
  });

  it("explains a camera it couldn't open", () => {
    tracking.status = "error";
    tracking.error = "Nenhuma câmera encontrada.";
    try {
      panel({ look: "hud" });
      expect(screen.getByText("Nenhuma câmera encontrada.")).toBeTruthy();
      expect(screen.queryByText("Apontando para cima")).toBeNull();
    } finally {
      tracking.status = "watching";
      tracking.error = null;
    }
  });
});

describe("GesturePanel in the written deck", () => {
  it("keeps its full legend", () => {
    panel();
    expect(screen.getByText("Palma parada (1 s)")).toBeTruthy();
    expect(screen.getByText("Apontando para cima")).toBeTruthy();
  });
});
