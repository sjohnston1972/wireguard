// scripts/lib/env.mjs
//
// Plain English: reads the .env file, the one place Steven fills in. Nothing
// clever: KEY=VALUE lines, # comments, blank lines. Also knows which keys are
// required and which are still placeholders, so every script can refuse to
// run with half-filled settings rather than failing halfway through.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Keys the project cannot function without. */
export const REQUIRED = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_RESOURCE_GROUP",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_DNS_TOKEN",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "CF_ACCESS_ALLOWED_EMAIL",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "WG_SERVER_PRIVATE_KEY",
  "SSH_PUBLIC_KEY",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
];

/** Defaults for optional keys, applied when the key is missing or blank. */
export const DEFAULTS = {
  AZURE_REGION: "uksouth",
  AZURE_VM_SIZE: "Standard_B1s",
  WG_DNS_NAME: "wg.clydeford.net",
  WG_PORT: "51820",
  WG_SUBNET: "10.13.13.0/24",
  GITHUB_WORKFLOW: "wg.yml",
  AUTO_DESTROY_DEFAULT_HOURS: "4",
  IDLE_DESTROY_MINUTES: "0",
  MONTHLY_BUDGET_GBP: "10",
};

export const PLACEHOLDER = /^REPLACE_ME/;

/**
 * Parse .env text into a plain object.
 * Handles: comments, blank lines, "export KEY=", single or double quotes,
 * and values containing "=" (only the first "=" splits).
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment only when preceded by whitespace.
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

/** Apply DEFAULTS to any missing or blank optional key. Returns a new object. */
export function withDefaults(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!out[k]) out[k] = v;
  }
  return out;
}

/** Which required keys are missing or blank, and which are still placeholders. */
export function checkEnv(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  const placeholders = Object.entries(env)
    .filter(([, v]) => PLACEHOLDER.test(v))
    .map(([k]) => k);
  return { missing, placeholders };
}

/** Load and parse .env from the repo root (or a given path). */
export function loadEnv(path = ".env") {
  const full = resolve(path);
  if (!existsSync(full)) {
    throw new Error(`${path} not found. Copy .env.example to .env and fill it in.`);
  }
  return withDefaults(parseEnv(readFileSync(full, "utf8")));
}

/**
 * Set or replace KEY=VALUE in .env text, keeping every other line and comment
 * exactly as it was. Appends at the end if the key is not present.
 */
export function upsertEnvLine(text, key, value) {
  const re = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  const sep = text.endsWith("\n") || text === "" ? "" : "\n";
  return `${text}${sep}${line}\n`;
}
