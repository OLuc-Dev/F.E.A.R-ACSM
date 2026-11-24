// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  extractGazeFeatures,
  fitCalibration,
  predictGaze,
  resolveAttentionTarget,
  validationError,
  type Landmark,
} from "@/lib/visual-attention";

const sample = (x: number, y: number) => ({
  features: [0.3 + x * 0.4, -0.1 + y * 0.2, 0, 0.3],
  x: x * 1000,
  y: y * 800,
});
const training = [0, 0.5, 1].flatMap((x) => [0, 0.5, 1].map((y) => sample(x, y)));

describe("calibrated viewport gaze", () => {
  it("maps unseen iris features and measures error on held-out targets", () => {
    const calibration = fitCalibration(training)!;
    const point = predictGaze(calibration, sample(0.25, 0.75).features)!;
    expect(point.x).toBeCloseTo(250, 0);
    expect(point.y).toBeCloseTo(600, 0);
    expect(validationError(calibration, [sample(0.25, 0.75), sample(0.75, 0.25)])).toBeLessThan(1);
    expect(validationError(calibration, [{ ...sample(0.25, 0.75), x: 900 }])).toBeGreaterThan(600);
  });

  it("rejects missing variation, insufficient calibration and invalid numbers", () => {
    expect(fitCalibration(training.slice(0, 8))).toBeNull();
    expect(fitCalibration(training.map((s) => ({ ...s, features: [0.5, 0, 0, 0] })))).toBeNull();
    expect(fitCalibration(training.map((s) => ({ ...s, x: NaN })))).toBeNull();
    const calibration = fitCalibration(training)!;
    expect(predictGaze(calibration, [NaN, 0, 0, 0])).toBeNull();
    expect(predictGaze(calibration, [20, 0, 0, 0])).toBeNull();
    expect(validationError(calibration, [])).toBe(Infinity);
  });

  it("extracts stable eye features and discards blinks/missing eyes", () => {
    const landmarks: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    for (const [a, b, top, bottom, iris, start] of [
      [33, 133, 159, 145, 468, 0.2],
      [362, 263, 386, 374, 473, 0.6],
    ]) {
      landmarks[a] = { x: start, y: 0.4 };
      landmarks[b] = { x: start + 0.15, y: 0.4 };
      landmarks[top] = { x: start + 0.075, y: 0.38 };
      landmarks[bottom] = { x: start + 0.075, y: 0.42 };
      landmarks[iris] = { x: start + 0.075, y: 0.4 };
    }
    expect(extractGazeFeatures(landmarks)?.[0]).toBeCloseTo(0.5);
    landmarks[145] = landmarks[159];
    expect(extractGazeFeatures(landmarks)).toBeNull();
    expect(extractGazeFeatures([])).toBeNull();
  });
});

describe("opt-in DOM context", () => {
  function hit(html: string) {
    document.body.innerHTML = html;
    Object.defineProperty(document, "elementFromPoint", {
      value: () => document.querySelector("p"),
      configurable: true,
    });
  }

  it("reads only marked cards and bounds the text", () => {
    hit(
      '<article data-visual-attention-target="Vídeo" role="group"><h2>Vídeo</h2><p>Uma aula de Python.</p></article>',
    );
    expect(resolveAttentionTarget(document, 10, 20)).toEqual({
      label: "Vídeo",
      text: "Vídeo Uma aula de Python.",
      role: "group",
    });
    hit("<article><p>Texto da página sem permissão.</p></article>");
    expect(resolveAttentionTarget(document, 10, 20)).toBeNull();
    hit(`<article data-visual-attention-target="Exemplo"><p>${"a".repeat(2000)}</p></article>`);
    expect(resolveAttentionTarget(document, 10, 20)?.text.length).toBe(1200);
  });

  it("does not collect fields or private/hidden cards", () => {
    for (const privateHtml of [
      '<input value="secret">',
      "<textarea>secret</textarea>",
      "<span data-visual-attention-private>secret</span>",
      "<span hidden>secret</span>",
    ]) {
      hit(`<article data-visual-attention-target="Privado"><p>Texto</p>${privateHtml}</article>`);
      expect(resolveAttentionTarget(document, 10, 20)).toBeNull();
    }
    hit('<article data-visual-attention-target="Privado" aria-hidden="true"><p>Texto</p></article>');
    expect(resolveAttentionTarget(document, 10, 20)).toBeNull();
    expect(resolveAttentionTarget(document, NaN, 20)).toBeNull();
  });
});
