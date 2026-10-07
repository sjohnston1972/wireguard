// workflow-actions.test.mjs
//
// Plain English: every action the GitHub workflows use is pinned by its full
// commit SHA, carries a "# vX.Y.Z" comment naming that release, and is a
// release that runs on Node 24. GitHub retired Node 20 for actions
// (https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/);
// an action still declaring node20 is forced onto Node 24 with a warning on
// every run. The allow-list below is the known-good set: each SHA was checked
// to have `runs.using: node24` in its action.yml. Moving an action means
// checking the new release's action.yml and adding it here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const DIR = new URL("../../.github/workflows/", import.meta.url);

/** action -> { sha, version } of the node24 release the workflows pin. */
const NODE24 = {
  "actions/checkout": { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  "actions/setup-node": { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" },
  "actions/cache": { sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9", version: "v6.1.0" },
  "hashicorp/setup-terraform": { sha: "dfe3c3f87815947d99a8997f908cb6525fc44e9e", version: "v4.0.1" },
};

const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

/** Every `uses:` line in every workflow, with its file. */
function usesLines() {
  const out = [];
  for (const f of files) {
    const text = readFileSync(new URL(f, DIR), "utf8");
    for (const m of text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)) out.push({ file: f, line: m[1].trim() });
  }
  return out;
}

test("the workflows are found and use actions", () => {
  assert.ok(files.includes("ci.yml") && files.includes("lab.yml") && files.includes("wg.yml"), files.join(", "));
  assert.ok(usesLines().length > 0);
});

test("every action is a known Node 24 release, pinned by full SHA with its version comment", () => {
  for (const { file, line } of usesLines()) {
    const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(line);
    assert.ok(m, `${file}: "${line}" is not owner/repo@<40-hex sha> # vX.Y.Z`);
    const [, action, sha, version] = m;
    const known = NODE24[action];
    assert.ok(known, `${file}: ${action} is not on the Node 24 allow-list`);
    assert.equal(sha, known.sha, `${file}: ${action} pinned to ${sha}, not the Node 24 release ${known.version}`);
    assert.equal(version, known.version, `${file}: ${action} comment says ${version}, the SHA is ${known.version}`);
  }
});

test("the parsed steps agree with the text (no uses: hidden from the line scan)", () => {
  let parsed = 0;
  for (const f of files) {
    const wf = parse(readFileSync(new URL(f, DIR), "utf8"));
    for (const job of Object.values(wf.jobs ?? {})) {
      if (job.uses) parsed++;
      for (const s of job.steps ?? []) if (s.uses) parsed++;
    }
  }
  assert.equal(parsed, usesLines().length);
});
