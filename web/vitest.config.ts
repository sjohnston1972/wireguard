import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: "web",
      root: import.meta.dirname,
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      unstubGlobals: true,
      // Shell tests render the whole app (the shell plus a real view, e.g. the
      // Overview with all its panels) and walk journeys across views: about 2-4 s
      // alone, more when every file runs in parallel. 5 s timed them out under load.
      testTimeout: 20_000,
    },
  }),
);
