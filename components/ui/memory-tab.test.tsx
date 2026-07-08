// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Strip framer-motion's animation timing so state changes (item removal, confirm
// expand/collapse) settle synchronously — the tests assert behaviour, not motion.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const MOTION_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "layout",
    "layoutId",
    "variants",
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileInView",
    "drag",
    "onAnimationComplete",
    "custom",
  ]);
  const clean = (props: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const key in props) if (!MOTION_PROPS.has(key)) out[key] = props[key];
    return out;
  };
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        // eslint-disable-next-line react/display-name
        React.forwardRef((props: Record<string, unknown>, ref: unknown) =>
          React.createElement(tag, { ...clean(props), ref }),
        ),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
  };
});

// Mock only the network. NOTE: no mockReset/mockClear here — under vitest with an
// async vi.mock factory it can corrupt the next mockImplementation; each test sets
// its own return value (which replaces the previous), and call counts use deltas.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getMemory: vi.fn(), forgetMemory: vi.fn() };
});

import { forgetMemory, getMemory, type MemoryItem } from "@/lib/api";
import { MEMORY_COPY } from "@/lib/memory-helpers";
import { MemoryTab } from "@/components/ui/memory-tab";

const getMem = vi.mocked(getMemory);
const forget = vi.mocked(forgetMemory);

const item = (id: string, text: string, source: string): MemoryItem => ({
  id,
  text,
  source,
  timestamp: Date.now() / 1000,
});

const withMemories = (memories: MemoryItem[]) => getMem.mockResolvedValue({ speaker: "Lucas", memories });

async function openConfirm() {
  fireEvent.click(screen.getByRole("button", { name: "Apagar esta memória" }));
  await screen.findByText(MEMORY_COPY.confirmTitle);
}

afterEach(cleanup);

describe("MemoryTab", () => {
  it("shows the loading state while memories load", () => {
    getMem.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<MemoryTab speaker="Lucas" />);
    expect(screen.getByText(MEMORY_COPY.loading)).toBeTruthy();
  });

  it("shows a focused empty state when there are no visible memories", async () => {
    withMemories([]);
    render(<MemoryTab speaker="Lucas" />);
    expect(await screen.findByText(MEMORY_COPY.empty)).toBeTruthy();
    expect(screen.getByText(MEMORY_COPY.emptySupport)).toBeTruthy();
  });

  it("renders the list of memories", async () => {
    withMemories([item("a", "gosto de café forte", "conversation")]);
    render(<MemoryTab speaker="Lucas" />);
    expect(await screen.findByText("gosto de café forte")).toBeTruthy();
  });

  it("hides F.E.A.R.'s own replies (assistant_reply) and notes it discreetly", async () => {
    withMemories([
      item("a", "pergunta do usuário", "conversation"),
      item("b", "resposta interna do fear", "assistant_reply"),
    ]);
    render(<MemoryTab speaker="Lucas" />);
    expect(await screen.findByText("pergunta do usuário")).toBeTruthy();
    expect(screen.queryByText("resposta interna do fear")).toBeNull();
    expect(screen.getByText(MEMORY_COPY.hiddenNote)).toBeTruthy();
  });

  it("humanizes the source label (never a raw string)", async () => {
    withMemories([item("a", "uma lembrança", "conversation")]);
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("uma lembrança");
    expect(screen.getByText(/conversa ·/)).toBeTruthy();
    expect(screen.queryByText(/conversation/)).toBeNull();
  });

  it("shows a recoverable error when the load fails — never a fake empty list", async () => {
    getMem.mockRejectedValueOnce(new Error("network down"));
    render(<MemoryTab speaker="Lucas" />);
    expect(await screen.findByText(MEMORY_COPY.loadError)).toBeTruthy();
    expect(screen.getByRole("button", { name: MEMORY_COPY.retry })).toBeTruthy();
    // A failed load must NOT read as the empty state.
    expect(screen.queryByText(MEMORY_COPY.empty)).toBeNull();
  });

  it("retries the load when 'Tentar novamente' is pressed", async () => {
    getMem.mockRejectedValueOnce(new Error("network down"));
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText(MEMORY_COPY.loadError);
    const before = getMem.mock.calls.length;

    withMemories([item("a", "voltou a responder", "conversation")]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MEMORY_COPY.retry }));
    });
    expect(await screen.findByText("voltou a responder")).toBeTruthy();
    expect(getMem.mock.calls.length).toBeGreaterThan(before);
  });

  it("asks for confirmation before deleting", async () => {
    withMemories([item("a", "apagável", "conversation")]);
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("apagável");
    await openConfirm();
    expect(screen.getByText(MEMORY_COPY.confirmSupport)).toBeTruthy();
  });

  it("does NOT call forget when the deletion is cancelled", async () => {
    withMemories([item("a", "apagável", "conversation")]);
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("apagável");
    await openConfirm();
    const before = forget.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: MEMORY_COPY.cancel }));
    expect(forget.mock.calls.length).toBe(before);
    expect(screen.queryByText(MEMORY_COPY.confirmTitle)).toBeNull();
  });

  it("deletes on confirm, removes the item, and confirms success", async () => {
    withMemories([item("a", "apagável", "conversation")]);
    forget.mockResolvedValue({ forgotten: true, id: "a" });
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("apagável");
    await openConfirm();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MEMORY_COPY.confirm }));
    });
    expect(forget).toHaveBeenLastCalledWith("a");
    expect(screen.getByText(MEMORY_COPY.deleteSuccess)).toBeTruthy();
    expect(screen.queryByText("apagável")).toBeNull();
  });

  it("treats { forgotten: false } as a recoverable failure, not a silent success", async () => {
    withMemories([item("a", "apagável", "conversation")]);
    forget.mockResolvedValue({ forgotten: false, id: "a" });
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("apagável");
    await openConfirm();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MEMORY_COPY.confirm }));
    });
    expect(screen.getByText(MEMORY_COPY.forgetRefused)).toBeTruthy();
    expect(screen.queryByText(MEMORY_COPY.deleteSuccess)).toBeNull();
    // The item stays — the user can try again.
    expect(screen.getByText("apagável")).toBeTruthy();
  });

  it("shows a recoverable error when the delete request throws", async () => {
    withMemories([item("a", "apagável", "conversation")]);
    forget.mockRejectedValue(new Error("network down"));
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("apagável");
    await openConfirm();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MEMORY_COPY.confirm }));
    });
    expect(screen.getByText(MEMORY_COPY.deleteError)).toBeTruthy();
    expect(screen.getByText("apagável")).toBeTruthy();
  });
});

// --- PR #19: local search, source filters, date grouping (longer lists) ---

const itemAt = (id: string, text: string, source: string, ts: number): MemoryItem => ({
  id,
  text,
  source,
  timestamp: ts,
});

// 4 visible memories (> threshold) so the toolbar shows: 3 conversation + 1 voice,
// spanning today / last-7-days / older.
const manyMemories = () => {
  const t = Date.now() / 1000;
  return [
    itemAt("c1", "Prefiro café forte", "conversation", t - 3600),
    itemAt("c2", "Reunião de produto amanhã", "conversation", t - 7200),
    itemAt("c3", "Notas no Obsidian sobre design", "conversation", t - 3 * 86400),
    itemAt("v1", "Comando de voz gravado", "voice", t - 30 * 86400),
  ];
};

describe("MemoryTab — search, filters, grouping", () => {
  it("keeps a short list flat: no search toolbar below the threshold", async () => {
    withMemories([item("a", "só uma", "conversation"), item("b", "e outra", "voice")]);
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("só uma");
    expect(screen.queryByPlaceholderText(MEMORY_COPY.searchPlaceholder)).toBeNull();
  });

  it("shows the search toolbar + date groups on a longer list", async () => {
    withMemories(manyMemories());
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("Prefiro café forte");
    expect(screen.getByPlaceholderText(MEMORY_COPY.searchPlaceholder)).toBeTruthy();
    expect(screen.getByText(MEMORY_COPY.searchScopeNote)).toBeTruthy();
    expect(screen.getByText("Hoje")).toBeTruthy();
    expect(screen.getByText("Últimos 7 dias")).toBeTruthy();
    expect(screen.getByText("Mais antigas")).toBeTruthy();
  });

  it("filters the visible memories by text (accent-insensitive)", async () => {
    withMemories(manyMemories());
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("Prefiro café forte");
    fireEvent.change(screen.getByPlaceholderText(MEMORY_COPY.searchPlaceholder), {
      target: { value: "cafe" },
    });
    expect(screen.getByText("Prefiro café forte")).toBeTruthy();
    expect(screen.queryByText("Reunião de produto amanhã")).toBeNull();
    expect(screen.queryByText("Comando de voz gravado")).toBeNull();
  });

  it("shows a no-results state when the search matches nothing", async () => {
    withMemories(manyMemories());
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("Prefiro café forte");
    fireEvent.change(screen.getByPlaceholderText(MEMORY_COPY.searchPlaceholder), {
      target: { value: "zzzzz" },
    });
    expect(screen.getByText(MEMORY_COPY.noResults)).toBeTruthy();
  });

  it("shows filter chips only for sources actually present", async () => {
    withMemories(manyMemories());
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("Prefiro café forte");
    expect(screen.getByRole("button", { name: MEMORY_COPY.filterAll })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conversa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voz" })).toBeTruthy();
    // Obsidian appears in a memory's TEXT but no memory has that source — no chip.
    expect(screen.queryByRole("button", { name: "Obsidian" })).toBeNull();
  });

  it("filters by source when a chip is selected", async () => {
    withMemories(manyMemories());
    render(<MemoryTab speaker="Lucas" />);
    await screen.findByText("Prefiro café forte");
    fireEvent.click(screen.getByRole("button", { name: "Voz" }));
    expect(screen.getByText("Comando de voz gravado")).toBeTruthy();
    expect(screen.queryByText("Prefiro café forte")).toBeNull();
    expect(screen.queryByText("Reunião de produto amanhã")).toBeNull();
  });
});

// --- lote #24: "consultada nesta resposta" highlight ---

describe("MemoryTab — consulted highlight", () => {
  it("marks the memories whose id is highlighted — and only those", async () => {
    withMemories([
      item("hit", "memória consultada", "conversation"),
      item("other", "memória comum", "voice"),
    ]);
    render(<MemoryTab speaker="Lucas" highlightIds={["hit"]} />);
    await screen.findByText("memória consultada");

    // Exactly one badge, on the right card (text marker, not colour alone).
    expect(screen.getAllByText(MEMORY_COPY.consultedBadge)).toHaveLength(1);
    const badge = screen.getByText(MEMORY_COPY.consultedBadge);
    expect(badge.closest("li")?.textContent).toContain("memória consultada");
    expect(badge.closest("li")?.textContent).not.toContain("memória comum");
  });

  it("shows no badge when no highlighted id matches", async () => {
    withMemories([item("a", "memória comum", "conversation")]);
    render(<MemoryTab speaker="Lucas" highlightIds={[]} />);
    await screen.findByText("memória comum");
    expect(screen.queryByText(MEMORY_COPY.consultedBadge)).toBeNull();
  });

  it("acknowledges consulted memories that are not in this view (honest note)", async () => {
    withMemories([item("a", "memória carregada", "conversation")]);
    render(<MemoryTab speaker="Lucas" highlightIds={["a", "nao-carregada"]} />);
    await screen.findByText("memória carregada");
    expect(screen.getByText(MEMORY_COPY.consultedMissingNote)).toBeTruthy();
  });

  it("omits the missing note when every consulted memory is visible", async () => {
    withMemories([item("a", "memória carregada", "conversation")]);
    render(<MemoryTab speaker="Lucas" highlightIds={["a"]} />);
    await screen.findByText("memória carregada");
    expect(screen.queryByText(MEMORY_COPY.consultedMissingNote)).toBeNull();
  });

  it("keeps the highlight while searching for the marked memory", async () => {
    const memories = manyMemories();
    withMemories(memories);
    render(<MemoryTab speaker="Lucas" highlightIds={[memories[0].id]} />);
    await screen.findByText("Prefiro café forte");
    fireEvent.change(screen.getByPlaceholderText(MEMORY_COPY.searchPlaceholder), {
      target: { value: "cafe" },
    });
    expect(screen.getByText("Prefiro café forte")).toBeTruthy();
    expect(screen.getByText(MEMORY_COPY.consultedBadge)).toBeTruthy();
  });

  it("never resurrects a hidden assistant_reply, even if its id is highlighted", async () => {
    withMemories([
      item("visible", "memória do usuário", "conversation"),
      item("reply-1", "resposta interna", "assistant_reply"),
    ]);
    render(<MemoryTab speaker="Lucas" highlightIds={["reply-1"]} />);
    await screen.findByText("memória do usuário");
    expect(screen.queryByText("resposta interna")).toBeNull(); // still hidden
    // Its id counts as "not in this view" — the honest note appears instead.
    expect(screen.getByText(MEMORY_COPY.consultedMissingNote)).toBeTruthy();
  });
});
