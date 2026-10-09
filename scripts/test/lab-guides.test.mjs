// lab-guides.test.mjs: the lab guides' diagrams (scripts/lib/guides.mjs, contract in shared/guides.ts),
// which labs-build writes to shared/guides.generated.json for the Worker's "Download PDF".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuideDiagrams, svgProblem, GUIDE_SVG_MAX } from "../lib/guides.mjs";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><marker id="m"/></defs><path d="M0 0" marker-end="url(#m)"/><use href="#m"/></svg>';
const LABS = ["az104-13-vnets", "az104-17-netwatcher-fix"];

/** A throwaway shared/guides folder with `index` (an object, or raw text) and `files` (path -> text). */
function withDir(index, files, fn) {
  const d = mkdtempSync(join(tmpdir(), "guides-"));
  try {
    if (index !== undefined) writeFileSync(join(d, "index.json"), typeof index === "string" ? index : JSON.stringify(index));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(d, path.split("/")[0]), { recursive: true });
      writeFileSync(join(d, path), text);
    }
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("no index.json yet: no diagrams, no problems", () => {
  withDir(undefined, {}, (d) => assert.deepEqual(buildGuideDiagrams(d, LABS), { data: { schema: 1, labs: {} }, problems: [], warnings: [] }));
});

test("reads each lab's diagrams in index order, with their SVG text", () => {
  const index = { "az104-13-vnets": [{ file: "architecture.svg", title: "Architecture", kind: "architecture" }, { file: "1.svg", title: " NSG order ", kind: "concept" }] };
  withDir(index, { "az104-13-vnets/architecture.svg": SVG, "az104-13-vnets/1.svg": SVG }, (d) => {
    const r = buildGuideDiagrams(d, LABS);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.data.labs["az104-13-vnets"], [
      { file: "architecture.svg", title: "Architecture", kind: "architecture", svg: SVG },
      { file: "1.svg", title: "NSG order", kind: "concept", svg: SVG },
    ]);
  });
});

test("a listed file that is missing builds as unavailable (svg null) with a note; an unknown lab is skipped with a note", () => {
  withDir({ "az104-13-vnets": [{ file: "architecture.svg", title: "Architecture", kind: "architecture" }], "az104-99-gone": [] }, {}, (d) => {
    const r = buildGuideDiagrams(d, LABS);
    assert.deepEqual(r.problems, []);
    assert.equal(r.data.labs["az104-13-vnets"][0].svg, null);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings.join("\n"), /missing/);
    assert.match(r.warnings.join("\n"), /az104-99-gone/);
  });
});

test("refuses a broken index: bad JSON, wrong shapes, bad names, kinds, titles and duplicates", () => {
  const bad = [
    "{ nope",
    "[]",
    { "az104-13-vnets": "architecture.svg" },
    { "az104-13-vnets": [{ file: "arch.svg", title: "A", kind: "architecture" }] },
    { "az104-13-vnets": [{ file: "../x.svg", title: "A", kind: "architecture" }] },
    { "az104-13-vnets": [{ file: "1.svg", title: "A", kind: "photo" }] },
    { "az104-13-vnets": [{ file: "1.svg", title: "", kind: "concept" }] },
    { "az104-13-vnets": [{ file: "1.svg", title: "A", kind: "concept", extra: 1 }] },
    { "az104-13-vnets": [{ file: "1.svg", title: "A", kind: "concept" }, { file: "1.svg", title: "B", kind: "concept" }] },
  ];
  for (const index of bad) withDir(index, {}, (d) => assert.ok(buildGuideDiagrams(d, LABS).problems.length > 0, JSON.stringify(index)));
});

test("refuses an SVG with script, handlers, foreignObject, outside links or over the size cap", () => {
  assert.equal(svgProblem(SVG), null);
  for (const text of [
    "<html></html>",
    "<svg><script>alert(1)</script></svg>",
    '<svg><rect onload="x()"/></svg>',
    "<svg><foreignObject></foreignObject></svg>",
    '<svg><image href="https://example.com/x.png"/></svg>',
    '<svg><use xlink:href="other.svg#a"/></svg>',
    '<svg><rect style="fill:url(https://x/y)"/></svg>',
    "<svg><style>@import 'x.css';</style></svg>",
    `<svg>${"x".repeat(GUIDE_SVG_MAX)}</svg>`,
  ]) assert.ok(svgProblem(text), text.slice(0, 60));
  withDir({ "az104-13-vnets": [{ file: "1.svg", title: "A", kind: "concept" }] }, { "az104-13-vnets/1.svg": "<svg><script>x</script></svg>" }, (d) =>
    assert.match(buildGuideDiagrams(d, LABS).problems.join("\n"), /<script>/),
  );
});

test("the script's constants match shared/guides.ts", async () => {
  const { readFileSync } = await import("node:fs");
  const ts = readFileSync(new URL("../../shared/guides.ts", import.meta.url), "utf8");
  assert.match(ts, /GUIDE_FILE_RE = \/\^\(architecture\|\[1-9\]\\d\?\)\\\.svg\$\//);
  assert.match(ts, /GUIDE_SVG_MAX = 512 \* 1024;/);
  assert.match(ts, /GUIDE_DIAGRAM_KINDS: readonly GuideDiagramKind\[\] = \["architecture", "concept"\]/);
});
