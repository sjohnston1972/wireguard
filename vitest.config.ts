import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The Worker's tests run in plain Node. Pure logic is tested directly; whole
// journeys (deploy, heartbeat, hibernate, resume, tear down) run against the
// harness in worker/test/harness.ts, which stands in for D1, KV, the Durable
// Object and the outside world. "cloudflare:workers" only exists inside the
// Workers runtime, so it is pointed at a small stand-in.
export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./worker/test/cf-workers-stub.ts", import.meta.url)) },
  },
  test: {
    include: ["worker/test/**/*.test.ts"],
    environment: "node",
  },
});
