// keys.test.mjs: "npm run keys -- --rotate", run for real against a
// throwaway .env in a temporary folder (never the project's own .env).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { genKeypair, publicKeyFrom } from "../lib/wg.mjs";
import { parseEnv, backupEnvLine } from "../lib/env.mjs";

const script = fileURLToPath(new URL("../keys.mjs", import.meta.url));

function inTempDir(envText, args) {
  const dir = mkdtempSync(join(tmpdir(), "wg-keys-"));
  try {
    writeFileSync(join(dir, ".env"), envText);
    // stdin is not a terminal here, like a script or CI.
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", input: "" });
    return { ...r, env: readFileSync(join(dir, ".env"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("backupEnvLine keeps the old line as a comment that parseEnv ignores", () => {
  const text = "A=1\nWG_SERVER_PRIVATE_KEY=old\nB=2\n";
  const out = backupEnvLine(text, "WG_SERVER_PRIVATE_KEY", "replaced 2026-09-26 10:00");
  assert.equal(out, "A=1\n# replaced 2026-09-26 10:00: WG_SERVER_PRIVATE_KEY=old\nWG_SERVER_PRIVATE_KEY=old\nB=2\n");
  assert.deepEqual(parseEnv(out), { A: "1", WG_SERVER_PRIVATE_KEY: "old", B: "2" });
  assert.equal(backupEnvLine("A=1\n", "MISSING", "x"), "A=1\n");
  assert.equal(backupEnvLine("EMPTY=\n", "EMPTY", "x"), "EMPTY=\n");
});

test("--rotate without a terminal or --yes refuses and changes nothing", () => {
  const old = genKeypair();
  const text = `WG_SERVER_PRIVATE_KEY=${old.privateKey}\nWG_SERVER_PUBLIC_KEY=${old.publicKey}\n`;
  const r = inTempDir(text, ["--rotate"]);
  assert.equal(r.status, 1);
  assert.equal(r.env, text);
});

test("--rotate --yes makes a new pair, keeps the old as comments, never prints a private key", () => {
  const old = genKeypair();
  const r = inTempDir(`# settings\nWG_SERVER_PRIVATE_KEY=${old.privateKey}\nWG_SERVER_PUBLIC_KEY=${old.publicKey}\nOTHER=x\n`, ["--rotate", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const env = parseEnv(r.env);
  assert.notEqual(env.WG_SERVER_PRIVATE_KEY, old.privateKey);
  assert.equal(env.WG_SERVER_PUBLIC_KEY, publicKeyFrom(env.WG_SERVER_PRIVATE_KEY));
  assert.equal(env.OTHER, "x");
  assert.match(r.env, new RegExp(`^# replaced .+: WG_SERVER_PRIVATE_KEY=${old.privateKey.replace(/[+/]/g, "\\$&")}$`, "m"));
  assert.match(r.env, new RegExp(`^# replaced .+: WG_SERVER_PUBLIC_KEY=${old.publicKey.replace(/[+/]/g, "\\$&")}$`, "m"));
  const printed = r.stdout + r.stderr;
  assert.ok(!printed.includes(old.privateKey), "old private key printed");
  assert.ok(!printed.includes(env.WG_SERVER_PRIVATE_KEY), "new private key printed");
  assert.ok(printed.includes(env.WG_SERVER_PUBLIC_KEY), "new public key shown");
});

test("without --rotate an existing key is left alone", () => {
  const old = genKeypair();
  const text = `WG_SERVER_PRIVATE_KEY=${old.privateKey}\nWG_SERVER_PUBLIC_KEY=${old.publicKey}\n`;
  const r = inTempDir(text, []);
  assert.equal(r.status, 0);
  assert.equal(r.env, text);
});
