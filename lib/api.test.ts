import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  CONSULTED_MEMORY_IDS_HEADER,
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
            obsidian: false,
          }),
        ),
    );
    const status = await getStatus();
    expect(status.assistant).toBe("F.E.A.R.");
    expect(status.memory).toBe(true);
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
});
