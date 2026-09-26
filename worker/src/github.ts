// github.ts
//
// Plain English: how the Worker talks to the Terraform runner. It presses the
// "Run workflow" button (workflow_dispatch) with a JSON payload, then watches
// the run: which step it is on, whether it passed, and the log text so far.
// GitHub does not hand back a run id when you press the button, so the
// workflow puts our run id in its title and we look it up by that.

import type { Env } from "./env";
import { config } from "./env";
import type { Step } from "./state";

const API = "https://api.github.com";

function headers(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wg-admin-worker",
  };
}

async function gh(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { ...headers(env), ...(init.headers ?? {}) } });
  return r;
}

export interface DispatchPayload {
  run_id: string;
  region: string;
  vm_size: string;
  peers_json: string;
  home_lan_cidr: string;
  ssh_allowed_cidr: string;
  wg_dns_name: string;
  wg_port: number;
  wg_subnet: string;
  loopback_ip: string;
  vnet_cidr: string;
  ssh_password: string;
  agent_url: string;
  agent_token: string;
  callback_url: string;
  callback_token: string;
}

/** Press "Run workflow". Throws with a readable message on failure. */
export async function dispatchWorkflow(env: Env, action: "apply" | "destroy", payload: Partial<DispatchPayload> & { run_id: string }): Promise<void> {
  const cfg = config(env);
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/workflows/${cfg.workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { action, payload: JSON.stringify(payload) } }),
  });
  if (r.status !== 204) {
    const text = await r.text().catch(() => "");
    throw new Error(`GitHub refused the dispatch (${r.status}): ${text.slice(0, 300)}`);
  }
}

export interface GhRun {
  id: number;
  status: string; // queued | in_progress | completed
  conclusion: string | null;
  html_url: string;
  display_title: string;
  created_at: string;
  updated_at?: string; // last change, e.g. when it completed
}

/** Find the workflow run whose title carries our run id. */
export async function findRunByTitle(env: Env, runId: string): Promise<GhRun | null> {
  const cfg = config(env);
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/workflows/${cfg.workflow}/runs?event=workflow_dispatch&per_page=15`);
  if (!r.ok) return null;
  const data = (await r.json()) as { workflow_runs: GhRun[] };
  return data.workflow_runs.find((x) => (x.display_title ?? "").includes(runId)) ?? null;
}

export async function getGhRun(env: Env, id: number): Promise<GhRun | null> {
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/runs/${id}`);
  if (!r.ok) return null;
  return (await r.json()) as GhRun;
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; status: string; conclusion: string | null }[];
}

export async function getJobs(env: Env, runId: number): Promise<GhJob[]> {
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/runs/${runId}/jobs`);
  if (!r.ok) return [];
  const data = (await r.json()) as { jobs: GhJob[] };
  return data.jobs ?? [];
}

/** Job log as plain text, or null if GitHub has nothing yet. Trimmed to the last `maxChars`. */
export async function getJobLogTail(env: Env, jobId: number, maxChars = 6000): Promise<string | null> {
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/jobs/${jobId}/logs`);
  if (!r.ok) return null;
  const text = await r.text();
  // Strip the ISO timestamp prefix GitHub puts on every line.
  const clean = text
    .split("\n")
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""))
    .join("\n");
  return clean.length > maxChars ? clean.slice(-maxChars) : clean;
}

export async function cancelGhRun(env: Env, id: number): Promise<boolean> {
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/runs/${id}/cancel`, { method: "POST" });
  return r.status === 202;
}

/** Steps flattened from the first job, for the live timeline. */
export function stepsFromJobs(jobs: GhJob[]): Step[] {
  const j = jobs[0];
  if (!j) return [];
  return j.steps
    .filter((s) => !/^(Set up job|Complete job|Post )/.test(s.name))
    .map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion }));
}
