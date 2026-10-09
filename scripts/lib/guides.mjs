// scripts/lib/guides.mjs
//
// Plain English: reads the lab guides' diagrams (the contract is in
// shared/guides.ts): shared/guides/index.json and the SVG files it lists,
// into the object labs-build writes as shared/guides.generated.json for the
// Worker to bundle. No index.json yet means no diagrams (every guide says so).
//
// Stops the build (a "problem"): an index.json that is not valid JSON or not
// the contract's shape, a file name outside the contract, an SVG over the
// size cap, or one with script, event handlers, foreignObject or links to
// anything outside the file (the PDF embeds each one as an image, which
// would not run or fetch them anyway; refusing them keeps the files honest).
// Only noted (a "warning"): a listed file that is missing (the guide shows
// "diagram unavailable") and an index entry for a lab not in the catalogue.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GUIDE_KINDS = ["architecture", "concept"];
export const GUIDE_FILE_RE = /^(architecture|[1-9]\d?)\.svg$/;
export const GUIDE_SVG_MAX = 512 * 1024;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why an SVG's text is refused, or null when it is fine. */
export function svgProblem(text) {
  if (Buffer.byteLength(text, "utf8") > GUIDE_SVG_MAX) return `is over ${GUIDE_SVG_MAX / 1024} kB`;
  if (!/<svg[\s>]/i.test(text)) return "is not an SVG (no <svg> element)";
  if (/<script[\s>/]/i.test(text)) return "has a <script>";
  if (/<foreignObject[\s>/]/i.test(text)) return "has a <foreignObject>";
  if (/\son[a-z]+\s*=/i.test(text)) return "has an event handler attribute (on...=)";
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#)/i.test(text)) return "links to something outside the file (only #fragment links are allowed)";
  if (/url\(\s*["']?\s*(?!#)/i.test(text)) return "uses url() for something outside the file (only url(#id) is allowed)";
  if (/@import/i.test(text)) return "has a CSS @import";
  return null;
}

/**
 * Read `guidesDir` (the repo's shared/guides). `labIds` are the catalogue's ids.
 * Returns { data: { schema: 1, labs }, problems: string[], warnings: string[] }.
 */
export function buildGuideDiagrams(guidesDir, labIds) {
  const problems = [];
  const warnings = [];
  const labs = {};
  const indexPath = join(guidesDir, "index.json");
  if (!existsSync(indexPath)) return { data: { schema: 1, labs }, problems, warnings };
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (e) {
    problems.push(`shared/guides/index.json is not valid JSON: ${e.message.split("\n")[0]}`);
    return { data: { schema: 1, labs }, problems, warnings };
  }
  if (!isObj(index)) {
    problems.push("shared/guides/index.json must be an object: lab id -> [{ file, title, kind }]");
    return { data: { schema: 1, labs }, problems, warnings };
  }
  const known = new Set(labIds);
  for (const [id, entries] of Object.entries(index)) {
    const at = (m) => problems.push(`shared/guides/index.json ${id}: ${m}`);
    if (!Array.isArray(entries)) {
      at("must be a list of { file, title, kind }");
      continue;
    }
    if (!known.has(id)) {
      warnings.push(`shared/guides/index.json lists ${id}, which is not a lab in the catalogue; skipped`);
      continue;
    }
    const out = [];
    const seen = new Set();
    entries.forEach((e, i) => {
      if (!isObj(e) || Object.keys(e).some((k) => !["file", "title", "kind"].includes(k))) return at(`entry ${i + 1} must be exactly { file, title, kind }`);
      if (typeof e.file !== "string" || !GUIDE_FILE_RE.test(e.file)) return at(`entry ${i + 1}: file must be architecture.svg or <n>.svg`);
      if (seen.has(e.file)) return at(`entry ${i + 1}: ${e.file} is listed twice`);
      seen.add(e.file);
      if (typeof e.title !== "string" || !e.title.trim() || e.title.length > 120) return at(`entry ${i + 1}: title must be 1-120 characters`);
      if (!GUIDE_KINDS.includes(e.kind)) return at(`entry ${i + 1}: kind must be architecture or concept`);
      const path = join(guidesDir, id, e.file);
      let svg = null;
      if (!existsSync(path)) warnings.push(`shared/guides/${id}/${e.file} is listed but missing: the guide shows "diagram unavailable"`);
      else {
        const text = readFileSync(path, "utf8");
        const why = svgProblem(text);
        if (why) return at(`${e.file} ${why}`);
        svg = text;
      }
      out.push({ file: e.file, title: e.title.trim(), kind: e.kind, svg });
    });
    if (out.length) labs[id] = out;
  }
  return { data: { schema: 1, labs }, problems, warnings };
}
