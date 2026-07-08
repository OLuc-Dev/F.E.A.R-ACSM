import { describe, expect, it } from "vitest";

import {
  HIDDEN_SOURCES,
  consultedChipLabel,
  groupByRecency,
  humanizeSource,
  presentSources,
  searchMemories,
  sourceChipLabel,
  timeAgo,
  visibleMemories,
} from "@/lib/memory-helpers";

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

describe("consultedChipLabel", () => {
  it("reads singular for one and plural for many — always 'consultada', never 'usada'", () => {
    expect(consultedChipLabel(1)).toBe("1 memória consultada nesta resposta");
    expect(consultedChipLabel(3)).toBe("3 memórias consultadas nesta resposta");
    expect(consultedChipLabel(1)).not.toMatch(/usada/);
  });
});

describe("sourceChipLabel", () => {
  it("capitalises the humanised label for uniform chips", () => {
    expect(sourceChipLabel("conversation")).toBe("Conversa");
    expect(sourceChipLabel("voice")).toBe("Voz");
    expect(sourceChipLabel("obsidian")).toBe("Obsidian");
  });
});

describe("presentSources", () => {
  it("returns distinct sources in first-seen order", () => {
    const items = [
      { source: "conversation" },
      { source: "voice" },
      { source: "conversation" },
      { source: "obsidian" },
    ];
    expect(presentSources(items)).toEqual(["conversation", "voice", "obsidian"]);
  });

  it("is empty for an empty list", () => {
    expect(presentSources([])).toEqual([]);
  });
});

describe("searchMemories", () => {
  const items = [
    { text: "Prefiro café forte" },
    { text: "Notas no Obsidian" },
    { text: "Reunião de produto" },
  ];

  it("returns everything for a blank query", () => {
    expect(searchMemories(items, "   ")).toHaveLength(3);
  });

  it("matches case- and accent-insensitively", () => {
    expect(searchMemories(items, "CAFE").map((m) => m.text)).toEqual(["Prefiro café forte"]);
    expect(searchMemories(items, "obsidian").map((m) => m.text)).toEqual(["Notas no Obsidian"]);
  });

  it("returns nothing when there is no match", () => {
    expect(searchMemories(items, "xyz")).toEqual([]);
  });
});

describe("groupByRecency", () => {
  const now = new Date("2026-07-07T12:00:00Z").getTime();
  const at = (msAgo: number) => Math.floor((now - msAgo) / 1000);
  const DAY = 86400 * 1000;

  it("buckets into hoje / últimos 7 dias / mais antigas and keeps order", () => {
    const items = [
      { id: "today", timestamp: at(2 * 3600 * 1000) },
      { id: "week", timestamp: at(3 * DAY) },
      { id: "old", timestamp: at(30 * DAY) },
    ];
    const groups = groupByRecency(items, now);
    expect(groups.map((g) => g.key)).toEqual(["hoje", "semana", "antigas"]);
    expect(groups.map((g) => g.label)).toEqual(["Hoje", "Últimos 7 dias", "Mais antigas"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["today"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["week"]);
    expect(groups[2].items.map((i) => i.id)).toEqual(["old"]);
  });

  it("omits empty groups", () => {
    const items = [{ id: "old", timestamp: at(20 * DAY) }];
    const groups = groupByRecency(items, now);
    expect(groups.map((g) => g.key)).toEqual(["antigas"]);
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
