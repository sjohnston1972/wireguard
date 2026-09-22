import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv, checkEnv, withDefaults, upsertEnvLine, REQUIRED } from "../lib/env.mjs";

test("parseEnv handles comments, quotes, export and = in values", () => {
  const env = parseEnv(`
# comment
A=1
export B=two
C="quoted value"
D='single'
E=has=equals
F=trailing # comment
G=
`);
  assert.deepEqual(env, {
    A: "1",
    B: "two",
    C: "quoted value",
    D: "single",
    E: "has=equals",
    F: "trailing",
    G: "",
  });
});

test("checkEnv reports missing required keys and placeholders", () => {
  const env = { AZURE_TENANT_ID: "x", GITHUB_TOKEN: "REPLACE_ME_pat" };
  const { missing, placeholders } = checkEnv(env);
  assert.ok(missing.includes("AZURE_CLIENT_ID"));
  assert.ok(!missing.includes("AZURE_TENANT_ID"));
  assert.deepEqual(placeholders, ["GITHUB_TOKEN"]);
});

test("withDefaults fills blanks but keeps set values", () => {
  const env = withDefaults({ WG_PORT: "51821", AZURE_REGION: "" });
  assert.equal(env.WG_PORT, "51821");
  assert.equal(env.AZURE_REGION, "uksouth");
  assert.equal(env.WG_DNS_NAME, "wg.clydeford.net");
});

test("upsertEnvLine replaces in place or appends", () => {
  const text = "# head\nA=1\nB=2\n";
  assert.equal(upsertEnvLine(text, "A", "9"), "# head\nA=9\nB=2\n");
  assert.equal(upsertEnvLine(text, "C", "3"), "# head\nA=1\nB=2\nC=3\n");
  assert.equal(upsertEnvLine("", "C", "3"), "C=3\n");
});

test("every REQUIRED key appears in .env.example", async () => {
  const { readFileSync } = await import("node:fs");
  const example = parseEnv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));
  for (const k of REQUIRED) assert.ok(k in example, `${k} missing from .env.example`);
});
