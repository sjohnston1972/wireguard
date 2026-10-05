// labs-readmes.test.mjs
//
// Plain English: every lab readme reads the same way in the lab modal, which
// already shows the lab's title above it: no "# Title" of its own, then a
// short introduction (what it is, what you practise, the exam outline it
// covers) before "## What it deploys". And two readmes that must say what
// is really true: where lab 7's storage key lives, and that lab 5's
// geo-redundant account needs a region that has a pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { labFolders, parseLabYaml, parseReadme } from "../lib/labs.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const readme = (id) => readFileSync(join(LABS, id, "readme.md"), "utf8").replace(/\r\n/g, "\n");

for (const id of labFolders(LABS)) {
  test(`${id}: no title of its own, and an introduction before What it deploys`, () => {
    const md = readme(id);
    assert.doesNotMatch(md, /^# /m, "the modal shows the title; the readme does not repeat it");
    const { blocks, problems } = parseReadme(md, "explore", id);
    assert.deepEqual(problems, []);
    const first = blocks.findIndex((b) => b.t === "h");
    assert.ok(first >= 1, "at least one paragraph comes first");
    assert.ok(blocks.slice(0, first).every((b) => b.t === "p"), "only paragraphs before the first heading");
    assert.equal(blocks[first].text, "What it deploys");
    // The introduction says which part of its exam's outline the lab covers (AZ-104 or AZ-305).
    const { exam } = parseLabYaml(readFileSync(join(LABS, id, "lab.yaml"), "utf8")).raw;
    assert.match(md.split("## What it deploys")[0], new RegExp(`${exam} outline`));
  });
}

test("lab 7 says everywhere its storage account key lives", () => {
  const md = readme("az104-07-files");
  assert.doesNotMatch(md, /key sits only in/i);
  for (const where of [/root-only credentials file/i, /custom data/i, /Terraform state/i]) assert.match(md, where);
});

test("lab 5 says the geo-redundant account needs a region with a pair", () => {
  assert.match(readme("az104-05-storage"), /paired region/i);
  assert.match(readme("az104-05-storage"), /no pair/i);
});
