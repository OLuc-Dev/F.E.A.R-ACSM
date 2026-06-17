"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  Cpu,
  FileText,
  FolderPlus,
  Loader2,
  Plug,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import {
  addKnowledgePath,
  addKnowledgeText,
  deleteKnowledge,
  getConfig,
  listKnowledge,
  updateConfig,
  type ConfigResponse,
  type ConfigUpdate,
  type KnowledgeListResponse,
  type StatusResponse,
} from "@/lib/api";

type Tab = "conhecimento" | "comportamento";

const MODE_META: Record<string, { label: string; desc: string }> = {
  equilibrio: { label: "Equilíbrio", desc: "Frio, lúcido e leal. A persona como ele é." },
  sombrio: { label: "Sombrio", desc: "Mais cortante, mais niilista, mais Ultron." },
  cirurgico: { label: "Cirúrgico", desc: "Sem teatro. Diagnóstico, decisão, ação." },
};

type StatusFlag = "openrouter" | "memory" | "spotify" | "obsidian" | "voice";

const INTEGRATIONS: { key: StatusFlag; label: string; hint: string }[] = [
  { key: "openrouter", label: "OpenRouter", hint: "OPENROUTER_API_KEY no .env" },
  { key: "memory", label: "Memória", hint: "local, ativa por padrão" },
  { key: "spotify", label: "Spotify", hint: "python scripts/spotify_login.py" },
  { key: "obsidian", label: "Obsidian", hint: "OBSIDIAN_VAULT_PATH no .env" },
  { key: "voice", label: "Voz", hint: "FEAR_ENABLE_VOICE_LISTENER=1" },
];

function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm outline-none transition placeholder:text-muted-foreground/50 focus:border-cyan-300/40 focus:bg-white/[0.05]"
    />
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="label-tn flex items-center gap-1.5">
      <span className="text-cyan-300/70">{icon}</span>
      {children}
    </span>
  );
}

export function SettingsPanel({
  open,
  onClose,
  status,
}: {
  open: boolean;
  onClose: () => void;
  status: StatusResponse | null;
}) {
  const [tab, setTab] = useState<Tab>("conhecimento");
  const [data, setData] = useState<KnowledgeListResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [modelInput, setModelInput] = useState("");
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

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
      setModelInput(cfg.model);
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    void refreshConfig();
  }, [open, refresh, refreshConfig]);

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

  async function applyConfig(update: ConfigUpdate) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const cfg = await updateConfig(update);
      setConfig(cfg);
      setModelInput(cfg.model);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não consegui salvar.");
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
  const modes = config?.persona_modes ?? ["equilibrio", "sombrio", "cirurgico"];

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
            <header className="sticky top-0 z-10 space-y-3 border-b border-white/[0.06] bg-card/40 px-5 py-4 backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                    <BrainCircuit className="size-4 text-cyan-300" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold tracking-[-0.01em]">Configuração</h2>
                    <p className="label-tn">F.E.A.R.</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Fechar"
                  className="grid size-8 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
                {(["conhecimento", "comportamento"] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setTab(value)}
                    className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
                      tab === value
                        ? "bg-cyan-300/15 text-cyan-200"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </header>

            <div className="flex-1 space-y-5 px-5 py-5">
              {error && (
                <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.08] p-3 text-[13px] leading-5 text-rose-200">
                  {error}
                </div>
              )}

              {tab === "conhecimento" ? (
                <>
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

                  <section className="space-y-2">
                    <div className="flex items-center justify-between">
                      <SectionLabel icon={<BrainCircuit className="size-3.5" />}>Fontes ativas</SectionLabel>
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

                  <form
                    onSubmit={submitText}
                    className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-3.5"
                  >
                    <SectionLabel icon={<FileText className="size-3.5" />}>Adicionar texto</SectionLabel>
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

                  <form
                    onSubmit={submitPath}
                    className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-3.5"
                  >
                    <SectionLabel icon={<FolderPlus className="size-3.5" />}>
                      Conectar pasta ou arquivo
                    </SectionLabel>
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
                </>
              ) : (
                <>
                  {/* Persona mode */}
                  <section className="space-y-2">
                    <SectionLabel icon={<Sparkles className="size-3.5" />}>Personalidade</SectionLabel>
                    <div className="grid gap-1.5">
                      {modes.map((mode) => {
                        const meta = MODE_META[mode] ?? { label: mode, desc: "" };
                        const active = config?.persona_mode === mode;
                        return (
                          <button
                            key={mode}
                            onClick={() => void applyConfig({ persona_mode: mode })}
                            disabled={busy}
                            className={`rounded-xl border p-3 text-left transition disabled:opacity-50 ${
                              active
                                ? "border-cyan-300/40 bg-cyan-300/[0.08]"
                                : "border-white/10 bg-white/[0.025] hover:bg-white/[0.04]"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span
                                className={`text-sm font-medium ${active ? "text-cyan-100" : "text-foreground/90"}`}
                              >
                                {meta.label}
                              </span>
                              {active && <Check className="size-4 text-cyan-300" />}
                            </div>
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{meta.desc}</p>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {/* Model */}
                  <section className="space-y-2">
                    <SectionLabel icon={<Cpu className="size-3.5" />}>Modelo (OpenRouter)</SectionLabel>
                    <Field
                      value={modelInput}
                      onChange={(event) => setModelInput(event.target.value)}
                      placeholder="ex: openai/gpt-oss-120b:free"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => void applyConfig({ model: modelInput.trim() })}
                        disabled={busy || !modelInput.trim() || modelInput.trim() === config?.model}
                        className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                        Salvar modelo
                      </button>
                      {config && config.model !== config.model_default && (
                        <button
                          onClick={() => void applyConfig({ model: config.model_default })}
                          disabled={busy}
                          className="inline-flex h-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-foreground transition hover:bg-white/[0.08] disabled:opacity-50"
                        >
                          Padrão
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] leading-4 text-muted-foreground/60">
                      Atual: {config?.model ?? "—"}. Ids em openrouter.ai/models. Vale por esta sessão; o
                      padrão fixo fica no .env.
                    </p>
                  </section>

                  {/* Integrations */}
                  <section className="space-y-2">
                    <SectionLabel icon={<Plug className="size-3.5" />}>Integrações</SectionLabel>
                    <ul className="space-y-0.5">
                      {INTEGRATIONS.map((item) => {
                        const on = status?.[item.key] ?? false;
                        return (
                          <li
                            key={item.key}
                            className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5"
                          >
                            <span className="flex items-center gap-2 text-[13px] text-foreground/80">
                              <span
                                className={`size-1.5 rounded-full ${on ? "bg-cyan-300 shadow-[0_0_8px_1px_rgba(34,211,238,0.6)]" : "bg-white/20"}`}
                              />
                              {item.label}
                            </span>
                            <span className="truncate text-[11px] text-muted-foreground/60">
                              {on ? "ativo" : item.hint}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-[11px] leading-4 text-muted-foreground/50">
                      Chaves de API ficam só no seu .env — nunca aqui.
                    </p>
                  </section>
                </>
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
