// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadScreenMode, nextScreenMode, saveScreenMode, useScreenCommentator } from "@/lib/screen-watch";

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("screen mode", () => {
  it("starts off, goes ask → watch → off, and is remembered", () => {
    expect(loadScreenMode()).toBe("off");
    expect([nextScreenMode("off"), nextScreenMode("ask"), nextScreenMode("watch")]).toEqual([
      "ask",
      "watch",
      "off",
    ]);
    saveScreenMode("watch");
    expect(loadScreenMode()).toBe("watch");
  });
});

describe("useScreenCommentator", () => {
  it("glances every so often and passes on what's worth saying", async () => {
    const glance = vi.fn(async () => "Olha o baú.");
    const onRemark = vi.fn();
    renderHook(() => useScreenCommentator({ active: true, hold: false, glance, onRemark, everyMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onRemark).toHaveBeenCalledWith("Olha o baú.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(glance).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when there's nothing to say, and waits its turn", async () => {
    const glance = vi.fn(async () => "");
    const onRemark = vi.fn();
    const hook = renderHook(
      (hold: boolean) => useScreenCommentator({ active: true, hold, glance, onRemark, everyMs: 1000 }),
      {
        initialProps: true,
      },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(glance).not.toHaveBeenCalled(); // F.E.A.R. or you were talking
    hook.rerender(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(glance).toHaveBeenCalledTimes(1);
    expect(onRemark).not.toHaveBeenCalled();
  });

  it("stops looking when switched off", async () => {
    const glance = vi.fn(async () => "x");
    const hook = renderHook(
      (active: boolean) =>
        useScreenCommentator({ active, hold: false, glance, onRemark: vi.fn(), everyMs: 1000 }),
      {
        initialProps: true,
      },
    );
    hook.rerender(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(glance).not.toHaveBeenCalled();
  });
});
