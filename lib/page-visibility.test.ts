// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { isPageShown, onPageShownChange } from "@/lib/page-visibility";

type AppWindow = Window & { __fearHidden?: boolean };

afterEach(() => {
  delete (window as AppWindow).__fearHidden;
});

describe("page visibility", () => {
  it("counts a window the app says is hidden in the tray as not shown", () => {
    expect(isPageShown()).toBe(true);
    const changed = vi.fn();
    const stop = onPageShownChange(changed);
    // What the Windows app runs when its window goes to the tray:
    (window as AppWindow).__fearHidden = true;
    window.dispatchEvent(new CustomEvent("fear:window", { detail: { hidden: true } }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(isPageShown()).toBe(false); // even though the browser still says "visible"
    stop();
  });

  it("follows the browser's own hidden state too", () => {
    const changed = vi.fn();
    const stop = onPageShownChange(changed);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(isPageShown()).toBe(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    stop();
  });
});
