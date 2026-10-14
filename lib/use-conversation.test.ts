// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock only the network + speech side-effects; keep ApiError and chat-helpers
// real so humanizeError behaves as in production.
// NOTE: do NOT mockReset/mockClear these in a hook — under vitest 2.1.9 with an
// async vi.mock factory it corrupts the next mockImplementation's arg binding.
// Each test sets its own implementation (which replaces the previous), and call
// counts are checked with deltas.
// The speech module keeps its real sentence splitter; only the audio is faked.
const spoken: string[] = [];
const fakeSpeaker = { say: (sentence: string) => spoken.push(sentence), stop: vi.fn() };
vi.mock("@/lib/speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speech")>();
  return {
    ...actual,
    startSpeaking: vi.fn(() => fakeSpeaker),
    stopSpeaking: vi.fn(),
    primeSpeech: vi.fn(),
  };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    streamCommand: vi.fn(),
    sendCommand: vi.fn(),
    resetConversation: vi.fn(),
    captureVoiceOnce: vi.fn(),
  };
});

import { ApiError, captureVoiceOnce, streamCommand } from "@/lib/api";
import { EMPTY_REPLY_NOTICE, INTERRUPTED_EMPTY_NOTICE, INTERRUPTED_NOTICE } from "@/lib/chat-helpers";
import { useConversation } from "@/lib/use-conversation";

const stream = vi.mocked(streamCommand);

const fearText = (msgs: { role: string; content: string }[]) =>
  msgs.filter((m) => m.role === "fear").at(-1)?.content ?? "";
const userTexts = (msgs: { role: string; content: string }[]) =>
  msgs.filter((m) => m.role === "user").map((m) => m.content);

afterEach(cleanup);

describe("useConversation", () => {
  it("does not send a blank message", async () => {
    const n0 = stream.mock.calls.length;
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("   \n ", "user");
    });
    expect(userTexts(result.current.messages)).toEqual([]);
    expect(stream.mock.calls.length).toBe(n0);
  });

  it("sends a message and appends the streamed reply", async () => {
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("Leitura ");
      onChunk("concluída.");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("analise isso", "user");
    });
    expect(userTexts(result.current.messages)).toEqual(["analise isso"]);
    expect(fearText(result.current.messages)).toBe("Leitura concluída.");
    expect(result.current.status).toBe("online");
  });

  it("blocks a second send fired before the first settles (busyRef)", async () => {
    const n0 = stream.mock.calls.length;
    let release: () => void = () => {};
    stream.mockImplementation(
      (_req, onChunk) =>
        new Promise<void>((resolve) => {
          onChunk("primeira");
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useConversation());
    const outcomes: boolean[] = [];
    await act(async () => {
      const first = result.current.send("primeira pergunta", "user");
      outcomes.push(await result.current.send("segunda pergunta", "user")); // must be ignored
      release();
      outcomes.push(await first);
    });
    expect(userTexts(result.current.messages)).toEqual(["primeira pergunta"]);
    expect(stream.mock.calls.length - n0).toBe(1);
    // …and says so, so a spoken question is never dropped without a word.
    expect(outcomes).toEqual([false, true]);
  });

  it("shows a friendly notice when the reply comes back empty", async () => {
    stream.mockImplementation(async () => {
      /* no chunks */
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("pergunta", "user");
    });
    expect(fearText(result.current.messages)).toBe(EMPTY_REPLY_NOTICE);
    expect(result.current.status).toBe("online");
  });

  it("humanizes an API error without leaking the raw HTTP code", async () => {
    stream.mockImplementation(async () => {
      throw new ApiError("HTTP 500", 500);
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("pergunta", "user");
    });
    expect(result.current.status).toBe("error");
    expect(fearText(result.current.messages)).toMatch(/servidor/i);
    expect(fearText(result.current.messages)).not.toMatch(/HTTP/);
  });

  // A stream that emits an optional first chunk then rejects when aborted —
  // mirrors how streamCommand behaves when the AbortController fires.
  const abortableStream = (firstChunk?: string) =>
    stream.mockImplementation(
      (_req, onChunk, signal) =>
        new Promise<void>((_resolve, reject) => {
          if (firstChunk) onChunk(firstChunk);
          (signal as AbortSignal | undefined)?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

  it("manual stop keeps partial tokens and notes the interruption (no error)", async () => {
    abortableStream("resposta parcial");
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      const p = result.current.send("pergunta", "user");
      result.current.stop();
      await p;
    });
    expect(fearText(result.current.messages)).toContain("resposta parcial");
    expect(result.current.messages.some((m) => m.role === "system" && m.content === INTERRUPTED_NOTICE)).toBe(
      true,
    );
    expect(result.current.status).toBe("online"); // never "error"
    expect(fearText(result.current.messages)).not.toMatch(/abort|HTTP/i);
  });

  it("manual stop with no tokens shows a neutral notice (no infinite dots)", async () => {
    abortableStream();
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      const p = result.current.send("pergunta", "user");
      result.current.stop();
      await p;
    });
    expect(fearText(result.current.messages)).toBe(INTERRUPTED_EMPTY_NOTICE);
    expect(result.current.status).toBe("online");
  });

  it("lets the user send again right after a manual stop", async () => {
    abortableStream("parcial");
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      const p = result.current.send("primeira", "user");
      result.current.stop();
      await p;
    });
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("nova resposta");
    });
    await act(async () => {
      await result.current.send("segunda", "user");
    });
    expect(userTexts(result.current.messages)).toEqual(["primeira", "segunda"]);
    expect(fearText(result.current.messages)).toBe("nova resposta");
    expect(result.current.status).toBe("online");
  });

  it("stop is a no-op when idle", () => {
    const { result } = renderHook(() => useConversation());
    const before = result.current.messages.length;
    act(() => {
      result.current.stop();
    });
    expect(result.current.messages.length).toBe(before);
    expect(result.current.status).toBe("online");
  });

  it("retry replays the last question", async () => {
    const n0 = stream.mock.calls.length;
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("ok");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("mesma pergunta", "user");
    });
    await act(async () => {
      result.current.retry();
    });
    expect(userTexts(result.current.messages)).toEqual(["mesma pergunta", "mesma pergunta"]);
    expect(stream.mock.calls.length - n0).toBe(2);
  });

  // --- lote #23: consulted-memory ids attached to the streamed reply ---

  it("stores consultedMemoryIds on the reply when the stream reports them", async () => {
    stream.mockImplementation(async (_req, onChunk, _signal, onIds) => {
      onIds?.(["mem-1", "mem-2"]); // header ids land before the first token
      onChunk("resposta com contexto");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("pergunta", "user");
    });
    const reply = result.current.messages.filter((m) => m.role === "fear").at(-1);
    expect(reply?.content).toBe("resposta com contexto");
    expect(reply?.consultedMemoryIds).toEqual(["mem-1", "mem-2"]);
  });

  it("keeps consultedMemoryIds empty when the stream reports none", async () => {
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("resposta sem contexto");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("pergunta", "user");
    });
    const reply = result.current.messages.filter((m) => m.role === "fear").at(-1);
    expect(reply?.consultedMemoryIds ?? []).toEqual([]);
  });

  it("keeps already-read consultedMemoryIds on a manually stopped reply", async () => {
    stream.mockImplementation(
      (_req, onChunk, signal, onIds) =>
        new Promise<void>((_resolve, reject) => {
          onIds?.(["mem-1"]); // ids were read from the headers before the abort
          onChunk("parcial");
          (signal as AbortSignal | undefined)?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      const p = result.current.send("pergunta", "user");
      result.current.stop();
      await p;
    });
    const reply = result.current.messages.filter((m) => m.role === "fear").at(-1);
    expect(reply?.content).toContain("parcial");
    expect(reply?.consultedMemoryIds).toEqual(["mem-1"]);
    expect(result.current.status).toBe("online"); // stop stays neutral, never an error
  });

  it("says it is listening before the clip is recorded, not after", async () => {
    let finishRecording: (status: "queued") => void = () => {};
    vi.mocked(captureVoiceOnce).mockImplementation(
      () => new Promise<"queued" | "disabled">((resolve) => (finishRecording = resolve)),
    );
    const { result } = renderHook(() => useConversation());
    let action: Promise<void> = Promise.resolve();
    await act(async () => {
      action = result.current.handleAppAction("voice", "user");
    });
    // Still recording: the notice must already be on screen.
    expect(result.current.messages.at(-1)?.content).toBe("Escutando um trecho de voz…");
    expect(result.current.status).toBe("listening");
    await act(async () => {
      finishRecording("queued");
      await action;
    });
    expect(result.current.status).toBe("online");
  });

  it("reports a disabled microphone instead of pretending to listen", async () => {
    vi.mocked(captureVoiceOnce).mockImplementation(async () => "disabled");
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.handleAppAction("voice", "user");
    });
    expect(result.current.messages.at(-1)?.content).toMatch(/desligada/);
  });

  it("shows why a dock action failed instead of blaming the network", async () => {
    vi.mocked(captureVoiceOnce).mockImplementation(async () => {
      throw new ApiError("Só o dono deste F.E.A.R. controla o microfone.", 403);
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.handleAppAction("voice", "user");
    });
    expect(result.current.messages.at(-1)?.content).toBe("Só o dono deste F.E.A.R. controla o microfone.");
  });

  it("speaks each sentence as soon as it has streamed in", async () => {
    spoken.length = 0;
    let heardDuringStream: string[] = [];
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("Primeira frase. Segun");
      heardDuringStream = [...spoken];
      onChunk("da frase");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      result.current.toggleVoice();
    });
    await act(async () => {
      await result.current.send("oi", "user");
    });
    expect(heardDuringStream).toEqual(["Primeira frase."]);
    expect(spoken).toEqual(["Primeira frase.", "Segunda frase"]);
  });

  it("answers a spoken question out loud even with the voice toggle off", async () => {
    spoken.length = 0;
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("Estou aqui.");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("oi", "user", { speak: true });
    });
    expect(spoken).toEqual(["Estou aqui."]);
  });

  it("stays silent with the voice off", async () => {
    spoken.length = 0;
    stream.mockImplementation(async (_req, onChunk) => {
      onChunk("Texto sem voz.");
    });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.send("oi", "user");
    });
    expect(spoken).toEqual([]);
  });
});
