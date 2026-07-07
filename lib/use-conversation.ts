import { useCallback, useEffect, useRef, useState } from "react";

import { captureVoiceOnce, resetConversation, sendCommand, streamCommand } from "@/lib/api";
import {
  EMPTY_REPLY_NOTICE,
  INTERRUPTED_EMPTY_NOTICE,
  INTERRUPTED_NOTICE,
  TIMEOUT_NOTICE,
  humanizeError,
  isBlankMessage,
} from "@/lib/chat-helpers";
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
  // Synchronous send lock. `isBusy` (state) only updates a render later, so a
  // rapid double Enter / double click would both read it as false and send
  // twice; a ref flips immediately and can't be raced.
  const busyRef = useRef(false);
  // The last thing the user asked, so "tentar de novo" can replay it verbatim.
  const lastPromptRef = useRef<{ text: string; speaker: string } | null>(null);
  // Marks a *manual* stop so the abort is treated as a neutral interruption
  // (never an error), distinct from a timeout abort or an unmount abort.
  const stopRef = useRef(false);

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

  // Replace (not append) the last F.E.A.R. bubble — for the empty-reply and
  // error notices, which stand in for a bubble that never filled.
  const setLastFear = useCallback((content: string) => {
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last && last.role === "fear") copy[copy.length - 1] = { ...last, content };
      return copy;
    });
  }, []);

  const send = useCallback(
    async (text: string, speaker: string) => {
      const trimmed = text.trim();
      // Guard on a ref, not `isBusy`: state updates a render late, so two fast
      // Enters would both see false and double-send. A ref flips synchronously.
      if (isBlankMessage(trimmed) || busyRef.current) return;
      busyRef.current = true;
      stopRef.current = false;

      const who = speaker || "user";
      lastPromptRef.current = { text: trimmed, speaker: who };

      // The user just acted — re-engage following so they see their message + reply.
      followingRef.current = true;
      setAtBottom(true);
      setIsBusy(true);
      setStatus("thinking");
      pushMessage("user", trimmed);
      pushMessage("fear", "");

      const controller = new AbortController();
      abortRef.current = controller;

      // Inactivity watchdog: if no token arrives (dead backend) or the stream
      // stalls mid-reply, abort so the UI never hangs on "thinking" forever.
      let timedOut = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 60_000);
      };
      arm();

      stopSpeaking();
      let full = "";
      try {
        await streamCommand(
          { text: trimmed, speaker: who },
          (chunk) => {
            arm(); // a token arrived — reset the stall timer
            if (!full) setStatus("speaking");
            full += chunk;
            appendToLastFear(chunk);
          },
          controller.signal,
        );
        clearTimeout(watchdog);
        // Call succeeded but nothing came back — don't strand the typing dots.
        if (!full.trim()) {
          setLastFear(EMPTY_REPLY_NOTICE);
          setStatus("online");
          return;
        }
        setStatus("online");
        // A fresh exchange just landed in memory — flare the presence.
        setMemoryTick((tick) => tick + 1);
        // Speak the finished reply if the voice is on.
        if (voiceOnRef.current) speak(full);
      } catch (error) {
        clearTimeout(watchdog);
        // A stalled stream that the watchdog aborted → recoverable timeout error.
        if (timedOut) {
          setLastFear(full ? `${full}\n\n${TIMEOUT_NOTICE}` : TIMEOUT_NOTICE);
          setStatus("error");
          return;
        }
        // An abort that isn't a timeout is either a manual stop or an unmount.
        if (controller.signal.aborted) {
          if (stopRef.current) {
            // Manual interruption: neutral, never an error, never leaks AbortError.
            // Keep partial tokens and note the cut; if nothing arrived, say so
            // plainly so no typing dots are left spinning.
            if (full.trim()) pushMessage("system", INTERRUPTED_NOTICE);
            else setLastFear(INTERRUPTED_EMPTY_NOTICE);
            setStatus("online");
          }
          // else: unmount / navigation — leave the thread untouched, stay silent.
          return;
        }
        // A real network/API failure → human error text (never a raw HTTP code).
        const notice = humanizeError(error);
        setLastFear(full ? `${full}\n\n${notice}` : notice);
        setStatus("error");
      } finally {
        clearTimeout(watchdog);
        busyRef.current = false;
        setIsBusy(false);
      }
    },
    [pushMessage, appendToLastFear, setLastFear],
  );

  // Replay the last question. It re-asks as a new turn (keeps the history of
  // what happened) rather than surgically rewinding the thread.
  const retry = useCallback(() => {
    const last = lastPromptRef.current;
    if (last && !busyRef.current) void send(last.text, last.speaker);
  }, [send]);

  // Manually stop the in-flight reply. Aborts the stream; `send`'s catch turns
  // that into a neutral interruption (not an error). No-op when idle.
  const stop = useCallback(() => {
    if (!busyRef.current) return;
    stopRef.current = true;
    abortRef.current?.abort();
  }, []);

  const handleAppAction = useCallback(
    async (appId: string, speaker: string) => {
      // Ignore dock taps while F.E.A.R. is mid-answer: a stray action can't
      // interleave with a live stream or wipe the thread from under it.
      if (busyRef.current) return;
      const who = speaker || "user";
      busyRef.current = true;
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
          setStatus("online");
        } else if (appId === "obsidian") {
          pushMessage("system", "Observo seu vault do Obsidian quando OBSIDIAN_VAULT_PATH está configurado.");
        }
      } catch {
        setStatus("error");
        pushMessage("system", "Não consegui falar com o backend local.");
      } finally {
        busyRef.current = false;
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
    retry,
    stop,
    handleAppAction,
  };
}
