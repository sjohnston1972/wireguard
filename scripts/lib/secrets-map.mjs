// scripts/lib/secrets-map.mjs
//
// Plain English: the routing table for secrets. Each .env key has a home:
// GitHub repository secrets (for Terraform running in Actions) or Worker
// secrets (for the Cloudflare Worker). Some go to both under different names.
// This file is pure (no side effects) so it can be unit tested.

/** .env key -> GitHub secret name. Terraform reads ARM_* for Azure. */
export const GITHUB_MAP = {
  AZURE_CLIENT_ID: "ARM_CLIENT_ID",
  AZURE_CLIENT_SECRET: "ARM_CLIENT_SECRET",
  AZURE_TENANT_ID: "ARM_TENANT_ID",
  AZURE_SUBSCRIPTION_ID: "ARM_SUBSCRIPTION_ID",
  AZURE_RESOURCE_GROUP: "AZURE_RESOURCE_GROUP",
  CLOUDFLARE_DNS_TOKEN: "CLOUDFLARE_DNS_TOKEN",
  CLOUDFLARE_ZONE_ID: "CLOUDFLARE_ZONE_ID",
  CLOUDFLARE_ACCOUNT_ID: "CLOUDFLARE_ACCOUNT_ID",
  R2_ACCESS_KEY_ID: "R2_ACCESS_KEY_ID",
  R2_SECRET_ACCESS_KEY: "R2_SECRET_ACCESS_KEY",
  R2_BUCKET: "R2_BUCKET",
  SSH_PUBLIC_KEY: "SSH_PUBLIC_KEY",
  WG_SERVER_PRIVATE_KEY: "WG_SERVER_PRIVATE_KEY",
};

/** .env keys that become Worker secrets (same name). Phase 2 uses these. */
export const WORKER_KEYS = [
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  // AZURE_RESOURCE_GROUP is a plain [vars] value in wrangler.toml, not a secret.
  "CLOUDFLARE_DNS_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "CF_ACCESS_ALLOWED_EMAIL",
  "WG_SERVER_PRIVATE_KEY",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "GITHUB_WORKFLOW",
  "NOTIFY_WEBHOOK_URL",
];

/** Keys that must NEVER leave this machine. */
export const LOCAL_ONLY = ["CLOUDFLARE_API_TOKEN"];

const PLACEHOLDER = /^REPLACE_ME/;

/**
 * Build the list of GitHub secrets to set from an env object.
 * Returns { secrets: {NAME: value}, warnings: [..], errors: [..] }.
 *
 * Special case: if CLOUDFLARE_DNS_TOKEN is still a placeholder, fall back to
 * the broad CLOUDFLARE_API_TOKEN with a loud warning, so Phase 1 can be tested
 * before the narrow token is minted.
 */
export function buildGithubSecrets(env) {
  const secrets = {};
  const warnings = [];
  const errors = [];

  for (const [envKey, ghName] of Object.entries(GITHUB_MAP)) {
    let value = env[envKey];
    if (envKey === "CLOUDFLARE_DNS_TOKEN" && (!value || PLACEHOLDER.test(value))) {
      if (env.CLOUDFLARE_API_TOKEN && !PLACEHOLDER.test(env.CLOUDFLARE_API_TOKEN)) {
        value = env.CLOUDFLARE_API_TOKEN;
        warnings.push(
          "CLOUDFLARE_DNS_TOKEN is not set: pushing the BROAD CLOUDFLARE_API_TOKEN to GitHub as a temporary stand-in. Mint a DNS-only token and rerun as soon as you can."
        );
      } else {
        errors.push("CLOUDFLARE_DNS_TOKEN is missing and no fallback is available");
        continue;
      }
    }
    if (!value) {
      errors.push(`${envKey} is blank`);
      continue;
    }
    if (PLACEHOLDER.test(value)) {
      errors.push(`${envKey} is still ${value}`);
      continue;
    }
    secrets[ghName] = value;
  }
  return { secrets, warnings, errors };
}

/** Build the list of Worker secrets. Same rules, no DNS fallback (the Worker only verifies DNS). */
export function buildWorkerSecrets(env) {
  // The dashboard copes with missing secrets (it shows a setup checklist), so
  // blanks and placeholders are skipped with a warning rather than blocking.
  const secrets = {};
  const errors = [];
  const warnings = [];
  for (const k of WORKER_KEYS) {
    let value = env[k];
    if (LOCAL_ONLY.includes(k)) continue;
    if (k === "CLOUDFLARE_DNS_TOKEN" && (!value || PLACEHOLDER.test(value)) && env.CLOUDFLARE_API_TOKEN && !PLACEHOLDER.test(env.CLOUDFLARE_API_TOKEN)) {
      value = env.CLOUDFLARE_API_TOKEN;
      warnings.push("CLOUDFLARE_DNS_TOKEN is not set: pushing the BROAD CLOUDFLARE_API_TOKEN to the Worker as a temporary stand-in. Mint a DNS-only token and rerun as soon as you can.");
    }
    if (!value) {
      if (k !== "NOTIFY_WEBHOOK_URL") warnings.push(`${k} is blank; skipped`);
      continue;
    }
    if (PLACEHOLDER.test(value)) {
      warnings.push(`${k} is still ${value}; skipped (the dashboard will show it as missing)`);
      continue;
    }
    secrets[k] = value;
  }
  return { secrets, errors, warnings };
}
