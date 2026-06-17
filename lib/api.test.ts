import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, getStatus, sendCommand, streamCommand } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(response));
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
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("parte 1 "));
        controller.enqueue(encoder.encode("parte 2"));
        controller.close();
      },
    });
    mockFetch(async () => new Response(body, { status: 200 }));

    const chunks: string[] = [];
    await streamCommand({ text: "x", speaker: "Lucas" }, (chunk) => chunks.push(chunk));
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
