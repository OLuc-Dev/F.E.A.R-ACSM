"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  Cpu,
  FileText,
  Loader2,
  Plug,
  Plus,
  Sparkles,
  Volume2,
  Trash2,
  X,
} from "lucide-react";

import {
  addKnowledgeText,
  deleteKnowledge,
  getConfig,
  getModels,
  listKnowledge,
  updateConfig,
  type ConfigResponse,
  type ConfigUpdate,
  type KnowledgeListResponse,
  type ModelsResponse,
  type StatusResponse,
} from "@/lib/api";
import { IS_DESKTOP } from "@/lib/desktop";
import {
  loadOnlineVoice,
  loadVoiceStyle,
  saveOnlineVoice,
  saveVoiceStyle,
  startSpeaking,
  VOICE_STYLES,
  type VoiceStyle,
} from "@/lib/speech";
import { fade, springSoft } from "@/lib/motion";
import { AppSettingsTab, Switch } from "@/components/ui/app-settings-tab";
import { MemoryTab } from "@/components/ui/memory-tab";
import { ModelPicker } from "@/components/ui/model-picker";

export type Tab = "conhecimento" | "comportamento" | "memoria" | "app";

const TAB_LABELS: Record<Tab, string> = {
  conhecimento: "Conhecimento",
  comportamento: "Comportamento",
  memoria: "Memória",
  app: "App",
};

// The Windows app adds its own switches; the web version has none to show.
const TABS: Tab[] = IS_DESKTOP
  ? ["conhecimento", "comportamento", "memoria", "app"]
  : ["conhecimento", "comportamento", "memoria"];

const MODE_META: Record<string, { label: string; desc: string }> = {
  equilibrio: { label: "Equilíbrio", desc: "Frio, lúcido e leal. A persona como ele é." },
  sombrio: { label: "Sombrio", desc: "Mais cortante, mais niilista, mais Ultron." },
  cirurgico: { label: "Cirúrgico", desc: "Sem teatro. Diagnóstico, decisão, ação." },
};

type StatusFlag = "openrouter" | "memory" | "spotify" | "music" | "obsidian" | "voice" | "calendar";

const INTEGRATIONS: { key: StatusFlag; label: string; hint: string }[] = IS_DESKTOP
  ? [
      { key: "openrouter", label: "OpenRouter", hint: "cole sua chave no ícone de conta" },
      { key: "memory", label: "Memória", hint: "local, ativa por padrão" },
      { key: "music", label: "Música", hint: "teclas de mídia do Windows" },
      { key: "obsidian", label: "Obsidian", hint: "escolha a pasta na aba App" },
      { key: "calendar", label: "Agenda", hint: "ainda não disponível no app" },
      { key: "voice", label: "Voz", hint: "reinstale o app para trazer a voz" },
    ]
  : [
      { key: "openrouter", label: "OpenRouter", hint: "OPENROUTER_API_KEY no .env" },
      { key: "memory", label: "Memória", hint: "local, ativa por padrão" },
      { key: "spotify", label: "Spotify", hint: "python scripts/spotify_login.py" },
      { key: "obsidian", label: "Obsidian", hint: "OBSIDIAN_VAULT_PATH no .env" },
      { key: "calendar", label: "Agenda", hint: "python scripts/google_login.py" },
      { key: "voice", label: "Voz", hint: 'pip install -e ".[voice]"' },
    ];

function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-10 w-full rounded-xl border border-overlay/10 bg-overlay/[0.03] px-3 text-sm outline-none transition placeholder:text-muted-foreground/50 focus:border-brand/40 focus:bg-overlay/[0.05]"
    />
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="label-tn flex items-center gap-1.5">
      <span className="text-brand/70">{icon}</span>
      {children}
    </span>
  );
}

export function SettingsPanel({
  open,
  onClose,
  status,
  speaker,
  initialTab = "conhecimento",
  highlightMemoryIds,
  hasOpenRouterKey = false,
  alwaysListen = false,
  onAlwaysListenChange,
  voiceInterface = false,
  onVoiceInterfaceChange,
}: {
  open: boolean;
  onClose: () => void;
  status: StatusResponse | null;
  speaker: string;
  initialTab?: Tab;
  // Memories to mark as "consultada nesta resposta" in the memory tab (set when
  // the inspector is opened from a reply's chip).
  highlightMemoryIds?: string[];
  // The signed-in user's own key counts as "OpenRouter on", not just the server's.
  hasOpenRouterKey?: boolean;
  // Listening as soon as the window opens (the switch shows when there's a voice).
  alwaysListen?: boolean;
  onAlwaysListenChange?: (on: boolean) => void;
  // The voice interface (JARVIS-style, no written chat) instead of the chat.
  voiceInterface?: boolean;
  onVoiceInterfaceChange?: (on: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("conhecimento");
  const [data, setData] = useState<KnowledgeListResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyle>("natural");
  const [onlineVoice, setOnlineVoice] = useState(true);
  useEffect(() => {
    if (!open) return;
    setVoiceStyle(loadVoiceStyle());
    setOnlineVoice(loadOnlineVoice());
  }, [open]);
  // OpenRouter's models, read when the Comportamento tab first opens.
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [textName, setTextName] = useState("");
  const [textContent, setTextContent] = useState("");

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
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    void refresh();
    void refreshConfig();
  }, [open, initialTab, refresh, refreshConfig]);

  useEffect(() => {
    if (!open || tab !== "comportamento" || models) return;
    let current = true;
    setModelsError(null);
    getModels()
      .then((listed) => current && setModels(listed))
      .catch((caught) => {
        if (current)
          setModelsError(caught instanceof Error ? caught.message : "Não consegui ler os modelos.");
      });
    return () => {
      current = false;
    };
  }, [open, tab, models]);

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
            <header className="sticky top-0 z-10 space-y-3 border-b border-overlay/[0.06] bg-card/40 px-5 py-4 backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 place-items-center rounded-xl border border-overlay/10 bg-overlay/[0.03]">
                    <BrainCircuit className="size-4 text-brand" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold tracking-[-0.01em]">Configuração</h2>
                    <p className="label-tn">F.E.A.R.</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Fechar"
                  className="tap grid size-8 place-items-center rounded-lg border border-overlay/10 bg-overlay/[0.03] text-muted-foreground hover:bg-overlay/[0.06] hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex gap-1 rounded-xl border border-overlay/10 bg-overlay/[0.03] p-1">
                {TABS.map((value) => (
                  <button
                    key={value}
                    onClick={() => setTab(value)}
                    className={`tap flex-1 rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                      tab === value ? "bg-brand/15 text-brand" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {TAB_LABELS[value]}
                  </button>
                ))}
              </div>
            </header>

            <div className="flex-1 px-5 py-5">
              {error && (
                <div className="mb-5 rounded-xl border border-danger/30 bg-danger/[0.08] p-3 text-[13px] leading-5 text-danger">
                  {error}
                </div>
              )}

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  className="space-y-5"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={fade}
                >
                  {tab === "conhecimento" ? (
                    <>
                      <p className="text-[13px] leading-6 text-muted-foreground">
                        Alimente a F.E.A.R. com o que ele deve saber. Tudo que você adicionar vira memória de
                        referência que ele consulta sozinho ao responder.
                      </p>

                      {unavailable && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-overlay/10 bg-overlay/[0.03] p-3 text-[13px] leading-5 text-muted-foreground">
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
                          <span>
                            A biblioteca de conhecimento está indisponível. Instale as dependências (chromadb)
                            e reinicie o backend.
                          </span>
                        </div>
                      )}

                      <section className="space-y-2">
                        <div className="flex items-center justify-between">
                          <SectionLabel icon={<BrainCircuit className="size-3.5" />}>
                            Fontes ativas
                          </SectionLabel>
                          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                        </div>

                        {sources.length === 0 ? (
                          <p className="rounded-xl border border-dashed border-overlay/10 bg-overlay/[0.02] px-3 py-4 text-center text-[13px] text-muted-foreground/70">
                            {loading ? "Carregando…" : "Nenhuma fonte ainda. Adicione abaixo."}
                          </p>
                        ) : (
                          <ul className="space-y-1.5">
                            <AnimatePresence initial={false}>
                              {sources.map((item) => (
                                <motion.li
                                  key={item.source}
                                  layout
                                  initial={{ opacity: 0, scale: 0.96 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.96 }}
                                  transition={springSoft}
                                  className="flex items-center justify-between gap-3 rounded-xl border border-overlay/10 bg-overlay/[0.025] px-3 py-2.5"
                                >
                                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                                    {item.source}
                                  </span>
                                  <span className="shrink-0 rounded-full border border-overlay/10 px-2 py-0.5 text-[10px] text-muted-foreground">
                                    {item.chunks} {item.chunks === 1 ? "trecho" : "trechos"}
                                  </span>
                                  <button
                                    onClick={() => void run(() => deleteKnowledge(item.source))}
                                    disabled={busy}
                                    aria-label={`Remover ${item.source}`}
                                    className="tap grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                                  >
                                    <Trash2 className="size-3.5" />
                                  </button>
                                </motion.li>
                              ))}
                            </AnimatePresence>
                          </ul>
                        )}
                      </section>

                      <form
                        onSubmit={submitText}
                        className="space-y-2 rounded-2xl border border-overlay/10 bg-overlay/[0.02] p-3.5"
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
                          className="scrollbar-thin w-full resize-none rounded-xl border border-overlay/10 bg-overlay/[0.03] p-3 text-sm leading-6 outline-none transition placeholder:text-muted-foreground/50 focus:border-brand/40 focus:bg-overlay/[0.05]"
                        />
                        <button
                          type="submit"
                          disabled={busy || !textContent.trim()}
                          className="tap inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-medium text-[hsl(var(--brand-ink))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                          Adicionar
                        </button>
                      </form>
                    </>
                  ) : tab === "comportamento" ? (
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
                                className={`tap rounded-xl border p-3 text-left disabled:opacity-50 ${
                                  active
                                    ? "border-brand/40 bg-brand/[0.08]"
                                    : "border-overlay/10 bg-overlay/[0.025] hover:bg-overlay/[0.04]"
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <span
                                    className={`text-sm font-medium ${active ? "text-brand" : "text-foreground/90"}`}
                                  >
                                    {meta.label}
                                  </span>
                                  {active && <Check className="size-4 text-brand" />}
                                </div>
                                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{meta.desc}</p>
                              </button>
                            );
                          })}
                        </div>
                      </section>

                      {/* Voice */}
                      <section className="space-y-2">
                        <SectionLabel icon={<Volume2 className="size-3.5" />}>Voz</SectionLabel>
                        <div className="grid gap-1.5">
                          {VOICE_STYLES.filter(
                            (option) => option.value === "system" || status?.voice_output,
                          ).map((option) => {
                            const active = voiceStyle === option.value;
                            return (
                              <div
                                key={option.value}
                                className={`flex items-center gap-2 rounded-xl border p-1 ${
                                  active
                                    ? "border-brand/40 bg-brand/[0.08]"
                                    : "border-overlay/10 bg-overlay/[0.025]"
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    saveVoiceStyle(option.value);
                                    setVoiceStyle(option.value);
                                  }}
                                  aria-pressed={active}
                                  className="tap flex-1 rounded-lg px-2 py-1.5 text-left"
                                >
                                  <span
                                    className={`text-sm font-medium ${active ? "text-brand" : "text-foreground/90"}`}
                                  >
                                    {option.label}
                                  </span>
                                  <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    startSpeaking(option.value).say("Eu sou o F.E.A.R. É assim que eu falo.")
                                  }
                                  className="tap rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-overlay/[0.06] hover:text-foreground"
                                >
                                  Ouvir
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        {status?.voice_online && (
                          <>
                            <Switch
                              checked={onlineVoice}
                              onChange={(on) => {
                                saveOnlineVoice(on);
                                setOnlineVoice(on);
                              }}
                              label="Voz neural online (Microsoft)"
                            />
                            <p className="text-[11px] leading-4 text-muted-foreground/60">
                              A mais natural: a voz Antonio, da Microsoft — o texto de cada frase que ele fala
                              vai para o serviço de voz dela. Sem internet, ele fala com a voz deste
                              computador. Desligada, a voz é sempre feita aqui.
                            </p>
                          </>
                        )}
                        <p className="text-[11px] leading-4 text-muted-foreground/60">
                          {status?.voice_output && !(status.voice_online && onlineVoice)
                            ? "A voz do F.E.A.R. é gerada neste computador. "
                            : ""}
                          Ele responde em voz alta quando você fala com ele, ou sempre, com o som ligado no
                          topo.
                        </p>
                        {status?.voice_input && onVoiceInterfaceChange && (
                          <>
                            <Switch
                              checked={voiceInterface}
                              onChange={onVoiceInterfaceChange}
                              label="Interface só de voz (estilo J.A.R.V.I.S.)"
                            />
                            <p className="text-[11px] leading-4 text-muted-foreground/60">
                              Ligada, a tela é só para conversar: o núcleo no centro ouve você e fala com a
                              voz do F.E.A.R., com legendas do que está sendo dito — sem caixa de texto nem
                              histórico. Desligada, volta o chat escrito.
                            </p>
                          </>
                        )}
                        {status?.voice_input && onAlwaysListenChange && (
                          <>
                            <Switch
                              checked={alwaysListen}
                              onChange={onAlwaysListenChange}
                              label="Ouvir assim que abrir"
                            />
                            <p className="text-[11px] leading-4 text-muted-foreground/60">
                              Com a janela aberta ele fica ouvindo e responde ao que você falar — sem clicar.
                              Não ouve enquanto ele mesmo fala, nem com a janela minimizada. Desligado, você
                              fala pelo botão do microfone ou segurando Ctrl+Espaço.
                            </p>
                          </>
                        )}
                      </section>

                      {/* Model */}
                      <section className="space-y-2">
                        <SectionLabel icon={<Cpu className="size-3.5" />}>Modelo (OpenRouter)</SectionLabel>
                        <ModelPicker
                          catalog={models}
                          loadError={modelsError}
                          current={config?.model ?? ""}
                          busy={busy}
                          onChoose={(model) => {
                            if (model !== config?.model) void applyConfig({ model });
                          }}
                        />
                        {config && config.model !== config.model_default && (
                          <button
                            onClick={() => void applyConfig({ model: config.model_default })}
                            disabled={busy}
                            className="tap inline-flex h-8 items-center justify-center rounded-xl border border-overlay/10 bg-overlay/[0.04] px-3 text-xs text-foreground hover:bg-overlay/[0.08] disabled:opacity-50"
                          >
                            Voltar ao padrão
                          </button>
                        )}
                        {config?.model_available === false && (
                          <p className="text-[11px] leading-4 text-amber-500/90">
                            O OpenRouter não tem mais o modelo {config.model}. Até você escolher outro, ele
                            responde com um modelo grátis.
                          </p>
                        )}
                        <p className="text-[11px] leading-4 text-muted-foreground/60">
                          Atual: {config?.model ?? "—"}. O custo dos pagos é uma estimativa, cobrada na sua
                          conta do OpenRouter. Se o modelo falhar, ele responde com um grátis sozinho.
                        </p>
                      </section>

                      {/* Integrations */}
                      <section className="space-y-2">
                        <SectionLabel icon={<Plug className="size-3.5" />}>Integrações</SectionLabel>
                        <ul className="space-y-0.5">
                          {INTEGRATIONS.map((item) => {
                            const on =
                              (status?.[item.key] ?? false) ||
                              (item.key === "openrouter" && hasOpenRouterKey) ||
                              // Talking through the window counts, not only the machine's microphone.
                              (item.key === "voice" && Boolean(status?.voice_input));
                            return (
                              <li
                                key={item.key}
                                className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5"
                              >
                                <span className="flex items-center gap-2 text-[13px] text-foreground/80">
                                  <span
                                    className={`size-1.5 rounded-full ${on ? "bg-brand shadow-[0_0_8px_1px_rgba(34,211,238,0.6)]" : "bg-overlay/20"}`}
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
                          {IS_DESKTOP
                            ? "Sua chave do OpenRouter fica criptografada neste computador."
                            : "Chaves de API ficam só no seu .env — nunca aqui."}
                        </p>
                      </section>
                    </>
                  ) : tab === "app" ? (
                    <AppSettingsTab />
                  ) : (
                    <MemoryTab speaker={speaker} highlightIds={highlightMemoryIds} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
