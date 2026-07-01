import { useCallback, useEffect, useRef, useState } from "react";

import { captureVoiceOnce, resetConversation, sendCommand, streamCommand } from "@/lib/api";
import { primeSpeech, speak, stopSpeaking } from "@/lib/speech";

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
  // Bumps once each time a new memory is formed (a completed exchange), so the
  // presence can flare its filigree when F.E.A.R. takes something in.
  const [memoryTick, setMemoryTick] = useState(0);

  const idRef = useRef(1);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // "Following" means stuck to the bottom: we keep pinning to the latest line
  // until the user actively scrolls up, then we leave them alone (and the page
  // can offer a "jump to latest" affordance via `atBottom`).
  const followingRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // When on, F.E.A.R. speaks its replies aloud via the browser (Web Speech API).
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(false);

  const nextId = useCallback(() => idRef.current++, []);

  const toggleVoice = useCallback(() => {
    setVoiceOn((on) => {
      const next = !on;
      voiceOnRef.current = next;
      // Prime within the user gesture (unlocks mobile); stop any speech when off.
      if (next) primeSpeech();
      else stopSpeaking();
      return next;
    });
  }, []);

  // Pin to the newest content while following.
  useEffect(() => {
    const el = threadRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Track whether the reader is at the bottom; drives following + the pill.
  const handleThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followingRef.current = near;
    setAtBottom(near);
  }, []);

  const scrollToLatest = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    followingRef.current = true;
    setAtBottom(true);
  }, []);

  // Cancel any in-flight stream and stop speech when the page unmounts.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      stopSpeaking();
    },
    [],
  );

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

      // The user just acted — re-engage following so they see their message + reply.
      followingRef.current = true;
      setAtBottom(true);
      setIsBusy(true);
      setStatus("thinking");
      pushMessage("user", trimmed);
      pushMessage("fear", "");

      const controller = new AbortController();
      abortRef.current = controller;

      stopSpeaking();
      try {
        let started = false;
        let full = "";
        await streamCommand(
          { text: trimmed, speaker: speaker || "user" },
          (chunk) => {
            if (!started) {
              setStatus("speaking");
              started = true;
            }
            full += chunk;
            appendToLastFear(chunk);
          },
          controller.signal,
        );
        setStatus("online");
        // A fresh exchange just landed in memory — flare the presence.
        setMemoryTick((tick) => tick + 1);
        // Speak the finished reply if the voice is on.
        if (voiceOnRef.current) speak(full);
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
        } else if (appId === "reset") {
          await resetConversation();
          setMessages([
            { id: nextId(), role: "system", content: "Conversa reiniciada. Memória pessoal mantida." },
          ]);
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

  return {
    messages,
    status,
    isBusy,
    memoryTick,
    threadRef,
    atBottom,
    handleThreadScroll,
    scrollToLatest,
    voiceOn,
    toggleVoice,
    send,
    handleAppAction,
  };
}
