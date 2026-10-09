// scripts/lib/mermaid.mjs
//
// Plain English: draws the lab readmes' concept diagrams (Mermaid sources in
// labs/_diagrams/<id>/<n>.mmd) as SVG files with one pinned Mermaid, in a
// hidden Edge or Chrome (lib/headless.mjs). Mermaid is not an npm
// dependency (its package is over 100 MB): its one-file browser build is
// downloaded once from the npm CDN, checked against a pinned SHA-256 before
// every use, and kept in node_modules/.cache/wg-mermaid/<version>/.
//
// The SVGs are committed, so neither a production build nor CI needs a
// browser. Each one carries a stamp, `<!-- labs-diagrams source <sha256> -->`,
// the hash of its source, the Mermaid version and the drawing settings
// (sourceStamp), so `npm run labs-diagrams -- --check` can tell a stale one
// without drawing it again (a browser's fonts would change the bytes).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MERMAID = {
  version: "12.1.0",
  url: "https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js",
  sha256: "6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2",
};

export const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** The light theme's colours (web/src/styles/themes.css), as Mermaid theme variables. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  deterministicIds: true,
  theme: "base",
  fontFamily: FONT,
  themeVariables: {
    fontFamily: FONT,
    fontSize: "14px",
    background: "#ffffff",
    primaryColor: "#eaf0fa",
    primaryBorderColor: "#2563eb",
    primaryTextColor: "#0f1b2d",
    secondaryColor: "#f4f7fb",
    secondaryBorderColor: "#768498",
    secondaryTextColor: "#0f1b2d",
    tertiaryColor: "#ffffff",
    tertiaryBorderColor: "#c3cddb",
    tertiaryTextColor: "#0f1b2d",
    lineColor: "#44546a",
    textColor: "#0f1b2d",
    mainBkg: "#eaf0fa",
    nodeBorder: "#2563eb",
    clusterBkg: "#f9fbfd",
    clusterBorder: "#768498",
    titleColor: "#0f1b2d",
    edgeLabelBackground: "#ffffff",
    actorBkg: "#eaf0fa",
    actorBorder: "#2563eb",
    actorTextColor: "#0f1b2d",
    actorLineColor: "#768498",
    signalColor: "#44546a",
    signalTextColor: "#0f1b2d",
    labelBoxBkgColor: "#f4f7fb",
    labelBoxBorderColor: "#768498",
    labelTextColor: "#0f1b2d",
    loopTextColor: "#44546a",
    noteBkgColor: "#fff7e6",
    noteBorderColor: "#b45309",
    noteTextColor: "#0f1b2d",
    activationBkgColor: "#dae5f9",
    activationBorderColor: "#2563eb",
    sequenceNumberColor: "#ffffff",
  },
  flowchart: { htmlLabels: false, curve: "basis", padding: 14, nodeSpacing: 44, rankSpacing: 52, wrappingWidth: 220 },
  sequence: { useMaxWidth: false, mirrorActors: false, actorMargin: 60, boxMargin: 8, noteMargin: 10, messageMargin: 34, wrap: true },
  htmlLabels: false,
};

const CACHE = fileURLToPath(new URL(`../../node_modules/.cache/wg-mermaid/${MERMAID.version}/mermaid.min.js`, import.meta.url));

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The hash a concept SVG is stamped with: its source (line endings ignored), the Mermaid version and the settings. */
export function sourceStamp(source) {
  return sha256(JSON.stringify({ source: source.replace(/\r\n?/g, "\n").trim(), mermaid: MERMAID.version, config: MERMAID_CONFIG }));
}

/** The stamp in a committed concept SVG, or null. */
export const stampOf = (svg) => /<!-- labs-diagrams source ([0-9a-f]{64}) -->/.exec(svg)?.[1] ?? null;

/** Mermaid's browser build, downloaded once and checked against the pin every time. */
export async function mermaidScript() {
  let body = existsSync(CACHE) ? readFileSync(CACHE) : null;
  if (!body || sha256(body) !== MERMAID.sha256) {
    const r = await fetch(MERMAID.url);
    if (!r.ok) throw new Error(`Mermaid ${MERMAID.version} did not download (${r.status} from ${MERMAID.url}).`);
    body = Buffer.from(await r.arrayBuffer());
    if (sha256(body) !== MERMAID.sha256) throw new Error(`Mermaid ${MERMAID.version} from ${MERMAID.url} does not match its pinned SHA-256: refusing to run it.`);
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, body);
  }
  return body.toString("utf8");
}

/** The header lines of a source: `%% title: ...` and `%% alt: ...`. */
export function sourceMeta(source) {
  const meta = {};
  for (const m of source.matchAll(/^%%\s*(title|alt):\s*(.+?)\s*$/gm)) meta[m[1]] = m[2];
  return meta;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Some Mermaid shapes are drawn as sketchy paths (rough.js, even with no roughness): every stretch twice, plus
 * stretches of no length. Drawn once, they look the same at a fraction of the size.
 */
export function sketchyOnce(d) {
  const segs = d.trim().split(/(?=M)/);
  if (segs.length < 8) return d;
  const out = [];
  let prev = null;
  for (const s of segs) {
    const nums = s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
    if (nums.length >= 4 && nums.every((v, i) => v === nums[i % 2])) continue; // no length
    const ends = nums.length >= 4 ? `${nums[0]} ${nums[1]} ${nums[nums.length - 2]} ${nums[nums.length - 1]}` : null;
    if (ends && ends === prev) continue; // the same stretch again
    prev = ends;
    out.push(s.trim());
  }
  return out.join(" ");
}

/**
 * Mermaid's SVG made standalone: a fixed width and height (from its viewBox), a white page, a <title> and <desc>
 * for screen readers, and the source stamp.
 */
export function finishSvg(svg, { title, alt, stamp }) {
  const open = /<svg\b[^>]*>/.exec(svg);
  if (!open) throw new Error("Mermaid gave no <svg>.");
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(open[0]);
  if (!vb) throw new Error("Mermaid's SVG has no viewBox.");
  const [x, y, w, h] = vb.slice(1).map(Number);
  const pad = 16;
  const W = Math.ceil(w + 2 * pad);
  const H = Math.ceil(h + 2 * pad);
  const id = /\bid="([^"]+)"/.exec(open[0])?.[1] ?? "concept";
  const head = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="${id}" width="${W}" height="${H}" viewBox="${Math.floor(x - pad)} ${Math.floor(y - pad)} ${W} ${H}" role="img" aria-labelledby="${id}-t ${id}-d">`;
  const page = `<rect x="${Math.floor(x - pad)}" y="${Math.floor(y - pad)}" width="${W}" height="${H}" fill="#ffffff"/>`;
  const inner = svg
    .slice(open.index + open[0].length)
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>|<desc\b[^>]*>[\s\S]*?<\/desc>/g, "")
    // Mermaid writes coordinates to 15 digits (and some shapes as long sketchy paths): a tenth of a pixel is plenty.
    .replace(/(\s(?:d|points|transform|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|dx|dy)=")([^"]*)"/g, (_, a, v) => `${a}${v.replace(/-?\d+\.\d+(?:e-?\d+)?/g, (x) => String(Math.round(Number(x) * 10) / 10))}"`)
    .replace(/(\sd=")([^"]*)"/g, (_, a, d) => `${a}${sketchyOnce(d)}"`);
  return `<!-- labs-diagrams source ${stamp} -->\n${head}<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(alt)}</desc>${page}${inner.trim()}\n`;
}

/**
 * Draws Mermaid sources in `browser` (lib/headless.mjs openBrowser()): [{ id, source }] → [{ id, svg }] (Mermaid's
 * own SVG, not yet finished). A source Mermaid cannot parse throws, naming it.
 */
export async function renderAll(browser, items) {
  const script = await mermaidScript();
  await browser.evaluate(`(() => { document.open(); document.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'); document.close(); return true; })()`);
  await browser.evaluate(`${script}\n;true`);
  const out = [];
  for (const it of items) {
    const config = { ...MERMAID_CONFIG, deterministicIDSeed: it.id };
    const expr = `(async () => {
      const m = globalThis.mermaid ?? globalThis.__esbuild_esm_mermaid_nm?.mermaid?.default ?? globalThis.__esbuild_esm_mermaid_nm?.mermaid;
      m.initialize(${JSON.stringify(config)});
      try {
        const r = await m.render(${JSON.stringify(it.id)}, ${JSON.stringify(it.source)});
        return { svg: r.svg };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    })()`;
    const r = await browser.evaluate(expr);
    if (!r || r.error) throw new Error(`${it.id}: Mermaid could not draw it: ${r?.error ?? "no answer"}`);
    out.push({ id: it.id, svg: r.svg });
  }
  return out;
}
