// env.ts
//
// Plain English: the Worker's settings, typed. Bindings (database, KV, R2,
// the run lock) come from wrangler.toml. Plain settings come from [vars].
// Secrets come from "wrangler secret put". This file also knows which
// secrets are required, so the dashboard can show a setup checklist instead
// of failing mysteriously when one is missing.

export interface Env {
  // Bindings
  DB: D1Database;
  STATUS: KVNamespace;
  STATE: R2Bucket;
  RUN_LOCK: DurableObjectNamespace;

  // Plain settings ([vars])
  PUBLIC_URL: string;
  WG_DNS_NAME: string;
  WG_PORT: string;
  WG_SUBNET: string;
  AZURE_REGION: string;
  AZURE_VM_SIZE: string;
  AZURE_RESOURCE_GROUP: string;
  HOME_LAN_CIDR?: string;
  SSH_ALLOWED_CIDR?: string;
  AUTO_DESTROY_DEFAULT_HOURS: string;
  IDLE_DESTROY_MINUTES: string;
  MONTHLY_BUDGET_GBP: string;
  HOURLY_RATE_GBP: string;
  AUTH_DEV_BYPASS?: string; // "1" only under wrangler dev

  // Secrets
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_TENANT_ID?: string;
  AZURE_SUBSCRIPTION_ID?: string;
  CLOUDFLARE_DNS_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAIL?: string;
  WG_SERVER_PRIVATE_KEY?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WORKFLOW?: string;
  NOTIFY_WEBHOOK_URL?: string;
}

/** Parsed, defaulted view of the plain settings. */
export interface Config {
  publicUrl: string;
  dnsName: string;
  port: number;
  subnet: string;
  region: string;
  vmSize: string;
  resourceGroup: string;
  homeLanCidr: string;
  sshAllowedCidr: string;
  autoDestroyDefaultHours: number;
  idleDestroyMinutes: number;
  monthlyBudgetGbp: number;
  hourlyRateGbp: number;
  workflow: string;
}

export function config(env: Env): Config {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
  };
  return {
    publicUrl: (env.PUBLIC_URL || "https://wg-admin.clydeford.net").replace(/\/$/, ""),
    dnsName: env.WG_DNS_NAME || "wg.clydeford.net",
    port: num(env.WG_PORT, 51820),
    subnet: env.WG_SUBNET || "10.13.13.0/24",
    region: env.AZURE_REGION || "uksouth",
    vmSize: env.AZURE_VM_SIZE || "Standard_B1s",
    resourceGroup: env.AZURE_RESOURCE_GROUP || "rg-wg-ondemand",
    homeLanCidr: env.HOME_LAN_CIDR || "",
    sshAllowedCidr: env.SSH_ALLOWED_CIDR || "",
    autoDestroyDefaultHours: num(env.AUTO_DESTROY_DEFAULT_HOURS, 4),
    idleDestroyMinutes: num(env.IDLE_DESTROY_MINUTES, 0),
    monthlyBudgetGbp: num(env.MONTHLY_BUDGET_GBP, 10),
    hourlyRateGbp: num(env.HOURLY_RATE_GBP, 0.0149),
    workflow: env.GITHUB_WORKFLOW || "wg.yml",
  };
}

/** Secrets grouped by what stops working without them. */
export const SECRET_GROUPS: Record<string, (keyof Env)[]> = {
  "Login (Cloudflare Access)": ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "CF_ACCESS_ALLOWED_EMAIL"],
  "Deploy and destroy (GitHub Actions)": ["GITHUB_REPO", "GITHUB_TOKEN"],
  "Azure checks and cost": ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID"],
  "DNS verification": ["CLOUDFLARE_DNS_TOKEN", "CLOUDFLARE_ZONE_ID"],
  "Peer configs (server public key)": ["WG_SERVER_PRIVATE_KEY"],
};

/** Which secrets are missing, by group. Empty object means fully configured. */
export function missingSecrets(env: Env): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [group, keys] of Object.entries(SECRET_GROUPS)) {
    const missing = keys.filter((k) => !env[k] || /^REPLACE_ME/.test(String(env[k])));
    if (missing.length) out[group] = missing as string[];
  }
  return out;
}

export function canDispatch(env: Env): boolean {
  return !!(env.GITHUB_REPO && env.GITHUB_TOKEN && !/^REPLACE_ME/.test(env.GITHUB_TOKEN));
}

export function canAzure(env: Env): boolean {
  return !!(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.AZURE_SUBSCRIPTION_ID);
}

export function canDns(env: Env): boolean {
  return !!(env.CLOUDFLARE_DNS_TOKEN && env.CLOUDFLARE_ZONE_ID && !/^REPLACE_ME/.test(env.CLOUDFLARE_DNS_TOKEN));
}
