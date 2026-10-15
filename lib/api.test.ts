import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  CONSULTED_MEMORY_IDS_HEADER,
  UNAUTHORIZED_EVENT,
  captureVoiceOnce,
  fetchVoice,
  getModels,
  getStatus,
  parseConsultedMemoryIdsHeader,
  sendCommand,
  streamCommand,
} from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(response));
}

// A two-chunk plain-text stream body, as /command/stream produces.
function streamBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("parte 1 "));
      controller.enqueue(encoder.encode("parte 2"));
      controller.close();
    },
  });
}

describe("api client", () => {
  it("sendCommand parses the JSON reply", async () => {
    mockFetch(async () => new Response(JSON.stringify({ reply: "oi", speaker: "Lucas", audio_file: null })));
    const result = await sendCommand({ text: "x", speaker: "Lucas" });
    expect(result.reply).toBe("oi");
  });

  it("throws ApiError on a non-ok response", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    await expect(sendCommand({ text: "x", speaker: "Lucas" })).rejects.toBeInstanceOf(ApiError);
  });

  it("streamCommand yields decoded chunks in order", async () => {
    mockFetch(async () => new Response(streamBody(), { status: 200 }));

    const chunks: string[] = [];
    await streamCommand({ text: "x", speaker: "Lucas" }, (chunk) => chunks.push(chunk));
    expect(chunks.join("")).toBe("parte 1 parte 2");
  });

  it("streamCommand reports consulted ids from the header, before the chunks", async () => {
    mockFetch(
      async () =>
        new Response(streamBody(), {
          status: 200,
          headers: { [CONSULTED_MEMORY_IDS_HEADER]: "u1-Ana-conversation-abc,u1-Ze%20Silva-voice-9f" },
        }),
    );

    const events: string[] = [];
    const ids: string[][] = [];
    await streamCommand(
      { text: "x", speaker: "Lucas" },
      (chunk) => events.push(`chunk:${chunk}`),
      undefined,
      (list) => {
        ids.push(list);
        events.push("ids");
      },
    );
    expect(ids).toEqual([["u1-Ana-conversation-abc", "u1-Ze Silva-voice-9f"]]); // decoded, once
    expect(events[0]).toBe("ids"); // ids land before the first token
    expect(events.slice(1).join("")).toBe("chunk:parte 1 chunk:parte 2"); // body untouched
  });

  it("streamCommand skips the callback when the header is absent — body unaffected", async () => {
    mockFetch(async () => new Response(streamBody(), { status: 200 }));

    const onIds = vi.fn();
    const chunks: string[] = [];
    await streamCommand({ text: "x", speaker: "Lucas" }, (chunk) => chunks.push(chunk), undefined, onIds);
    expect(onIds).not.toHaveBeenCalled();
    expect(chunks.join("")).toBe("parte 1 parte 2");
  });

  it("getStatus parses the status payload", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            assistant: "F.E.A.R.",
            openrouter: false,
            memory: true,
            voice: false,
            spotify: false,
            music: true,
            obsidian: false,
          }),
        ),
    );
    const status = await getStatus();
    expect(status.assistant).toBe("F.E.A.R.");
    expect(status.memory).toBe(true);
    expect(status.music).toBe(true);
  });
});

describe("parseConsultedMemoryIdsHeader", () => {
  it("returns [] for a missing or blank header", () => {
    expect(parseConsultedMemoryIdsHeader(null)).toEqual([]);
    expect(parseConsultedMemoryIdsHeader("")).toEqual([]);
    expect(parseConsultedMemoryIdsHeader("   ")).toEqual([]);
  });

  it("decodes percent-encoded ids", () => {
    expect(parseConsultedMemoryIdsHeader("u1-Ze%20Silva-voice-9f")).toEqual(["u1-Ze Silva-voice-9f"]);
  });

  it("ignores empty entries and trims whitespace", () => {
    expect(parseConsultedMemoryIdsHeader(" a , , b ,")).toEqual(["a", "b"]);
  });

  it("skips malformed encodings instead of throwing", () => {
    expect(parseConsultedMemoryIdsHeader("ok,%zz,tambem-ok")).toEqual(["ok", "tambem-ok"]);
  });

  it("dedups while keeping first-seen order", () => {
    expect(parseConsultedMemoryIdsHeader("b,a,b,c,a")).toEqual(["b", "a", "c"]);
  });

  it("streamCommand keeps a character split across the last two chunks", async () => {
    const bytes = new TextEncoder().encode("até");
    mockFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // "é" is two bytes; end the stream after its first one is held back.
              controller.enqueue(bytes.slice(0, bytes.length - 1));
              controller.enqueue(bytes.slice(bytes.length - 1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );

    const chunks: string[] = [];
    await streamCommand({ text: "x", speaker: "Lucas" }, (chunk) => chunks.push(chunk));
    expect(chunks.join("")).toBe("até");
  });

  it("announces a rejected session so the app can sign out", async () => {
    mockFetch(async () => new Response(JSON.stringify({ detail: "Sessão inválida." }), { status: 401 }));
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const listener = vi.fn();
    target.addEventListener(UNAUTHORIZED_EVENT, listener);

    await expect(getStatus()).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fetchVoice asks for the sentence in the chosen style, online unless told otherwise", async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Blob(["ID3"]), { headers: { "content-type": "audio/mpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    const audio = await fetchVoice("Olá.", "fear", signal);
    await fetchVoice("Olá.", "natural", signal, false);

    expect(await audio.text()).toBe("ID3");
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    expect(bodies).toEqual([
      { text: "Olá.", style: "fear", online: true },
      { text: "Olá.", style: "natural", online: false },
    ]);
  });

  it("getModels reads OpenRouter's models, or says why it couldn't", async () => {
    const listed = { models: [], default: "lab/inkling:free", fallbacks: ["openrouter/free"] };
    mockFetch(async () => new Response(JSON.stringify(listed)));
    expect(await getModels()).toEqual(listed);

    const detail = "Não consegui ler a lista de modelos do OpenRouter agora.";
    mockFetch(async () => new Response(JSON.stringify({ detail }), { status: 503 }));
    await expect(getModels()).rejects.toThrow(detail);
  });

  it("captureVoiceOnce tells a disabled mic apart from a queued clip", async () => {
    mockFetch(async () => new Response(JSON.stringify({ status: "disabled", hint: "x" })));
    expect(await captureVoiceOnce()).toBe("disabled");
    mockFetch(async () => new Response(JSON.stringify({ status: "queued" })));
    expect(await captureVoiceOnce()).toBe("queued");
  });
});
