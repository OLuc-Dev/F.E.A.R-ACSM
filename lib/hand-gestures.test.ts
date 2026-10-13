import { describe, expect, it } from "vitest";

import { type GestureCommand, GestureInterpreter, type HandPose, type HandSample } from "@/lib/hand-gestures";

// Synthetic camera streams at 15 fps (what hand-tracker.ts runs at).
const FRAME_MS = 1000 / 15;

type Frame = [t: number, hand: HandSample | null];

class Stream {
  frames: Frame[] = [];
  t = 0;

  hold(pose: HandPose, x: number, y: number, ms: number, flickerEvery = 0): this {
    for (let elapsed = 0, index = 0; elapsed < ms; elapsed += FRAME_MS, index++) {
      const shown: HandPose = flickerEvery && index % flickerEvery === flickerEvery - 1 ? "None" : pose;
      this.push({ pose: shown, x, y });
    }
    return this;
  }

  move(pose: HandPose, from: [number, number], to: [number, number], ms: number): this {
    const steps = Math.max(1, Math.round(ms / FRAME_MS));
    for (let step = 1; step <= steps; step++) {
      const k = step / steps;
      this.push({ pose, x: from[0] + (to[0] - from[0]) * k, y: from[1] + (to[1] - from[1]) * k });
    }
    return this;
  }

  wave(pose: HandPose, center: number, amplitude: number, hz: number, ms: number): this {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      this.push({ pose, x: center + amplitude * Math.sin((2 * Math.PI * hz * elapsed) / 1000), y: 0.5 });
    }
    return this;
  }

  gone(ms: number): this {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) this.push(null);
    return this;
  }

  private push(hand: HandSample | null): void {
    this.frames.push([this.t, hand]);
    this.t += FRAME_MS;
  }

  commands(): GestureCommand[] {
    const interpreter = new GestureInterpreter();
    const fired: GestureCommand[] = [];
    for (const [t, hand] of this.frames) {
      const command = interpreter.update(t, hand);
      if (command) fired.push(command);
    }
    return fired;
  }
}

const stream = () => new Stream();

describe("held poses", () => {
  it("an open palm held still for a second toggles once, however long it stays up", () => {
    expect(stream().hold("Open_Palm", 0.5, 0.5, 3000).commands()).toEqual(["palm_hold"]);
  });

  it("is not a command when held for less than a second", () => {
    expect(stream().hold("Open_Palm", 0.5, 0.5, 800).commands()).toEqual([]);
  });

  it("fires again only after the palm is lowered and raised again", () => {
    const commands = stream()
      .hold("Open_Palm", 0.5, 0.5, 1300)
      .hold("None", 0.5, 0.5, 500)
      .hold("Open_Palm", 0.5, 0.5, 1300)
      .commands();
    expect(commands).toEqual(["palm_hold", "palm_hold"]);
  });

  it("a brief tracking dropout doesn't toggle the music again", () => {
    const commands = stream()
      .hold("Open_Palm", 0.5, 0.5, 1300)
      .gone(400)
      .hold("Open_Palm", 0.5, 0.5, 1500)
      .commands();
    expect(commands).toEqual(["palm_hold"]);
  });

  it("but taking the hand away and raising it again does", () => {
    const commands = stream()
      .hold("Open_Palm", 0.5, 0.5, 1300)
      .gone(1200)
      .hold("Open_Palm", 0.5, 0.5, 1300)
      .commands();
    expect(commands).toEqual(["palm_hold", "palm_hold"]);
  });

  it("ignores an open hand that is drifting instead of held", () => {
    expect(stream().move("Open_Palm", [0.3, 0.5], [0.45, 0.55], 1500).commands()).toEqual([]);
  });

  it("tolerates the recognizer flickering to 'None' for a frame", () => {
    expect(stream().hold("Open_Palm", 0.5, 0.5, 1400, 6).commands()).toEqual(["palm_hold"]);
  });

  it("a fist held still for 0.7s is the silence command", () => {
    expect(stream().hold("Closed_Fist", 0.5, 0.6, 900).commands()).toEqual(["fist_hold"]);
    expect(stream().hold("Closed_Fist", 0.5, 0.6, 500).commands()).toEqual([]);
  });

  it("pointing up for 0.6s means 'listen to me'", () => {
    expect(stream().hold("Pointing_Up", 0.5, 0.4, 800).commands()).toEqual(["point_hold"]);
    expect(stream().hold("Pointing_Up", 0.5, 0.4, 400).commands()).toEqual([]);
  });

  it("needs the hold to be continuous: a hand that leaves the frame starts over", () => {
    const commands = stream()
      .hold("Open_Palm", 0.5, 0.5, 600)
      .gone(500)
      .hold("Open_Palm", 0.5, 0.5, 600)
      .commands();
    expect(commands).toEqual([]);
  });

  it("a wave the camera samples too slowly is never mistaken for a held palm", () => {
    // A 2 Hz wave seen at 4 fps lands on the same point of each stroke: it looks still.
    const interpreter = new GestureInterpreter();
    const fired: GestureCommand[] = [];
    for (let t = 0; t <= 3000; t += 250) {
      const x = 0.5 + 0.08 * Math.sin((2 * Math.PI * 2 * t) / 1000);
      const command = interpreter.update(t, { pose: "Open_Palm", x, y: 0.5 });
      if (command) fired.push(command);
    }
    expect(fired).not.toContain("palm_hold");
  });

  it("works at a slow camera frame rate too", () => {
    const interpreter = new GestureInterpreter();
    const fired: GestureCommand[] = [];
    for (let t = 0; t <= 1600; t += 200) {
      const command = interpreter.update(t, { pose: "Open_Palm", x: 0.5, y: 0.5 });
      if (command) fired.push(command);
    }
    expect(fired).toEqual(["palm_hold"]);
  });
});

describe("swipes", () => {
  it("from a hand at rest, moving to your right is 'next'", () => {
    const commands = stream()
      .hold("Open_Palm", 0.3, 0.5, 400)
      .move("Open_Palm", [0.3, 0.5], [0.7, 0.52], 300)
      .hold("Open_Palm", 0.7, 0.52, 300)
      .commands();
    expect(commands).toEqual(["swipe_right"]);
  });

  it("and moving to your left is 'previous'", () => {
    const commands = stream()
      .hold("Open_Palm", 0.7, 0.5, 400)
      .move("Open_Palm", [0.7, 0.5], [0.3, 0.5], 300)
      .commands();
    expect(commands).toEqual(["swipe_left"]);
  });

  it("still registers on a slow camera (4 fps)", () => {
    const interpreter = new GestureInterpreter();
    const fired: GestureCommand[] = [];
    // At rest for 0.5 s, a 0.3 s swipe, then a moment at the end — sampled every 250 ms.
    const xAt = (t: number) => (t <= 500 ? 0.3 : t >= 800 ? 0.68 : 0.3 + (0.38 * (t - 500)) / 300);
    for (let t = 0; t <= 1500; t += 250) {
      const command = interpreter.update(t, { pose: "Open_Palm", x: xAt(t), y: 0.5 });
      if (command) fired.push(command);
    }
    expect(fired).toEqual(["swipe_right"]);
  });

  it("survives the tracker losing the hand mid-swipe", () => {
    // On a slow machine the hand outruns the tracker and reappears at the end.
    const commands = stream()
      .hold("Open_Palm", 0.3, 0.5, 400)
      .gone(330)
      .hold("Open_Palm", 0.68, 0.5, 300)
      .commands();
    expect(commands).toEqual(["swipe_right"]);
  });

  it("lowering one hand and raising the other is not a swipe", () => {
    const right = (x: number) => ({ pose: "Open_Palm" as const, x, y: 0.5, side: "Right" as const });
    const left = (x: number) => ({ pose: "Open_Palm" as const, x, y: 0.5, side: "Left" as const });
    const interpreter = new GestureInterpreter();
    const fired: GestureCommand[] = [];
    const frames: [number, HandSample | null][] = [];
    for (let t = 0; t < 400; t += FRAME_MS) frames.push([t, right(0.3)]);
    for (let t = 400; t < 700; t += FRAME_MS) frames.push([t, null]);
    for (let t = 700; t < 1000; t += FRAME_MS) frames.push([t, left(0.7)]);
    for (const [t, hand] of frames) {
      const command = interpreter.update(t, hand);
      if (command) fired.push(command);
    }
    expect(fired).toEqual([]);
  });

  it("a hand entering the frame and crossing it is not a swipe", () => {
    // Reaching across the desk: never at rest, so there is nothing to swipe from.
    expect(stream().move("None", [0.05, 0.5], [0.9, 0.55], 700).commands()).toEqual([]);
  });

  it("a slow movement across the frame is not a swipe", () => {
    const commands = stream()
      .hold("Open_Palm", 0.3, 0.5, 400)
      .move("Open_Palm", [0.3, 0.5], [0.7, 0.5], 1500)
      .commands();
    expect(commands).toEqual([]);
  });

  it("a mostly vertical movement is not a swipe", () => {
    const commands = stream()
      .hold("Open_Palm", 0.4, 0.2, 400)
      .move("Open_Palm", [0.4, 0.2], [0.7, 0.8], 300)
      .commands();
    expect(commands).toEqual([]);
  });

  it("the tracker jumping to another hand is not a swipe", () => {
    const commands = stream().hold("Open_Palm", 0.2, 0.5, 500).hold("Open_Palm", 0.75, 0.5, 300).commands();
    expect(commands).toEqual([]);
  });

  it("two swipes inside the cooldown count once", () => {
    const commands = stream()
      .hold("Open_Palm", 0.3, 0.5, 400)
      .move("Open_Palm", [0.3, 0.5], [0.7, 0.5], 250)
      .hold("Open_Palm", 0.7, 0.5, 300)
      .move("Open_Palm", [0.7, 0.5], [0.3, 0.5], 250)
      .commands();
    expect(commands).toEqual(["swipe_right"]);
  });
});

describe("waves", () => {
  it("an open hand waving side to side is a wave", () => {
    expect(
      stream().hold("Open_Palm", 0.5, 0.5, 300).wave("Open_Palm", 0.5, 0.08, 2.5, 1600).commands(),
    ).toEqual(["wave"]);
  });

  it("a still hand's jitter is not a wave", () => {
    const jittery = stream();
    for (let index = 0; index < 40; index++) {
      jittery.hold("None", 0.5 + (index % 2 ? 0.01 : -0.01), 0.5, FRAME_MS);
    }
    expect(jittery.commands()).toEqual([]);
  });

  it("a fist shaking is not a wave", () => {
    expect(stream().wave("Closed_Fist", 0.5, 0.08, 2.5, 1600).commands()).not.toContain("wave");
  });
});
