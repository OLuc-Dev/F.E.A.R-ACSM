// Pure, DOM-free helpers for the memory inspector — the copy, the source
// humanisation, and the visibility rule live here so they are unit-testable
// without a browser and the component stays focused on wiring + state.

// All the memory-panel copy in one place. Cold, lucid, in control — never
// technical, never alarming. The user reads plain language, not raw fields.
export const MEMORY_COPY = {
  loading: "Lendo memórias…",
  empty: "Nenhuma memória registrada ainda.",
  emptySupport: "O F.E.A.R preserva apenas o que ajuda a manter contexto útil.",
  loadError: "Não consegui carregar as memórias.",
  retry: "Tentar novamente",
  confirmTitle: "Apagar esta memória?",
  confirmSupport: "Essa ação remove este registro do contexto do F.E.A.R.",
  cancel: "Cancelar",
  confirm: "Apagar",
  deleteSuccess: "Memória apagada.",
  deleteError: "Não consegui apagar esta memória.",
  // The backend answered 200 but refused (e.g. a claimed memory whose id keeps
  // its pre-account shape). Recoverable, never a silent success.
  forgetRefused: "Este registro não pôde ser removido agora.",
  // Shown only when we actually hid something, so the note is always truthful.
  hiddenNote: "Respostas internas do F.E.A.R não aparecem nesta visão.",
} as const;

// Sources the store can attach to a memory. `assistant_reply` (F.E.A.R.'s own
// words) is intentionally absent: it is hidden from the main list, so it never
// needs a label.
const SOURCE_LABELS: Record<string, string> = {
  conversation: "conversa",
  voice: "voz",
  spotify: "Spotify",
  calendar: "calendário",
  obsidian: "Obsidian",
};

/** Human label for a raw memory `source`. Never leaks a technical string. */
export function humanizeSource(source: string): string {
  return SOURCE_LABELS[source] ?? "origem desconhecida";
}

// Sources kept out of the main inspector. F.E.A.R.'s own replies are stored as
// memories too, but showing them as "what it remembers about you" is confusing
// and reads as a black box — so they are hidden from this view (never deleted).
export const HIDDEN_SOURCES = new Set(["assistant_reply"]);

/** The memories a user should actually see: everything but F.E.A.R.'s own words. */
export function visibleMemories<T extends { source: string }>(items: T[]): T[] {
  return items.filter((item) => !HIDDEN_SOURCES.has(item.source));
}

/** Short relative time for the memory list (client-side; pt-BR). */
export function timeAgo(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `há ${days} d`;
  return new Date(epochSeconds * 1000).toLocaleDateString("pt-BR");
}
