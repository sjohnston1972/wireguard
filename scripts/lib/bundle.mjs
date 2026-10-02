// scripts/lib/bundle.mjs
//
// Plain English: the size check for the built app (plan 5 ruling 8). The app
// is one person's dashboard, so there is no code-splitting work; the budget
// only stops it quietly doubling. Sizes are what travels over the wire
// (gzip), in kB of 1000 bytes, the unit Vite's build output prints.

export const LIMITS = { jsGzip: 320_000, cssGzip: 50_000 };

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;

/**
 * files: [{ name, bytes, gzip, gallery? }] with names relative to web/dist
 * ("assets/index-abc.js"); `gallery` is true when the file mentions __gallery;
 * `inlineFont` when a stylesheet carries a font as a data: URI.
 * Returns { ok, lines }: a table of every JS and CSS file, the two totals
 * against their limits, and a "FAIL ..." line for each problem.
 */
export function judgeBundle(files, limits = LIMITS) {
  const lines = [];
  const fails = [];
  const js = files.filter((f) => f.name.endsWith(".js"));
  const css = files.filter((f) => f.name.endsWith(".css"));
  const width = Math.max(10, ...files.map((f) => f.name.length));
  lines.push(`${"file".padEnd(width)}  ${"raw".padStart(10)}  ${"gzip".padStart(10)}`);
  for (const f of [...js, ...css]) lines.push(`${f.name.padEnd(width)}  ${kb(f.bytes).padStart(10)}  ${kb(f.gzip).padStart(10)}`);

  for (const [label, group, limit] of [["JS", js, limits.jsGzip], ["CSS", css, limits.cssGzip]]) {
    const total = group.reduce((s, f) => s + f.gzip, 0);
    lines.push(`${label} total ${kb(total)} gzip (limit ${kb(limit)})`);
    if (total > limit) fails.push(`FAIL ${label} is ${kb(total)} gzip, over the ${kb(limit)} budget: ${group.map((f) => f.name).join(", ")}`);
  }
  for (const f of files.filter((f) => f.name.endsWith(".map"))) fails.push(`FAIL source map in the build: ${f.name}`);
  for (const f of files.filter((f) => f.gallery)) fails.push(`FAIL the dev-only __gallery is in the build: ${f.name}`);
  for (const f of files.filter((f) => f.inlineFont)) fails.push(`FAIL a font is inlined as a data: URI (the CSP's font-src 'self' blocks it): ${f.name}`);
  return { ok: fails.length === 0, lines: [...lines, ...fails] };
}
