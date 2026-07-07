import { describe, expect, it } from "vitest";

import { HIDDEN_SOURCES, humanizeSource, timeAgo, visibleMemories } from "@/lib/memory-helpers";

describe("humanizeSource", () => {
  it("maps known sources to plain pt-BR labels", () => {
    expect(humanizeSource("conversation")).toBe("conversa");
    expect(humanizeSource("voice")).toBe("voz");
    expect(humanizeSource("spotify")).toBe("Spotify");
    expect(humanizeSource("calendar")).toBe("calendário");
    expect(humanizeSource("obsidian")).toBe("Obsidian");
  });

  it("falls back to a discreet label for unknown sources — never a raw string", () => {
    expect(humanizeSource("weird_internal_source")).toBe("origem desconhecida");
    expect(humanizeSource("")).toBe("origem desconhecida");
  });
});

describe("visibleMemories", () => {
  it("hides F.E.A.R.'s own replies (assistant_reply) and keeps the rest", () => {
    const items = [
      { id: "a", source: "conversation" },
      { id: "b", source: "assistant_reply" },
      { id: "c", source: "voice" },
      { id: "d", source: "assistant_reply" },
    ];
    expect(visibleMemories(items).map((m) => m.id)).toEqual(["a", "c"]);
    expect(HIDDEN_SOURCES.has("assistant_reply")).toBe(true);
  });

  it("returns everything when nothing is hidden", () => {
    const items = [{ source: "conversation" }, { source: "obsidian" }];
    expect(visibleMemories(items)).toHaveLength(2);
  });
});

describe("timeAgo", () => {
  it("reads 'agora' for a just-now timestamp", () => {
    expect(timeAgo(Date.now() / 1000)).toBe("agora");
  });

  it("reads minutes for a few minutes ago", () => {
    expect(timeAgo(Date.now() / 1000 - 300)).toBe("há 5 min");
  });

  it("never returns a negative/future duration", () => {
    expect(timeAgo(Date.now() / 1000 + 10_000)).toBe("agora");
  });
});
