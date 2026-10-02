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
      // Vitest's default 5 s per test. Only the suites that render the whole app
      // and walk journeys through it (the view folders' test setups, the command
      // palette) raise their own limit, so a slow or hanging unit test still fails fast.
    },
  }),
);
