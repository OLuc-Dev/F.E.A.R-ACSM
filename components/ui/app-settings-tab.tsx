"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { BookOpen, FolderOpen, Hand, Info, Loader2, Power, Unplug } from "lucide-react";

import {
  type DesktopSettings,
  type DesktopSettingsUpdate,
  getDesktopSettings,
  updateDesktopSettings,
} from "@/lib/api";
import { humanizeError } from "@/lib/chat-helpers";
import { APP_VERSION, canPickFolder, pickFolder } from "@/lib/desktop";

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="label-tn flex items-center gap-2 text-muted-foreground">
        <span className="text-brand/70">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="tap flex w-full items-center justify-between gap-3 rounded-xl border border-overlay/10 bg-overlay/[0.025] px-3 py-2.5 text-left text-[13px] text-foreground/85 hover:bg-overlay/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
      <span
        aria-hidden
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-brand" : "bg-overlay/20"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

const NOTE = "text-[11px] leading-4 text-muted-foreground/60";

/** The Windows app's own switches. Each one applies at once and is remembered. */
export function AppSettingsTab() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vaultInput, setVaultInput] = useState("");
  const folderPicker = canPickFolder();

  const load = useCallback(async () => {
    try {
      const current = await getDesktopSettings();
      setSettings(current);
      setVaultInput(current.obsidian_vault);
      setError(null);
    } catch (caught) {
      setError(humanizeError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(update: DesktopSettingsUpdate) {
    setBusy(true);
    setError(null);
    try {
      const next = await updateDesktopSettings(update);
      setSettings(next);
      setVaultInput(next.obsidian_vault);
    } catch (caught) {
      setError(humanizeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function chooseVault() {
    const folder = await pickFolder();
    if (folder) await apply({ obsidian_vault: folder });
  }

  if (!settings) {
    return error ? (
      <p className="rounded-xl border border-danger/30 bg-danger/[0.08] p-3 text-[13px] text-danger">
        {error}
      </p>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-xl border border-danger/30 bg-danger/[0.08] p-3 text-[13px] leading-5 text-danger">
          {error}
        </p>
      )}

      <Section icon={<Hand className="size-3.5" />} title="Palmas">
        <Switch
          checked={settings.claps}
          disabled={busy || !settings.claps_available}
          onChange={(claps) => void apply({ claps })}
          label="Duas palmas dão play/pause na música"
        />
        {!settings.claps_available ? (
          <p className={NOTE}>Este F.E.A.R. não tem acesso ao microfone.</p>
        ) : settings.claps && !settings.claps_listening ? (
          <p className={`${NOTE} text-danger/80`}>
            O microfone não abriu. Confira em Configurações do Windows → Privacidade → Microfone se os
            aplicativos da área de trabalho podem usá-lo.
          </p>
        ) : (
          <p className={NOTE}>O áudio é analisado aqui mesmo e nunca é gravado.</p>
        )}
      </Section>

      <Section icon={<BookOpen className="size-3.5" />} title="Obsidian">
        {settings.obsidian_vault ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-xl border border-overlay/10 bg-overlay/[0.025] px-3 py-2.5">
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  settings.obsidian_watching
                    ? "bg-brand shadow-[0_0_8px_1px_rgba(34,211,238,0.6)]"
                    : "bg-overlay/20"
                }`}
              />
              <span className="truncate text-[13px] text-foreground/85" title={settings.obsidian_vault}>
                {settings.obsidian_vault}
              </span>
            </div>
            <div className="flex gap-2">
              {folderPicker && (
                <button
                  type="button"
                  onClick={() => void chooseVault()}
                  disabled={busy}
                  className="tap inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-overlay/10 bg-overlay/[0.04] text-sm text-foreground hover:bg-overlay/[0.08] disabled:opacity-50"
                >
                  <FolderOpen className="size-4" /> Trocar pasta
                </button>
              )}
              <button
                type="button"
                onClick={() => void apply({ obsidian_vault: "" })}
                disabled={busy}
                className="tap inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-overlay/10 bg-overlay/[0.04] text-sm text-muted-foreground hover:bg-overlay/[0.08] hover:text-foreground disabled:opacity-50"
              >
                <Unplug className="size-4" /> Desconectar
              </button>
            </div>
          </div>
        ) : folderPicker ? (
          <button
            type="button"
            onClick={() => void chooseVault()}
            disabled={busy}
            className="tap inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-medium text-[hsl(var(--brand-ink))] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
            Escolher a pasta do vault
          </button>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (vaultInput.trim()) void apply({ obsidian_vault: vaultInput.trim() });
            }}
          >
            <input
              value={vaultInput}
              onChange={(event) => setVaultInput(event.target.value)}
              placeholder="C:/Users/você/Documents/Obsidian"
              aria-label="Pasta do vault do Obsidian"
              className="h-9 min-w-0 flex-1 rounded-xl border border-overlay/10 bg-overlay/[0.03] px-3 text-sm outline-none focus:border-brand/40"
            />
            <button
              type="submit"
              disabled={busy || !vaultInput.trim()}
              className="tap h-9 rounded-xl bg-brand px-3 text-sm font-medium text-[hsl(var(--brand-ink))] disabled:opacity-50"
            >
              Conectar
            </button>
          </form>
        )}
        <p className={NOTE}>
          Suas notas viram memória do F.E.A.R.: na primeira vez ele lê o vault inteiro; depois, só o que você
          escrever ou mudar, mesmo com o app fechado.
        </p>
      </Section>

      {settings.autostart_available && (
        <Section icon={<Power className="size-3.5" />} title="Inicialização">
          <Switch
            checked={settings.autostart}
            disabled={busy}
            onChange={(autostart) => void apply({ autostart })}
            label="Iniciar com o Windows (minimizado)"
          />
        </Section>
      )}

      <Section icon={<Info className="size-3.5" />} title="Sobre">
        <p className="text-[13px] text-foreground/80">
          F.E.A.R. {APP_VERSION ? `versão ${APP_VERSION}` : "(desenvolvimento)"}
        </p>
        <p className={NOTE}>Memória, chave e configurações ficam só neste computador.</p>
      </Section>
    </div>
  );
}
