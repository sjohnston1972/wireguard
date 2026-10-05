// labs/net.ts
//
// Plain English: every outside call the lab engine makes (GitHub, Azure,
// Microsoft Graph) goes through a Net, so the lab watch can promise a fixed
// number of them per cron run (spec §7.4, plan: makeBudget(20)). A request
// from the dashboard uses `direct`, which only counts; the watch uses
// `budgeted`, which refuses the call (BudgetExceeded) before it is made once
// the run's allowance is spent. GitHub's API, Azure's sign-in, ARM and Graph
// are all reached through here.

import type { Env } from "../env";
import { config } from "../env";
import { makeBudget, BudgetExceeded, type Budget } from "../insights/types";

export { BudgetExceeded };

export interface Net {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Calls left (Infinity for direct). */
  remaining(): number;
  used(): number;
  /** Take `n` calls for something that fetches without this Net (a notification), or throw BudgetExceeded. */
  take(n?: number): void;
}

/** No allowance: the dashboard's own requests (they make a handful of calls each). */
export function directNet(): Net {
  let used = 0;
  return {
    fetch: (url, init) => {
      used++;
      return fetch(url, init);
    },
    remaining: () => Infinity,
    used: () => used,
    take: (n = 1) => {
      used += n;
    },
  };
}

/** At most `limit` calls (and no more than `parent` has left); one more throws BudgetExceeded before anything is sent. */
export function budgetedNet(limit: number, parent?: Budget): Net & { budget: Budget } {
  const budget = makeBudget(limit, parent);
  return {
    budget,
    fetch: (url, init) => {
      budget.take(1);
      return fetch(url, init);
    },
    remaining: () => budget.remaining(),
    used: () => budget.used(),
    take: (n = 1) => budget.take(n),
  };
}

// ── GitHub ───────────────────────────────────────────────────────────────

const GH = "https://api.github.com";
/** The lab workflow (spec §5). Only this file name is ever dispatched by the lab engine: never the gateway's wg.yml. */
export const LAB_WORKFLOW = "lab.yml";

function ghHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "wg-admin-worker" };
}

export interface GhLabRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  display_title: string;
  created_at: string;
  updated_at?: string;
}

/** Press "Run workflow" on lab.yml, from main. Throws a readable message when GitHub refuses. */
export async function dispatchLab(env: Env, net: Net, action: string, payload: Record<string, unknown>): Promise<void> {
  const r = await net.fetch(`${GH}/repos/${env.GITHUB_REPO}/actions/workflows/${LAB_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { action, payload: JSON.stringify(payload) } }),
  });
  if (r.status !== 204) throw new Error(`GitHub refused the lab dispatch (${r.status}).`);
}

/** The lab.yml run whose title ends with our run id (run-name "lab <action> <lab id> <run id>"). */
export async function findLabRun(env: Env, net: Net, runId: string): Promise<GhLabRun | null> {
  const r = await net.fetch(`${GH}/repos/${env.GITHUB_REPO}/actions/workflows/${LAB_WORKFLOW}/runs?event=workflow_dispatch&per_page=30`, { headers: ghHeaders(env) });
  if (!r.ok) return null;
  const data = (await r.json()) as { workflow_runs?: GhLabRun[] };
  return (data.workflow_runs ?? []).find((x) => (x.display_title ?? "").split(" ").at(-1) === runId) ?? null;
}

export async function getGhRun(env: Env, net: Net, id: number): Promise<GhLabRun | null> {
  const r = await net.fetch(`${GH}/repos/${env.GITHUB_REPO}/actions/runs/${id}`, { headers: ghHeaders(env) });
  if (!r.ok) return null;
  return (await r.json()) as GhLabRun;
}

export interface GhStep {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** The first job's steps, or null when GitHub did not answer. */
export async function getSteps(env: Env, net: Net, id: number): Promise<GhStep[] | null> {
  const r = await net.fetch(`${GH}/repos/${env.GITHUB_REPO}/actions/runs/${id}/jobs`, { headers: ghHeaders(env) });
  if (!r.ok) return null;
  const data = (await r.json()) as { jobs?: { steps?: GhStep[] }[] };
  return (data.jobs?.[0]?.steps ?? [])
    .filter((s) => !/^(Set up job|Complete job|Post )/.test(s.name))
    .map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion, started_at: s.started_at ?? null, completed_at: s.completed_at ?? null }));
}

export async function cancelGh(env: Env, net: Net, id: number): Promise<boolean> {
  const r = await net.fetch(`${GH}/repos/${env.GITHUB_REPO}/actions/runs/${id}/cancel`, { method: "POST", headers: ghHeaders(env) });
  return r.status === 202;
}

// ── Azure and Graph ──────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

/** The two audiences the lab engine signs in to. The ARM token shares azure.ts's KV cache. */
const AUDIENCE = {
  arm: { scope: "https://management.azure.com/.default", key: "azure:token" },
  graph: { scope: "https://graph.microsoft.com/.default", key: "labs:graph-token" },
} as const;

/** A bearer token for ARM or Graph (client credentials), cached in KV until a minute before it expires. */
export async function token(env: Env, net: Net, aud: keyof typeof AUDIENCE): Promise<string> {
  const a = AUDIENCE[aud];
  const cached = await env.STATUS.get<TokenCache>(a.key, "json").catch(() => null);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: env.AZURE_CLIENT_ID ?? "", client_secret: env.AZURE_CLIENT_SECRET ?? "", scope: a.scope });
  const r = await net.fetch(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`Azure sign-in for ${aud === "arm" ? "Azure" : "Microsoft Graph"} failed (${r.status}).`);
  const data = (await r.json()) as { access_token: string; expires_in: number };
  const rec: TokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  await env.STATUS.put(a.key, JSON.stringify(rec), { expirationTtl: Math.max(60, data.expires_in) });
  return rec.token;
}

/** An ARM call: `path` starts "/subscriptions/..." or "/providers/...". */
export async function arm(env: Env, net: Net, path: string, init: RequestInit = {}): Promise<Response> {
  const t = await token(env, net, "arm");
  return net.fetch(`https://management.azure.com${path}`, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...((init.headers as Record<string, string>) ?? {}) } });
}

/** A Graph v1.0 call: `path` starts "/users" or "/groups". */
export async function graph(env: Env, net: Net, path: string): Promise<Response> {
  const t = await token(env, net, "graph");
  return net.fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${t}`, ConsistencyLevel: "eventual" } });
}

/** The dashboard's public address, for the payload's callback URLs. */
export const publicUrl = (env: Env) => config(env).publicUrl;
