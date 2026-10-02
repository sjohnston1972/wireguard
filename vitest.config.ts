import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Two Vitest projects. "worker" runs in plain Node: pure logic is tested
// directly, and whole journeys (deploy, heartbeat, hibernate, resume, tear
// down) run against the harness in worker/test/harness.ts, which stands in for
// D1, KV, the Durable Object and the outside world. "cloudflare:workers" only
// exists inside the Workers runtime, so it is pointed at a small stand-in.
// "web" is the React app in web/, tested in jsdom (see web/vitest.config.ts).
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: { "cloudflare:workers": fileURLToPath(new URL("./worker/test/cf-workers-stub.ts", import.meta.url)) },
        },
        test: {
          name: "worker",
          include: ["worker/test/**/*.test.ts"],
          environment: "node",
        },
      },
      "web/vitest.config.ts",
    ],
  },
});
