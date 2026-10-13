// Copies MediaPipe's WASM runtime out of node_modules into public/, so hand
// gestures load it from this app (offline, version-matched) and never from a CDN.
// Runs before `next dev` and `next build`.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const target = join(root, "public", "mediapipe", "wasm");
// FilesetResolver.forVisionTasks() picks one of these two at runtime (SIMD or not);
// the "module" variant is only used by the ES-module loader, which we don't use.
const files = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

if (!existsSync(source)) {
  console.error("copy-mediapipe: @mediapipe/tasks-vision is not installed; run npm install.");
  process.exit(1);
}
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(source, file), join(target, file));
console.log(`copy-mediapipe: ${files.length} files -> public/mediapipe/wasm`);
