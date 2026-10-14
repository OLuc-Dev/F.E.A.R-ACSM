// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPTION_LINGER_MS, useHudCaptions, VoiceHud } from "@/components/ui/voice-hud";

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no animation frames to give the core; it doesn't need them here.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type CaptionInput = Parameters<typeof useHudCaptions>[0];
const base: CaptionInput = { heard: "", heardId: 0, saying: "", notice: "", quiet: true };

describe("useHudCaptions", () => {
  it("shows what you said, then the sentence being spoken, then fades once quiet", () => {
    const hook = renderHook((input: CaptionInput) => useHudCaptions(input), { initialProps: base });
    expect(hook.result.current).toEqual({ you: null, fear: null });

    hook.rerender({ ...base, heard: "Qual é a capital da França?", heardId: 3, quiet: false });
    expect(hook.result.current.you).toBe("Qual é a capital da França?");
    hook.rerender({
      ...base,
      heard: "Qual é a capital da França?",
      heardId: 3,
      saying: "Paris.",
      quiet: false,
    });
    expect(hook.result.current.fear).toBe("Paris.");

    // Done talking: the last sentence stays a while, then both fade.
    hook.rerender({ ...base, heard: "Qual é a capital da França?", heardId: 3, quiet: true });
    expect(hook.result.current.fear).toBe("Paris.");
    act(() => vi.advanceTimersByTime(CAPTION_LINGER_MS + 10));
    expect(hook.result.current).toEqual({ you: null, fear: null });
  });

  it("never fades mid-answer, and a new question clears the old answer", () => {
    const hook = renderHook((input: CaptionInput) => useHudCaptions(input), {
      initialProps: { ...base, heard: "Oi", heardId: 1, saying: "Olá.", quiet: false },
    });
    act(() => vi.advanceTimersByTime(CAPTION_LINGER_MS * 3));
    expect(hook.result.current).toEqual({ you: "Oi", fear: "Olá." }); // still answering
    hook.rerender({ ...base, heard: "E agora?", heardId: 2, quiet: false });
    expect(hook.result.current).toEqual({ you: "E agora?", fear: null });
  });

  it("shows a reply it couldn't say out loud (an error)", () => {
    const hook = renderHook((input: CaptionInput) => useHudCaptions(input), {
      initialProps: { ...base, notice: "Não consegui falar com o modelo.", quiet: false },
    });
    expect(hook.result.current.fear).toBe("Não consegui falar com o modelo.");
  });
});

function hud(overrides: Partial<Parameters<typeof VoiceHud>[0]> = {}) {
  const props: Parameters<typeof VoiceHud>[0] = {
    mode: "listening",
    coreLabel: "Ouvindo — é só falar (clique para pausar)",
    corePressed: true,
    onCore: vi.fn(),
    inputLevel: { current: 0 },
    outputLevel: () => 0,
    hint: "É só falar",
    notice: null,
    you: "Qual é a capital da França?",
    fear: "Paris.",
    readings: [{ label: "Memória", value: "ativa", on: true }],
    backendOnline: true,
    userName: "lucas",
    hasKey: false,
    onAddKey: vi.fn(),
    onAccount: vi.fn(),
    onSettings: vi.fn(),
    ...overrides,
  };
  render(<VoiceHud {...props} />);
  return props;
}

describe("VoiceHud", () => {
  it("is for talking: no box to type in, just what's being said", () => {
    hud();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Qual é a capital da França?")).toBeTruthy();
    expect(screen.getByText("Paris.")).toBeTruthy();
    expect(screen.getByText("Ouvindo")).toBeTruthy(); // the core says what it's doing
  });

  it("the core is the microphone: a click reaches it", () => {
    const props = hud();
    fireEvent.click(screen.getByRole("button", { name: /Ouvindo — é só falar/ }));
    expect(props.onCore).toHaveBeenCalledTimes(1);
  });

  it("asks for the OpenRouter key when there's none", () => {
    const props = hud();
    fireEvent.click(screen.getByRole("button", { name: /Sem chave do OpenRouter/ }));
    expect(props.onAddKey).toHaveBeenCalledTimes(1);
  });

  it("puts a microphone problem where the hint was", () => {
    hud({ notice: "Nenhum microfone encontrado." });
    expect(screen.getByText("Nenhum microfone encontrado.")).toBeTruthy();
    expect(screen.queryByText("É só falar")).toBeNull();
  });
});
