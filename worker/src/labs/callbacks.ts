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
// 401, 403 or 404 counts against the caller's failure brake, as on the
// gateway's /api/callback. Tokens are compared by their SHA-256 only; a body
// with a key the route does not take is refused (400, naming the key), so a
// changed workflow cannot slip anything unexpected in.

import type { Env } from "../env";
import { randomToken, safeEqual, sha256Hex } from "../auth";
import { verifyGithubOidc } from "../oidc";
import { directNet, getGhRun, LAB_WORKFLOW } from "./net";
import { getLabRun, updateRun } from "./store";
import { finishRun, readOutputs } from "./settle";

export interface CallbackReply {
  status: number;
  body: unknown;
}

const noToken: CallbackReply = { status: 401, body: { error: "missing token" } };
const notYet: CallbackReply = { status: 501, body: { error: "labs are not built yet" } };
const badBody = (error: string, field?: string): CallbackReply => ({ status: 400, body: field ? { error, field } : { error } });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The first key of `b` not in `allowed`, or null. */
const unknownKey = (b: Obj, allowed: readonly string[]): string | null => Object.keys(b).find((k) => !allowed.includes(k)) ?? null;

/** A lab run by id, with its callback token checked. */
async function runForToken(env: Env, token: string, runId: unknown) {
  if (typeof runId !== "string" || !runId.startsWith("lab-")) return { reply: { status: 404, body: { error: "unknown run" } } as CallbackReply };
  const run = await getLabRun(env, runId);
  if (!run || !run.callback_token_hash) return { reply: { status: 404, body: { error: "unknown run" } } as CallbackReply };
  if (!safeEqual(await sha256Hex(token), run.callback_token_hash)) return { reply: { status: 401, body: { error: "bad token" } } as CallbackReply };
  return { run };
}

const RESULT_KEYS = ["run_id", "action", "status", "outputs", "github_run_id", "github_run_url"] as const;

/** POST /api/callback/lab: a lab run's result, with the run's callback token. */
export async function handleLabCallback(env: Env, token: string | null, body: unknown): Promise<CallbackReply> {
  if (!token) return noToken;
  if (!isObj(body)) return badBody("expected {run_id, action, status, outputs}");
  const extra = unknownKey(body, RESULT_KEYS);
  if (extra) return badBody(`${extra} is not something this takes`, extra);
  if (typeof body.status !== "string" || (body.action !== undefined && typeof body.action !== "string")) return badBody("expected {run_id, action, status, outputs}");
  const outputs = readOutputs(body.outputs);
  if (!outputs.ok) return badBody(`${outputs.field} is not something this takes`, outputs.field);
  const found = await runForToken(env, token, body.run_id);
  if (!found.run) return found.reply;
  const run = found.run;
  if (run.finished_at) return { status: 200, body: { message: "already settled" } };
  if (body.action !== undefined && body.action !== run.action) return badBody(`this run is a ${run.action}, not a ${String(body.action)}`, "action");

  const ghId = Number(body.github_run_id);
  if (Number.isInteger(ghId) && ghId > 0 && !run.github_run_id) await updateRun(env, run.id, { github_run_id: ghId });
  const ok = body.status === "success";
  const settled = await finishRun(env, run, { ok, outputs: outputs.outputs, via: "callback", error: ok ? null : `The workflow reported "${String(body.status).slice(0, 40)}". See the GitHub log.` });
  return { status: 200, body: { message: settled ? "ok" : "already settled" } };
}

/**
 * Hand a lab run its per-run secrets, once. The caller has already checked
 * the OIDC token came from lab.yml on main; `ghRunId` is GitHub's run number
 * from it. The run must carry our run id in its title, so a token from some
 * other dispatch of lab.yml cannot collect this run's secrets. The callback
 * token is minted here and only its hash is kept.
 */
export async function issueLabSecrets(env: Env, runId: string, ghRunId: number): Promise<CallbackReply> {
  const run = runId.startsWith("lab-") ? await getLabRun(env, runId) : null;
  if (!run) return { status: 404, body: { error: "unknown run" } };
  if (run.finished_at || !["queued", "running"].includes(run.status)) return { status: 409, body: { error: "run is not active" } };
  if (run.callback_token_hash) return { status: 409, body: { error: "secrets already collected" } };
  const gh = await getGhRun(env, directNet(), ghRunId);
  const title = (gh?.display_title ?? "").split(" ");
  if (!gh || title[0] !== "lab" || title.at(-1) !== run.id) return { status: 403, body: { error: "that GitHub run is not this run" } };
  const callbackToken = randomToken();
  const claimed = await updateRun(
    env,
    run.id,
    { callback_token_hash: await sha256Hex(callbackToken), github_run_id: ghRunId, github_run_url: gh.html_url, status: "running", started_at: run.started_at ?? new Date().toISOString() },
    "callback_token_hash IS NULL AND finished_at IS NULL",
  );
  if (!claimed) return { status: 409, body: { error: "secrets already collected" } };
  return { status: 200, body: { callback_token: callbackToken, admin_password: run.admin_password ?? "" } };
}

/** POST /api/callback/lab-secrets: `oidcToken` is GitHub's OIDC token; only lab.yml on main may collect (claimsProblem's allowed workflow). */
export async function handleLabSecrets(env: Env, oidcToken: string | null, body: unknown): Promise<CallbackReply> {
  if (!oidcToken) return noToken;
  let claims;
  try {
    claims = await verifyGithubOidc(env, oidcToken, LAB_WORKFLOW);
  } catch (e) {
    return { status: 401, body: { error: `not a trusted workflow: ${(e as Error).message}` } };
  }
  if (!isObj(body) || typeof body.run_id !== "string") return badBody("missing run_id");
  const extra = unknownKey(body, ["run_id"]);
  if (extra) return badBody(`${extra} is not something this takes`, extra);
  return issueLabSecrets(env, body.run_id, Number(claims.run_id));
}

/** POST /api/callback/lab-peer: begin (answers { go: boolean }) or end (releases the 10-minute gateway lock). */
export async function handleLabPeer(_env: Env, token: string | null, _body: unknown): Promise<CallbackReply> {
  return token ? notYet : noToken;
}

/** POST /api/callback/lab-peerings-removed: wg.yml removed every peering on vnet-wg; peered sessions become disconnected. */
export async function handleLabPeeringsRemoved(_env: Env, token: string | null, _body: unknown): Promise<CallbackReply> {
  return token ? notYet : noToken;
}
