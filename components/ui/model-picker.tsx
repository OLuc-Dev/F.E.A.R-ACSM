"use client";

import { useMemo, useState } from "react";
import { Check, Download, Loader2, Search } from "lucide-react";

import type {
  LocalDownload,
  LocalModelsResponse,
  ModelOption,
  ModelsResponse,
  PullProgress,
} from "@/lib/api";

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

/** A size on disk, the way people say it: "3,3 GB". */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`;
}

// Searching ignores case and accents: "codigo" finds "Código".
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** A download in progress, or the reason it stopped. */
export interface PullState {
  tag: string;
  progress: PullProgress | null;
  error: string | null;
}

function ModelRow({
  id,
  name,
  tag,
  detail,
  active,
  busy,
  onChoose,
}: {
  id: string;
  name: string;
  tag?: string;
  detail: string;
  active: boolean;
  busy: boolean;
  onChoose: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChoose(id)}
      disabled={busy}
      aria-pressed={active}
      title={id}
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
          {name}
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

function DownloadRow({
  download,
  pulling,
  disabled,
  onPull,
}: {
  download: LocalDownload;
  pulling: PullState | null;
  disabled: boolean;
  onPull: (tag: string) => void;
}) {
  const mine = pulling?.tag === download.tag ? pulling : null;
  const progress = mine?.progress;
  const percent = progress?.total ? Math.floor((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="min-w-0 rounded-xl border border-dashed border-overlay/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">{download.name}</span>
        {(!mine || mine.error) && (
          <button
            type="button"
            onClick={() => onPull(download.tag)}
            disabled={disabled}
            className="tap inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand/30 bg-brand/10 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/20 disabled:opacity-50"
          >
            <Download className="size-3" /> Baixar · {gigabytes(download.size)}
          </button>
        )}
      </div>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{download.note}</span>
      {mine?.error && <p className="mt-1 text-xs text-amber-500/90">{mine.error}</p>}
      {mine && !mine.error && (
        <div className="mt-2">
          <div
            role="progressbar"
            aria-label={`Baixando ${download.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-overlay/10"
          >
            <div className="h-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {progress?.total
              ? `Baixando… ${percent}% (${gigabytes(progress.completed)} de ${gigabytes(progress.total)})`
              : "Começando o download…"}
          </p>
        </div>
      )}
    </div>
  );
}

/** The models on this computer (Ollama): the ones downloaded, and the ones to download. */
function LocalModels({
  local,
  current,
  busy,
  pulling,
  onChoose,
  onPull,
  onRefresh,
}: {
  local: LocalModelsResponse | null;
  current: string;
  busy: boolean;
  pulling: PullState | null;
  onChoose: (id: string) => void;
  onPull: (tag: string) => void;
  onRefresh: () => void;
}) {
  if (!local) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Procurando o Ollama…
      </p>
    );
  }
  if (!local.running) {
    return (
      <div className="rounded-xl border border-dashed border-overlay/20 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        Para eu pensar aqui no seu PC, de graça e sem limite (até sem internet), instale o{" "}
        <a
          href="https://ollama.com/download"
          target="_blank"
          rel="noreferrer"
          className="text-brand underline"
        >
          Ollama
        </a>
        , que é grátis. Com ele aberto, volte aqui para baixar um modelo.
        <button
          type="button"
          onClick={onRefresh}
          className="tap mt-2 block rounded-lg border border-overlay/15 px-2 py-1 text-[11px] text-foreground/80 hover:bg-overlay/[0.06]"
        >
          Procurar o Ollama de novo
        </button>
      </div>
    );
  }
  const names = new Map(local.downloads.map((download) => [download.tag, download.name]));
  const toDownload = local.downloads.filter((download) => !download.installed);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      {local.models.map((model) => (
        <ModelRow
          key={model.id}
          id={model.id}
          name={names.get(model.tag) ?? model.tag}
          tag={model.tag === local.recommended ? "recomendado" : undefined}
          detail={`no seu PC · ${gigabytes(model.size)}${model.parameter_size ? ` · ${model.parameter_size}` : ""}`}
          active={model.id === current}
          busy={busy}
          onChoose={onChoose}
        />
      ))}
      {toDownload.map((download) => (
        <DownloadRow
          key={download.tag}
          download={download}
          pulling={pulling}
          disabled={busy || Boolean(pulling && !pulling.error)}
          onPull={onPull}
        />
      ))}
    </div>
  );
}

/**
 * Choosing the model F.E.A.R. thinks with: the ones on this computer (Ollama,
 * free and unlimited), the free ones OpenRouter has today, and a search over
 * every other (paid ones with a rough cost).
 */
export function ModelPicker({
  catalog,
  loadError,
  local,
  pulling,
  current,
  busy,
  onChoose,
  onPull,
  onRefreshLocal,
}: {
  catalog: ModelsResponse | null;
  loadError: string | null;
  local: LocalModelsResponse | null;
  pulling: PullState | null;
  current: string;
  busy: boolean;
  onChoose: (id: string) => void;
  onPull: (tag: string) => void;
  onRefreshLocal: () => void;
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

  const sectionLabel = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70";
  return (
    <div className="space-y-2">
      <p className={sectionLabel}>No seu PC · grátis e sem limite</p>
      <LocalModels
        local={local}
        current={current}
        busy={busy}
        pulling={pulling}
        onChoose={onChoose}
        onPull={onPull}
        onRefresh={onRefreshLocal}
      />

      <p className={`${sectionLabel} pt-1`}>Na nuvem (OpenRouter)</p>
      {!catalog ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {loadError ?? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Carregando os modelos do OpenRouter…
            </>
          )}
        </p>
      ) : (
        <>
          {pinned && (
            <ModelRow
              id={pinned.id}
              name={pinned.name}
              tag="em uso"
              detail={costLabel(pinned)}
              active
              busy={busy}
              onChoose={onChoose}
            />
          )}
          {/* minmax(0, 1fr): long descriptions truncate instead of widening the column. */}
          <div className="grid max-h-64 grid-cols-[minmax(0,1fr)] gap-1.5 overflow-y-auto pr-1">
            {free.map((model) => (
              <ModelRow
                key={model.id}
                id={model.id}
                name={model.name}
                tag={tagFor(model.id)}
                detail={`grátis, até 50 por dia · ${model.description || model.id}`}
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
                  id={model.id}
                  name={model.name}
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
        </>
      )}
    </div>
  );
}
