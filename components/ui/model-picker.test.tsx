// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { costLabel, gigabytes, ModelPicker } from "@/components/ui/model-picker";
import type { LocalModelsResponse, ModelOption, ModelsResponse } from "@/lib/api";

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
    local: null,
    pulling: null,
    current: "lab/inkling:free",
    busy: false,
    onChoose: vi.fn(),
    onPull: vi.fn(),
    onRefreshLocal: vi.fn(),
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

const ollama: LocalModelsResponse = {
  running: true,
  recommended: "qwen3.5:4b",
  models: [{ id: "ollama/qwen3.5:4b", tag: "qwen3.5:4b", size: 3_324_173_934, parameter_size: "4.2B" }],
  downloads: [
    {
      id: "ollama/qwen3.5:4b",
      tag: "qwen3.5:4b",
      name: "Qwen 3.5 4B (Alibaba)",
      size: 3_320_000_000,
      note: "rápido",
      installed: true,
    },
    {
      id: "ollama/gemma4:e4b",
      tag: "gemma4:e4b",
      name: "Gemma 4 E4B (Google)",
      size: 6_580_000_000,
      note: "mais esperto, precisa de placa de 8 GB",
      installed: false,
    },
  ],
};

describe("ModelPicker, models on this computer", () => {
  it("points to Ollama when it isn't installed or open, and looks again on request", () => {
    const props = picker({ local: { running: false, models: [], downloads: [], recommended: "" } });
    expect(screen.getByRole("link", { name: "Ollama" }).getAttribute("href")).toBe(
      "https://ollama.com/download",
    );
    fireEvent.click(screen.getByRole("button", { name: "Procurar o Ollama de novo" }));
    expect(props.onRefreshLocal).toHaveBeenCalled();
  });

  it("lists the downloaded models to choose, the recommended one marked", () => {
    const props = picker({ local: ollama });
    const qwen = screen.getByRole("button", { name: /Qwen 3\.5 4B \(Alibaba\)/ });
    expect(within(qwen).getByText("recomendado")).toBeTruthy();
    expect(plain(qwen.textContent)).toContain("no seu PC · 3,3 GB · 4.2B");
    fireEvent.click(qwen);
    expect(props.onChoose).toHaveBeenCalledWith("ollama/qwen3.5:4b");
  });

  it("offers the ones not downloaded yet", () => {
    const props = picker({ local: ollama });
    fireEvent.click(screen.getByRole("button", { name: /Baixar · 6,6 GB/ }));
    expect(props.onPull).toHaveBeenCalledWith("gemma4:e4b");
  });

  it("shows how a download is going, and why it stopped", () => {
    picker({
      local: ollama,
      pulling: {
        tag: "gemma4:e4b",
        progress: { status: "pulling", completed: 2.97e9, total: 6.6e9 },
        error: null,
      },
    });
    const bar = screen.getByRole("progressbar", { name: "Baixando Gemma 4 E4B (Google)" });
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
    expect(plain(screen.getByText(/Baixando… 45%/).textContent)).toBe("Baixando… 45% (3 GB de 6,6 GB)");
    expect(screen.queryByRole("button", { name: /Baixar/ })).toBeNull(); // one download at a time
    cleanup();

    picker({
      local: ollama,
      pulling: { tag: "gemma4:e4b", progress: null, error: "Não consegui baixar o modelo." },
    });
    expect(screen.getByText("Não consegui baixar o modelo.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Baixar · 6,6 GB/ })).toBeTruthy(); // try again
  });

  it("measures a download against the whole model, so the bar never goes backwards", () => {
    // Ollama announced only a first, small part so far (0,7 GB of the 6,6 GB).
    picker({
      local: ollama,
      pulling: {
        tag: "gemma4:e4b",
        progress: { status: "pulling", completed: 0.66e9, total: 0.7e9 },
        error: null,
      },
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
    expect(plain(screen.getByText(/Baixando…/).textContent)).toBe("Baixando… 10% (0,7 GB de 6,6 GB)");
  });

  it("keeps the local models usable when OpenRouter's list can't be read", () => {
    picker({ catalog: null, loadError: "Sem internet.", local: ollama });
    expect(screen.getByText("Sem internet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Qwen 3\.5 4B/ })).toBeTruthy();
  });
});

describe("gigabytes", () => {
  it("says sizes the way people do", () => {
    expect(plain(gigabytes(3_324_173_934))).toBe("3,3 GB");
    expect(plain(gigabytes(6_580_000_000))).toBe("6,6 GB");
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
