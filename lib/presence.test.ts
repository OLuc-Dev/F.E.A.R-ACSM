// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  awayFor,
  GREET_AFTER_MS,
  greetingName,
  LEAVE_AFTER_MS,
  loadPresencePreference,
  type PresenceEvent,
  PresenceWatcher,
  savePresencePreference,
  welcomeBack,
} from "@/lib/presence";
import type { GlanceListener, PresenceTracker, PresenceTrackerFactory } from "@/lib/presence-tracker";
import { usePresence } from "@/lib/use-presence";

const MIN = 60_000;

/** Glances every 500 ms from `from` to `to`, all with or all without a face. */
function glances(watcher: PresenceWatcher, from: number, to: number, face: boolean): PresenceEvent[] {
  const events: PresenceEvent[] = [];
  for (let t = from; t <= to; t += 500) {
    const event = watcher.update(t, face);
    if (event) events.push(event);
  }
  return events;
}

describe("PresenceWatcher", () => {
  it("takes you as already here when switched on, without a hello", () => {
    const watcher = new PresenceWatcher();
    expect(glances(watcher, 0, 5000, true)).toEqual([]);
    expect(watcher.state).toBe("here");
  });

  it("needs a face held for a moment, not a flicker", () => {
    const watcher = new PresenceWatcher();
    watcher.update(0, true);
    watcher.update(500, true);
    watcher.update(1000, false);
    watcher.update(1500, true);
    expect(watcher.state).toBe("unknown");
  });

  it("notices you leave and come back, and greets after a real absence", () => {
    const watcher = new PresenceWatcher();
    glances(watcher, 0, 2000, true);
    // Looking away for a few seconds isn't leaving.
    expect(glances(watcher, 2500, 2000 + LEAVE_AFTER_MS - 1000, false)).toEqual([]);
    const left = glances(watcher, 2000 + LEAVE_AFTER_MS - 500, 10 * MIN, false);
    expect(left).toEqual([{ type: "left", at: 2000 }]);
    expect(watcher.state).toBe("away");

    const back = glances(watcher, 10 * MIN + 500, 10 * MIN + 2000, true);
    expect(back).toEqual([{ type: "arrived", awayMs: 10 * MIN + 1500 - 2000, greet: true }]);
    expect(watcher.state).toBe("here");
  });

  it("lets a quick trip pass in silence", () => {
    const watcher = new PresenceWatcher();
    glances(watcher, 0, 1000, true);
    glances(watcher, 1500, GREET_AFTER_MS - 30_000, false);
    const [back] = glances(watcher, GREET_AFTER_MS - 29_500, GREET_AFTER_MS - 28_000, true);
    expect(back).toMatchObject({ type: "arrived", greet: false });
  });

  it("starts over after a reset", () => {
    const watcher = new PresenceWatcher();
    glances(watcher, 0, 1000, true);
    glances(watcher, 1500, 5 * MIN, false);
    watcher.reset();
    expect(glances(watcher, 5 * MIN, 6 * MIN, true)).toEqual([]);
  });
});

describe("what F.E.A.R. says", () => {
  it("calls you by your first name", () => {
    expect(greetingName("lucas.silva7@gmail.com")).toBe("Lucas");
    expect(greetingName("ext_lucas@x.com")).toBe("Lucas");
    expect(greetingName("jo@x.com")).toBe("");
    expect(greetingName("JOAO@x.com")).toBe("Joao");
    expect(greetingName("7@x.com")).toBe("");
  });

  it("says roughly how long you were gone", () => {
    expect(awayFor(3 * MIN)).toBe("uns 5 minutos");
    expect(awayFor(22 * MIN)).toBe("uns 20 minutos");
    expect(awayFor(58 * MIN)).toBe("1 hora");
    expect(awayFor(185 * MIN)).toBe("umas 3 horas");
  });

  it("greets by the time of day after hours away, briefly otherwise", () => {
    const morning = new Date(2026, 10, 3, 9, 0);
    expect(welcomeBack(3 * 60 * MIN, "Lucas", morning)).toBe(
      "Bom dia, Lucas. Faz umas 3 horas que você saiu.",
    );
    expect(welcomeBack(30 * MIN, "Lucas", morning, () => 0)).toBe("De volta, Lucas. Foram uns 30 minutos.");
    expect(welcomeBack(5 * MIN, "", morning, () => 0)).toBe("De volta.");
    expect(welcomeBack(5 * 60 * MIN, "", new Date(2026, 10, 3, 21, 0))).toMatch(/^Boa noite\./);
  });

  it("remembers whether it was on", () => {
    expect(loadPresencePreference()).toBe(false);
    savePresencePreference(true);
    expect(loadPresencePreference()).toBe(true);
    savePresencePreference(false);
    expect(loadPresencePreference()).toBe(false);
  });
});

class FakeTracker implements PresenceTracker {
  cameraOn = false;
  failWith: unknown = null;
  constructor(readonly glance: GlanceListener) {}
  async start() {
    if (this.failWith) throw this.failWith;
    this.cameraOn = true;
  }
  stop() {
    this.cameraOn = false;
  }
  close() {
    this.cameraOn = false;
  }
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("usePresence", () => {
  afterEach(() => {
    cleanup();
    setVisibility("visible");
  });

  function setup(configure: (tracker: FakeTracker) => void = () => {}) {
    let tracker: FakeTracker | null = null;
    const factory: PresenceTrackerFactory = async (glance) => {
      tracker = new FakeTracker(glance);
      configure(tracker);
      return tracker;
    };
    const events: PresenceEvent[] = [];
    const hook = renderHook(
      ({ enabled }) => usePresence({ enabled, onEvent: (e) => events.push(e), createTracker: factory }),
      { initialProps: { enabled: false } },
    );
    return { hook, events, tracker: () => tracker as FakeTracker };
  }

  it("watches only while on and the window is shown, and reports arrivals", async () => {
    const { hook, events, tracker } = setup();
    expect(hook.result.current.status).toBe("off");
    await act(async () => hook.rerender({ enabled: true }));
    expect(hook.result.current.status).toBe("watching");
    expect(tracker().cameraOn).toBe(true);

    act(() => {
      for (let t = 0; t <= 1000; t += 500) tracker().glance(t, true);
      for (let t = 1500; t <= 10 * MIN; t += 500) tracker().glance(t, false);
    });
    expect(hook.result.current.state).toBe("away");
    act(() => {
      for (let t = 10 * MIN; t <= 10 * MIN + 1000; t += 500) tracker().glance(t, true);
    });
    expect(events.map((e) => e.type)).toEqual(["left", "arrived"]);
    expect(hook.result.current.state).toBe("here");

    await act(async () => setVisibility("hidden"));
    expect(hook.result.current.status).toBe("paused");
    expect(tracker().cameraOn).toBe(false);
    await act(async () => setVisibility("visible"));
    expect(tracker().cameraOn).toBe(true);

    await act(async () => hook.rerender({ enabled: false }));
    expect(tracker().cameraOn).toBe(false);
    expect(hook.result.current.status).toBe("off");
  });

  it("says plainly when there's no camera", async () => {
    const { hook } = setup((tracker) => {
      tracker.failWith = new DOMException("no camera", "NotFoundError");
    });
    await act(async () => hook.rerender({ enabled: true }));
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toBe("Nenhuma câmera encontrada.");
  });
});
