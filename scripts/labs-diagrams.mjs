// scripts/labs-diagrams.mjs   (npm run labs-diagrams [-- --check | --render])
//
// Plain English: the diagrams that replace the hand-drawn ```text sketches
// in the lab readmes, written to shared/guides/ and committed:
//
//   shared/guides/<id>/architecture.svg  every lab with a planned diagram
//       (shared/topology/planned/<id>.json): the interactive diagram's own
//       stacking, packing (the fixed 9:5 shape) and line routing, drawn as
//       one self-contained light SVG with the Azure icons it uses inside it
//       (web/src/views/labs/topology/static/architectureSvg.ts, run through
//       Vite's module runner). Pure Node, byte-stable on every OS.
//   shared/guides/<id>/<n>.svg  a concept diagram (a request path, a
//       sequence, a hierarchy) from the Mermaid source labs/_diagrams/<id>/
//       <n>.mmd, drawn with the pinned Mermaid in a hidden Edge or Chrome
//       (scripts/lib/mermaid.mjs). Sources live outside the lab folders, so
//       adding one never needs a lab version bump. A source starts with
//       `%% title: ...` and `%% alt: ...` lines (both required) and may say
//       `%% sketch: <n>` (which sketch it replaces; 0, the first, if not).
//   shared/guides/index.json  lab id -> its diagrams in readme order,
//       exactly { file, title, kind } (the lab guides' contract,
//       shared/guides.ts, which the "Download PDF" guide reads).
//   shared/guides/placement.json  the same list as { file, sketch, alt,
//       width, height } (GuidePlacement in shared/labs.ts): labs-build puts
//       each diagram in the catalogue in place of the ```text block numbered
//       `sketch` (scripts/lib/labs.mjs applyDiagrams); the readmes themselves
//       never change. A block meant to stay as text (command output) uses
//       another fence (```console).
//
// Rules, checked every run: every ```text sketch of every readme has at
// least one diagram; every SVG is at most 150 kB; no SVG or source holds
// anything that looks like real data (an address outside the private and
// documentation ranges, a GUID, an email address, a key or a password).
//
// Default: writes the architecture SVGs and the index, draws each concept
// SVG whose source changed (its stamp, the hash of source + Mermaid version +
// settings, differs) and removes files nothing lists. Drawing needs Edge or
// Chrome (or SHOTS_BROWSER=path); without one a stale concept diagram is a
// failure, never a skip. --render draws every concept SVG again.
// --check writes nothing and needs no browser: it exits 1 when any file is
// missing, stale or extra, or a rule fails. CI's labs job runs it.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { labFolders, parseLabYaml, readmeSketches } from "./lib/labs.mjs";
import { finishSvg, sourceMeta, sourceStamp, stampOf } from "./lib/mermaid.mjs";
import { svgProblem as guideSvgProblem } from "./lib/guides.mjs";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const PATHS = {
  labs: at("../labs/"),
  sources: at("../labs/_diagrams/"),
  planned: at("../shared/topology/planned/"),
  guides: at("../shared/guides/"),
  sprite: at("../web/src/views/labs/topology/icons/azure.svg"),
  renderer: at("../web/src/views/labs/topology/static/architectureSvg.ts"),
  shared: at("../shared/"),
};

/** The largest an SVG may be. */
export const MAX_SVG_BYTES = 150_000;

/** The architecture renderer, from the TypeScript (Vite's module runner, with the app's @shared alias). */
export async function loadRenderer(paths = PATHS) {
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport(paths.renderer, { configFile: false, logLevel: "error", resolve: { alias: { "@shared": paths.shared.replace(/[\\/]$/, "") } } });
  return module;
}

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The words an SVG shows (text, title, desc), without its markup, styles or shapes. */
export function visibleText(svg) {
  return decode(
    svg
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<style\b[\s\S]*?<\/style>/g, " ")
      .replace(/<defs\b[\s\S]*?<\/defs>/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Addresses a diagram may show: private, shared, link-local, loopback and documentation ranges, masks. */
export const ALLOWED_NETS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "255.0.0.0/8",
  // Azure's platform DNS and health-probe address, the same in every subscription.
  "168.63.129.16/32",
];
const ipNum = (s) => s.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const ipOk = (ip) =>
  ALLOWED_NETS.some((net) => {
    const [base, bits] = net.split("/");
    const unit = 2 ** (32 - Number(bits));
    return Math.floor(ipNum(ip) / unit) === Math.floor(ipNum(base) / unit);
  });

/** Why `text` (an SVG's visible words, or a source) might hold real data: [] when it is clean. */
export function privacyProblems(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
    if (m.slice(1, 5).some((x) => Number(x) > 255)) continue;
    if (!ipOk(m[0])) out.push(`a public IP address (${m[0]}): use the example addresses`);
  }
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) out.push("a GUID (a subscription, tenant or object id?)");
  // Bounded runs, so a long run of letters never makes these regexes crawl.
  if (/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}\.[A-Za-z0-9.-]{2,}/.test(text)) out.push("an email address");
  if (/\/subscriptions\//i.test(text)) out.push("a resource id with a subscription in it");
  if (/AccountKey=|SharedAccessSignature|[?&]sig=|password\s*[:=]\s*\S|secret\s*[:=]\s*\S|BEGIN [A-Z ]*PRIVATE KEY/i.test(text)) out.push("a key, signature, password or secret");
  if (/[A-Za-z0-9+/]{40,}={0,2}/.test(text)) out.push("a long encoded string (a key?)");
  return out;
}

/** The size an SVG declares on its root: { width, height }. */
export function svgSize(svg) {
  const open = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  return { width: Number(/\bwidth="([\d.]+)"/.exec(open)?.[1] ?? 0), height: Number(/\bheight="([\d.]+)"/.exec(open)?.[1] ?? 0) };
}

const lf = (s) => s.replace(/\r\n?/g, "\n");
const read = (p) => (existsSync(p) ? lf(readFileSync(p, "utf8")) : null);

/**
 * Plans every lab's diagrams. Returns { labs, index, files, concepts, problems }:
 * `files` the architecture SVGs to write (relative path → text), `concepts`
 * every Mermaid source ({ id, n, rel, source, stamp, meta, committed, stale }),
 * `index` the GuideIndex, `problems` [{ lab, message }].
 */
export async function planDiagrams({ paths = PATHS, renderer = null } = {}) {
  const problems = [];
  const fail = (lab, message) => problems.push({ lab, message });
  const r = renderer ?? (await loadRenderer(paths));
  const sprite = readFileSync(paths.sprite, "utf8");
  const labs = labFolders(paths.labs);
  const files = new Map();
  const concepts = [];
  const index = {};
  for (const id of labs) {
    const md = read(join(paths.labs, id, "readme.md")) ?? "";
    const sketches = readmeSketches(md);
    const title = String(parseLabYaml(read(join(paths.labs, id, "lab.yaml")) ?? "").raw?.title ?? id);
    const entries = [];
    const plannedFile = join(paths.planned, `${id}.json`);
    if (existsSync(plannedFile)) {
      const got = r.architectureSvg(JSON.parse(readFileSync(plannedFile, "utf8")), { sprite, title: `${title}: architecture` });
      const rel = `${id}/architecture.svg`;
      files.set(rel, got.svg);
      entries.push({ file: rel, title: `${title}: architecture`, kind: "architecture", alt: `Architecture diagram. ${got.description}`, sketch: 0, width: got.width, height: got.height });
    }
    const dir = join(paths.sources, id);
    const names = existsSync(dir) ? readdirSync(dir).sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || (a < b ? -1 : 1)) : [];
    for (const f of names) {
      if (!/^[1-9]\d*\.mmd$/.test(f)) {
        fail(id, `labs/_diagrams/${id}/${f}: sources are named 1.mmd, 2.mmd, ...`);
        continue;
      }
      const n = parseInt(f, 10);
      const source = lf(readFileSync(join(dir, f), "utf8"));
      const meta = sourceMeta(source);
      if (!meta.title) fail(id, `labs/_diagrams/${id}/${f} needs a "%% title: ..." line`);
      if (!meta.alt) fail(id, `labs/_diagrams/${id}/${f} needs a "%% alt: ..." line (what a screen reader says)`);
      const sketch = Number(/^%%\s*sketch:\s*(\d+)\s*$/m.exec(source)?.[1] ?? 0);
      for (const p of privacyProblems(source)) fail(id, `labs/_diagrams/${id}/${f}: ${p}`);
      const rel = `${id}/${n}.svg`;
      const committed = read(join(paths.guides, rel));
      const stamp = sourceStamp(source);
      const stale = committed === null || stampOf(committed) !== stamp;
      concepts.push({ id, n, rel, source, stamp, meta, committed, stale, sketch });
      const size = committed ? svgSize(committed) : { width: 0, height: 0 };
      entries.push({ file: rel, title: meta.title ?? "", kind: "concept", alt: meta.alt ?? "", sketch, width: size.width, height: size.height });
    }
    entries.sort((a, b) => a.sketch - b.sketch || (a.kind === b.kind ? 0 : a.kind === "architecture" ? -1 : 1));
    // Every sketch handled, and no diagram for a sketch the readme does not have.
    for (const s of sketches) if (!entries.some((e) => e.sketch === s.index)) fail(id, `readme sketch ${s.index + 1} (a \`\`\`text block${s.heading ? ` under "${s.heading}"` : ""}) has no diagram: add labs/_diagrams/${id}/<n>.mmd with "%% sketch: ${s.index}", or use another fence (\`\`\`console) for text that should stay`);
    for (const e of entries) if (e.sketch >= sketches.length) fail(id, `${e.file} is for sketch ${e.sketch + 1}, but the readme has ${sketches.length} \`\`\`text sketch(es)`);
    if (entries.length) index[id] = entries.filter((e) => e.sketch < sketches.length);
  }
  if (existsSync(paths.sources)) for (const d of readdirSync(paths.sources)) if (statSync(join(paths.sources, d)).isDirectory() && !labs.includes(d)) fail(d, `labs/_diagrams/${d} has no lab folder`);
  return { labs, index, files, concepts, problems };
}

/** The rules every SVG must keep: its size and its words. */
export function svgProblems(rel, svg) {
  const out = [];
  const bytes = Buffer.byteLength(svg);
  if (bytes > MAX_SVG_BYTES) out.push(`${rel} is ${(bytes / 1000).toFixed(1)} kB (at most ${MAX_SVG_BYTES / 1000} kB)`);
  for (const p of privacyProblems(visibleText(svg))) out.push(`${rel}: ${p}`);
  if (/<script\b|\bon[a-z]+="|<foreignObject\b|(?:href|src)="(?:https?:|data:|\/\/)/i.test(svg)) out.push(`${rel}: an SVG must be shapes and text only (no scripts, event handlers, foreignObject or outside links)`);
  // And whatever labs-build would refuse for the lab guides (scripts/lib/guides.mjs).
  const guide = guideSvgProblem(svg);
  if (guide) out.push(`${rel} ${guide} (labs-build refuses it)`);
  return out;
}

const sortedText = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])), null, 1) + "\n";
const base = (rel) => rel.slice(rel.indexOf("/") + 1);

/**
 * The two generated lists, from the plan's entries ({ file: "<id>/<name>", title, kind, alt, sketch, width, height }):
 * index.json, the lab guides' contract (shared/guides.ts: exactly { file, title, kind }, file a name in the lab's
 * folder), and placement.json, where each one goes in the readme ({ file, sketch, alt, width, height }, same order).
 */
export function guideTexts(index) {
  const map = (f) => Object.fromEntries(Object.entries(index).map(([id, list]) => [id, list.map(f)]));
  return {
    "index.json": sortedText(map((e) => ({ file: base(e.file), title: e.title, kind: e.kind }))),
    "placement.json": sortedText(map((e) => ({ file: base(e.file), sketch: e.sketch, alt: e.alt, width: e.width, height: e.height }))),
  };
}
const LISTS = ["index.json", "placement.json"];

/** Every file under shared/guides, relative ("az104-16-lb-appgw/architecture.svg"). */
function listGuides(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const d of readdirSync(dir).sort()) {
    const p = join(dir, d);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) out.push(`${d}/${f}`);
    else out.push(d);
  }
  return out;
}

/**
 * Writes (or with `check`, compares) shared/guides. `draw(items)` draws Mermaid sources ([{ id, source }] →
 * [{ id, svg }], Mermaid's own SVG); null: no browser. Returns { problems, written, drawn }.
 */
export async function runLabsDiagrams({ paths = PATHS, check = false, renderAll = false, draw = null, renderer = null, log = console.log } = {}) {
  const plan = await planDiagrams({ paths, renderer });
  const problems = [...plan.problems];
  const fail = (lab, message) => problems.push({ lab, message });
  const written = [];
  let drawn = 0;

  // Concept SVGs: drawn again only when their source changed (or --render).
  const todo = plan.concepts.filter((c) => c.stale || renderAll);
  if (todo.length && check) for (const c of todo) fail(c.id, `shared/guides/${c.rel} is ${c.committed === null ? "missing" : "stale"}: labs/_diagrams/${c.id}/${c.n}.mmd changed since it was drawn (run npm run labs-diagrams, which needs Edge or Chrome, and commit shared/guides)`);
  if (todo.length && !check) {
    if (!draw) for (const c of todo) fail(c.id, `shared/guides/${c.rel} needs drawing, and no Edge or Chrome was found (set SHOTS_BROWSER=path)`);
    else {
      const got = await draw(todo.map((c) => ({ id: `${c.id}-${c.n}`, source: c.source })));
      for (const [i, c] of todo.entries()) {
        c.committed = finishSvg(got[i].svg, { title: c.meta.title ?? "", alt: c.meta.alt ?? "", stamp: c.stamp });
        const size = svgSize(c.committed);
        const e = plan.index[c.id]?.find((x) => x.file === c.rel);
        if (e) Object.assign(e, size);
        drawn++;
      }
    }
  }

  const want = new Map(plan.files);
  for (const c of plan.concepts) if (c.committed !== null) want.set(c.rel, c.committed);
  for (const [rel, svg] of want) for (const p of svgProblems(rel, svg)) fail(rel.split("/")[0], p);
  const texts = guideTexts(plan.index);
  const have = listGuides(paths.guides);

  if (check) {
    for (const [rel, svg] of plan.files) {
      const now = read(join(paths.guides, rel));
      if (now === null) fail(rel.split("/")[0], `shared/guides/${rel} is missing (run npm run labs-diagrams and commit shared/guides)`);
      else if (now !== svg) fail(rel.split("/")[0], `shared/guides/${rel} is stale: the planned diagram or the drawing changed (run npm run labs-diagrams and commit shared/guides)`);
    }
    for (const name of LISTS) {
      const now = read(join(paths.guides, name));
      if (now === null) fail(null, `shared/guides/${name} is missing (run npm run labs-diagrams)`);
      else if (now !== texts[name]) fail(null, `shared/guides/${name} is stale (run npm run labs-diagrams and commit shared/guides)`);
    }
    for (const rel of have) if (!LISTS.includes(rel) && !want.has(rel)) fail(rel.split("/")[0], `shared/guides/${rel} is not any lab's diagram: delete it (npm run labs-diagrams removes it)`);
    return { problems, written, drawn };
  }

  if (problems.length) return { problems, written, drawn };
  for (const [rel, svg] of want) {
    const p = join(paths.guides, rel);
    if (read(p) === svg) continue;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, svg);
    written.push(rel);
  }
  for (const name of LISTS) {
    if (read(join(paths.guides, name)) === texts[name]) continue;
    mkdirSync(paths.guides, { recursive: true });
    writeFileSync(join(paths.guides, name), texts[name]);
    written.push(name);
  }
  for (const rel of have) {
    if (LISTS.includes(rel) || want.has(rel)) continue;
    rmSync(join(paths.guides, rel), { force: true });
    log(`labs-diagrams: removed shared/guides/${rel}`);
  }
  for (const d of existsSync(paths.guides) ? readdirSync(paths.guides) : []) {
    const p = join(paths.guides, d);
    if (statSync(p).isDirectory() && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
  return { problems, written, drawn };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const renderAll = args.includes("--render");
  let browser = null;
  let draw = null;
  if (!check) {
    const { openBrowser } = await import("./lib/headless.mjs");
    const { renderAll: renderMermaid } = await import("./lib/mermaid.mjs");
    // The browser starts only when something needs drawing.
    draw = async (items) => {
      browser ??= await openBrowser();
      if (!browser) throw new Error("No Edge or Chrome found to draw the Mermaid diagrams (set SHOTS_BROWSER=path).");
      return await renderMermaid(browser, items);
    };
  }
  try {
    const { problems, written, drawn } = await runLabsDiagrams({ check, renderAll, draw });
    for (const p of problems) console.error(`  ${p.lab ? `${p.lab}: ` : ""}${p.message}`);
    if (problems.length) {
      console.error(`labs-diagrams: ${problems.length} problem(s)${check ? "" : "; nothing written"}`);
      process.exitCode = 1;
    } else if (check) console.log("labs-diagrams: every readme diagram is fresh");
    else console.log(`labs-diagrams: ${written.length} file(s) written, ${drawn} concept diagram(s) drawn`);
  } finally {
    await browser?.close();
  }
}
