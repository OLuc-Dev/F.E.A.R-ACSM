import { describe, expect, it } from "vitest";

import { accountInitial, accountName, keyStatusLabel } from "@/lib/identity";

describe("account identity", () => {
  it("derives the short name from the email local part", () => {
    expect(accountName("joao@example.com")).toBe("joao");
    expect(accountName("Lucas.Silva@x.io")).toBe("Lucas.Silva");
  });

  it("never returns an empty name", () => {
    expect(accountName("@nope")).toBe("você");
    expect(accountName("")).toBe("você");
  });

  it("builds an uppercase initial", () => {
    expect(accountInitial("joao@example.com")).toBe("J");
    expect(accountInitial("")).toBe("?");
  });

  it("labels the key status without an error tone", () => {
    expect(keyStatusLabel(true)).toBe("ativa");
    expect(keyStatusLabel(false)).toBe("faltando");
  });
});
