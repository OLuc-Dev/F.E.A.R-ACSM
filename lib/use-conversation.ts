import { useCallback, useEffect, useRef, useState } from "react";

import {
  captureVoiceOnce,
  getMemory,
  resetConversation,
  sendCommand,
  streamCommand,
} from "@/lib/api";

export type Role = "user" | "fear" | "system";
export type Status = "online" | "listening" | "thinking" | "speaking" | "error";

export interface Message {
  id: number;
  role: Role;
  content: string;
}

const GREETING: Message = { id: 0, role: "fear", content: "Presença ativa. Diga o próximo movimento." };

// Owns the F.E.A.R. conversation: the message thread, live streaming, status, and
// the dock actions that post into the thread. Keeps the page a presentation layer.
export function useConversation() {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [status, setStatus] = useState<Status>("online");
  const [isBusy, setIsBusy] = useState(false);

  const idRef = useRef(1);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const nextId = useCallback(() => idRef.current++, []);

  // Keep the thread pinned to the latest message.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Cancel any in-flight stream when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const pushMessage = useCallback(
    (role: Role, content: string) => {
      setMessages((prev) => [...prev, { id: nextId(), role, content }]);
    },
    [nextId],
  );

  const appendToLastFear = useCallback((chunk: string) => {
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last && last.role === "fear") {
        copy[copy.length - 1] = { ...last, content: last.content + chunk };
      }
      return copy;
    });
  }, []);

  const send = useCallback(
    async (text: string, speaker: string) => {
      const trimmed = text.trim();
      if (!trimmed || isBusy) return;

      setIsBusy(true);
      setStatus("thinking");
      pushMessage("user", trimmed);
      pushMessage("fear", "");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        let started = false;
        await streamCommand(
          { text: trimmed, speaker: speaker || "user" },
          (chunk) => {
            if (!started) {
              setStatus("speaking");
              started = true;
            }
            appendToLastFear(chunk);
          },
          controller.signal,
        );
        setStatus("online");
      } catch (error) {
        if (controller.signal.aborted) return;
        appendToLastFear(error instanceof Error ? `Erro: ${error.message}` : "Falha ao falar com o backend.");
        setStatus("error");
      } finally {
        setIsBusy(false);
      }
    },
    [isBusy, pushMessage, appendToLastFear],
  );

  const handleAppAction = useCallback(
    async (appId: string, speaker: string) => {
      const who = speaker || "user";
      try {
        if (appId === "spotify") {
          setStatus("thinking");
          const data = await sendCommand({ text: "toggle Spotify playback", speaker: who });
          pushMessage("fear", data.reply || "Spotify acionado.");
          setStatus("online");
        } else if (appId === "voice") {
          setStatus("listening");
          await captureVoiceOnce();
          pushMessage("system", "Escutando um trecho de voz…");
          setStatus("online");
        } else if (appId === "memory") {
          const data = await getMemory(who);
          pushMessage("system", `${data.memories.length} memória(s) recente(s) sobre ${who}.`);
        } else if (appId === "reset") {
          await resetConversation(who);
          setMessages([{ id: nextId(), role: "system", content: "Conversa reiniciada. Memória pessoal mantida." }]);
        } else if (appId === "obsidian") {
          pushMessage("system", "Observo seu vault do Obsidian quando OBSIDIAN_VAULT_PATH está configurado.");
        }
      } catch {
        setStatus("error");
        pushMessage("system", "Não consegui falar com o backend local.");
      }
    },
    [nextId, pushMessage],
  );

  return { messages, status, isBusy, threadRef, send, handleAppAction };
}
