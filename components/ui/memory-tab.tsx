"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check, Database, Loader2, RotateCcw, Search, Trash2, X } from "lucide-react";

import { forgetMemory, getMemory, type MemoryItem } from "@/lib/api";
import {
  MEMORY_COPY,
  groupByRecency,
  humanizeSource,
  presentSources,
  searchMemories,
  sourceChipLabel,
  timeAgo,
  visibleMemories,
} from "@/lib/memory-helpers";
import { springSoft } from "@/lib/motion";

// A single-line status note under the header: a success or a recoverable
// failure. One at a time — a new action replaces the previous note.
type Notice = { kind: "success" | "error"; text: string } | null;

// Below this many visible memories the list is short enough to read at a glance,
// so the search/filter/grouping toolbar would be clutter — render a flat list
// (exactly the #18 behaviour). The toolbar earns its space only on longer lists.
const TOOLS_THRESHOLD = 3;

/**
 * The memory inspector: what F.E.A.R. has kept about the user/context.
 *
 * Extracted from the settings panel so its trust-critical states (loading,
 * recoverable error, confirm-before-delete, honest delete result) are isolated
 * and unit-testable. F.E.A.R.'s own replies are hidden from this view; deleting
 * always asks first; a load failure never masquerades as an empty list.
 *
 * On longer lists it adds local navigation — text search, source filter chips,
 * and date grouping — all over the memories already loaded here (never a global
 * query the backend can't back).
 */
export function MemoryTab({ speaker }: { speaker: string }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setNotice(null);
    setConfirmingId(null);
    try {
      const data = await getMemory();
      setItems(data.memories);
    } catch {
      // Never swallow a failed load as an empty list — that reads as "you have
      // no memories" when the truth is "we couldn't reach them".
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const askDelete = useCallback((id: string) => {
    setNotice(null);
    setConfirmingId(id);
  }, []);

  const cancelDelete = useCallback(() => setConfirmingId(null), []);

  const confirmDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    setNotice(null);
    try {
      const result = await forgetMemory(id);
      if (result.forgotten) {
        setItems((prev) => prev.filter((item) => item.id !== id));
        setNotice({ kind: "success", text: MEMORY_COPY.deleteSuccess });
      } else {
        // 200 but refused (e.g. a claimed pre-account id) — recoverable, and the
        // item stays. The structural fix belongs to a backend lot.
        setNotice({ kind: "error", text: MEMORY_COPY.forgetRefused });
      }
    } catch {
      setNotice({ kind: "error", text: MEMORY_COPY.deleteError });
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }, []);

  const visible = visibleMemories(items);
  const hiddenCount = items.length - visible.length;
  const showTools = visible.length > TOOLS_THRESHOLD;
  const sources = presentSources(visible);
  // Ignore a stale filter whose source no longer exists (e.g. after deleting the
  // last memory of that origin).
  const activeSource = sourceFilter && sources.includes(sourceFilter) ? sourceFilter : null;
  const bySource = activeSource ? visible.filter((item) => item.source === activeSource) : visible;
  const results = showTools ? searchMemories(bySource, query) : visible;
  const groups = groupByRecency(results);
  const shownCount = showTools ? results.length : visible.length;

  const renderItem = (item: MemoryItem) => {
    const confirming = confirmingId === item.id;
    const deleting = deletingId === item.id;
    return (
      <motion.li
        key={item.id}
        layout
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={springSoft}
        className="rounded-xl border border-overlay/10 bg-overlay/[0.025] px-3 py-2.5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm leading-5 text-foreground/90">{item.text}</p>
            <p className="label-tn text-muted-foreground/60">
              {humanizeSource(item.source)} · {timeAgo(item.timestamp)}
            </p>
          </div>
          {!confirming && (
            <button
              onClick={() => askDelete(item.id)}
              aria-label="Apagar esta memória"
              className="tap grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>

        <AnimatePresence initial={false}>
          {confirming && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.16 }}
              className="overflow-hidden"
            >
              <div className="mt-2.5 space-y-2 border-t border-overlay/10 pt-2.5">
                <div>
                  <p className="text-[13px] font-medium text-foreground/90">{MEMORY_COPY.confirmTitle}</p>
                  <p className="text-[12px] leading-5 text-muted-foreground/70">
                    {MEMORY_COPY.confirmSupport}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={cancelDelete}
                    disabled={deleting}
                    className="tap inline-flex h-8 flex-1 items-center justify-center rounded-lg border border-overlay/10 bg-overlay/[0.04] text-[13px] text-foreground hover:bg-overlay/[0.08] disabled:opacity-50"
                  >
                    {MEMORY_COPY.cancel}
                  </button>
                  <button
                    onClick={() => void confirmDelete(item.id)}
                    disabled={deleting}
                    className="tap inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-danger text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {deleting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    {MEMORY_COPY.confirm}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.li>
    );
  };

  const chipClass = (active: boolean) =>
    `tap rounded-full border px-2.5 py-1 text-[11px] transition ${
      active
        ? "border-brand/40 bg-brand/15 text-brand"
        : "border-overlay/10 bg-overlay/[0.03] text-muted-foreground hover:text-foreground"
    }`;

  return (
    <>
      <p className="text-[13px] leading-6 text-muted-foreground">
        O que a F.E.A.R. reteve sobre você — das conversas e da voz. Ele consulta isto sozinho ao responder. O
        que não te servir mais, apague.
      </p>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="label-tn flex items-center gap-1.5">
            <span className="text-brand/70">
              <Database className="size-3.5" />
            </span>
            Lembranças de {speaker || "você"}
          </span>
          {!loading && !loadError && visible.length > 0 && (
            <span className="label-tn text-muted-foreground/60">{shownCount}</span>
          )}
        </div>

        {notice && (
          <div
            role="status"
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] leading-5 ${
              notice.kind === "success"
                ? "border-brand/25 bg-brand/[0.08] text-brand"
                : "border-danger/30 bg-danger/[0.08] text-danger"
            }`}
          >
            {notice.kind === "success" ? (
              <Check className="size-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="size-3.5 shrink-0" />
            )}
            {notice.text}
          </div>
        )}

        {loading ? (
          <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-overlay/10 bg-overlay/[0.02] px-3 py-4 text-[13px] text-muted-foreground/70">
            <Loader2 className="size-3.5 animate-spin" />
            {MEMORY_COPY.loading}
          </p>
        ) : loadError ? (
          <div className="space-y-2.5 rounded-xl border border-danger/25 bg-danger/[0.06] px-3 py-4 text-center">
            <p className="flex items-center justify-center gap-2 text-[13px] text-danger">
              <AlertTriangle className="size-3.5 shrink-0" />
              {MEMORY_COPY.loadError}
            </p>
            <button
              onClick={() => void load()}
              className="tap inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-overlay/10 bg-overlay/[0.04] px-3 text-[13px] text-foreground hover:bg-overlay/[0.08]"
            >
              <RotateCcw className="size-3.5" />
              {MEMORY_COPY.retry}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="space-y-1 rounded-xl border border-dashed border-overlay/10 bg-overlay/[0.02] px-3 py-5 text-center">
            <p className="text-[13px] text-foreground/80">{MEMORY_COPY.empty}</p>
            <p className="text-[12px] leading-5 text-muted-foreground/60">{MEMORY_COPY.emptySupport}</p>
          </div>
        ) : showTools ? (
          <div className="space-y-2.5">
            <div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Buscar nas memórias"
                  placeholder={MEMORY_COPY.searchPlaceholder}
                  className="h-9 w-full rounded-xl border border-overlay/10 bg-overlay/[0.03] pl-9 pr-9 text-sm outline-none transition placeholder:text-muted-foreground/50 focus:border-brand/40 focus:bg-overlay/[0.05]"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Limpar busca"
                    className="tap absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-overlay/[0.06] hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground/50">
                {MEMORY_COPY.searchScopeNote}
              </p>
            </div>

            {sources.length >= 2 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSourceFilter(null)}
                  aria-pressed={activeSource === null}
                  className={chipClass(activeSource === null)}
                >
                  {MEMORY_COPY.filterAll}
                </button>
                {sources.map((source) => (
                  <button
                    key={source}
                    onClick={() => setSourceFilter(source)}
                    aria-pressed={activeSource === source}
                    className={chipClass(activeSource === source)}
                  >
                    {sourceChipLabel(source)}
                  </button>
                ))}
              </div>
            )}

            {results.length === 0 ? (
              <p className="rounded-xl border border-dashed border-overlay/10 bg-overlay/[0.02] px-3 py-5 text-center text-[13px] text-muted-foreground/70">
                {MEMORY_COPY.noResults}
              </p>
            ) : (
              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.key} className="space-y-1.5">
                    <p className="label-tn text-muted-foreground/50">{group.label}</p>
                    <ul className="space-y-1.5">
                      <AnimatePresence initial={false}>{group.items.map(renderItem)}</AnimatePresence>
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>{visible.map(renderItem)}</AnimatePresence>
          </ul>
        )}

        {!loading && !loadError && hiddenCount > 0 && (
          <p className="text-[11px] leading-4 text-muted-foreground/50">{MEMORY_COPY.hiddenNote}</p>
        )}
      </section>
    </>
  );
}
