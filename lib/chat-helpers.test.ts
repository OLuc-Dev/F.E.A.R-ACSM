import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { humanizeError, isBlankMessage } from "@/lib/chat-helpers";

describe("isBlankMessage", () => {
  it("blocks empty, spaces, tabs and newlines", () => {
    expect(isBlankMessage("")).toBe(true);
    expect(isBlankMessage("   ")).toBe(true);
    expect(isBlankMessage("\n\n")).toBe(true);
    expect(isBlankMessage("\t \n ")).toBe(true);
  });

  it("allows real text even with surrounding whitespace", () => {
    expect(isBlankMessage("  oi  ")).toBe(false);
    expect(isBlankMessage("?")).toBe(false);
  });
});

describe("humanizeError", () => {
  it("never leaks a raw HTTP code", () => {
    const msg = humanizeError(new ApiError("HTTP 500", 500));
    expect(msg).not.toMatch(/HTTP/);
    expect(msg).toMatch(/servidor/i);
  });

  it("maps auth and rate-limit to plain language", () => {
    expect(humanizeError(new ApiError("unauthorized", 401))).toMatch(/sess[aã]o/i);
    expect(humanizeError(new ApiError("slow down", 429))).toMatch(/espera/i);
  });

  it("treats a 403 as a refusal, not an expired session", () => {
    const refusal = "Só o dono deste F.E.A.R. controla o microfone.";
    expect(humanizeError(new ApiError(refusal, 403))).toBe(refusal);
    expect(humanizeError(new ApiError("HTTP 403", 403))).toMatch(/permiss[aã]o/i);
    expect(humanizeError(new ApiError("HTTP 403", 403))).not.toMatch(/sess[aã]o/i);
  });

  it("surfaces a meaningful backend detail as-is", () => {
    expect(humanizeError(new ApiError("Configure sua chave do OpenRouter", 400))).toBe(
      "Configure sua chave do OpenRouter",
    );
  });

  it("falls back for network and unknown errors", () => {
    expect(humanizeError(new Error("Failed to fetch"))).toMatch(/backend/i);
    expect(humanizeError("weird")).toMatch(/n[aã]o consegui/i);
  });
});
