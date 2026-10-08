// demo/env.ts
//
// Plain English: the only environment the app's code sees while it serves
// demo data (demo mode spec §3 ruling 3). It is built from an allow-list,
// never by copying the real one: the plain settings named in DEMO_VARS
// (exactly wrangler.toml's [vars]; a test pins the two together) and the demo
// store's look-alike bindings (sql.ts). So it holds no secret at all (no
// Azure, GitHub, Cloudflare DNS, Access, ntfy or VAPID private key), no
// ASSETS, no DEMO_STORE and never AUTH_DEV_BYPASS: code running for a demo
// person cannot reach anything real, and canAzure/canDispatch/canDns are false.
//
// Four of those settings name the real setup (its addresses and networks),
// so the demo shows example values instead (DEMO_MASKS), safe for recordings.
//
// It carries DEMO_MARK, a Symbol only this module makes. It survives
// `{ ...env }`, and no setting or secret can forge it (configuration only
// makes string keys). isDemoEnv reads it.

import type { Env } from "../env";
import { d1Over, kvOver, r2Over, doNamespaceOver, type SqlLike, type WriteMeter } from "./sql";

/** Marks a demo environment. */
export const DEMO_MARK: unique symbol = Symbol("wg-admin demo environment");

/** The plain settings a demo environment copies: exactly wrangler.toml's [vars]. */
export const DEMO_VARS = [
  "PUBLIC_URL",
  "WG_DNS_NAME",
  "WG_PORT",
  "WG_SUBNET",
  "WG_SUBNET6",
  "WG_SERVER_PUBLIC_KEY",
  "VAPID_PUBLIC_KEY",
  "WG_LOOPBACK_IP",
  "AZURE_REGION",
  "AZURE_VM_SIZE",
  "AZURE_RESOURCE_GROUP",
  "AZURE_VNET_CIDR",
  "WORKLOAD_SUBNET",
  "TEST_VM",
  "TEST_VM_RATE_GBP",
  "HOME_LAN_CIDR",
  "SSH_ALLOWED_CIDR",
  "AUTO_DESTROY_DEFAULT_HOURS",
  "IDLE_DESTROY_MINUTES",
  "MONTHLY_BUDGET_GBP",
  "HOURLY_RATE_GBP",
  "STANDBY_RATE_GBP",
  "EXPIRY_ACTION",
  "STANDBY_MAX_DAYS",
] as const satisfies readonly (keyof Env)[];

/**
 * What the demo shows instead of the real setup's own names: documentation
 * names and ranges (RFC 2606, RFC 5737). The home LAN is the demo story's own
 * (its home-site client routes it and its traffic goes there), so the story
 * stays consistent. PUBLIC_URL and WG_DNS_NAME are always set (the app falls
 * back to the real names when they are missing); the home LAN and the SSH
 * range only when the real one is set (empty means "none").
 */
export const DEMO_MASKS = {
  PUBLIC_URL: "https://wg-admin.example.com",
  WG_DNS_NAME: "vpn.example.com",
  HOME_LAN_CIDR: "192.168.1.0/24",
  SSH_ALLOWED_CIDR: "203.0.113.0/24",
} as const satisfies Partial<Record<(typeof DEMO_VARS)[number], string>>;
const ALWAYS_MASKED: readonly string[] = ["PUBLIC_URL", "WG_DNS_NAME"];

/** True only for an environment made by makeDemoEnv (or a copy of one). */
export function isDemoEnv(env: unknown): boolean {
  return typeof env === "object" && env !== null && (env as { [DEMO_MARK]?: unknown })[DEMO_MARK] === true;
}

/**
 * A demo environment: the DEMO_VARS read by name from `vars` (strings only;
 * nothing else of `vars` is read; DEMO_MASKS in place of the real names), and DB, STATUS, STATE and RUN_LOCK over the
 * demo store's SQLite, every write counted on `meter`.
 */
export function makeDemoEnv(vars: Partial<Record<(typeof DEMO_VARS)[number], unknown>>, sql: SqlLike, meter: WriteMeter): Env {
  const out: Record<string | symbol, unknown> = {};
  for (const k of DEMO_VARS) {
    const v = vars[k];
    const mask = (DEMO_MASKS as Partial<Record<string, string>>)[k];
    if (mask !== undefined && (ALWAYS_MASKED.includes(k) || (typeof v === "string" && v !== ""))) out[k] = mask;
    else if (typeof v === "string") out[k] = v;
  }
  out.DB = d1Over(sql, meter);
  out.STATUS = kvOver(sql, meter);
  out.STATE = r2Over(sql, meter);
  out.RUN_LOCK = doNamespaceOver(sql, meter);
  Object.defineProperty(out, DEMO_MARK, { value: true, enumerable: true });
  return out as unknown as Env;
}
