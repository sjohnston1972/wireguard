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
import * as db from "../db";
import { getSnapshot } from "../state";
import { acquireLock, releaseLock, GATEWAY_LOCK } from "../lock";
import { getLabRun, getSession, LIVE_SQL, updateRun, updateSession } from "./store";
import { labDef } from "./catalogue";
import { finishRun, readOutputs } from "./settle";

export interface CallbackReply {
  status: number;
  body: unknown;
}

const noToken: CallbackReply = { status: 401, body: { error: "missing token" } };
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

/**
 * POST /api/callback/lab-peer (spec §7.6), from step 9 of a deploy, peer or
 * test run, with the run's callback token.
 *   begin: "go" only while the gateway is running or in Standby and the
 *          gateway's own lock can be taken as peer:<run id> for 10 minutes,
 *          so a peering change never races a gateway apply or destroy on
 *          vnet-wg. Otherwise "wait": the session's peering is waiting, and
 *          Re-peer offers it once the gateway is running.
 *   end:   releases that lock; { ok: true } means peered.
 */
export async function handleLabPeer(env: Env, token: string | null, body: unknown): Promise<CallbackReply> {
  if (!token) return noToken;
  if (!isObj(body)) return badBody("expected {run_id, phase}");
  const extra = unknownKey(body, ["run_id", "phase", "ok"]);
  if (extra) return badBody(`${extra} is not something this takes`, extra);
  if (body.phase !== "begin" && body.phase !== "end") return badBody("phase is begin or end", "phase");
  if (body.phase === "end" && typeof body.ok !== "boolean") return badBody("end says ok: true or false", "ok");
  if (body.phase === "begin" && body.ok !== undefined) return badBody("ok is only for end", "ok");
  const found = await runForToken(env, token, body.run_id);
  if (!found.run) return found.reply;
  const run = found.run;
  if (run.finished_at || !["queued", "running"].includes(run.status)) return { status: 409, body: { error: "run is not active" } };
  if (!["deploy", "peer", "test"].includes(run.action)) return { status: 409, body: { error: `a ${run.action} run does not peer` } };
  const holder = `peer:${run.id}`;
  const live = "state NOT IN ('ended', 'ended_dirty')";

  if (body.phase === "end") {
    await releaseLock(env, holder, false, GATEWAY_LOCK);
    await updateSession(env, run.session_id, { peering: body.ok ? "on" : "waiting" }, live);
    return { status: 200, body: { message: body.ok ? "peered" : "noted: not peered" } };
  }
  const snap = await getSnapshot(env);
  if (snap.state !== "running" && snap.state !== "standby") {
    await updateSession(env, run.session_id, { peering: "waiting" }, live);
    return { status: 200, body: { go: false, reason: "the gateway is not running; Re-peer once it is" } };
  }
  const lock = await acquireLock(env, holder, { name: GATEWAY_LOCK, ttlMs: PEER_LOCK_MS });
  if (!lock.ok) {
    await updateSession(env, run.session_id, { peering: "waiting" }, live);
    return { status: 200, body: { go: false, reason: "the gateway is busy with a run; Re-peer once it has finished" } };
  }
  await updateSession(env, run.session_id, { peering: "waiting" }, live);
  return { status: 200, body: { go: true, ...(await dnsLinkFor(env, run.session_id)) } };
}

/**
 * Whether this peering links the lab's private DNS zones to vnet-wg (lab.yaml
 * dns_link). Azure refuses to link two zones with the same name (two labs'
 * privatelink.blob.core.windows.net) to one VNet, so while another peered
 * lab has linked its zones this one peers without linking, and says why.
 * The lab run reads `dns_link` from this answer (step 9).
 */
async function dnsLinkFor(env: Env, sid: string): Promise<{ dns_link: boolean; note?: string }> {
  const s = await getSession(env, sid);
  const def = s ? labDef(s.lab_id) : null;
  if (!s || !def?.connectivity.dns_link) return { dns_link: false };
  const others = (await env.DB.prepare(`SELECT lab_id FROM lab_sessions WHERE id <> ?1 AND peering = 'on' AND state IN (${LIVE_SQL})`).bind(sid).all<{ lab_id: string }>()).results;
  const clash = others.find((o) => labDef(o.lab_id)?.connectivity.dns_link);
  if (!clash) return { dns_link: true };
  const title = labDef(clash.lab_id)?.title ?? clash.lab_id;
  return { dns_link: false, note: `Private DNS zones not linked: ${title} has linked its zones to the gateway's VNet, and Azure refuses two zones of the same name there. Unpeer it, then re-peer this lab to link them.` };
}

/** The gateway's lock is held at most this long for one lab's peering (spec §7.6). */
export const PEER_LOCK_MS = 10 * 60_000;

const REMOVED_KEYS = ["run_id", "peerings_removed", "dns_links_removed", "complete"] as const;
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000;

/**
 * POST /api/callback/lab-peerings-removed (spec §6): wg.yml's first destroy
 * step removed every peering and DNS link on vnet-wg, and says so with the
 * gateway run's own callback token, while that destroy is running. Peered
 * lab sessions become "disconnected" (the labs keep running), ready for
 * Re-peer when the gateway is next running. Body exactly
 * { run_id, peerings_removed, dns_links_removed, complete }.
 */
export async function handleLabPeeringsRemoved(env: Env, token: string | null, body: unknown): Promise<CallbackReply> {
  if (!token) return noToken;
  if (!isObj(body)) return badBody("expected {run_id, peerings_removed, dns_links_removed, complete}");
  const extra = unknownKey(body, REMOVED_KEYS);
  if (extra) return badBody(`${extra} is not something this takes`, extra);
  if (typeof body.run_id !== "string" || !body.run_id) return badBody("run_id is the gateway run's id", "run_id");
  if (!count(body.peerings_removed)) return badBody("peerings_removed is a whole number", "peerings_removed");
  if (!count(body.dns_links_removed)) return badBody("dns_links_removed is a whole number", "dns_links_removed");
  if (typeof body.complete !== "boolean") return badBody("complete is true or false", "complete");
  const run = await db.getRun(env, body.run_id);
  if (!run || !run.callback_token_hash) return { status: 404, body: { error: "unknown run" } };
  if (!safeEqual(await sha256Hex(token), run.callback_token_hash)) return { status: 401, body: { error: "bad token" } };
  if (run.action !== "destroy" || run.finished_at || !["queued", "running"].includes(run.status)) return { status: 409, body: { error: "only a gateway destroy in progress removes lab peerings" } };
  const r = await env.DB.prepare(`UPDATE lab_sessions SET peering = 'disconnected' WHERE peering = 'on' AND state IN (${LIVE_SQL})`).run();
  const n = Number(r.meta?.changes ?? 0);
  if (n > 0 || !body.complete) {
    await db.addAlert(
      env,
      "info",
      `The gateway's tear-down removed ${body.peerings_removed} lab peering${body.peerings_removed === 1 ? "" : "s"} and ${body.dns_links_removed} DNS link${body.dns_links_removed === 1 ? "" : "s"}${body.complete ? "" : " (some could not be removed)"}. ${n} lab${n === 1 ? " is" : "s are"} now disconnected; Re-peer once the gateway is running again.`,
      run.id,
    );
  }
  return { status: 200, body: { message: "ok", disconnected: n } };
}
