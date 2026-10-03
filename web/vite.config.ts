import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Dev: `npm run dev:web` serves the app on 5173 and forwards /api and /captures
// to `npm run dev:api` (wrangler dev) on 8787. Build: output goes to web/dist.
const api = "http://127.0.0.1:8787";

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
    // (npm run bundle-size fails the build if one slips through.)
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
});
