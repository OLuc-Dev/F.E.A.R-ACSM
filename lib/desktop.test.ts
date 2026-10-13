// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { getToken } from "@/lib/auth";
import { adoptLaunchToken } from "@/lib/desktop";

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("adoptLaunchToken", () => {
  it("keeps the session the app window was opened with and scrubs it from the URL", () => {
    window.history.replaceState(null, "", "/#token=gAAAA%3Dabc");

    adoptLaunchToken();

    expect(getToken()).toBe("gAAAA=abc");
    expect(window.location.hash).toBe("");
  });

  it("leaves an existing session alone when the URL carries none", () => {
    window.localStorage.setItem("fear.token", "saved");

    adoptLaunchToken();

    expect(getToken()).toBe("saved");
  });
});
