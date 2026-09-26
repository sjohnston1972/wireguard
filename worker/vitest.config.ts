import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import shared from "../vitest.config";

// So "npx vitest run" also works from inside worker/. The real settings (the
// "cloudflare:workers" stand-in, which tests to run) live in the repo root's
// vitest.config.ts; this just points vitest back at the repo root and reuses
// them, so the two can never drift apart.
export default defineConfig({
  ...shared,
  root: fileURLToPath(new URL("..", import.meta.url)),
});
