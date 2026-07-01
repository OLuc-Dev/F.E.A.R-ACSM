import { afterEach, describe, expect, it, vi } from "vitest";

import { authHeaders, clearToken, getToken, setToken } from "@/lib/auth";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Give lib/auth a minimal window.localStorage to exercise the browser path
// (the test runner is a Node environment, so there is no window by default).
function stubStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

describe("auth token", () => {
  it("is logged out with no window (SSR / tests)", () => {
    expect(getToken()).toBeNull();
    expect(authHeaders()).toEqual({});
  });

  it("stores, reads, and clears the token and builds the Bearer header", () => {
    stubStorage();
    setToken("tok-123");
    expect(getToken()).toBe("tok-123");
    expect(authHeaders()).toEqual({ authorization: "Bearer tok-123" });

    clearToken();
    expect(getToken()).toBeNull();
    expect(authHeaders()).toEqual({});
  });
});
