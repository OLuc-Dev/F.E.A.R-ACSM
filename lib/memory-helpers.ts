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
  searchPlaceholder: "Buscar nas memórias…",
  noResults: "Nenhuma memória encontrada.",
  // Honest about scope: search runs over what's loaded here, not the whole store.
  searchScopeNote: "A busca considera as memórias carregadas nesta visão.",
  filterAll: "Tudo",
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

// Capitalise the first letter for chip labels ("conversa" → "Conversa"), so
// humanised sources read uniformly next to already-capitalised ones (Spotify).
export function sourceChipLabel(source: string): string {
  const label = humanizeSource(source);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Distinct sources present in a list, in first-seen order — drives the filter chips. */
export function presentSources<T extends { source: string }>(items: T[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item.source)) {
      seen.add(item.source);
      out.push(item.source);
    }
  }
  return out;
}

// Case- and accent-insensitive so "cafe" finds "café" and "OBSIDIAN" finds
// "Obsidian" — pt-BR users should not fight diacritics to find a memory.
const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

/** Filter by a free-text query over the memory text. An empty query matches all. */
export function searchMemories<T extends { text: string }>(items: T[], query: string): T[] {
  const needle = normalizeText(query.trim());
  if (!needle) return items;
  return items.filter((item) => normalizeText(item.text).includes(needle));
}

export type RecencyKey = "hoje" | "semana" | "antigas";
export interface MemoryGroup<T> {
  key: RecencyKey;
  label: string;
  items: T[];
}

const RECENCY_LABELS: Record<RecencyKey, string> = {
  hoje: "Hoje",
  semana: "Últimos 7 dias",
  antigas: "Mais antigas",
};

/**
 * Bucket memories by recency using rolling windows from `now`: the last 24h
 * ("Hoje"), the last 7 days, and older. Rolling (not calendar) windows keep it
 * timezone-independent and deterministic. Only non-empty groups are returned,
 * in that order; item order within a group is preserved (the backend already
 * sorts newest-first).
 */
export function groupByRecency<T extends { timestamp: number }>(
  items: T[],
  now: number = Date.now(),
): MemoryGroup<T>[] {
  const nowSeconds = now / 1000;
  const buckets: Record<RecencyKey, T[]> = { hoje: [], semana: [], antigas: [] };
  for (const item of items) {
    const elapsed = nowSeconds - item.timestamp;
    if (elapsed < 86400) buckets.hoje.push(item);
    else if (elapsed < 7 * 86400) buckets.semana.push(item);
    else buckets.antigas.push(item);
  }
  return (["hoje", "semana", "antigas"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: RECENCY_LABELS[key], items: buckets[key] }));
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
