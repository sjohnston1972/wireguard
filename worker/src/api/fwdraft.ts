// api/fwdraft.ts
//
// Plain English: rule edits from the Firewall screen. They never touch the
// live rules: the first edit copies the live rules and default into a draft
// (each copied rule keeps its id, so the screen names a rule the same way
// with or without a draft), later edits change the draft, and an edit that
// leaves the draft the same as live deletes it. Apply puts the draft live in
// one step, refused (409) if the live rules changed after the draft began;
// Discard throws it away. Published ports and captures stay instant
// (api/firewall.ts).

import type { Context, Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { idParam } from "./clients";
import * as db from "../db";
import { effectiveConfig } from "../settings";
import { ZONE_LABEL, parseCidr, parsePorts, type EndKind, type Proto } from "../firewall";
import { draftView, moveTo, ruleFromDrop, type RuleBody } from "../fwdraft";
import type { Env } from "../env";
import type { Peer } from "../db";
import type { ApiOk, FirewallDraft } from "../../../shared/api";

type Obj = Record<string, unknown>;
type Problem = { message: string; field?: string };

const KINDS: EndKind[] = ["any", "zone", "client", "cidr"];
const PROTOS: Proto[] = ["any", "tcp", "udp", "icmp"];
const RULE_FIELDS = ["name", "from", "to", "proto", "ports", "action", "enabled", "log"];
const NO_RULE = "No such rule.";
const STALE = "The live rules changed since this draft began. Discard it and start again.";

/** The draft as GET /firewall shows it, or null when there is none. */
export async function loadDraft(env: Env, o?: { peers?: Peer[] }): Promise<FirewallDraft | null> {
  const pol = await db.getFwPolicy(env);
  if (pol.draft_base === null) return null;
  const [live, draft, peers, cfg] = await Promise.all([db.listFwRules(env), db.listFwDraftRules(env), o?.peers ?? db.listPeers(env), effectiveConfig(env)]);
  return draftView({ live, liveDefault: cfg.firewallDefault, draft, draftDefault: pol.draft_default ?? cfg.firewallDefault, peers, cfg, baseVersion: pol.draft_base, liveVersion: pol.live_version });
}

/** After a draft write: a draft that no longer differs from live is deleted. */
async function settle(env: Env): Promise<void> {
  const d = await loadDraft(env);
  if (d && d.changes === 0) await db.dropFwDraft(env);
}

/** The rules the screen is showing right now: the draft's when there is one, else the live ones. */
async function shownRules(env: Env): Promise<{ id: number; position: number }[]> {
  return (await db.getFwPolicy(env)).draft_base === null ? db.listFwRules(env) : db.listFwDraftRules(env);
}

/** One end of a rule: the simulator's kinds, IPv6 networks included. A client must exist. */
function ruleEnd(raw: unknown, field: "from" | "to", peers: Peer[]): { kind: EndKind; value: string } | Problem {
  const bad = (message: string) => ({ message, field });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad(`${field} must be an object with a kind and a value.`);
  const { kind, value } = raw as Obj;
  if (typeof kind !== "string" || !KINDS.includes(kind as EndKind)) return bad(`${field}.kind must be one of: ${KINDS.join(", ")}.`);
  if (kind === "any") return { kind: "any", value: "" };
  if (kind === "zone") {
    if (typeof value !== "string" || !Object.hasOwn(ZONE_LABEL, value)) return bad(`${field}.value must be one of: ${Object.keys(ZONE_LABEL).join(", ")}.`);
    return { kind: "zone", value };
  }
  if (kind === "client") {
    const text = typeof value === "number" ? String(value) : value;
    const id = typeof text === "string" && /^\d+$/.test(text) ? Number(text) : 0;
    if (!Number.isSafeInteger(id) || id < 1) return bad(`${field}.value must be a client's number.`);
    if (!peers.some((p) => p.id === id)) return bad("No such client.");
    return { kind: "client", value: String(id) };
  }
  const c = typeof value === "string" ? parseCidr(value) : null;
  if (!c) return bad(`${field}.value must be an IP address or network.`);
  return { kind: "cidr", value: c.text };
}

/**
 * A rule body checked field by field: a whole rule when `was` is null (add),
 * or the fields given laid over `was` (edit). Every field present must be
 * the right type; a name is 1 to 60 characters; ports only for tcp and udp,
 * and only a real port list. Changing to a protocol without ports drops them.
 */
function checkRule(b: Obj, was: RuleBody | null, peers: Peer[]): RuleBody | Problem {
  const extra = Object.keys(b).find((k) => !RULE_FIELDS.includes(k));
  if (extra) return { message: `${extra} is not something a rule has.`, field: extra };
  if (was && !Object.keys(b).length) return { message: "Send at least one field to change." };
  const need = (k: string) => !was || b[k] !== undefined;
  const out: RuleBody = was ? { ...was } : ({} as RuleBody);
  if (need("name")) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 60) return { message: "A rule's name is 1 to 60 characters.", field: "name" };
    out.name = name;
  }
  for (const [field, kind, value] of [["from", "src_kind", "src_value"], ["to", "dst_kind", "dst_value"]] as const) {
    if (!need(field)) continue;
    const e = ruleEnd(b[field], field, peers);
    if ("message" in e) return e;
    out[kind] = e.kind;
    out[value] = e.value;
  }
  if (need("proto")) {
    if (!PROTOS.includes(b.proto as Proto)) return { message: `proto must be one of: ${PROTOS.join(", ")}.`, field: "proto" };
    out.proto = b.proto as Proto;
  }
  if (need("action")) {
    if (b.action !== "allow" && b.action !== "deny") return { message: 'action must be "allow" or "deny".', field: "action" };
    out.action = b.action;
  }
  for (const k of ["enabled", "log"] as const) {
    if (b[k] !== undefined && typeof b[k] !== "boolean") return { message: `${k} must be true or false.`, field: k };
    if (b[k] !== undefined) out[k] = b[k] ? 1 : 0;
    else if (!was) out[k] = k === "enabled" ? 1 : 0;
  }
  if (b.ports !== undefined && typeof b.ports !== "string") return { message: 'ports must be text, such as "443", "80,443" or "8000-8100".', field: "ports" };
  const ports = b.ports !== undefined ? (b.ports as string).replace(/\s+/g, "") : (was?.ports ?? "");
  if (out.proto === "tcp" || out.proto === "udp") {
    if (parsePorts(ports) === null) return { message: `"${ports}" is not a port list (try 8080, 80,443 or 8000-8100).`, field: "ports" };
    out.ports = ports;
  } else {
    if (b.ports !== undefined && ports !== "") return { message: "Ports only apply to tcp and udp.", field: "ports" };
    out.ports = "";
  }
  return out;
}

const ok = (c: Context<ApiEnv>, message: string) => c.json({ ok: true, message } satisfies ApiOk);
const noId = (c: Context<ApiEnv>) => fail(c, 400, "bad_input", "id must be a rule's number.", "id");

export function registerFwDraft(api: Hono<ApiEnv>): void {
  api.post("/firewall/draft/rules", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    const r = checkRule(b, null, await db.listPeers(c.env));
    if ("message" in r) return fail(c, 400, "bad_input", r.message, r.field);
    await db.ensureFwDraft(c.env);
    await db.addFwDraftRule(c.env, r);
    await settle(c.env);
    return ok(c, `Added "${r.name}" to the draft.`);
  });

  api.put("/firewall/draft/rules/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c);
    const b = (await body<Obj>(c)) ?? {};
    const pol = await db.getFwPolicy(c.env);
    const was = (pol.draft_base === null ? await db.listFwRules(c.env) : await db.listFwDraftRules(c.env)).find((x) => x.id === id);
    if (!was) return fail(c, 404, "not_found", NO_RULE);
    const r = checkRule(b, was, await db.listPeers(c.env));
    if ("message" in r) return fail(c, 400, "bad_input", r.message, r.field);
    await db.ensureFwDraft(c.env);
    await db.updateFwDraftRule(c.env, id, r);
    await settle(c.env);
    return ok(c, `Saved "${r.name}" in the draft.`);
  });

  api.post("/firewall/draft/rules/:id/move", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c);
    const b = (await body<Obj>(c)) ?? {};
    const extra = Object.keys(b).find((k) => k !== "dir" && k !== "to");
    if (extra) return fail(c, 400, "bad_input", `${extra} is not part of a move.`, extra);
    if (b.dir !== undefined && b.to !== undefined) return fail(c, 400, "bad_input", "Send dir or to, not both.", "to");
    if (b.dir === undefined && b.to === undefined) return fail(c, 400, "bad_input", 'Send dir ("up" or "down") or to (a place in the list, from 0).', "dir");
    if (b.dir !== undefined && b.dir !== "up" && b.dir !== "down") return fail(c, 400, "bad_input", 'dir must be "up" or "down".', "dir");
    const shown = await shownRules(c.env);
    if (!shown.some((x) => x.id === id)) return fail(c, 404, "not_found", NO_RULE);
    if (b.to !== undefined && !(typeof b.to === "number" && Number.isInteger(b.to) && b.to >= 0 && b.to < shown.length)) {
      return fail(c, 400, "bad_input", `to must be a whole number from 0 to ${shown.length - 1} (the default rule stays last).`, "to");
    }
    await db.ensureFwDraft(c.env);
    const draft = await db.listFwDraftRules(c.env);
    const at = draft.findIndex((x) => x.id === id);
    const to = b.to !== undefined ? (b.to as number) : at + (b.dir === "up" ? -1 : 1);
    const next = moveTo(draft, id, to);
    if (next.some((r, i) => r.id !== draft[i].id)) await db.orderFwDraft(c.env, next.map((r) => r.id));
    await settle(c.env);
    return ok(c, "Moved in the draft.");
  });

  api.delete("/firewall/draft/rules/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return noId(c);
    const gone = (await shownRules(c.env)).find((x) => x.id === id) as { name?: string } | undefined;
    if (!gone) return fail(c, 404, "not_found", NO_RULE);
    await db.ensureFwDraft(c.env);
    await db.deleteFwDraftRule(c.env, id);
    await settle(c.env);
    return ok(c, `Removed "${gone.name}" in the draft.`);
  });

  api.put("/firewall/draft/default", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    const extra = Object.keys(b).find((k) => k !== "action");
    if (extra) return fail(c, 400, "bad_input", `${extra} is not part of the default.`, extra);
    if (b.action !== "allow" && b.action !== "deny") return fail(c, 400, "bad_input", 'action must be "allow" or "deny".', "action");
    await db.ensureFwDraft(c.env);
    await db.setFwDraftDefault(c.env, b.action);
    await settle(c.env);
    return ok(c, `Default set to ${b.action} in the draft.`);
  });

  api.post("/firewall/draft/from-drop", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    const extra = Object.keys(b).find((k) => !["src", "dst", "proto", "dport"].includes(k));
    if (extra) return fail(c, 400, "bad_input", `${extra} is not part of a drop.`, extra);
    for (const k of ["src", "dst", "proto"]) if (typeof b[k] !== "string") return fail(c, 400, "bad_input", `${k} must be text.`, k);
    if (b.dport !== undefined && b.dport !== null && !(typeof b.dport === "number" && Number.isInteger(b.dport))) return fail(c, 400, "bad_input", "dport must be a whole number or null.", "dport");
    const r = ruleFromDrop({ src: b.src as string, dst: b.dst as string, proto: b.proto as string, dport: (b.dport as number | null | undefined) ?? null }, await db.listPeers(c.env));
    if (!r) return fail(c, 400, "bad_input", "That drop has no usable addresses.", "src");
    await db.ensureFwDraft(c.env);
    await db.addFwDraftRule(c.env, r);
    await settle(c.env);
    return ok(c, `Added "${r.name}" to the draft. Review and apply to let it through.`);
  });

  api.post("/firewall/draft/apply", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    const extra = Object.keys(b).find((k) => k !== "baseVersion");
    if (extra) return fail(c, 400, "bad_input", `${extra} is not part of an apply.`, extra);
    const base = b.baseVersion;
    if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 1) return fail(c, 400, "bad_input", "baseVersion must be the version GET /firewall gave.", "baseVersion");
    const pol = await db.getFwPolicy(c.env);
    if (pol.draft_base === null) return fail(c, 409, "no_draft", "There is no draft to apply.");
    if (pol.draft_base !== base || pol.live_version !== base) return fail(c, 409, "stale", STALE);
    const d = (await loadDraft(c.env))!;
    // A rule the VM could not load would make it refuse the whole set. Rules
    // already broken in live and left alone do not block (the VM skips them today).
    const broken = d.rules.find((r) => (r.mark === "added" || r.mark === "changed") && r.enabled && r.problem);
    if (broken) return fail(c, 422, "rule_problem", `Rule ${broken.place}, ${broken.name}: ${broken.problem}`, "rules");
    const applied = await db.applyFwDraft(c.env, base, {
      user: c.get("user"),
      target: "rule set",
      before: { version: base },
      after: { version: base + 1, changes: d.changes, diff: d.diff },
    });
    if (!applied) return fail(c, 409, "stale", STALE);
    return ok(c, `Applied ${d.changes} change${d.changes === 1 ? "" : "s"}. The VM picks them up within 30 seconds.`);
  });

  api.delete("/firewall/draft", async (c) => {
    const had = (await db.getFwPolicy(c.env)).draft_base !== null;
    await db.dropFwDraft(c.env);
    return ok(c, had ? "Draft discarded. The live rules are as they were." : "There was no draft.");
  });
}
