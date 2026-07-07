// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock only the network + speech side-effects; keep ApiError and chat-helpers
// real so humanizeError behaves as in production.
// NOTE: do NOT mockReset/mockClear these in a hook — under vitest 2.1.9 with an
// async vi.mock factory it corrupts the next mockImplementation's arg binding.
// Each test sets its own implementation (which replaces the previous), and call
// counts are checked with deltas.
vi.mock("@/lib/speech", () => ({
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
  primeSpeech: vi.fn(),
}));
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

import { ApiError, streamCommand } from "@/lib/api";
import { EMPTY_REPLY_NOTICE } from "@/lib/chat-helpers";
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
    await act(async () => {
      const first = result.current.send("primeira pergunta", "user");
      await result.current.send("segunda pergunta", "user"); // must be ignored
      release();
      await first;
    });
    expect(userTexts(result.current.messages)).toEqual(["primeira pergunta"]);
    expect(stream.mock.calls.length - n0).toBe(1);
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
});
