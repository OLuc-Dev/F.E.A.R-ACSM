import { describe, expect, it } from "vitest";

import { toHandSample } from "@/lib/hand-tracker";

// 21 landmarks with the palm (wrist + knuckles) at image x = 0.2, y = 0.6.
const hand = Array.from({ length: 21 }, () => ({ x: 0.2, y: 0.6 }));

describe("toHandSample", () => {
  it("mirrors x so a hand on the image's left is on your right", () => {
    const sample = toHandSample(hand, { name: "Open_Palm", score: 0.9 }, "Right");
    expect(sample).toEqual({ pose: "Open_Palm", x: 0.8, y: 0.6, side: "Right" });
  });

  it("reports an unsure gesture as 'None' rather than guessing", () => {
    expect(toHandSample(hand, { name: "Closed_Fist", score: 0.4 })?.pose).toBe("None");
    expect(toHandSample(hand, null)?.pose).toBe("None");
  });

  it("is no hand at all without a full set of landmarks", () => {
    expect(toHandSample(null, null)).toBeNull();
    expect(toHandSample(hand.slice(0, 5), { name: "Open_Palm", score: 0.9 })).toBeNull();
  });
});
