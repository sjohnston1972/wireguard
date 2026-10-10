// scripts/lib/bundle.mjs
//
// Plain English: the size check for the built app (plan 5 ruling 8). Sizes
// are what travels over the wire (gzip), in kB of 1000 bytes, the unit Vite's
// build output prints.
//
// The budgets:
// - Entry JS, 320 kB: what every page load fetches before anything shows,
//   that is index.html's module script plus the chunks it preloads
//   (<link rel="modulepreload">). This is ruling 8's budget.
// - All JS, 500 kB: the entry plus the chunks loaded only when needed (the
//   Azure insights widgets, the labs page, and the lab diagram's own lazy
//   chunk with @xyflow/react, lab topology spec §11) and sw.js. It stops
//   lazy chunks quietly growing without bound. (400 kB before the diagram,
//   450 kB until the lab readme diagrams brought the total to ~450 kB.)
// - CSS, 50 kB in all.
// - Each planned lab diagram (shared/topology/planned/<id>.json, emitted as
//   a hashed assets/*.json file, never JS), 16 kB.
// - The Azure icon sprite (assets/azure-<hash>.svg), 60 kB.
// And the diagram never in the entry: an entry file that mentions
// "react-flow__" or "@xyflow" fails (FORBIDDEN_IN_ENTRY).

export const LIMITS = { entryJsGzip: 320_000, jsGzip: 500_000, cssGzip: 50_000, topologyDataGzip: 16_000, spriteGzip: 60_000 };

/** Strings no entry JS file may contain: the diagram library belongs in its lazy chunk only. */
export const FORBIDDEN_IN_ENTRY = ["react-flow__", "@xyflow"];

const isPlanned = (f) => f.name.startsWith("assets/") && f.name.endsWith(".json");
const isSprite = (f) => /^assets\/azure[^/]*\.svg$/.test(f.name);

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;

/**
 * The JS files a page load fetches at once, from the built index.html: its
 * module scripts and modulepreload links, as paths relative to web/dist
 * ("assets/index-abc.js").
 */
export function entryFiles(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/g)) out.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"[^>]*>/g)) out.push(m[1]);
  return out.map((p) => p.replace(/^\.?\//, ""));
}

/**
 * files: [{ name, bytes, gzip, entry?, gallery?, inlineFont?, forbidden? }]
 * with names relative to web/dist ("assets/index-abc.js"); `entry` marks the
 * JS a page load fetches at once (entryFiles); `gallery` is true when the
 * file mentions __gallery; `inlineFont` when a stylesheet carries a font as
 * a data: URI; `forbidden` the FORBIDDEN_IN_ENTRY strings the file contains
 * (a FAIL only for an entry file). assets/*.json are planned diagrams and
 * assets/azure*.svg the icon sprite, each checked against its own limit.
 * Returns { ok, lines }: a table of every JS and CSS file (lazy chunks
 * marked), the totals against their limits, and a "FAIL ..." line for each
 * problem.
 */
export function judgeBundle(files, limits = LIMITS) {
  const lines = [];
  const fails = [];
  const js = files.filter((f) => f.name.endsWith(".js"));
  const css = files.filter((f) => f.name.endsWith(".css"));
  const entry = js.filter((f) => f.entry);
  const lazy = (f) => f.name.startsWith("assets/") && f.name.endsWith(".js") && !f.entry;
  const width = Math.max(10, ...files.map((f) => f.name.length));
  lines.push(`${"file".padEnd(width)}  ${"raw".padStart(10)}  ${"gzip".padStart(10)}`);
  for (const f of [...js, ...css]) lines.push(`${f.name.padEnd(width)}  ${kb(f.bytes).padStart(10)}  ${kb(f.gzip).padStart(10)}${lazy(f) ? "  lazy" : ""}`);

  for (const [label, group, limit] of [
    ["Entry JS", entry, limits.entryJsGzip],
    ["JS total", js, limits.jsGzip],
    ["CSS total", css, limits.cssGzip],
  ]) {
    const total = group.reduce((s, f) => s + f.gzip, 0);
    lines.push(`${label} ${kb(total)} gzip (limit ${kb(limit)})`);
    if (total > limit) fails.push(`FAIL ${label === "Entry JS" ? "entry JS" : label.replace(" total", "")} is ${kb(total)} gzip, over the ${kb(limit)} budget: ${group.map((f) => f.name).join(", ")}`);
  }
  const planned = files.filter(isPlanned);
  if (planned.length) {
    const big = planned.reduce((a, b) => (b.gzip > a.gzip ? b : a));
    lines.push(`Planned diagrams ${planned.length} file${planned.length === 1 ? "" : "s"}, largest ${kb(big.gzip)} gzip (${big.name}) (limit ${kb(limits.topologyDataGzip)} each)`);
    for (const f of planned) if (f.gzip > limits.topologyDataGzip) fails.push(`FAIL planned diagram ${f.name} is ${kb(f.gzip)} gzip, over the ${kb(limits.topologyDataGzip)} budget`);
  }
  for (const f of files.filter(isSprite)) {
    lines.push(`Icon sprite ${kb(f.gzip)} gzip (limit ${kb(limits.spriteGzip)}): ${f.name}`);
    if (f.gzip > limits.spriteGzip) fails.push(`FAIL the icon sprite ${f.name} is ${kb(f.gzip)} gzip, over the ${kb(limits.spriteGzip)} budget`);
  }
  for (const f of entry) for (const s of f.forbidden ?? []) fails.push(`FAIL entry file ${f.name} mentions ${s}: the diagram belongs in its lazy chunk, never the entry`);
  for (const f of files.filter((f) => f.name.endsWith(".map"))) fails.push(`FAIL source map in the build: ${f.name}`);
  for (const f of files.filter((f) => f.gallery)) fails.push(`FAIL the dev-only __gallery is in the build: ${f.name}`);
  for (const f of files.filter((f) => f.inlineFont)) fails.push(`FAIL a font is inlined as a data: URI (the CSP's font-src 'self' blocks it): ${f.name}`);
  return { ok: fails.length === 0, lines: [...lines, ...fails] };
}
