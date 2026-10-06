import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { ChunkingContext } from "rolldown";

// Dev: `npm run dev:web` serves the app on 5173 and forwards /api and /captures
// to `npm run dev:api` (wrangler dev) on 8787. Build: output goes to web/dist.
const api = "http://127.0.0.1:8787";

/**
 * One entry chunk: every module the page loads at once (reachable from the
 * entry by static imports) goes into it. Modules reached only through
 * `import()` (the Azure insights widgets, the boot log, Add widgets…; see
 * src/widgets/lazy.tsx) are left to form their own chunks, loaded when used.
 * Left to itself, the bundler also moves the code those chunks share with the
 * entry into a second, preloaded chunk, which only costs compression.
 */
function inEntryGraph(): (id: string, ctx: ChunkingContext) => string | null {
  let graph: Set<string> | null = null;
  const build = (start: string, ctx: ChunkingContext) => {
    // Up from any module to the entry, then down the static imports only.
    const seen = new Set([start]);
    const up = [start];
    const entries: string[] = [];
    while (up.length) {
      const info = ctx.getModuleInfo(up.shift()!);
      if (!info) continue;
      if (info.isEntry) entries.push(info.id);
      for (const p of [...info.importers, ...info.dynamicImporters]) if (!seen.has(p)) seen.add(p), up.push(p);
    }
    const g = new Set(entries);
    const down = [...entries];
    while (down.length) for (const c of ctx.getModuleInfo(down.shift()!)?.importedIds ?? []) if (!g.has(c)) g.add(c), down.push(c);
    return g;
  };
  return (id, ctx) => ((graph ??= build(id, ctx)).has(id) ? "app" : null);
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": api, "/captures": api },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts always ship as files: Vite would otherwise inline the small subsets
    // into the CSS as data: URIs, which the CSP's font-src 'self' blocks.
    // (npm run bundle-size fails the build if one slips through.) The lab
    // diagrams' planned graphs (JSON) and the icon sprite (SVG) are files too:
    // inlined, a small planned graph would become a data: URI inside JS.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf|json|svg)$/i.test(file.split("?")[0]!) ? false : undefined),
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: inEntryGraph() }],
        },
      },
    },
  },
});
