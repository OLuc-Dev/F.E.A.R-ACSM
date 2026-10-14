import { describe, expect, it, vi } from "vitest";

import { checkForUpdate, isNewer } from "@/lib/updates";

const release = (tag: string) =>
  vi.fn(async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://example.test/${tag}` })));

describe("isNewer", () => {
  it("compares versions number by number", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true); // not string order
    expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("nightly", "0.1.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("offers a newer release with its page", async () => {
    expect(await checkForUpdate("0.1.0", release("v0.2.0"))).toEqual({
      version: "0.2.0",
      url: "https://example.test/v0.2.0",
    });
  });

  it("stays quiet when already up to date", async () => {
    expect(await checkForUpdate("0.2.0", release("v0.2.0"))).toBeNull();
  });

  it("never asks from a development build", async () => {
    const fetcher = release("v9.9.9");
    expect(await checkForUpdate("0.0.0-dev", fetcher)).toBeNull();
    expect(await checkForUpdate("", fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is silent offline or when GitHub says no", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await checkForUpdate("0.1.0", offline as unknown as typeof fetch)).toBeNull();
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(await checkForUpdate("0.1.0", missing)).toBeNull();
  });
});
