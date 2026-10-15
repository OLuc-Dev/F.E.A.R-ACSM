// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { costLabel, ModelPicker } from "@/components/ui/model-picker";
import type { ModelOption, ModelsResponse } from "@/lib/api";

afterEach(cleanup);

// Currency formatting keeps "US$" and the amount together with a no-break space.
const plain = (text: string | null) => (text ?? "").replace(/\u00a0/g, " ");

const model = (id: string, name: string, extra: Partial<ModelOption> = {}): ModelOption => ({
  id,
  name,
  description: `${name} description`,
  free: true,
  context_length: 100_000,
  cost_per_100_replies: null,
  ...extra,
});

const catalog: ModelsResponse = {
  default: "lab/inkling:free",
  fallbacks: ["nvidia/nemotron:free", "openrouter/free"],
  models: [
    model("lab/inkling:free", "Thinking Machines: Inkling"),
    model("nvidia/nemotron:free", "NVIDIA: Nemotron"),
    model("openrouter/free", "Free Models Router"),
    model("google/gemma:free", "Google: Gemma"),
    model("anthropic/claude-sonnet", "Anthropic: Claude Sonnet", { free: false, cost_per_100_replies: 1 }),
    model("openai/gpt-oss-120b", "OpenAI: gpt-oss-120b", { free: false, cost_per_100_replies: 0.0705 }),
    model("tiny/cheap", "Tiny: Cheap", { free: false, cost_per_100_replies: 0.002 }),
  ],
};

function picker(overrides: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const props: Parameters<typeof ModelPicker>[0] = {
    catalog,
    loadError: null,
    current: "lab/inkling:free",
    busy: false,
    onChoose: vi.fn(),
    ...overrides,
  };
  render(<ModelPicker {...props} />);
  return props;
}

describe("ModelPicker", () => {
  it("lists the free models, the default and fallbacks marked, the one in use pressed", () => {
    picker();
    const inkling = screen.getByRole("button", { name: /Thinking Machines: Inkling/ });
    expect(inkling.getAttribute("aria-pressed")).toBe("true");
    expect(within(inkling).getByText("padrão")).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /NVIDIA: Nemotron/ })).getByText("reserva"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Google: Gemma/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: /Claude Sonnet/ })).toBeNull(); // paid ones wait for a search
  });

  it("chooses a free model with one click", () => {
    const props = picker();
    fireEvent.click(screen.getByRole("button", { name: /Google: Gemma/ }));
    expect(props.onChoose).toHaveBeenCalledWith("google/gemma:free");
  });

  it("finds the paid ones by name or id, with what they cost", () => {
    const props = picker();
    fireEvent.change(screen.getByLabelText("Procurar outro modelo"), { target: { value: "claude" } });
    const claude = screen.getByRole("button", { name: /Anthropic: Claude Sonnet/ });
    expect(plain(claude.textContent)).toContain("≈ US$ 1,00 a cada 100 respostas");
    fireEvent.click(claude);
    expect(props.onChoose).toHaveBeenCalledWith("anthropic/claude-sonnet");

    fireEvent.change(screen.getByLabelText("Procurar outro modelo"), { target: { value: "GPT-OSS" } });
    expect(plain(screen.getByRole("button", { name: /gpt-oss-120b/ }).textContent)).toContain("US$ 0,07");
  });

  it("can still try an id the list doesn't have", () => {
    const props = picker();
    fireEvent.change(screen.getByLabelText("Procurar outro modelo"), {
      target: { value: "openai/gpt-oss-120b:nitro" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Usar “openai\/gpt-oss-120b:nitro”/ }));
    expect(props.onChoose).toHaveBeenCalledWith("openai/gpt-oss-120b:nitro");
  });

  it("shows a paid model in use above the free ones", () => {
    picker({ current: "anthropic/claude-sonnet" });
    const inUse = screen.getByRole("button", { name: /Anthropic: Claude Sonnet/ });
    expect(inUse.getAttribute("aria-pressed")).toBe("true");
    expect(within(inUse).getByText("em uso")).toBeTruthy();
  });

  it("says when the list is loading, or couldn't be read", () => {
    picker({ catalog: null });
    expect(screen.getByText(/Carregando os modelos/)).toBeTruthy();
    cleanup();
    picker({ catalog: null, loadError: "Não consegui ler a lista de modelos do OpenRouter agora." });
    expect(screen.getByText(/Não consegui ler a lista/)).toBeTruthy();
  });
});

describe("costLabel", () => {
  it("puts a price on 100 replies, in words", () => {
    expect(costLabel(catalog.models[0])).toBe("grátis");
    expect(plain(costLabel(catalog.models[4]))).toBe("≈ US$ 1,00 a cada 100 respostas");
    expect(plain(costLabel(catalog.models[6]))).toBe("menos de US$ 0,01 a cada 100 respostas");
    expect(costLabel(model("openrouter/auto", "Auto", { free: false }))).toBe("preço varia");
  });
});
