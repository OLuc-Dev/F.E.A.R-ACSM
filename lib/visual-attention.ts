// Experimental, calibrated viewport gaze. Landmarks alone are not a gaze model:
// a user's calibration and separate validation are required before using a point.
export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export interface CalibrationSample {
  features: number[];
  x: number;
  y: number;
}

export interface Calibration {
  mean: number[];
  scale: number[];
  weightsX: number[];
  weightsY: number[];
  min: number[];
  max: number[];
}

export interface AttentionTarget {
  label: string;
  text: string;
  role: string;
}

export interface VisualAttention {
  source: "webcam-calibrated" | "pointer-test";
  coordinate_space: "viewport-css-pixels";
  x: number;
  y: number;
  viewport_width: number;
  viewport_height: number;
  captured_at_ms: number;
  calibration_error_px: number;
  target: AttentionTarget | null;
}

/** Eye-relative iris positions and a coarse nose/eye geometry cue, not emotions. */
export function extractGazeFeatures(landmarks: Landmark[]): number[] | null {
  if (landmarks.length < 478) return null;
  const required = [1, 33, 133, 159, 145, 362, 263, 386, 374, 468, 473];
  if (
    required.some((index) => !Number.isFinite(landmarks[index]?.x) || !Number.isFinite(landmarks[index]?.y))
  )
    return null;

  function eye(a: number, b: number, top: number, bottom: number, iris: number) {
    const left = landmarks[a];
    const right = landmarks[b];
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const width2 = dx * dx + dy * dy;
    if (width2 < 1e-6) return null;
    const width = Math.sqrt(width2);
    // Discard blinks and heavily occluded eyes; their iris estimates jump.
    if (
      Math.hypot(landmarks[top].x - landmarks[bottom].x, landmarks[top].y - landmarks[bottom].y) / width <
      0.08
    )
      return null;
    const px = landmarks[iris].x - left.x;
    const py = landmarks[iris].y - left.y;
    const x = (px * dx + py * dy) / width2;
    const y = (-px * dy + py * dx) / width2;
    if (x < -0.15 || x > 1.15 || Math.abs(y) > 0.75) return null;
    return { x, y, cx: (left.x + right.x) / 2, cy: (left.y + right.y) / 2 };
  }

  const right = eye(33, 133, 159, 145, 468);
  const left = eye(362, 263, 386, 374, 473);
  if (!right || !left) return null;
  const dx = left.cx - right.cx;
  const dy = left.cy - right.cy;
  const distance2 = dx * dx + dy * dy;
  if (distance2 < 1e-5) return null;
  const nx = landmarks[1].x - (left.cx + right.cx) / 2;
  const ny = landmarks[1].y - (left.cy + right.cy) / 2;
  return [
    (left.x + right.x) / 2,
    (left.y + right.y) / 2,
    (nx * dx + ny * dy) / distance2,
    (-nx * dy + ny * dx) / distance2,
  ];
}

/** Affine ridge regression in normalized feature space. No external ML runtime. */
export function fitCalibration(samples: CalibrationSample[]): Calibration | null {
  const size = samples[0]?.features.length ?? 0;
  if (
    samples.length < 9 ||
    size !== 4 ||
    samples.some((s) => s.features.length !== size || ![s.x, s.y, ...s.features].every(Number.isFinite))
  )
    return null;
  if (
    Math.max(...samples.map((s) => s.x)) - Math.min(...samples.map((s) => s.x)) < 1 ||
    Math.max(...samples.map((s) => s.y)) - Math.min(...samples.map((s) => s.y)) < 1
  )
    return null;
  const mean = Array.from(
    { length: size },
    (_, i) => samples.reduce((sum, s) => sum + s.features[i], 0) / samples.length,
  );
  const deviations = mean.map((value, i) =>
    Math.sqrt(samples.reduce((sum, s) => sum + (s.features[i] - value) ** 2, 0) / samples.length),
  );
  // The first two features must vary: head motion alone cannot calibrate gaze.
  if (deviations[0] < 1e-4 || deviations[1] < 1e-4) return null;
  const scale = deviations.map((value) => (value < 1e-6 ? 1 : value));
  const rows = samples.map((s) => [1, ...s.features.map((value, i) => (value - mean[i]) / scale[i])]);
  const n = size + 1;
  const normal = Array.from({ length: n }, (_, i) =>
    Array.from(
      { length: n },
      (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j && i > 0 ? 0.01 : 0),
    ),
  );
  const rhs = (axis: "x" | "y") =>
    Array.from({ length: n }, (_, i) => rows.reduce((sum, row, j) => sum + row[i] * samples[j][axis], 0));
  const weightsX = solve(normal, rhs("x"));
  const weightsY = solve(normal, rhs("y"));
  if (!weightsX || !weightsY) return null;
  return {
    mean,
    scale,
    weightsX,
    weightsY,
    min: mean.map((_, i) => Math.min(...samples.map((s) => s.features[i]))),
    max: mean.map((_, i) => Math.max(...samples.map((s) => s.features[i]))),
  };
}

function solve(matrix: number[][], rhs: number[]): number[] | null {
  const rows = matrix.map((row, i) => [...row, rhs[i]]);
  const n = rows.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let i = col + 1; i < n; i++) if (Math.abs(rows[i][col]) > Math.abs(rows[pivot][col])) pivot = i;
    if (Math.abs(rows[pivot][col]) < 1e-10) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    rows[col] = rows[col].map((value) => value / divisor);
    for (let i = 0; i < n; i++) {
      if (i === col) continue;
      const factor = rows[i][col];
      rows[i] = rows[i].map((value, j) => value - factor * rows[col][j]);
    }
  }
  const result = rows.map((row) => row[n]);
  return result.every(Number.isFinite) ? result : null;
}

export function predictGaze(calibration: Calibration, features: number[]): { x: number; y: number } | null {
  if (features.length !== calibration.mean.length || !features.every(Number.isFinite)) return null;
  // Reject substantial feature extrapolation. Normalized features cannot detect
  // every head translation or distance change: the user must keep their posture.
  // Do not clamp a bad prediction onto a screen edge and invent attention there.
  if (
    features.some(
      (value, i) =>
        value < calibration.min[i] - Math.max(0.02, (calibration.max[i] - calibration.min[i]) * 0.25) ||
        value > calibration.max[i] + Math.max(0.02, (calibration.max[i] - calibration.min[i]) * 0.25),
    )
  )
    return null;
  const row = [1, ...features.map((value, i) => (value - calibration.mean[i]) / calibration.scale[i])];
  const x = row.reduce((sum, value, i) => sum + value * calibration.weightsX[i], 0);
  const y = row.reduce((sum, value, i) => sum + value * calibration.weightsY[i], 0);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** RMS Euclidean error on held-out targets, in CSS pixels. */
export function validationError(calibration: Calibration, samples: CalibrationSample[]): number {
  if (!samples.length) return Infinity;
  let sum = 0;
  for (const sample of samples) {
    if (![sample.x, sample.y].every(Number.isFinite)) return Infinity;
    const point = predictGaze(calibration, sample.features);
    if (!point) return Infinity;
    sum += (point.x - sample.x) ** 2 + (point.y - sample.y) ** 2;
  }
  return Math.sqrt(sum / samples.length);
}

/** Only explicitly marked, public demo cards. Never read arbitrary page text. */
export function resolveAttentionTarget(doc: Document, x: number, y: number): AttentionTarget | null {
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || typeof doc.elementFromPoint !== "function")
    return null;
  const hit = doc.elementFromPoint(x, y);
  const target = hit?.closest("[data-visual-attention-target]");
  if (!target || target.closest('[data-visual-attention-private], [hidden], [aria-hidden="true"]'))
    return null;
  const privateSelector =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-visual-attention-private], [hidden], [aria-hidden="true"]';
  if (target.querySelector(privateSelector)) return null;
  const label = (
    target.getAttribute("data-visual-attention-target") ||
    target.getAttribute("aria-label") ||
    ""
  )
    .trim()
    .slice(0, 160);
  const text = Array.from(target.querySelectorAll("h2, h3, p"), (node) => node.textContent?.trim() || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 1200);
  if (!label && !text) return null;
  return { label, text, role: (target.getAttribute("role") || target.tagName.toLowerCase()).slice(0, 40) };
}
