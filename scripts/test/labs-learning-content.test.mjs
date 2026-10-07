// labs-learning-content.test.mjs
//
// Plain English: the real learning content (labs redesign spec §5, §14). Every
// lab in the catalogue has a valid labs/_learning/<id>.yaml (one sentence of
// objective, exactly three points within the lengths, a learning time inside
// the lab's range), no file names a lab that does not exist, the catalogue
// carries each one, and labs-check passes on the repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, labFolders, LEARNING_DIR, readLearning } from "../lib/labs.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const labs = join(repo, "labs");

test("every catalogue lab has a valid learning file, and no file is without a lab", () => {
  const { catalogue, problems } = buildCatalogue(labs, { requireLearning: true });
  assert.deepEqual(problems, []);
  const ids = catalogue.labs.map((l) => l.id).sort();
  assert.equal(ids.length, labFolders(labs).length);
  const files = readdirSync(join(labs, LEARNING_DIR)).sort();
  assert.deepEqual(files, ids.map((id) => `${id}.yaml`));
  assert.deepEqual(Object.keys(catalogue.learning).sort(), ids);
  const again = readLearning(labs, ids, catalogue.labs, { requireLearning: true });
  assert.deepEqual(again.problems, []);
});

test("each has one objective sentence, exactly 3 points within the lengths, and a learning time in range", () => {
  const { catalogue } = buildCatalogue(labs, { requireLearning: true });
  for (const lab of catalogue.labs) {
    const l = catalogue.learning[lab.id];
    assert.ok(l, lab.id);
    assert.ok(l.objective.length >= 30 && l.objective.length <= 140, `${lab.id} objective length ${l.objective.length}`);
    assert.equal(l.learn.length, 3, lab.id);
    for (const p of l.learn) assert.ok(p.length >= 15 && p.length <= 90, `${lab.id}: ${p}`);
    assert.ok(l.learning_min >= 15 && l.learning_min <= Math.min(240, lab.timing.max_h * 60) && l.learning_min % 5 === 0, `${lab.id} learning_min ${l.learning_min}`);
  }
});

test("labs-check passes on the repo, learning content included", () => {
  const check = spawnSync(process.execPath, [join(repo, "scripts", "labs-check.mjs")], { cwd: repo, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
