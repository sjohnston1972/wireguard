// scripts/test/fixtures/shard.mjs
//
// Plain English: node --test runs test files in parallel, but the tests in one
// file one after another. A file of slow tests (each runs bash scripts, and
// Git Bash starts processes slowly on Windows) is so split into shards: the
// tests live in <name>.cases.mjs, which takes `test` from here, and each
// <name>.shard-<i>.test.mjs is one line, `await runShard(import.meta.url)`.
// Shard i of n registers every nth test, starting at the ith, so each test
// runs in exactly one shard. n is the number of shard files, which must be
// numbered 1 to n. Run the cases file itself (node --test <name>.cases.mjs)
// and every test runs.

import { test as nodeTest } from "node:test";
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let shard = null;
let seen = 0;

/** node:test's test, for a cases file: registered only in its shard (every test when no shard is running). */
export function test(...args) {
  const mine = !shard || seen % shard.total === shard.index - 1;
  seen++;
  if (mine) return nodeTest(...args);
  return Promise.resolve();
}

/** Which shard a shard file is, of how many: { cases, index, total }. Throws unless the shards are 1 to n. */
export function shardOf(shardFile) {
  const m = /^(.+)\.shard-(\d+)\.test\.mjs$/.exec(basename(shardFile));
  if (!m) throw new Error(`${basename(shardFile)} is not named <name>.shard-<i>.test.mjs`);
  const [, name, i] = m;
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.shard-(\\d+)\\.test\\.mjs$`);
  const numbers = readdirSync(dirname(shardFile))
    .map((f) => re.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  if (!numbers.every((n, k) => n === k + 1)) throw new Error(`${name}'s shard files must be numbered 1 to n; found ${numbers.join(", ")}`);
  return { cases: `${name}.cases.mjs`, index: Number(i), total: numbers.length };
}

/** Run one shard: the cases file next to `shardUrl`, registering only this shard's tests. */
export async function runShard(shardUrl) {
  const file = fileURLToPath(shardUrl);
  const { cases, index, total } = shardOf(file);
  shard = { index, total };
  await import(pathToFileURL(`${dirname(file)}/${cases}`).href);
}
