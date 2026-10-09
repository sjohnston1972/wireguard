// labs-diagrams.test.mjs
//
// Plain English: the readme diagrams (scripts/labs-diagrams.mjs, shared/
// guides). Per lab: every hand-drawn ```text sketch of its readme was
// handled (replaced by the generated architecture diagram, or converted to a
// Mermaid concept diagram) and none is left in the catalogue; every SVG it
// lists exists, is small, holds no real data and (a concept diagram) was
// drawn from its current source. Then the pieces: finding sketches,
// swapping them for diagram blocks, the privacy and size rules, the Mermaid
// SVG clean-up, and the generator's write / check / stale / extra-file rules
// on a throw-away tree with a stand-in renderer (no browser, no Vite).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDiagrams, buildCatalogue, labFolders, parseReadme, readmeSketches } from "../lib/labs.mjs";
import { MAX_SVG_BYTES, privacyProblems, runLabsDiagrams, svgProblems, visibleText } from "../labs-diagrams.mjs";
import { finishSvg, sketchyOnce, sourceMeta, sourceStamp, stampOf } from "../lib/mermaid.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const GUIDES = fileURLToPath(new URL("../../shared/guides/", import.meta.url));
const SOURCES = join(LABS, "_diagrams");
const index = JSON.parse(readFileSync(join(GUIDES, "index.json"), "utf8"));
const { catalogue, problems: buildProblems } = buildCatalogue(LABS);
const lf = (s) => s.replace(/\r\n?/g, "\n");

test("the catalogue builds with the diagrams in place", () => {
  assert.deepEqual(buildProblems, []);
});

for (const id of labFolders(LABS)) {
  test(`${id}: every readme sketch is a diagram now, each file present, small, clean and fresh`, () => {
    const md = lf(readFileSync(join(LABS, id, "readme.md"), "utf8"));
    const sketches = readmeSketches(md);
    const entries = index[id] ?? [];
    for (const s of sketches) assert.ok(entries.some((e) => e.sketch === s.index), `sketch ${s.index + 1} under "${s.heading}" has no diagram`);
    for (const e of entries) {
      assert.ok(e.sketch < sketches.length, `${e.file} is for a sketch the readme does not have`);
      assert.ok(e.title && e.alt && e.width > 0 && e.height > 0, `${e.file} has a title, alt text and a size`);
      assert.match(e.file, new RegExp(`^${id}/(architecture|[1-9]\\d*)\\.svg$`));
      const svg = lf(readFileSync(join(GUIDES, e.file), "utf8"));
      assert.deepEqual(svgProblems(e.file, svg), []);
      if (e.kind === "concept") {
        const source = lf(readFileSync(join(SOURCES, id, e.file.slice(id.length + 1).replace(/\.svg$/, ".mmd")), "utf8"));
        assert.equal(stampOf(svg), sourceStamp(source), `${e.file} was drawn from its current source`);
        assert.equal(e.title, sourceMeta(source).title);
      }
    }
    // A lab with a planned diagram always has its architecture diagram first.
    if (existsSync(fileURLToPath(new URL(`../../shared/topology/planned/${id}.json`, import.meta.url)))) assert.equal(entries[0]?.kind, "architecture");
    // In the catalogue: no ```text block left, and the diagrams where the sketches were.
    const blocks = catalogue.readmes[id] ?? [];
    const flat = (list) => list.flatMap((b) => (b.t === "details" ? [b, ...flat(b.blocks)] : [b]));
    assert.equal(flat(blocks).filter((b) => b.t === "code" && b.lang === "text").length, 0, "no hand-drawn sketch is left");
    assert.deepEqual(
      flat(blocks).filter((b) => b.t === "diagram").map((b) => b.file),
      entries.map((e) => e.file),
    );
  });
}

test("readmeSketches: only ```text fences, in order, inside <details> too, with the heading above", () => {
  const md = "Intro\n\n## What it deploys\n\n```text\na --> b\n```\n\n```console\n$ ls\n```\n\n## Symptom\n\n<details>\n<summary>What was broken</summary>\n\n```text\nx\n```\n\n</details>\n";
  assert.deepEqual(readmeSketches(md), [
    { index: 0, heading: "What it deploys" },
    { index: 1, heading: "Symptom" },
  ]);
  // A fence inside another fence's body is text, not a sketch.
  assert.deepEqual(readmeSketches("```hcl\n```text\n```\n"), []);
});

test("applyDiagrams: each sketch becomes its diagrams in order; other code and unlisted sketches stay", () => {
  const md = "## A\n\n```text\none\n```\n\n```console\nkeep\n```\n\n<details>\n<summary>S</summary>\n\n```text\ntwo\n```\n\n</details>\n\n```text\nthree\n```\n";
  const { blocks } = parseReadme(md, "explore", null);
  const e = (file, sketch, kind = "concept") => ({ file, title: file, kind, alt: `alt ${file}`, sketch, width: 10, height: 5 });
  const out = applyDiagrams(blocks, [e("x/architecture.svg", 0, "architecture"), e("x/1.svg", 0), e("x/2.svg", 1)]);
  assert.deepEqual(
    out.map((b) => (b.t === "details" ? `details[${b.blocks.map((x) => x.file ?? x.t).join(",")}]` : (b.file ?? `${b.t}:${b.lang ?? ""}`))),
    ["h:", "x/architecture.svg", "x/1.svg", "code:console", "details[x/2.svg]", "code:text"],
  );
  assert.deepEqual(out[1], { t: "diagram", kind: "architecture", file: "x/architecture.svg", title: "x/architecture.svg", alt: "alt x/architecture.svg", width: 10, height: 5 });
  assert.deepEqual(applyDiagrams(blocks, undefined), blocks);
});

test("privacy: example and private addresses pass; public addresses, ids, emails and keys do not", () => {
  assert.deepEqual(privacyProblems("10.71.192.4 172.16.0.1 192.168.1.1 203.0.113.10 198.51.100.7 192.0.2.1 168.63.129.16 0.0.0.0/0 100.64.0.1 255.255.255.0"), []);
  assert.deepEqual(privacyProblems("TCP 8081-8090→8080, VXLAN 800/10800, version 1.2.3"), []);
  assert.match(privacyProblems("from 20.50.1.2").join(), /public IP address \(20\.50\.1\.2\)/);
  assert.match(privacyProblems("sub 0f3c1a2b-1234-4cde-9abc-0123456789ab").join(), /GUID/);
  assert.match(privacyProblems("ask steven@example.org").join(), /email/);
  assert.match(privacyProblems("/subscriptions/x/resourceGroups/y").join(), /subscription/);
  assert.match(privacyProblems("password: hunter2").join(), /password/);
  assert.match(privacyProblems("AccountKey=abc").join(), /key/);
});

test("svgProblems: the size cap and shapes-and-text only", () => {
  assert.deepEqual(svgProblems("a.svg", '<svg><use href="#az-x"/><text>ok</text></svg>'), []);
  assert.match(svgProblems("a.svg", `<svg>${"x".repeat(MAX_SVG_BYTES)}</svg>`).join(), /kB \(at most 150 kB\)/);
  assert.match(svgProblems("a.svg", "<svg><script>x</script></svg>").join(), /shapes and text only/);
  assert.match(svgProblems("a.svg", '<svg><image href="https://example.org/a.png"/></svg>').join(), /shapes and text only/);
  assert.match(svgProblems("a.svg", "<svg><foreignObject/></svg>").join(), /shapes and text only/);
  assert.equal(visibleText("<!-- c --><svg><style>.a{}</style><defs><text>hidden</text></defs><title>T</title><text>a &amp; b</text></svg>"), "T a & b");
});

test("Mermaid clean-up: sketchy paths drawn once, a fixed size, title, desc and the source stamp", () => {
  const twice = "M0 0 C1 0, 2 0, 3 0 M0 0 C1 0, 2 0, 3 0 M3 0 C3 0, 3 0, 3 0 M3 0 C3 1, 3 2, 3 3 M3 0 C3 1, 3 2, 3 3 M3 3 C2 3, 1 3, 0 3 M3 3 C2 3, 1 3, 0 3 M0 3 C0 2, 0 1, 0 0";
  assert.equal(sketchyOnce(twice), "M0 0 C1 0, 2 0, 3 0 M3 0 C3 1, 3 2, 3 3 M3 3 C2 3, 1 3, 0 3 M0 3 C0 2, 0 1, 0 0");
  assert.equal(sketchyOnce("M0 0 L5 5"), "M0 0 L5 5");
  const raw = '<svg id="lab-1" width="100%" style="max-width: 200px;" viewBox="0 0 200.25 100.5" xmlns="http://www.w3.org/2000/svg"><title>old</title><g><path d="M1.23456 2.34567 L3 4"/><text>a</text></g></svg>';
  const stamp = sourceStamp("flowchart LR\n a --> b");
  const out = finishSvg(raw, { title: "T <1>", alt: "A & B", stamp });
  assert.equal(stampOf(out), stamp);
  assert.match(out, /<svg [^>]*width="233" height="133" viewBox="-16 -16 233 133"/);
  assert.match(out, /<title id="lab-1-t">T &lt;1&gt;<\/title><desc id="lab-1-d">A &amp; B<\/desc>/);
  assert.match(out, /d="M1.2 2.3 L3 4"/);
  assert.doesNotMatch(out, /old|max-width/);
  // The stamp ignores line endings, not content.
  assert.equal(sourceStamp("a\r\nb"), sourceStamp("a\nb"));
  assert.notEqual(sourceStamp("a\nb"), sourceStamp("a\nc"));
  assert.deepEqual(sourceMeta("%% title: Hello\n%% alt: World.\nflowchart LR"), { title: "Hello", alt: "World." });
});

/** A throw-away repo tree: two labs, one with a concept source; a stand-in renderer. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), "wg-diagrams-"));
  const paths = {
    labs: join(root, "labs"),
    sources: join(root, "labs", "_diagrams"),
    planned: join(root, "planned"),
    guides: join(root, "guides"),
    sprite: join(root, "sprite.svg"),
  };
  for (const d of [paths.labs, paths.planned, paths.guides, join(paths.sources, "lab-a")]) mkdirSync(d, { recursive: true });
  writeFileSync(paths.sprite, "<svg></svg>");
  for (const id of ["lab-a", "lab-b"]) {
    mkdirSync(join(paths.labs, id));
    writeFileSync(join(paths.labs, id, "lab.yaml"), `title: "Title ${id}"\n`);
    writeFileSync(join(paths.labs, id, "readme.md"), "Intro\n\n## What it deploys\n\n```text\nsketch\n```\n");
    writeFileSync(join(paths.planned, `${id}.json`), JSON.stringify({ labId: id, nodes: [], edges: [] }));
  }
  writeFileSync(join(paths.sources, "lab-a", "1.mmd"), "%% title: Flow\n%% alt: A flows to B.\nflowchart LR\n  a --> b\n");
  const renderer = { architectureSvg: (g, o) => ({ svg: `<svg width="10" height="5"><title>${o.title}</title><text>${g.labId}</text></svg>\n`, width: 10, height: 5, description: `About ${g.labId}.` }) };
  const drawn = [];
  const draw = async (items) => items.map((it) => (drawn.push(it.id), { id: it.id, svg: `<svg id="${it.id}" viewBox="0 0 40 20"><text>drawn</text></svg>` }));
  return { root, paths, renderer, draw, drawn };
}

test("the generator: writes, then --check passes; a changed source or plan, a missing sketch or an extra file fails --check", async () => {
  const t = tree();
  try {
    const quiet = () => {};
    let r = await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, draw: t.draw, log: quiet });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(t.drawn, ["lab-a-1"]);
    const idx = JSON.parse(readFileSync(join(t.paths.guides, "index.json"), "utf8"));
    assert.deepEqual(idx["lab-a"], [
      { file: "lab-a/architecture.svg", title: "Title lab-a: architecture", kind: "architecture", alt: "Architecture diagram. About lab-a.", sketch: 0, width: 10, height: 5 },
      { file: "lab-a/1.svg", title: "Flow", kind: "concept", alt: "A flows to B.", sketch: 0, width: 72, height: 52 },
    ]);
    assert.equal(idx["lab-b"].length, 1);
    r = await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, check: true });
    assert.deepEqual(r.problems, []);

    // A second write draws nothing (the stamps match).
    await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, draw: t.draw, log: quiet });
    assert.deepEqual(t.drawn, ["lab-a-1"]);

    // The source changed: stale until drawn again.
    writeFileSync(join(t.paths.sources, "lab-a", "1.mmd"), "%% title: Flow\n%% alt: A flows to B.\nflowchart LR\n  a --> c\n");
    r = await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, check: true });
    assert.match(r.problems.map((p) => p.message).join(), /lab-a\/1\.svg is stale/);
    // ... and no browser means a failure, never a skip.
    r = await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, draw: null, log: quiet });
    assert.match(r.problems.map((p) => p.message).join(), /no Edge or Chrome/);
    await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, draw: t.draw, log: quiet });

    // The planned diagram changed: the architecture SVG is stale.
    const other = { architectureSvg: (g, o) => ({ ...t.renderer.architectureSvg(g, o), svg: "<svg><text>new</text></svg>\n" }) };
    r = await runLabsDiagrams({ paths: t.paths, renderer: other, check: true });
    assert.match(r.problems.map((p) => p.message).join(), /lab-a\/architecture\.svg is stale/);

    // An extra file is reported, and removed by a write.
    writeFileSync(join(t.paths.guides, "lab-b", "9.svg"), "<svg/>");
    r = await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, check: true });
    assert.match(r.problems.map((p) => p.message).join(), /lab-b\/9\.svg is not any lab's diagram/);
    await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, draw: t.draw, log: quiet });
    assert.equal(existsSync(join(t.paths.guides, "lab-b", "9.svg")), false);

    // A sketch with no diagram (no planned graph, no source) fails; so does a source without alt text.
    rmSync(join(t.paths.planned, "lab-b.json"));
    writeFileSync(join(t.paths.sources, "lab-a", "2.mmd"), "%% title: No alt\nflowchart LR\n  a --> b\n");
    // A folder of sources for no lab is reported; a README beside them is not.
    writeFileSync(join(t.paths.sources, "README.md"), "notes");
    mkdirSync(join(t.paths.sources, "lab-gone"));
    r = await runLabsDiagrams({ paths: t.paths, renderer: t.renderer, check: true });
    const msgs = r.problems.map((p) => `${p.lab}: ${p.message}`).join("\n");
    assert.match(msgs, /lab-b: readme sketch 1 \(a ```text block under "What it deploys"\) has no diagram/);
    assert.match(msgs, /lab-a: labs\/_diagrams\/lab-a\/2\.mmd needs a "%% alt: \.\.\." line/);
    assert.match(msgs, /lab-gone: labs\/_diagrams\/lab-gone has no lab folder/);
    assert.doesNotMatch(msgs, /README/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
