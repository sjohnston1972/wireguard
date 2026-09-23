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

/** The checks on the claims, separate from the signature so they can be tested. */
export function claimsProblem(env: Env, c: GithubClaims): string | null {
  const repo = env.GITHUB_REPO ?? "";
  const wf = config(env).workflow;
  if (!repo) return "GITHUB_REPO is not set";
  if (c.repository !== repo) return `wrong repository ${c.repository}`;
  if (c.ref !== "refs/heads/main") return `wrong ref ${c.ref}`;
  if (c.workflow_ref !== `${repo}/.github/workflows/${wf}@refs/heads/main`) return `wrong workflow ${c.workflow_ref}`;
  if (c.event_name !== "workflow_dispatch") return `wrong event ${c.event_name}`;
  if (!c.run_id || !/^\d+$/.test(c.run_id)) return "no run id";
  return null;
}

/** Verify a GitHub Actions OIDC token. Throws with a short reason if it is not ours. */
export async function verifyGithubOidc(env: Env, token: string): Promise<GithubClaims> {
  const { payload } = await jwtVerify(token, jwks, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });
  const c = payload as GithubClaims;
  const problem = claimsProblem(env, c);
  if (problem) throw new Error(problem);
  return c;
}
