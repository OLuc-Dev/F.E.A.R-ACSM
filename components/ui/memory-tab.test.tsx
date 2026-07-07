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
