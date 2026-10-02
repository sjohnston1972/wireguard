// api/simulate.ts
//
// Plain English: the Firewall screen's "what would happen if..." box. You post
// a flow (from, to, protocol, port) and get back whether the live rules allow
// it and which rule decides. Nothing is written. The checking of the request
// lives here; the answer itself comes from simulate.ts.

import type { Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { ZONE_LABEL, parseCidr, type EndKind } from "../firewall";
import { simulate, type SimEndInput } from "../simulate";
import type { SimResult } from "../../../shared/api";

type Obj = Record<string, unknown>;
type Checked = { end: SimEndInput; clientId: number | null } | { error: string; field: string };

const KINDS: EndKind[] = ["any", "zone", "client", "cidr"];

/** One end of the flow, checked for its shape. A client's existence is checked by the caller. */
function checkEnd(raw: unknown, field: "from" | "to"): Checked {
  const bad = (error: string) => ({ error, field });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad(`${field} must be an object with a kind and a value.`);
  const { kind, value } = raw as Obj;
  if (typeof kind !== "string" || !KINDS.includes(kind as EndKind)) return bad(`${field}.kind must be one of: ${KINDS.join(", ")}.`);
  if (kind === "any") return { end: { kind: "any", value: "" }, clientId: null };
  if (kind === "zone") {
    if (typeof value !== "string" || !Object.hasOwn(ZONE_LABEL, value)) return bad(`${field}.value must be one of: ${Object.keys(ZONE_LABEL).join(", ")}.`);
    return { end: { kind: "zone", value }, clientId: null };
  }
  if (kind === "client") {
    const text = typeof value === "number" ? String(value) : value;
    const id = typeof text === "string" && /^\d+$/.test(text) ? Number(text) : 0;
    if (!Number.isSafeInteger(id) || id < 1) return bad(`${field}.value must be a client's number.`);
    return { end: { kind: "client", value: String(id) }, clientId: id };
  }
  const c = typeof value === "string" ? parseCidr(value) : null;
  if (!c) return bad(`${field}.value must be an IPv4 address or network.`);
  if (c.family !== 4) return bad("IPv6 is not simulated yet");
  return { end: { kind: "cidr", value: c.text }, clientId: null };
}

export function registerSimulate(api: Hono<ApiEnv>): void {
  api.post("/firewall/simulate", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    const from = checkEnd(b.from, "from");
    if ("error" in from) return fail(c, 400, "bad_input", from.error, from.field);
    const to = checkEnd(b.to, "to");
    if ("error" in to) return fail(c, 400, "bad_input", to.error, to.field);
    const proto = b.proto;
    if (proto !== "tcp" && proto !== "udp" && proto !== "icmp") return fail(c, 400, "bad_input", 'proto must be "tcp", "udp" or "icmp".', "proto");
    const port = b.port ?? null;
    if (port !== null) {
      if (proto === "icmp") return fail(c, 400, "bad_input", "A port only applies to tcp and udp.", "port");
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return fail(c, 400, "bad_input", "port must be a whole number from 1 to 65535.", "port");
    }
    for (const [e, field] of [[from, "from"], [to, "to"]] as const) {
      if (e.clientId !== null && !(await db.getPeer(c.env, e.clientId))) return fail(c, 404, "not_found", "No such client.", field);
    }
    const [rules, peers, cfg, snap, forwards] = await Promise.all([db.listFwRules(c.env), db.listPeers(c.env), effectiveConfig(c.env), getSnapshot(c.env), db.listForwards(c.env)]);
    const out: SimResult = simulate({ from: from.end, to: to.end, proto, port: port as number | null }, { rules, defaultAction: cfg.firewallDefault, cfg, peers, publicIp: snap.public_ip, forwards });
    return c.json(out);
  });
}
