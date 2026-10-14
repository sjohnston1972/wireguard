// oidc.ts
//
// Plain English: GitHub Actions can ask GitHub for a signed note (an OIDC
// token) that says "I am workflow wg.yml, on main, in sjohnston1972/wireguard,
// run number N". The Worker checks the signature against GitHub's published
// keys, like checking a courier's badge with the courier company rather than
// taking their word for it. Only a run that passes gets the per-run secrets
// (SSH password, heartbeat and callback tokens), so those never have to travel
// in the public dispatch payload or appear in the public log.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";
import { config } from "./env";

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_AUDIENCE = "wg-admin";

const jwks = createRemoteJWKSet(new URL(`${OIDC_ISSUER}/.well-known/jwks`));

export interface GithubClaims extends JWTPayload {
  repository?: string;
  ref?: string;
  workflow_ref?: string;
  event_name?: string;
  run_id?: string;
}

/** The `workflow_ref` claim a token from `workflow` on main in our repo carries. */
export function workflowRef(env: Env, workflow: string): string {
  return `${env.GITHUB_REPO ?? ""}/.github/workflows/${workflow}@refs/heads/main`;
}

/**
 * The checks on the claims, separate from the signature so they can be tested.
 * `workflow` is the workflow file (or files) this route accepts: the
 * gateway's two (wg.yml for Azure, wg-aws.yml for AWS) for
 * /api/callback/secrets, "lab.yml" only for /api/callback/lab-secrets (labs
 * spec §7.2), so neither can collect the other's secrets. Which of the
 * gateway's two may collect a given run's secrets is issueRunSecrets' check.
 */
export function claimsProblem(env: Env, c: GithubClaims, workflow?: string | string[]): string | null {
  const repo = env.GITHUB_REPO ?? "";
  const wf = workflow ?? config(env).workflow;
  if (!repo) return "GITHUB_REPO is not set";
  if (c.repository !== repo) return `wrong repository ${c.repository}`;
  if (c.ref !== "refs/heads/main") return `wrong ref ${c.ref}`;
  const allowed = (Array.isArray(wf) ? wf : [wf]).map((w) => workflowRef(env, w));
  if (!c.workflow_ref || !allowed.includes(c.workflow_ref)) return `wrong workflow ${c.workflow_ref}`;
  if (c.event_name !== "workflow_dispatch") return `wrong event ${c.event_name}`;
  if (!c.run_id || !/^\d+$/.test(c.run_id)) return "no run id";
  return null;
}

/** Verify a GitHub Actions OIDC token from `workflow`, or one of a list (default: the gateway's wg.yml). Throws with a short reason if it is not ours. */
export async function verifyGithubOidc(env: Env, token: string, workflow?: string | string[]): Promise<GithubClaims> {
  const { payload } = await jwtVerify(token, jwks, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });
  const c = payload as GithubClaims;
  const problem = claimsProblem(env, c, workflow);
  if (problem) throw new Error(problem);
  return c;
}
