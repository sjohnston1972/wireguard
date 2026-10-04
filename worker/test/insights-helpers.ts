// insights-helpers.ts
//
// Plain English: a pretend Azure for the insights collector's tests. Every
// outside call the collector makes (sign-in, ARM, the retail price API, the
// boot log blob) is answered from trimmed reply shapes in
// fixtures/azure/*.json and counted, so tests can check what was asked, how
// many calls a run made, and that nothing leaked. Fake ids only: all-zero
// subscription, example.net people, TEST-NET addresses.

import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeEnv, type World } from "./harness";
import { saveSnapshot, type AgentReport, type Snapshot } from "../src/state";
import type { Env } from "../src/env";

export const SUB = "00000000-0000-0000-0000-000000000000";
/** wg-admin's service principal (client id) in these tests. */
export const CLIENT = "11111111-1111-1111-1111-111111111111";
/** The service principal's object id, as the fake token's `oid` claim says. */
export const OID = "33333333-3333-3333-3333-333333333333";
export const SECRET = "fake-client-secret-XYZ";
export const AZ_ENV: Partial<Env> = { AZURE_SUBSCRIPTION_ID: SUB, AZURE_CLIENT_ID: CLIENT, AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222", AZURE_CLIENT_SECRET: SECRET };
export const NO_AZURE: Partial<Env> = { AZURE_TENANT_ID: undefined, AZURE_CLIENT_ID: undefined, AZURE_CLIENT_SECRET: undefined, AZURE_SUBSCRIPTION_ID: undefined };

export const NOW = new Date("2026-10-04T10:07:00Z");
export const MIN = 60_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const ago = (min: number, now = NOW) => iso(now.getTime() - min * MIN);

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/azure/${name}.json`, import.meta.url), "utf8");
}
export function fixture<T = any>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

const b64url = (s: string) => Buffer.from(s).toString("base64url");
/** A token shaped like Entra's (header.payload.signature); only the payload's claims matter here. */
export const FAKE_TOKEN = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ aud: "https://management.azure.com", appid: CLIENT, oid: OID }))}.c2ln`;

export interface AzCall {
  method: string;
  url: string;
  u: URL;
  headers: Record<string, string>;
  body: string | null;
}
type Handler = (c: AzCall) => Response | Promise<Response> | undefined;

export interface AzWorld {
  calls: AzCall[];
  /** Tried first, in order; the first to answer wins. */
  handlers: Handler[];
  loginStatus: number;
  /** The VM's serial console log, as the blob serves it. */
  serialLog: string;
  /** False: the blob ignores Range and sends everything with 200. */
  ranged: boolean;
  harness: World;
}

export const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** An env with Azure configured, and the pretend Azure answering every call. */
export function azureEnv(overrides: Partial<Env> = {}): { env: Env; az: AzWorld } {
  const { env, world } = makeEnv({ ...AZ_ENV, ...overrides });
  const az: AzWorld = { calls: [], handlers: [], loginStatus: 200, serialLog: "[    0.000000] Linux version 6.8.0-1015-azure\nwg-admin boot ok\n", ranged: true, harness: world };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const call: AzCall = { method: (init?.method ?? "GET").toUpperCase(), url, u: new URL(url), headers, body: init?.body ? String(init.body) : null };
    az.calls.push(call);
    for (const h of az.handlers) {
      const r = await h(call);
      if (r) return r;
    }
    return defaultAnswer(call, az);
  });
  return { env, az };
}

function defaultAnswer(c: AzCall, az: AzWorld): Response {
  const { u } = c;
  const p = decodeURIComponent(u.pathname);
  if (u.hostname === "login.microsoftonline.com") return az.loginStatus === 200 ? json({ access_token: FAKE_TOKEN, expires_in: 3600, token_type: "Bearer" }) : json({ error: "invalid_client" }, az.loginStatus);
  if (u.hostname === "management.azure.com") {
    if (p.endsWith("/availabilityStatuses/current")) return json(fixture("availability-current"));
    if (p.endsWith("/virtualMachines/vm-wg") && c.method === "GET") return json(fixture("vm-instanceview"));
    if (p.endsWith("/retrieveBootDiagnosticsData") && c.method === "POST") return json(fixture("bootdiag"));
    if (p.endsWith("/providers/Microsoft.Insights/metrics")) return json(fixture(p.includes("/publicIPAddresses/") ? "metrics-pip" : "metrics-vm"));
    if (p.endsWith("/providers/Microsoft.Insights/metricDefinitions")) return json(fixture(p.includes("/publicIPAddresses/") ? "metricdefs-pip" : "metricdefs-vm"));
    if (p.endsWith("/eventtypes/management/values")) {
      const skip = u.searchParams.get("$skipToken");
      return skip === "page2" ? json(fixture("activity-page2")) : skip ? json({ value: [] }) : json(fixture("activity"));
    }
    if (p.endsWith("/Microsoft.ResourceHealth/events")) return json(fixture("service-events"));
    if (p.endsWith("/Microsoft.Compute/skus")) return new Response(fixtureText("skus-uksouth"), { status: 200, headers: { "Content-Type": "application/json" } });
    if (p.endsWith("/usages")) return json(fixture("usages-uksouth"));
    return json({ error: { code: "ResourceNotFound", message: "not found" } }, 404);
  }
  if (u.hostname === "prices.azure.com") return json(fixture("prices-uksouth"));
  if (u.hostname.endsWith(".blob.core.windows.net")) {
    const bytes = new TextEncoder().encode(az.serialLog);
    if (c.method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Length": String(bytes.length) } });
    const range = c.headers["range"]?.match(/^bytes=(\d+)-(\d+)?$/);
    if (range && az.ranged) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : bytes.length - 1;
      return new Response(bytes.slice(from, to + 1), { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${bytes.length}` } });
    }
    return new Response(bytes, { status: 200 });
  }
  throw new Error(`unexpected fetch ${c.method} ${c.url}`);
}

/** Calls whose URL contains `part`. */
export const callsTo = (az: AzWorld, part: string) => az.calls.filter((c) => decodeURIComponent(c.url).includes(part));

/** A version-7 agent report. */
export function agentReport(over: Partial<AgentReport> = {}): AgentReport {
  return { at: ago(0.5), hostname: "vm-wg", uptime_seconds: 7200, load: "0.12 0.10 0.08", listen_port: 51820, server_public_key: null, loopback: null, peers: [], agent_version: 7, vitals: null, ...over };
}

/** The VM running for two hours, heartbeat fresh. */
export async function running(env: Env, over: Partial<Snapshot> = {}, now = NOW): Promise<Snapshot> {
  return saveSnapshot(env, {
    state: "running",
    since: ago(120, now),
    running_since: ago(120, now),
    last_agent_at: ago(0.5, now),
    agent: agentReport(),
    region: "uksouth",
    vm_size: "Standard_B1s",
    public_ip: "198.51.100.7",
    azure: { checked_at: ago(3, now), resource_group: "rg-wg-ondemand", exists: true, resources: [] },
    ...over,
  });
}

/** Every az_feed row, by feed. */
export async function feedRows(env: Env): Promise<Record<string, { status: string; last_ok_at: string | null; last_try_at: string | null; error: string | null; next_due_at: string | null }>> {
  const rows = (await env.DB.prepare("SELECT * FROM az_feed").all<any>()).results;
  return Object.fromEntries(rows.map((r) => [r.feed, r]));
}

export async function setFeed(env: Env, feed: string, cols: { status?: string; last_ok_at?: string | null; last_try_at?: string | null; next_due_at?: string | null; error?: string | null }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO az_feed (feed, last_try_at, last_ok_at, status, error, next_due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (feed) DO UPDATE SET last_try_at = excluded.last_try_at, last_ok_at = excluded.last_ok_at, status = excluded.status, error = excluded.error, next_due_at = excluded.next_due_at",
  )
    .bind(feed, cols.last_try_at ?? null, cols.last_ok_at ?? null, cols.status ?? "ok", cols.error ?? null, cols.next_due_at ?? null)
    .run();
}

/** Mark every feed (and housekeeping) not due until `until`. */
export async function allNotDue(env: Env, until = iso(NOW.getTime() + 60 * MIN)): Promise<void> {
  for (const f of ["health", "vmMetrics", "pipMetrics", "metricDefs", "activity", "serviceHealth", "capacity", "prices", "bootLog", "housekeeping"]) await setFeed(env, f, { status: "ok", last_ok_at: ago(1), last_try_at: ago(1), next_due_at: until });
}

export async function latest<T = any>(env: Env, key: string): Promise<T | null> {
  const r = await env.DB.prepare("SELECT json FROM az_latest WHERE key = ?1").bind(key).first<{ json: string }>();
  return r ? (JSON.parse(r.json) as T) : null;
}
