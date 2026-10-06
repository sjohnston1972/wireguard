// tf-runner.test.mjs
//
// Plain English: every offline Terraform run (labs-tf, labs-topology) leaves
// a terraform-provider<digits> folder (~48 MB) in the temp folder; 1,275 of
// them once filled 61 GB. withTfRunner (scripts/labs-tf.mjs) runs each child
// with TMP, TEMP and TMPDIR pointing at a scratch folder of its own, emptied
// after each child and deleted in a finally. A fake terraform (node) writes a
// terraform-provider123 folder into its temp folder; nothing is left after.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
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
  await withTfRunner({ cache: "plugin-cache-dir" }, async (run) => {
    for (let i = 0; i < 2; i++) {
      const r = run(process.execPath, ["-e", FAKE_TERRAFORM], {});
      assert.equal(r.status, 0, r.stderr);
      const env = JSON.parse(r.stdout);
      seen.push(env);
      assert.equal(env.TEMP, env.TMPDIR);
      assert.equal(env.TMP, env.TMPDIR);
      assert.notEqual(env.TMPDIR.toLowerCase(), tmpdir().toLowerCase(), "not the shared temp folder");
      assert.equal(env.cache, "plugin-cache-dir", "the plugin cache is kept");
      assert.equal(readdirSync(env.TMPDIR).length, 0, "each child's leftovers are cleared as it ends");
    }
  });
  for (const env of seen) assert.equal(existsSync(env.TMPDIR), false, "the scratch folder is gone");
  const left = readdirSync(tmpdir()).filter((f) => !before.has(f) && (/^terraform-provider/i.test(f) || /^labs-tf-tmp-/.test(f)));
  assert.deepEqual(left, []);
});

test("the scratch folder is deleted even when the work throws", async () => {
  let dir = null;
  await assert.rejects(
    withTfRunner({ cache: "c" }, async (run) => {
      dir = JSON.parse(run(process.execPath, ["-e", FAKE_TERRAFORM], {}).stdout).TMPDIR;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(dir);
  assert.equal(existsSync(dir), false);
});
