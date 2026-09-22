import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGithubSecrets, buildWorkerSecrets, GITHUB_MAP, LOCAL_ONLY } from "../lib/secrets-map.mjs";

const full = {
  AZURE_CLIENT_ID: "cid",
  AZURE_CLIENT_SECRET: "csec",
  AZURE_TENANT_ID: "tid",
  AZURE_SUBSCRIPTION_ID: "sid",
  AZURE_RESOURCE_GROUP: "rg-wg-ondemand",
  CLOUDFLARE_API_TOKEN: "BROAD",
  CLOUDFLARE_DNS_TOKEN: "NARROW",
  CLOUDFLARE_ZONE_ID: "zone",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud",
  CF_ACCESS_ALLOWED_EMAIL: "a@b.c",
  R2_ACCESS_KEY_ID: "rk",
  R2_SECRET_ACCESS_KEY: "rs",
  R2_BUCKET: "wg-admin-tfstate",
  SSH_PUBLIC_KEY: "ssh-ed25519 AAAA",
  WG_SERVER_PRIVATE_KEY: "priv",
  GITHUB_REPO: "o/r",
  GITHUB_TOKEN: "ghp",
  GITHUB_WORKFLOW: "wg.yml",
};

test("GitHub secrets: Azure keys are renamed to ARM_* and the broad token never goes", () => {
  const { secrets, warnings, errors } = buildGithubSecrets(full);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(secrets.ARM_CLIENT_ID, "cid");
  assert.equal(secrets.CLOUDFLARE_DNS_TOKEN, "NARROW");
  assert.ok(!("CLOUDFLARE_API_TOKEN" in secrets));
  assert.ok(!Object.values(secrets).includes("BROAD"));
  assert.equal(Object.keys(secrets).length, Object.keys(GITHUB_MAP).length);
});

test("GitHub secrets: placeholder DNS token falls back to the broad token with a warning", () => {
  const env = { ...full, CLOUDFLARE_DNS_TOKEN: "REPLACE_ME_mint_scoped_dns_token" };
  const { secrets, warnings, errors } = buildGithubSecrets(env);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.equal(secrets.CLOUDFLARE_DNS_TOKEN, "BROAD");
});

test("GitHub secrets: other placeholders are errors, not pushed", () => {
  const env = { ...full, R2_ACCESS_KEY_ID: "REPLACE_ME_r2" };
  const { secrets, errors } = buildGithubSecrets(env);
  assert.ok(errors.some((e) => e.includes("R2_ACCESS_KEY_ID")));
  assert.ok(!("R2_ACCESS_KEY_ID" in secrets));
});

test("Worker secrets: never include local-only keys; optional webhook may be blank", () => {
  const { secrets, errors } = buildWorkerSecrets(full);
  assert.deepEqual(errors, []);
  for (const k of LOCAL_ONLY) assert.ok(!(k in secrets));
  assert.ok(!("NOTIFY_WEBHOOK_URL" in secrets));
  assert.equal(secrets.CF_ACCESS_AUD, "aud");
});
