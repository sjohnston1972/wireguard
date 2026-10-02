// api/firewall.ts
//
// Plain English: the Firewall screen's data and its published-port and
// packet-capture actions. The rule table is read-only here (editing rules
// comes with the Firewall view's drafts); what you can change are the
// published ports (saved first, then Azure's edge is told, and if Azure
// refuses you hear it as a warning rather than losing the change), captures
// on the VM, and the hit counters.

import type { Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { idParam } from "./clients";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { clearFirewallCounters } from "../runs";
import { compileFirewall, endLabel, serviceLabel, zoneAddrs, checkForward, ZONE_LABEL, CAPTURE_IFACES, type Zone, type Forward } from "../firewall";
import { policyState, totalHits, dropsSince, dropStats24h, fwHitsLast24h, vmUpHours24h, onlyWhenUp, isStarterRule } from "../fwview";
import { syncPublished } from "../published";
import { startCapture, captureFilter, validFilter } from "../capture";
import type { ApiOk, FirewallResponse } from "../../../shared/api";

const DAY_MS = 86_400_000;
const FILTER_PROBLEM = "That filter has characters a capture filter never needs.";

type Obj = Record<string, unknown>;
type Problem = { message: string; field: string };

/** Type problems in a published-port body: every field present must be the right JSON type. `required` also demands the ones the form needs. */
function forwardTypes(b: Obj, required: boolean): Problem | null {
  const text = (k: string) => b[k] !== undefined && typeof b[k] !== "string" && { message: `${k} must be text.`, field: k };
  const num = (k: string, nullable: boolean) => b[k] !== undefined && !(nullable && b[k] === null) && !(typeof b[k] === "number" && Number.isInteger(b[k])) && { message: `${k} must be a whole number.`, field: k };
  if (required) {
    if (b.proto !== "tcp" && b.proto !== "udp") return { message: 'proto must be "tcp" or "udp".', field: "proto" };
    if (!Number.isInteger(b.public_port)) return { message: "public_port must be a whole number.", field: "public_port" };
    if (typeof b.target_ip !== "string") return { message: "target_ip must be text.", field: "target_ip" };
  }
  if (b.proto !== undefined && b.proto !== "tcp" && b.proto !== "udp") return { message: 'proto must be "tcp" or "udp".', field: "proto" };
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { message: "enabled must be true or false.", field: "enabled" };
  return text("name") || num("public_port", false) || text("target_ip") || num("target_port", true) || (b.allow_from !== null && text("allow_from")) || null;
}

/** "TCP 8080", as the audit trail names a published port. */
const forwardLabel = (f: { name: string; proto: string; public_port: number }) => `${f.name} (${f.proto.toUpperCase()} ${f.public_port})`;

export function registerFirewall(api: Hono<ApiEnv>): void {
  api.get("/firewall", async (c) => {
    const [rules, peers, cfg, snap, forwards, captures] = await Promise.all([db.listFwRules(c.env), db.listPeers(c.env), effectiveConfig(c.env), getSnapshot(c.env), db.listForwards(c.env), db.listCaptures(c.env)]);
    const fw = await compileFirewall(rules, cfg, peers, cfg.firewallDefault, forwards);
    const ps = policyState(snap, fw.hash);
    const now = Date.now();
    const [last24h, dropStats, fwHits, up] = await Promise.all([dropsSince(c.env, new Date(now - DAY_MS).toISOString()), dropStats24h(c.env, now), fwHitsLast24h(c.env, now), vmUpHours24h(c.env, now)]);
    const flat = Array<number>(24).fill(0);
    // null when nothing at all was recorded; 0 when history exists but this counter did not match.
    const hits = (key: string) => (fwHits ? (fwHits[key]?.packets ?? 0) : null);
    // [] when nothing at all was recorded; otherwise 24 hours with the hours the VM was down as null.
    const trend = (key: string) => (fwHits ? onlyWhenUp(fwHits[key]?.trend ?? flat, up) : []);
    const lastHit = snap.firewall?.last_hit ?? {};
    const who = (ip: string) => peers.find((p) => p.ip === ip)?.name ?? ip;
    const out: FirewallResponse = {
      now: new Date(now).toISOString(),
      running: snap.state === "running",
      defaultAction: cfg.firewallDefault,
      policy: { hash: fw.hash, state: ps.state, text: ps.text },
      rules: rules.map((r, i) => ({
        ...r,
        place: i + 1,
        fromLabel: endLabel(r.src_kind, r.src_value, peers),
        toLabel: endLabel(r.dst_kind, r.dst_value, peers),
        service: serviceLabel(r),
        hits: totalHits(snap, `r${r.id}`),
        lastHit: lastHit[`r${r.id}`] ?? null,
        problem: fw.problems[r.id] ?? null,
        hits24h: hits(`r${r.id}`),
        trend24h: trend(`r${r.id}`),
        starter: isStarterRule(r),
      })),
      defaultHits: totalHits(snap, "default"),
      defaultHits24h: hits("default"),
      defaultTrend24h: trend("default"),
      defaultLastHit: lastHit.default ?? null,
      countersClearedAt: snap.fw_cleared_at,
      drops: { recent: (snap.firewall?.drops ?? []).map((d) => ({ at: d.at, src: d.src, dst: d.dst, proto: d.proto, dport: d.dport, fromName: who(d.src), toName: who(d.dst) })), last24h, uniqueSources24h: dropStats.uniqueSources, previous24h: dropStats.previous, hourly24h: onlyWhenUp(dropStats.hourly, up) },
      zones: (Object.keys(ZONE_LABEL) as Zone[]).map((z) => {
        const a = zoneAddrs(z, cfg);
        return { zone: z, label: ZONE_LABEL[z], v4: a.v4, v6: a.v6, negate: !!a.negate };
      }),
      testVm: { ip: snap.test_vm_ip, enabled: cfg.testVm },
      forwards: forwards.map((f) => ({ ...f, connections: totalHits(snap, `f${f.id}`), lastHit: lastHit[`f${f.id}`] ?? null })),
      captures,
      capture: { busy: !!snap.capture_req, ifaces: CAPTURE_IFACES },
      publicIp: snap.public_ip,
      dnsName: cfg.dnsName,
      kpis: { rules: rules.length, enabled: rules.filter((r) => r.enabled).length, defaultAction: cfg.firewallDefault, drops24h: last24h, published: forwards.filter((f) => f.enabled).length, captureBusy: !!snap.capture_req },
      // Placeholders until the draft backend (plan 4 area A) reads fw_policy and the draft.
      version: 1,
      draft: null,
    };
    return c.json(out);
  });

  api.post("/firewall/forwards", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    const t = forwardTypes(b, true);
    if (t) return fail(c, 400, "bad_input", t.message, t.field);
    const chk = checkForward(b, await effectiveConfig(c.env));
    if (!chk.ok) return fail(c, 400, "bad_input", chk.message, chk.field);
    const f = chk.value;
    const taken = `${f.proto.toUpperCase()} ${f.public_port} is already published.`;
    if ((await db.listForwards(c.env)).some((x) => x.proto === f.proto && x.public_port === f.public_port)) return fail(c, 409, "conflict", taken, "public_port");
    try {
      await db.addForward(c.env, f);
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message)) return fail(c, 409, "conflict", taken, "public_port");
      throw e;
    }
    const user = c.get("user");
    await db.addAlert(c.env, "info", `Published ${f.proto.toUpperCase()} ${f.public_port} to ${f.target_ip}:${f.target_port} (${f.name}) by ${user}.`);
    await db.audit(c.env, user, "firewall.forward.add", forwardLabel(f), null, f);
    const err = await syncPublished(c.env);
    const out: ApiOk = { ok: true, message: `Published ${f.proto.toUpperCase()} ${f.public_port} → ${f.target_ip}:${f.target_port}. It works within 30 seconds.`, ...(err ? { warning: `Saved, but Azure did not open the port: ${err}` } : {}) };
    return c.json(out);
  });

  api.put("/firewall/forwards/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a published port's number.", "id");
    const b = (await body<Obj>(c)) ?? {};
    const t = forwardTypes(b, false);
    if (t) return fail(c, 400, "bad_input", t.message, t.field);
    const was = (await db.listForwards(c.env)).find((x) => x.id === id);
    if (!was) return fail(c, 404, "not_found", "No such published port.");
    // The body is laid over what is stored, then the whole is checked as if it were new.
    const chk = checkForward({ ...was, ...b, ...(b.allow_from === null ? { allow_from: "" } : {}) }, await effectiveConfig(c.env));
    if (!chk.ok) return fail(c, 400, "bad_input", chk.message, chk.field);
    const next: Omit<Forward, "id"> = { ...chk.value, enabled: typeof b.enabled === "boolean" ? (b.enabled ? 1 : 0) : was.enabled };
    const taken = `${next.proto.toUpperCase()} ${next.public_port} is already published.`;
    if ((await db.listForwards(c.env)).some((x) => x.id !== id && x.proto === next.proto && x.public_port === next.public_port)) return fail(c, 409, "conflict", taken, "public_port");
    try {
      await db.updateForward(c.env, id, next);
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message)) return fail(c, 409, "conflict", taken, "public_port");
      throw e;
    }
    const onlyEnabled = (["name", "proto", "public_port", "target_ip", "target_port", "allow_from"] as const).every((k) => next[k] === was[k]) && next.enabled !== was.enabled;
    const action = onlyEnabled ? (next.enabled ? "firewall.forward.enable" : "firewall.forward.disable") : "firewall.forward.edit";
    await db.audit(c.env, c.get("user"), action, forwardLabel(was), was, { id, ...next });
    const err = await syncPublished(c.env);
    const out: ApiOk = { ok: true, message: `Saved ${forwardLabel(next)}.`, ...(err ? { warning: `Saved, but Azure did not update: ${err}` } : {}) };
    return c.json(out);
  });

  api.delete("/firewall/forwards/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a published port's number.", "id");
    const f = (await db.listForwards(c.env)).find((x) => x.id === id);
    if (!f) return fail(c, 404, "not_found", "No such published port.");
    await db.deleteForward(c.env, id);
    await db.audit(c.env, c.get("user"), "firewall.forward.delete", forwardLabel(f), f, null);
    const err = await syncPublished(c.env);
    const out: ApiOk = { ok: true, message: `Stopped publishing ${forwardLabel(f)}.`, ...(err ? { warning: `Saved, but Azure did not update: ${err}` } : {}) };
    return c.json(out);
  });

  api.post("/firewall/captures", async (c) => {
    const b = (await body<Obj>(c)) ?? {};
    if (typeof b.iface !== "string" || !Object.hasOwn(CAPTURE_IFACES, b.iface)) return fail(c, 400, "bad_input", `iface must be one of: ${Object.keys(CAPTURE_IFACES).join(", ")}.`, "iface");
    if (typeof b.seconds !== "number" || !Number.isInteger(b.seconds) || b.seconds < 5 || b.seconds > 300) return fail(c, 400, "bad_input", "seconds must be a whole number from 5 to 300.", "seconds");
    const who = b.who ?? "any";
    if (who !== "any" && (typeof who !== "number" || !Number.isInteger(who) || who < 1)) return fail(c, 400, "bad_input", 'who must be "any" or a client\'s number.', "who");
    if (b.filter !== undefined && typeof b.filter !== "string") return fail(c, 400, "bad_input", "filter must be text.", "filter");
    const extra = (b.filter ?? "").toString().trim();
    if (!validFilter(extra)) return fail(c, 400, "bad_input", FILTER_PROBLEM, "filter");
    if (who !== "any" && !(await db.getPeer(c.env, who as number))) return fail(c, 404, "not_found", "No such client.", "who");
    const filter = await captureFilter(c.env, who === "any" ? "any" : `client:${who}`, extra);
    const user = c.get("user");
    const message = await startCapture(c.env, { iface: b.iface, filter, seconds: b.seconds, by: user });
    await db.audit(c.env, user, "capture.start", b.iface, null, { iface: b.iface, filter, seconds: b.seconds });
    const out: ApiOk = { ok: true, message };
    return c.json(out);
  });

  api.post("/firewall/counters/clear", async (c) => {
    const user = c.get("user");
    await clearFirewallCounters(c.env);
    await db.addAlert(c.env, "info", `Firewall hit counters cleared by ${user}.`);
    await db.audit(c.env, user, "firewall.counters.clear", "hit counters");
    const out: ApiOk = { ok: true, message: "Counters cleared. Hits count from zero again." };
    return c.json(out);
  });
}
