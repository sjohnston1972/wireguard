// shard.test.mjs
//
// Plain English: a slow test file split into shards (fixtures/shard.mjs) must
// still run every test, each exactly once, and refuse shard files with a gap
// in their numbers (a missing shard would silently drop tests).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { shardOf } from "./fixtures/shard.mjs";

// A node --test of its own: without the parent runner's NODE_TEST_CONTEXT, which would make it report to the parent instead.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const SHARD = pathToFileURL(join(import.meta.dirname, "fixtures", "shard.mjs")).href;

function suite(shards) {
  const dir = mkdtempSync(join(tmpdir(), "shard-test-"));
  const log = join(dir, "ran.log").replace(/\\/g, "/");
  const cases = [`import { appendFileSync } from "node:fs";`, `import { test } from ${JSON.stringify(SHARD)};`];
  for (let i = 1; i <= 11; i++) cases.push(`test("case ${i}", () => appendFileSync(${JSON.stringify(log)}, "case ${i}\\n"));`);
  writeFileSync(join(dir, "demo.cases.mjs"), cases.join("\n"));
  for (const i of shards) writeFileSync(join(dir, `demo.shard-${i}.test.mjs`), `import { runShard } from ${JSON.stringify(SHARD)};\nawait runShard(import.meta.url);\n`);
  return { dir, ran: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("the shards run every test of the cases file, each exactly once", () => {
  const s = suite([1, 2, 3, 4]);
  try {
    const r = spawnSync(process.execPath, ["--test", ...[1, 2, 3, 4].map((i) => join(s.dir, `demo.shard-${i}.test.mjs`))], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const ran = s.ran();
    assert.equal(ran.length, 11, ran.join(", "));
    assert.deepEqual([...new Set(ran)].sort(), Array.from({ length: 11 }, (_, k) => `case ${k + 1}`).sort());
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the cases file run on its own runs every test", () => {
  const s = suite([1, 2]);
  try {
    const r = spawnSync(process.execPath, ["--test", join(s.dir, "demo.cases.mjs")], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.ran().length, 11);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("shard files with a gap in their numbers are refused", () => {
  const s = suite([1, 3]);
  try {
    for (const i of [1, 3]) assert.throws(() => shardOf(join(s.dir, `demo.shard-${i}.test.mjs`)), /numbered 1 to n; found 1, 3/);
    writeFileSync(join(s.dir, "demo.shard-2.test.mjs"), "");
    assert.deepEqual(shardOf(join(s.dir, "demo.shard-3.test.mjs")), { cases: "demo.cases.mjs", index: 3, total: 3 });
    assert.throws(() => shardOf(join(s.dir, "demo.test.mjs")), /not named/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
