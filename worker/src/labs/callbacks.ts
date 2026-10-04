// labs/callbacks.ts
//
// Plain English: what lab.yml (and, for one route, wg.yml) tells the Worker,
// outside the login, each call proving itself with a token (labs spec §7.2):
//
//   POST /api/callback/lab                    the run's result (§5 step 16)
//   POST /api/callback/lab-secrets            OIDC: the run's callback token and admin password
//   POST /api/callback/lab-peer               { run_id, phase: "begin" } -> { go }; { run_id, phase: "end", ok }
//   POST /api/callback/lab-peerings-removed   from wg.yml's destroy, with the gateway run's callback token
//
// index.ts reads the body (null when it is not JSON), passes the bearer
// token (null when absent) and answers with the reply's status and body; a
// 401, 403 or 404 counts against the caller's failure brake.
//
// Contract stubs (plan L0): each refuses a missing token (401) and is
// otherwise not built yet (501). The engine (plan L2) fills them in, keeping
// these names and signatures.

import type { Env } from "../env";

export interface CallbackReply {
  status: number;
  body: unknown;
}

const noToken: CallbackReply = { status: 401, body: { error: "missing token" } };
const notYet: CallbackReply = { status: 501, body: { error: "labs are not built yet" } };

/** POST /api/callback/lab: a lab run's result, with the run's callback token. */
export async function handleLabCallback(_env: Env, token: string | null, _body: unknown): Promise<CallbackReply> {
  return token ? notYet : noToken;
}

/** POST /api/callback/lab-secrets: `oidcToken` is GitHub's OIDC token; only lab.yml on main may collect (claimsProblem's allowed workflow). */
export async function handleLabSecrets(_env: Env, oidcToken: string | null, _body: unknown): Promise<CallbackReply> {
  return oidcToken ? notYet : noToken;
}

/** POST /api/callback/lab-peer: begin (answers { go: boolean }) or end (releases the 10-minute gateway lock). */
export async function handleLabPeer(_env: Env, token: string | null, _body: unknown): Promise<CallbackReply> {
  return token ? notYet : noToken;
}

/** POST /api/callback/lab-peerings-removed: wg.yml removed every peering on vnet-wg; peered sessions become disconnected. */
export async function handleLabPeeringsRemoved(_env: Env, token: string | null, _body: unknown): Promise<CallbackReply> {
  return token ? notYet : noToken;
}
