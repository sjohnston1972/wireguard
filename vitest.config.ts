import { defineConfig } from "vitest/config";

// Unit tests for the Worker's pure logic run in plain Node. Anything that
// needs D1, KV or fetch is exercised end to end against the deployed Worker.
export default defineConfig({
  test: {
    include: ["worker/test/**/*.test.ts"],
    environment: "node",
  },
});
