"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, BrainCircuit, FileText, FolderPlus, Loader2, Plus, Trash2, X } from "lucide-react";

import {
  addKnowledgePath,
  addKnowledgeText,
  deleteKnowledge,
  listKnowledge,
  type KnowledgeListResponse,
} from "@/lib/api";

function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm outline-none transition placeholder:text-muted-foreground/50 focus:border-cyan-300/40 focus:bg-white/[0.05]"
    />
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<KnowledgeListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [textName, setTextName] = useState("");
  const [textContent, setTextContent] = useState("");
  const [pathValue, setPathValue] = useState("");
  const [pathName, setPathName] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listKnowledge());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não consegui falar com o backend.");
      setData({ available: false, sources: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operação falhou.");
    } finally {
      setBusy(false);
    }
  }

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!textContent.trim()) return;
    void run(async () => {
      await addKnowledgeText(textName.trim() || "Nota", textContent.trim());
      setTextName("");
      setTextContent("");
    });
  }

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pathValue.trim()) return;
    void run(async () => {
      await addKnowledgePath(pathValue.trim(), pathName.trim() || undefined);
      setPathValue("");
      setPathName("");
    });
  }

  const sources = data?.sources ?? [];
  const unavailable = data !== null && !data.available;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <button
            aria-label="Fechar configuração"
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Configuração"
            className="panel scrollbar-thin relative flex h-full w-full max-w-md flex-col overflow-y-auto rounded-l-[1.6rem] rounded-r-none"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-card/40 px-5 py-4 backdrop-blur-xl">
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                  <BrainCircuit className="size-4 text-cyan-300" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold tracking-[-0.01em]">Configuração</h2>
                  <p className="label-tn">Fontes de conhecimento</p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Fechar"
                className="grid size-8 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="flex-1 space-y-5 px-5 py-5">
              <p className="text-[13px] leading-6 text-muted-foreground">
                Alimente a F.E.A.R. com o que ele deve saber. Tudo que você adicionar vira memória de
                referência que ele consulta sozinho ao responder.
              </p>

              {unavailable && (
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[13px] leading-5 text-amber-200/90">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    A biblioteca de conhecimento está indisponível. Instale as dependências (chromadb,
                    sentence-transformers) e reinicie o backend.
                  </span>
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.08] p-3 text-[13px] leading-5 text-rose-200">
                  {error}
                </div>
              )}

              {/* Current sources */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="label-tn">Fontes ativas</span>
                  {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>

                {sources.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center text-[13px] text-muted-foreground/70">
                    {loading ? "Carregando…" : "Nenhuma fonte ainda. Adicione abaixo."}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {sources.map((item) => (
                      <li
                        key={item.source}
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                          {item.source}
                        </span>
                        <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted-foreground">
                          {item.chunks} {item.chunks === 1 ? "trecho" : "trechos"}
                        </span>
                        <button
                          onClick={() => void run(() => deleteKnowledge(item.source))}
                          disabled={busy}
                          aria-label={`Remover ${item.source}`}
                          className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-rose-400/10 hover:text-rose-300 disabled:opacity-50"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Add by text */}
              <form
                onSubmit={submitText}
                className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-3.5"
              >
                <span className="label-tn flex items-center gap-1.5">
                  <FileText className="size-3.5 text-cyan-300/70" /> Adicionar texto
                </span>
                <Field
                  value={textName}
                  onChange={(event) => setTextName(event.target.value)}
                  placeholder="Nome (ex: Princípios de produto)"
                />
                <textarea
                  value={textContent}
                  onChange={(event) => setTextContent(event.target.value)}
                  rows={4}
                  placeholder="Cole aqui o conhecimento que ele deve absorver…"
                  className="scrollbar-thin w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm leading-6 outline-none transition placeholder:text-muted-foreground/50 focus:border-cyan-300/40 focus:bg-white/[0.05]"
                />
                <button
                  type="submit"
                  disabled={busy || !textContent.trim()}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Adicionar
                </button>
              </form>

              {/* Add by local path */}
              <form
                onSubmit={submitPath}
                className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-3.5"
              >
                <span className="label-tn flex items-center gap-1.5">
                  <FolderPlus className="size-3.5 text-cyan-300/70" /> Conectar pasta ou arquivo
                </span>
                <Field
                  value={pathValue}
                  onChange={(event) => setPathValue(event.target.value)}
                  placeholder="/caminho/para/notas (pasta ou .md)"
                />
                <Field
                  value={pathName}
                  onChange={(event) => setPathName(event.target.value)}
                  placeholder="Nome da fonte (opcional)"
                />
                <p className="text-[11px] leading-4 text-muted-foreground/60">
                  Caminho no computador onde o backend roda. Indexa todos os .md de uma pasta.
                </p>
                <button
                  type="submit"
                  disabled={busy || !pathValue.trim()}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-foreground transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
                  Indexar caminho
                </button>
              </form>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
