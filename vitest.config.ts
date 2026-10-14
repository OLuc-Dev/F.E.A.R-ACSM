import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // JSX is compiled here, not by tsconfig: Next.js insists on "jsx": "preserve"
  // there (and rewrites the file on every build/lint if it differs).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": root },
  },
  test: {
    include: ["lib/**/*.test.ts", "components/**/*.test.{ts,tsx}"],
  },
});
