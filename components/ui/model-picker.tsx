"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";

import type { ModelOption, ModelsResponse } from "@/lib/api";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });
const SEARCH_RESULTS = 8;

/** What a model costs, in words: per 100 of F.E.A.R.'s replies, roughly. */
export function costLabel(model: ModelOption): string {
  if (model.free) return "grátis";
  const cost = model.cost_per_100_replies;
  if (cost === null) return "preço varia";
  if (cost < 0.01) return `menos de ${money.format(0.01)} a cada 100 respostas`;
  return `≈ ${money.format(cost)} a cada 100 respostas`;
}

// Searching ignores case and accents: "codigo" finds "Código".
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

function ModelRow({
  model,
  tag,
  detail,
  active,
  busy,
  onChoose,
}: {
  model: ModelOption;
  tag?: string;
  detail: string;
  active: boolean;
  busy: boolean;
  onChoose: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChoose(model.id)}
      disabled={busy}
      aria-pressed={active}
      title={model.id}
      className={`tap w-full min-w-0 rounded-xl border px-3 py-2 text-left disabled:opacity-50 ${
        active
          ? "border-brand/40 bg-brand/[0.08]"
          : "border-overlay/10 bg-overlay/[0.025] hover:bg-overlay/[0.04]"
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium ${active ? "text-brand" : "text-foreground/90"}`}
        >
          {model.name}
        </span>
        {tag && (
          <span className="shrink-0 rounded-md border border-overlay/15 px-1.5 text-[10px] text-muted-foreground">
            {tag}
          </span>
        )}
        {active && <Check className="size-4 shrink-0 text-brand" />}
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

/**
 * Choosing the model F.E.A.R. thinks with: the free ones OpenRouter has today,
 * and a search over every other (paid ones with a rough cost).
 */
export function ModelPicker({
  catalog,
  loadError,
  current,
  busy,
  onChoose,
}: {
  catalog: ModelsResponse | null;
  loadError: string | null;
  current: string;
  busy: boolean;
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  const tagFor = (id: string) =>
    id === catalog?.default ? "padrão" : catalog?.fallbacks.includes(id) ? "reserva" : undefined;

  const free = useMemo(() => catalog?.models.filter((model) => model.free) ?? [], [catalog]);
  // A paid (or unlisted) model in use shows above the free ones, so the choice is visible.
  const chosen = catalog?.models.find((model) => model.id === current);
  const pinned = chosen && !chosen.free ? chosen : null;

  const wanted = fold(query.trim());
  const found = useMemo(() => {
    if (!wanted || !catalog) return [];
    return catalog.models
      .filter((model) => fold(model.name).includes(wanted) || fold(model.id).includes(wanted))
      .slice(0, SEARCH_RESULTS);
  }, [catalog, wanted]);
  // An exact id typed in that the list doesn't have (a :nitro variant, say) can
  // still be tried: saving checks it against OpenRouter.
  const typedId = query.trim();
  const offerTyped = typedId.includes("/") && !catalog?.models.some((model) => model.id === typedId);

  if (!catalog) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {loadError ?? (
          <>
            <Loader2 className="size-3.5 animate-spin" /> Carregando os modelos do OpenRouter…
          </>
        )}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {pinned && (
        <ModelRow
          model={pinned}
          tag="em uso"
          detail={costLabel(pinned)}
          active
          busy={busy}
          onChoose={onChoose}
        />
      )}
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Grátis</p>
      {/* minmax(0, 1fr): long descriptions truncate instead of widening the column. */}
      <div className="grid max-h-64 grid-cols-[minmax(0,1fr)] gap-1.5 overflow-y-auto pr-1">
        {free.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            tag={tagFor(model.id)}
            detail={model.description || model.id}
            active={model.id === current}
            busy={busy}
            onChoose={onChoose}
          />
        ))}
      </div>

      <label className="flex h-9 items-center gap-2 rounded-xl border border-overlay/10 bg-overlay/[0.03] px-3 focus-within:border-brand/40">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Procurar outro modelo (pago ou grátis)…"
          aria-label="Procurar outro modelo"
          className="h-full w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </label>
      {wanted && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {found.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              tag={tagFor(model.id)}
              detail={`${model.id} · ${costLabel(model)}`}
              active={model.id === current}
              busy={busy}
              onChoose={onChoose}
            />
          ))}
          {offerTyped && (
            <button
              type="button"
              onClick={() => onChoose(typedId)}
              disabled={busy}
              className="tap rounded-xl border border-dashed border-overlay/20 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-overlay/[0.04] disabled:opacity-50"
            >
              Usar “{typedId}”
            </button>
          )}
          {!found.length && !offerTyped && (
            <p className="text-xs text-muted-foreground">Nenhum modelo com esse nome.</p>
          )}
        </div>
      )}
    </div>
  );
}
