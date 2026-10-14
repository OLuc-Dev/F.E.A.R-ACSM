// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { loadVoiceInterface, saveVoiceInterface } from "@/lib/ui-mode";

afterEach(() => window.localStorage.clear());

describe("interface mode", () => {
  it("talks by default, and remembers choosing the written chat", () => {
    expect(loadVoiceInterface()).toBe(true);
    saveVoiceInterface(false);
    expect(loadVoiceInterface()).toBe(false);
    saveVoiceInterface(true);
    expect(loadVoiceInterface()).toBe(true);
  });
});
