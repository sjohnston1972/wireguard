// tf-runner.test.mjs
//
// Plain English: every offline Terraform run (labs-tf, labs-topology) leaves
// a terraform-provider<digits> folder (~48 MB) in the temp folder; 1,275 of
// them once filled 61 GB. withTfRunner (scripts/labs-tf.mjs) runs each child
// with TMP, TEMP and TMPDIR pointing at a scratch folder of its own, emptied
// after each child and deleted in a finally. A fake terraform (node) writes a
// terraform-provider123 folder into its temp folder; nothing is left after.
//
// The plugin cache is the run's own too. With no lock file (the labs commit
// none) Terraform never reuses a cache entry it cannot check against one: it
// downloads the provider again and rewrites the entry in place. A cache shared
// by two runs at once meant one run's terraform started a provider binary the
// other was half way through rewriting ("plugin didn't start"). Two runs at
// once, each told to use the same shared cache, must not see each other's
// bytes, and must leave the shared folder alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withTfRunner } from "../labs-tf.mjs";

const FAKE_TERRAFORM = `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = join(process.env.TMPDIR, "terraform-provider123");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "plugin.bin"), "x".repeat(1024));
console.log(JSON.stringify({ TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR, cache: process.env.TF_PLUGIN_CACHE_DIR }));
`;

test("terraform runs with its own temp folder, and nothing it leaves there survives the run", async () => {
  const before = new Set(readdirSync(tmpdir()));
  const seen = [];
  await withTfRunner({}, async (run) => {
    for (let i = 0; i < 2; i++) {
      const r = run(process.execPath, ["-e", FAKE_TERRAFORM], {});
      assert.equal(r.status, 0, r.stderr);
      const env = JSON.parse(r.stdout);
      seen.push(env);
      assert.equal(env.TEMP, env.TMPDIR);
      assert.equal(env.TMP, env.TMPDIR);
      assert.notEqual(env.TMPDIR.toLowerCase(), tmpdir().toLowerCase(), "not the shared temp folder");
      assert.equal(readdirSync(env.TMPDIR).length, 0, "each child's leftovers are cleared as it ends");
      assert.ok(env.cache && existsSync(env.cache), "a plugin cache folder of the run's own");
      assert.ok(!env.cache.toLowerCase().startsWith(env.TMPDIR.toLowerCase()), "the cache is not in the temp folder emptied after each child");
    }
  });
  assert.equal(seen[0].cache, seen[1].cache, "one cache for every child of a run");
  for (const env of seen) {
    assert.equal(existsSync(env.TMPDIR), false, "the scratch folder is gone");
    assert.equal(existsSync(env.cache), false, "the run's plugin cache is gone");
  }
  const left = readdirSync(tmpdir()).filter((f) => !before.has(f) && (/^terraform-provider/i.test(f) || /^labs-tf-tmp-/.test(f)));
  assert.deepEqual(left, []);
});

test("the scratch folder is deleted even when the work throws", async () => {
  let dir = null;
  await assert.rejects(
    withTfRunner({}, async (run) => {
      dir = JSON.parse(run(process.execPath, ["-e", FAKE_TERRAFORM], {}).stdout).TMPDIR;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(dir);
  assert.equal(existsSync(dir), false);
});

/**
 * A fake terraform init: writes a provider binary into the plugin cache as Terraform does (in place), waits until the
 * other run has written its own, then reads its binary back. A shared cache hands it the other run's bytes.
 */
const FAKE_INIT = `
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { RUN_ID, BARRIER, TF_PLUGIN_CACHE_DIR: cache } = process.env;
if (!cache) { console.error("no TF_PLUGIN_CACHE_DIR"); process.exit(3); }
const bin = join(cache, "registry.terraform.io", "hashicorp", "azurerm", "4.0.0", "os_arch", "terraform-provider-azurerm_v4.0.0_x5.exe");
mkdirSync(dirname(bin), { recursive: true });
const body = RUN_ID.repeat(64 * 1024);
writeFileSync(bin, body);
writeFileSync(join(BARRIER, RUN_ID), "");
const until = Date.now() + 60000;
const nap = new Int32Array(new SharedArrayBuffer(4));
while (readdirSync(BARRIER).length < 2) {
  if (Date.now() > until) { console.error("the other run never wrote its provider"); process.exit(4); }
  Atomics.wait(nap, 0, 0, 20);
}
console.log(JSON.stringify({ cache, intact: readFileSync(bin, "utf8") === body }));
`;

/** One labs-tf-like process: withTfRunner and the fake init, its JSON line on stdout. */
function oneRun(env) {
  const runner = pathToFileURL(join(import.meta.dirname, "..", "labs-tf.mjs")).href;
  const script = `
    import { withTfRunner } from ${JSON.stringify(runner)};
    await withTfRunner({}, async (run) => {
      const r = run(process.execPath, ["-e", ${JSON.stringify(FAKE_INIT)}], {});
      process.stdout.write(r.stdout ?? "");
      process.stderr.write(r.stderr ?? "");
      process.exitCode = r.status ?? 1;
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("two runs at once, both pointed at one shared plugin cache, never see each other's providers", async () => {
  const shared = mkdtempSync(join(tmpdir(), "labs-tf-shared-cache-"));
  const barrier = mkdtempSync(join(tmpdir(), "labs-tf-barrier-"));
  try {
    const [a, b] = await Promise.all(["a", "b"].map((id) => oneRun({ TF_PLUGIN_CACHE_DIR: shared, RUN_ID: id, BARRIER: barrier })));
    for (const r of [a, b]) assert.equal(r.code, 0, r.err);
    const [ra, rb] = [JSON.parse(a.out), JSON.parse(b.out)];
    assert.ok(ra.intact && rb.intact, "each run read back the provider it wrote");
    assert.notEqual(ra.cache, rb.cache, "each run has a cache of its own");
    for (const r of [ra, rb]) {
      assert.notEqual(r.cache.toLowerCase(), shared.toLowerCase(), "not the shared cache");
      assert.equal(existsSync(r.cache), false, "the run's cache is deleted when it ends");
    }
    assert.deepEqual(readdirSync(shared), [], "nothing was written into the shared cache");
  } finally {
    rmSync(shared, { recursive: true, force: true });
    rmSync(barrier, { recursive: true, force: true });
  }
});
