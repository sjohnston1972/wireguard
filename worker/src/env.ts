// env.ts
//
// Plain English: the Worker's settings, typed. Bindings (database, KV, R2,
// the run lock) come from wrangler.toml. Plain settings come from [vars].
// Secrets come from "wrangler secret put". This file also knows which
// secrets are required, so the dashboard can show a setup checklist instead
// of failing mysteriously when one is missing.

import { isDemoEnv } from "./demo/env";
import type { DemoStore } from "./demo/store";

/** Which cloud a headend lives in. A record without one is Azure (everything before AWS existed). */
export type Cloud = "azure" | "aws";

export interface Env {
  // Bindings
  DB: D1Database;
  STATUS: KVNamespace;
  STATE: R2Bucket;
  RUN_LOCK: DurableObjectNamespace;
  /**
   * Demo mode's store (demo/store.ts): its own SQLite, never the bindings above. Reached only by the demo gate and the demo
   * control routes (index.ts, api/demo.ts); a demo environment (demo/env.ts) never has it.
   */
  DEMO_STORE: DurableObjectNamespace<DemoStore>;
  /** The built app (web/dist), for the /assets/* guard (assetguard.ts). Absent in tests. */
  ASSETS?: Fetcher;
  /**
   * Cloudflare Browser Rendering (wrangler.toml [browser]), for the lab guide PDFs (labs/guidepdf.ts). Absent in tests and
   * in a demo environment; the guide route then answers 503 (or, in demo mode, 409) rather than trying anything else.
   */
  BROWSER?: Fetcher;
  /** The public showcase's page and films (showcase.ts), its own bucket. Absent in tests unless a test adds one. */
  SHOWCASE?: R2Bucket;

  // Plain settings ([vars])
  PUBLIC_URL: string;
  WG_DNS_NAME: string;
  WG_PORT: string;
  WG_SUBNET: string;
  WG_SUBNET6?: string;
  WG_LOOPBACK_IP?: string;
  // Public, so a plain var. The private half never reaches the Worker.
  WG_SERVER_PUBLIC_KEY?: string;
  AZURE_REGION: string;
  AZURE_VM_SIZE: string;
  AZURE_RESOURCE_GROUP: string;
  AZURE_VNET_CIDR?: string;
  AWS_ENABLED?: string; // "1" shows AWS in the Deploy picker
  AWS_REGION?: string; // default eu-west-2 (London)
  AWS_INSTANCE_TYPE?: string; // default t4g.micro
  AWS_HOURLY_RATE_GBP?: string; // running headend, for the cost estimate
  AWS_STANDBY_RATE_GBP?: string; // stopped headend (volume + address)
  AWS_USD_GBP?: string; // Cost Explorer reports dollars; this converts to pounds
  GITHUB_WORKFLOW_AWS?: string; // the AWS build workflow file
  WORKLOAD_SUBNET?: string; // servers behind the WireGuard firewall, in the same VNet
  TEST_VM?: string; // "1" builds the test VM in the workloads subnet
  TEST_VM_RATE_GBP?: string;
  HOME_LAN_CIDR?: string;
  SSH_ALLOWED_CIDR?: string;
  AUTO_DESTROY_DEFAULT_HOURS: string;
  IDLE_DESTROY_MINUTES: string;
  MONTHLY_BUDGET_GBP: string;
  HOURLY_RATE_GBP: string;
  STANDBY_RATE_GBP?: string;
  EXPIRY_ACTION?: string; // "destroy" | "hibernate": what the timer and idle limit do
  STANDBY_MAX_DAYS?: string;
  AUTH_DEV_BYPASS?: string; // "1" only under wrangler dev

  // Secrets
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_TENANT_ID?: string;
  AZURE_SUBSCRIPTION_ID?: string;
  // AWS: the Worker's own narrow IAM user (infra/aws-bootstrap). Never the admin keys.
  AWS_WORKER_ACCESS_KEY_ID?: string;
  AWS_WORKER_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_DNS_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAIL?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WORKFLOW?: string;
  NOTIFY_WEBHOOK_URL?: string;
  NOTIFY_TOKEN?: string; // ntfy.sh access token (ntfy.sh still limits free accounts per IP, so it does not help from Workers)
  VAPID_PUBLIC_KEY?: string; // Web Push: public half, a plain var in wrangler.toml
  VAPID_PRIVATE_KEY?: string; // Web Push: private half, a secret
}

/** Parsed, defaulted view of the plain settings. */
export interface Config {
  aws: { enabled: boolean; region: string; instanceType: string; hourlyRateGbp: number; standbyRateGbp: number; usdToGbp: number; workflow: string };
  publicUrl: string;
  dnsName: string;
  port: number;
  subnet: string;
  subnet6: string;
  loopbackIp: string;
  region: string;
  vmSize: string;
  resourceGroup: string;
  vnetCidr: string;
  workloadCidr: string;
  testVm: boolean;
  testVmRateGbp: number;
  firewallDefault: "deny" | "allow";
  homeLanCidr: string;
  sshAllowedCidr: string;
  autoDestroyDefaultHours: number;
  idleDestroyMinutes: number;
  monthlyBudgetGbp: number;
  hourlyRateGbp: number;
  standbyRateGbp: number;
  expiryAction: "destroy" | "hibernate";
  standbyMaxDays: number;
  workflow: string;
}

export function config(env: Env): Config {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
  };
  return {
    publicUrl: (env.PUBLIC_URL || "https://cloudlabs.clydeford.net").replace(/\/$/, ""),
    dnsName: env.WG_DNS_NAME || "wg.clydeford.net",
    port: num(env.WG_PORT, 51820),
    subnet: env.WG_SUBNET || "10.13.13.0/24",
    subnet6: env.WG_SUBNET6 ?? "fd13:13::/64",
    loopbackIp: env.WG_LOOPBACK_IP || "10.13.255.1",
    region: env.AZURE_REGION || "uksouth",
    vmSize: env.AZURE_VM_SIZE || "Standard_B1s",
    resourceGroup: env.AZURE_RESOURCE_GROUP || "rg-wg-ondemand",
    vnetCidr: env.AZURE_VNET_CIDR || "10.50.0.0/16",
    workloadCidr: env.WORKLOAD_SUBNET || "10.50.2.0/24",
    testVm: env.TEST_VM === "1",
    testVmRateGbp: num(env.TEST_VM_RATE_GBP, 0.006),
    firewallDefault: "deny",
    homeLanCidr: env.HOME_LAN_CIDR || "",
    sshAllowedCidr: env.SSH_ALLOWED_CIDR || "",
    autoDestroyDefaultHours: num(env.AUTO_DESTROY_DEFAULT_HOURS, 4),
    idleDestroyMinutes: num(env.IDLE_DESTROY_MINUTES, 0),
    monthlyBudgetGbp: num(env.MONTHLY_BUDGET_GBP, 10),
    hourlyRateGbp: num(env.HOURLY_RATE_GBP, 0.0157),
    standbyRateGbp: num(env.STANDBY_RATE_GBP, 0.0064),
    expiryAction: env.EXPIRY_ACTION === "hibernate" ? "hibernate" : "destroy",
    standbyMaxDays: num(env.STANDBY_MAX_DAYS, 7),
    workflow: env.GITHUB_WORKFLOW || "wg.yml",
    aws: {
      enabled: env.AWS_ENABLED === "1",
      region: env.AWS_REGION || "eu-west-2",
      instanceType: env.AWS_INSTANCE_TYPE || "t4g.micro",
      hourlyRateGbp: num(env.AWS_HOURLY_RATE_GBP, 0.011),
      standbyRateGbp: num(env.AWS_STANDBY_RATE_GBP, 0.005),
      usdToGbp: num(env.AWS_USD_GBP, 0.75),
      workflow: env.GITHUB_WORKFLOW_AWS || "wg-aws.yml",
    },
  };
}

/** Secrets grouped by what stops working without them. */
export const SECRET_GROUPS: Record<string, (keyof Env)[]> = {
  "Login (Cloudflare Access)": ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "CF_ACCESS_ALLOWED_EMAIL"],
  "Deploy and destroy (GitHub Actions)": ["GITHUB_REPO", "GITHUB_TOKEN"],
  "Azure checks and cost": ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID"],
  "DNS verification": ["CLOUDFLARE_DNS_TOKEN", "CLOUDFLARE_ZONE_ID"],
  "Peer configs (server public key)": ["WG_SERVER_PUBLIC_KEY"],
};

/**
 * Which secrets are missing, by group. Empty object means fully configured.
 * A demo environment answers {} (demo mode spec ruling 15): it has no secrets
 * by design, and the app must not lay a setup checklist over the demo. Server
 * logic still asks canDispatch/canAzure/canDns, which stay false there.
 */
export function missingSecrets(env: Env): Record<string, string[]> {
  if (isDemoEnv(env)) return {};
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

/** Are the Worker's AWS keys set? (Optional: without them AWS simply is not offered.) */
export function canAws(env: Env): boolean {
  const ok = (v?: string) => !!v && !/^REPLACE_ME/.test(v);
  return ok(env.AWS_WORKER_ACCESS_KEY_ID) && ok(env.AWS_WORKER_SECRET_ACCESS_KEY);
}

/** The running and standby rates for a headend in this cloud. */
export function ratesFor(cfg: Config, cloud: Cloud): { hourlyRateGbp: number; standbyRateGbp: number } {
  return cloud === "aws" ? { hourlyRateGbp: cfg.aws.hourlyRateGbp, standbyRateGbp: cfg.aws.standbyRateGbp } : { hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp };
}

export function canDns(env: Env): boolean {
  return !!(env.CLOUDFLARE_DNS_TOKEN && env.CLOUDFLARE_ZONE_ID && !/^REPLACE_ME/.test(env.CLOUDFLARE_DNS_TOKEN));
}
