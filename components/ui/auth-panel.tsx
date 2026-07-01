"use client";

import { FormEvent, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, KeyRound, Loader2, LogOut, Mail, ShieldCheck, UserRound, X } from "lucide-react";

import { type AuthUser } from "@/lib/api";
import { fade, springSoft } from "@/lib/motion";

type Mode = "login" | "register";

function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm outline-none transition placeholder:text-muted-foreground/50 focus:border-cyan-300/40 focus:bg-white/[0.05]"
    />
  );
}

export function AuthPanel({
  open,
  onClose,
  user,
  onSignIn,
  onSignUp,
  onSignOut,
  onSaveKey,
}: {
  open: boolean;
  onClose: () => void;
  user: AuthUser | null;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (email: string, password: string) => Promise<void>;
  onSignOut: () => void;
  onSaveKey: (apiKey: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState(false);

  // Clear transient state when the panel opens/closes or the account flips.
  useEffect(() => {
    setError(null);
    setPassword("");
    setApiKey("");
    setSavedKey(false);
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await onSignIn(email.trim(), password);
      else await onSignUp(email.trim(), password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não consegui autenticar.");
    } finally {
      setBusy(false);
    }
  }

  async function submitKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSavedKey(false);
    try {
      await onSaveKey(apiKey.trim());
      setApiKey("");
      setSavedKey(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não consegui salvar a chave.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] grid place-items-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <button
            aria-label="Fechar"
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Conta"
            className="panel relative w-full max-w-sm overflow-hidden rounded-[1.4rem] p-5"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={springSoft}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                  <UserRound className="size-4 text-cyan-300" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold tracking-[-0.01em]">
                    {user ? "Sua conta" : mode === "login" ? "Entrar" : "Criar conta"}
                  </h2>
                  <p className="label-tn">F.E.A.R.</p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Fechar"
                className="tap grid size-8 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {error && (
              <div className="mb-4 rounded-xl border border-rose-400/30 bg-rose-400/[0.08] p-3 text-[13px] leading-5 text-rose-200">
                {error}
              </div>
            )}

            <AnimatePresence mode="wait" initial={false}>
              {user ? (
                <motion.div
                  key="account"
                  className="space-y-4"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={fade}
                >
                  <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2.5">
                    <Mail className="size-4 shrink-0 text-cyan-300/70" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">{user.email}</span>
                  </div>

                  <form onSubmit={submitKey} className="space-y-2">
                    <span className="label-tn flex items-center gap-1.5">
                      <span className="text-cyan-300/70">
                        <KeyRound className="size-3.5" />
                      </span>
                      Sua chave do OpenRouter
                    </span>
                    <Field
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={user.has_openrouter_key ? "•••••••• (salva)" : "sk-or-v1-…"}
                      autoComplete="off"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={busy || !apiKey.trim()}
                        className="tap inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 text-sm font-medium text-slate-950 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                        Salvar chave
                      </button>
                      {user.has_openrouter_key && (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-cyan-300/30 bg-cyan-300/[0.08] px-2.5 py-1.5 text-[11px] text-cyan-200">
                          <ShieldCheck className="size-3.5" /> ativa
                        </span>
                      )}
                    </div>
                    {savedKey && (
                      <p className="text-[11px] leading-4 text-cyan-300/80">Chave guardada, criptografada.</p>
                    )}
                    <p className="text-[11px] leading-4 text-muted-foreground/60">
                      Pegue a sua em openrouter.ai/keys. Fica só no servidor, criptografada — nunca aparece de
                      volta aqui.
                    </p>
                  </form>

                  <button
                    onClick={onSignOut}
                    className="tap inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] text-sm text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  >
                    <LogOut className="size-4" /> Sair
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="auth"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={fade}
                >
                  <div className="mb-4 flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
                    {(["login", "register"] as const).map((value) => (
                      <button
                        key={value}
                        onClick={() => {
                          setMode(value);
                          setError(null);
                        }}
                        className={`tap flex-1 rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                          mode === value
                            ? "bg-cyan-300/15 text-cyan-200"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {value === "login" ? "Entrar" : "Criar conta"}
                      </button>
                    ))}
                  </div>

                  <form onSubmit={submitAuth} className="space-y-2.5">
                    <Field
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="e-mail"
                      autoComplete="email"
                      required
                    />
                    <Field
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={mode === "register" ? "senha (mín. 8)" : "senha"}
                      autoComplete={mode === "register" ? "new-password" : "current-password"}
                      required
                    />
                    <button
                      type="submit"
                      disabled={busy || !email.trim() || !password}
                      className="tap inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 text-sm font-medium text-slate-950 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <UserRound className="size-4" />}
                      {mode === "login" ? "Entrar" : "Criar conta"}
                    </button>
                  </form>

                  <p className="mt-3 text-[11px] leading-4 text-muted-foreground/60">
                    Sua conta mantém sua memória e sua chave separadas das dos outros. Você traz sua própria
                    chave do OpenRouter depois de entrar.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
