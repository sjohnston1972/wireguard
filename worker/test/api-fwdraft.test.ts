// api-fwdraft.test.ts
//
// Plain English: firewall rule edits through the data API go into a draft
// first (/api/v1/firewall/draft...). The live rules, and so the VM, are
// untouched until Apply. These pin the draft's life: created by the first
// edit as a copy of the live rules and default, shown by GET /firewall with
// what Apply would change, deleted when it no longer differs from live,
// applied in one step (refused if the live rules moved on meanwhile), or
// discarded.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import worker from "../src/index";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent, currentFirewall } from "../src/runs";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const PHONE = "P".repeat(43) + "=";

const web = { name: "Web to the test VM", from: { kind: "zone", value: "clients" }, to: { kind: "cidr", value: "10.50.2.4" }, proto: "tcp", ports: "443", action: "allow" };

async function policy(env: Env) {
  return env.DB.prepare("SELECT live_version, draft_base, draft_default FROM fw_policy WHERE id = 1").first<{ live_version: number; draft_base: number | null; draft_default: string | null }>();
}
async function draftRows(env: Env) {
  return (await env.DB.prepare("SELECT * FROM fw_draft_rules ORDER BY position, id").all<{ id: number; live_id: number | null; name: string }>()).results;
}
async function fw(env: Env) {
  const r = await api(env, "GET", "/firewall");
  expect(r.status, r.text).toBe(200);
  return r.json;
}
const ids = (rs: { id: number }[]) => rs.map((r) => r.id);

describe("firewall drafts: editing", () => {
  it("first edit copies live rules and default with base = live version", async () => {
    const { env } = apiEnv();
    const live = await db.listFwRules(env);
    const before = await fw(env);
    expect(before.version).toBe(1);
    expect(before.draft).toBeNull();

    const r = await api(env, "POST", "/firewall/draft/rules", web);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ ok: true, message: expect.any(String) });

    expect(await policy(env)).toEqual({ live_version: 1, draft_base: 1, draft_default: "deny" });
    const rows = await draftRows(env);
    expect(rows.length).toBe(live.length + 1);
    expect(rows.slice(0, live.length).map((x) => [x.id, x.live_id])).toEqual(live.map((x) => [x.id, x.id]));
    expect(rows.at(-1)!.live_id).toBeNull();
    expect(rows.at(-1)!.id).toBeGreaterThan(Math.max(...live.map((x) => x.id)));

    const j = await fw(env);
    expect(j.version).toBe(1);
    expect(j.draft).toMatchObject({ baseVersion: 1, stale: false, defaultAction: "deny", changes: 1 });
    expect(j.draft.rules.length).toBe(live.length + 1);
    expect(j.draft.rules[0]).toMatchObject({ id: live[0].id, liveId: live[0].id, place: 1, mark: null, fromLabel: "Tunnel clients", toLabel: "Internet", service: "Any", problem: null });
    expect(j.draft.rules.at(-1)).toMatchObject({ liveId: null, place: live.length + 1, mark: "added", name: web.name, src_kind: "zone", dst_kind: "cidr", dst_value: "10.50.2.4/32", proto: "tcp", ports: "443", enabled: 1, log: 0, service: "TCP 443" });
    expect(j.draft.diff.added).toEqual([{ id: rows.at(-1)!.id, name: web.name, place: live.length + 1 }]);
  });

  it("draft edits leave GET firewall rules live and fill draft.diff", async () => {
    const { env } = apiEnv();
    const live = await db.listFwRules(env);
    const [a, b] = [live[1], live[2]];
    expect((await api(env, "PUT", `/firewall/draft/rules/${a.id}`, { name: "Renamed", enabled: false })).status).toBe(200);
    expect((await api(env, "DELETE", `/firewall/draft/rules/${b.id}`)).status).toBe(200);
    expect((await api(env, "PUT", "/firewall/draft/default", { action: "allow" })).status).toBe(200);

    expect(await db.listFwRules(env)).toEqual(live);
    expect(await db.getSetting(env, "firewall_default")).toBeNull();
    const j = await fw(env);
    expect(j.rules.map((x: { name: string }) => x.name)).toEqual(live.map((x) => x.name));
    expect(j.defaultAction).toBe("deny");
    expect(j.version).toBe(1);
    expect(j.draft.defaultAction).toBe("allow");
    expect(j.draft.changes).toBe(3);
    expect(j.draft.diff).toEqual({
      added: [],
      removed: [{ id: b.id, name: b.name, place: 3 }],
      changed: [{ id: a.id, name: "Renamed", fields: [{ field: "name", before: a.name, after: "Renamed" }, { field: "enabled", before: "on", after: "off" }] }],
      moved: [],
      defaultChanged: { before: "deny", after: "allow" },
    });
    expect(j.draft.rules.find((x: { id: number }) => x.id === a.id)).toMatchObject({ mark: "changed", enabled: 0, name: "Renamed" });
    expect(ids(j.draft.rules)).not.toContain(b.id);
  });

  it("add validates name, ends, proto and ports with the field", async () => {
    const { env } = apiEnv();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...web, name: "  " }, "name"],
      [{ ...web, name: "x".repeat(61) }, "name"],
      [{ ...web, name: 7 }, "name"],
      [{ ...web, from: undefined }, "from"],
      [{ ...web, from: { kind: "zone", value: "mars" } }, "from"],
      [{ ...web, from: { kind: "client", value: "99" } }, "from"],
      [{ ...web, to: { kind: "cidr", value: "nope" } }, "to"],
      [{ ...web, to: "anywhere" }, "to"],
      [{ ...web, proto: "gre" }, "proto"],
      [{ ...web, proto: "icmp", ports: "22" }, "ports"],
      [{ ...web, ports: "99999" }, "ports"],
      [{ ...web, ports: 443 }, "ports"],
      [{ ...web, action: undefined }, "action"],
      [{ ...web, action: "reject" }, "action"],
      [{ ...web, enabled: "yes" }, "enabled"],
      [{ ...web, log: 1 }, "log"],
      [{ ...web, colour: "red" }, "colour"],
    ];
    for (const [b, field] of cases) {
      const r = await api(env, "POST", "/firewall/draft/rules", b);
      expect(r.status, `${field}: ${r.text}`).toBe(400);
      expect(r.json.error, JSON.stringify(b)).toMatchObject({ code: "bad_input", field });
    }
    // Nothing refused left a draft behind.
    expect((await fw(env)).draft).toBeNull();
    // IPv6 networks are allowed in rules (the simulator alone is IPv4-only).
    const v6 = await api(env, "POST", "/firewall/draft/rules", { ...web, to: { kind: "cidr", value: "2001:DB8::/32" }, proto: "udp", ports: "53, 853" });
    expect(v6.status, v6.text).toBe(200);
    expect((await fw(env)).draft.rules.at(-1)).toMatchObject({ dst_value: "2001:db8::/32", ports: "53,853" });
  });

  it("edit validates as add does, and needs at least one field", async () => {
    const { env } = apiEnv();
    const [r1] = await db.listFwRules(env);
    for (const [b, field] of [
      [{ name: "" }, "name"],
      [{ ports: "22" }, "ports"], // the rule is proto any
      [{ to: { kind: "zone", value: "nowhere" } }, "to"],
      [{ id: 4 }, "id"],
    ] as [Record<string, unknown>, string][]) {
      const r = await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, b);
      expect(r.status, r.text).toBe(400);
      expect(r.json.error.field).toBe(field);
    }
    expect((await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, {})).status).toBe(400);
    expect((await fw(env)).draft).toBeNull();
    // Switching to tcp with ports in one go is fine; switching back to any drops the ports.
    expect((await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, { proto: "tcp", ports: "80" })).status).toBe(200);
    expect((await fw(env)).draft.rules[0]).toMatchObject({ proto: "tcp", ports: "80" });
    expect((await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, { proto: "any" })).status).toBe(200);
    expect((await fw(env)).draft).toBeNull();
  });

  it("move with dir and with to, to out of range is 400 to, unknown id 404", async () => {
    const { env } = apiEnv();
    const live = ids(await db.listFwRules(env));
    const [r1, r2, r3, r4, r5] = live;
    const order = async () => ids((await fw(env)).draft?.rules ?? (await db.listFwRules(env)));

    expect((await api(env, "POST", `/firewall/draft/rules/${r5}/move`, { to: 0 })).status).toBe(200);
    expect(await order()).toEqual([r5, r1, r2, r3, r4]);
    const j = await fw(env);
    expect(j.draft.diff.moved).toEqual([{ id: r5, name: expect.any(String), from: 5, to: 1 }]);
    expect(j.draft.rules[0].mark).toBe("moved");
    expect(j.draft.changes).toBe(1);

    expect((await api(env, "POST", `/firewall/draft/rules/${r5}/move`, { dir: "down" })).status).toBe(200);
    expect(await order()).toEqual([r1, r5, r2, r3, r4]);
    // Past the top: nothing moves.
    expect((await api(env, "POST", `/firewall/draft/rules/${r1}/move`, { dir: "up" })).status).toBe(200);
    expect(await order()).toEqual([r1, r5, r2, r3, r4]);
    // Dropped on its own place: nothing moves.
    expect((await api(env, "POST", `/firewall/draft/rules/${r2}/move`, { to: 2 })).status).toBe(200);
    expect(await order()).toEqual([r1, r5, r2, r3, r4]);

    // The default row is not a place a rule can go (it is always last, after index n-1).
    for (const b of [{ to: 5 }, { to: -1 }, { to: 1.5 }, { to: "0" }]) {
      const r = await api(env, "POST", `/firewall/draft/rules/${r5}/move`, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.field).toBe("to");
    }
    for (const b of [{ dir: "left" }, {}, { dir: "up", to: 1 }]) {
      const r = await api(env, "POST", `/firewall/draft/rules/${r5}/move`, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(["dir", "to"]).toContain(r.json.error.field);
    }
    const nf = await api(env, "POST", "/firewall/draft/rules/999/move", { dir: "up" });
    expect(nf.status).toBe(404);
    expect(nf.json.error.message).toBe("No such rule.");
    expect((await api(env, "POST", "/firewall/draft/rules/abc/move", { dir: "up" })).status).toBe(400);

    // Back to its live place: the draft is empty and goes.
    expect((await api(env, "POST", `/firewall/draft/rules/${r5}/move`, { to: 4 })).status).toBe(200);
    expect((await fw(env)).draft).toBeNull();
  });

  it("unknown rule ids are 404 and leave no draft", async () => {
    const { env } = apiEnv();
    for (const [m, b] of [["PUT", { name: "x" }], ["DELETE", undefined]] as const) {
      const r = await api(env, m, "/firewall/draft/rules/999", b);
      expect(r.status, r.text).toBe(404);
      expect(r.json.error).toMatchObject({ code: "not_found", message: "No such rule." });
    }
    expect((await fw(env)).draft).toBeNull();
    expect(await draftRows(env)).toEqual([]);
    expect((await policy(env))!.draft_base).toBeNull();
  });

  it("from-drop adds an allow rule to the draft", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "POST", "/firewall/draft/from-drop", { src: "10.13.13.2", dst: "10.50.2.9", proto: "TCP", dport: 22 });
    expect(r.status, r.text).toBe(200);
    expect(r.json.message).toContain("Allow Phone to 10.50.2.9 TCP 22");
    const last = (await fw(env)).draft.rules.at(-1);
    expect(last).toMatchObject({ mark: "added", src_kind: "client", src_value: String(p.id), dst_kind: "cidr", dst_value: "10.50.2.9/32", proto: "tcp", ports: "22", action: "allow", fromLabel: "Phone" });
    expect((await db.listFwRules(env)).some((x) => x.name.startsWith("Allow Phone"))).toBe(false);

    const bad = await api(env, "POST", "/firewall/draft/from-drop", { src: "nope", dst: "10.50.2.9", proto: "TCP", dport: 22 });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("src");
    const badPort = await api(env, "POST", "/firewall/draft/from-drop", { src: "10.13.13.2", dst: "10.50.2.9", proto: "TCP", dport: "22" });
    expect(badPort.status).toBe(400);
    expect(badPort.json.error.field).toBe("dport");
  });

  it("an edit back to live deletes the draft", async () => {
    const { env } = apiEnv();
    const [r1] = await db.listFwRules(env);
    expect((await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, { name: "Something else" })).status).toBe(200);
    expect((await fw(env)).draft).not.toBeNull();
    expect((await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, { name: r1.name })).status).toBe(200);
    expect((await fw(env)).draft).toBeNull();
    expect(await draftRows(env)).toEqual([]);
    expect(await policy(env)).toEqual({ live_version: 1, draft_base: null, draft_default: null });

    expect((await api(env, "PUT", "/firewall/draft/default", { action: "allow" })).status).toBe(200);
    expect((await fw(env)).draft.changes).toBe(1);
    expect((await api(env, "PUT", "/firewall/draft/default", { action: "deny" })).status).toBe(200);
    expect((await fw(env)).draft).toBeNull();
    const bad = await api(env, "PUT", "/firewall/draft/default", { action: "drop" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("action");
  });
});

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");
const STALE = "The live rules changed since this draft began. Discard it and start again.";

/** An old page route, posted as a form the way the browser does. */
async function page(env: Env, path: string, form: Record<string, string> = {}): Promise<number> {
  const r = await worker.fetch(
    new Request(base + path, { method: "POST", body: new URLSearchParams(form).toString(), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" } }),
    env,
    ctx,
  );
  await r.text();
  return r.status;
}

async function deployWith(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "dev@localhost" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

/** Everything Apply could touch, for "changed nothing". */
async function everything(env: Env) {
  const q = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return {
    rules: await q("SELECT * FROM fw_rules ORDER BY id"),
    draft: await q("SELECT * FROM fw_draft_rules ORDER BY id"),
    policy: await q("SELECT live_version, draft_base, draft_default FROM fw_policy"),
    settings: await q("SELECT * FROM settings ORDER BY key"),
    audit: await q("SELECT * FROM audit ORDER BY id"),
  };
}

describe("firewall drafts: apply, discard, staleness", () => {
  it("apply replaces fw_rules keeping kept ids, sets the default, bumps version, clears the draft, writes one firewall.apply audit", async () => {
    const { env } = apiEnv();
    const live = await db.listFwRules(env);
    const [r1, r2, r3, r4, r5] = live;
    expect((await api(env, "PUT", `/firewall/draft/rules/${r2.id}`, { name: "Renamed" })).status).toBe(200);
    expect((await api(env, "DELETE", `/firewall/draft/rules/${r3.id}`)).status).toBe(200);
    expect((await api(env, "POST", "/firewall/draft/rules", web)).status).toBe(200);
    expect((await api(env, "POST", `/firewall/draft/rules/${r5.id}/move`, { to: 0 })).status).toBe(200);
    expect((await api(env, "PUT", "/firewall/draft/default", { action: "allow" })).status).toBe(200);
    const d = (await fw(env)).draft;
    expect(d.changes).toBe(5);

    const r = await api(env, "POST", "/firewall/draft/apply", { baseVersion: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ ok: true, message: "Applied 5 changes. The VM picks them up within 30 seconds." });

    const now = await db.listFwRules(env);
    expect(now.map((x) => x.name)).toEqual([r5.name, r1.name, "Renamed", r4.name, web.name]);
    expect(now.slice(0, 4).map((x) => x.id)).toEqual([r5.id, r1.id, r2.id, r4.id]);
    expect(live.map((x) => x.id)).not.toContain(now[4].id);
    expect(now[4]).toMatchObject({ src_kind: "zone", src_value: "clients", dst_kind: "cidr", dst_value: "10.50.2.4/32", proto: "tcp", ports: "443", action: "allow", enabled: 1, log: 0 });
    expect(await db.getSetting(env, "firewall_default")).toBe("allow");
    expect(await policy(env)).toEqual({ live_version: 2, draft_base: null, draft_default: null });
    expect(await draftRows(env)).toEqual([]);
    const j = await fw(env);
    expect(j.version).toBe(2);
    expect(j.draft).toBeNull();
    expect(j.defaultAction).toBe("allow");

    const entries = (await db.listAudit(env, { kind: "firewall" })).filter((a) => a.action === "firewall.apply");
    expect(entries).toHaveLength(1);
    expect(entries[0].user).toBe("dev@localhost");
    expect(JSON.parse(entries[0].after_json!)).toMatchObject({ version: 2, diff: d.diff });
    expect(JSON.parse(entries[0].before_json!)).toMatchObject({ version: 1 });

    // What the VM is sent at its next heartbeat is the applied rule set.
    const compiled = await currentFirewall(env);
    expect(compiled.text).toContain("Renamed");
    expect(compiled.text).toContain(`# ${now[4].id}: ${web.name}`);
    expect(compiled.text).toMatch(/type filter hook forward priority filter \+ 10; policy accept;/);
  });

  it("apply with a stale baseVersion is 409 and changes nothing", async () => {
    const { env } = apiEnv();
    const [r1] = await db.listFwRules(env);
    expect((await api(env, "PUT", `/firewall/draft/rules/${r1.id}`, { name: "Draft name" })).status).toBe(200);

    // A wrong baseVersion while the draft is current.
    let was = await everything(env);
    let r = await api(env, "POST", "/firewall/draft/apply", { baseVersion: 7 });
    expect(r.status, r.text).toBe(409);
    expect(r.json.error.message).toBe(STALE);
    expect(await everything(env)).toEqual(was);

    // The live rules change underneath the draft (another tab, the old page, a restore).
    await db.bumpFwVersion(env);
    expect((await fw(env)).draft).toMatchObject({ baseVersion: 1, stale: true });
    was = await everything(env);
    for (const baseVersion of [1, 2]) {
      r = await api(env, "POST", "/firewall/draft/apply", { baseVersion });
      expect(r.status, `${baseVersion}: ${r.text}`).toBe(409);
      expect(r.json.error).toMatchObject({ code: "stale", message: STALE });
      expect(await everything(env)).toEqual(was);
    }
    // The batch guards itself too (a change landing between the route's check and the batch).
    for (const base of [1, 2]) {
      expect(await db.applyFwDraft(env, base, { user: "dev@localhost", target: "rule set", before: { version: base }, after: { version: base + 1 } })).toBe(false);
      expect(await everything(env)).toEqual(was);
    }

    for (const b of [{}, { baseVersion: "1" }, { baseVersion: 1.5 }, { baseVersion: 1, extra: true }]) {
      const bad = await api(env, "POST", "/firewall/draft/apply", b);
      expect(bad.status, JSON.stringify(b)).toBe(400);
    }
  });

  it("apply with no draft is 409 and changes nothing", async () => {
    const { env } = apiEnv();
    const was = await everything(env);
    const r = await api(env, "POST", "/firewall/draft/apply", { baseVersion: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("There is no draft to apply.");
    expect(await everything(env)).toEqual(was);
  });

  it("apply refuses 422 for a broken added rule but not for an unchanged broken copy", async () => {
    const { env } = apiEnv();
    await db.addFwRule(env, { enabled: 1, name: "Old broken", src_kind: "client", src_value: "99", dst_kind: "any", dst_value: "", proto: "any", ports: "", action: "allow", log: 0 });
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    expect((await api(env, "POST", "/firewall/draft/rules", { ...web, name: "Phone in", from: { kind: "client", value: String(p.id) } })).status).toBe(200);
    await db.deletePeer(env, p.id);
    const j = await fw(env);
    const added = j.draft.rules.at(-1);
    expect(added.problem).toMatch(/no longer exists/);

    const was = await everything(env);
    const r = await api(env, "POST", "/firewall/draft/apply", { baseVersion: 1 });
    expect(r.status, r.text).toBe(422);
    expect(r.json.error).toMatchObject({ field: "rules", message: `Rule ${added.place}, Phone in: ${added.problem}` });
    expect(await everything(env)).toEqual(was);

    expect((await api(env, "DELETE", `/firewall/draft/rules/${added.id}`)).status).toBe(200);
    expect((await api(env, "POST", "/firewall/draft/rules", web)).status).toBe(200);
    const ok = await api(env, "POST", "/firewall/draft/apply", { baseVersion: 1 });
    expect(ok.status, ok.text).toBe(200);
    expect((await db.listFwRules(env)).map((x) => x.name)).toContain("Old broken");
  });

  it("restore and a settings default change bump live_version", async () => {
    const { env } = apiEnv();
    const version = async () => (await fw(env)).version;
    expect(await version()).toBe(1);
    expect((await api(env, "PUT", "/firewall/draft/default", { action: "allow" })).status).toBe(200);

    expect((await api(env, "PUT", "/settings", { firewall_default: "allow" })).status).toBe(200);
    expect(await version()).toBe(2);
    expect((await fw(env)).draft.stale).toBe(true);
    // Saving it again unchanged, or another setting, is not a change to the rules.
    expect((await api(env, "PUT", "/settings", { firewall_default: "allow", idle_destroy_minutes: 45 })).status).toBe(200);
    expect(await version()).toBe(2);

    const file = JSON.parse((await api(env, "GET", "/backup/export")).text);
    const p = await api(env, "POST", "/backup/restore/preview", file);
    expect(p.status, p.text).toBe(200);
    expect((await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" })).status).toBe(200);
    expect(await version()).toBe(3);
    expect((await api(env, "POST", "/firewall/draft/apply", { baseVersion: 1 })).status).toBe(409);
  });

  it("the old page's rule and default edits bump live_version", async () => {
    const { env } = apiEnv();
    const version = async () => (await db.getFwPolicy(env)).live_version;
    const [r1] = await db.listFwRules(env);
    const steps: [string, Record<string, string>][] = [
      ["/firewall/rules", { name: "Old page rule", from: "zone:clients", to: "any", proto: "any", action: "allow" }],
      [`/firewall/rules/${r1.id}/down`, {}],
      [`/firewall/rules/${r1.id}/up`, {}],
      [`/firewall/rules/${r1.id}/toggle`, {}],
      [`/firewall/rules/${r1.id}/delete`, {}],
      ["/firewall/default", { value: "allow" }],
      ["/firewall/allow-drop", { src: "198.51.100.7", dst: "10.50.2.9", proto: "TCP", dport: "22" }],
    ];
    let v = await version();
    for (const [path, form] of steps) {
      expect(await page(env, path, form), path).toBe(200);
      expect(await version(), path).toBe(v + 1);
      v++;
    }
  });

  it("discard deletes the draft and is ok with none", async () => {
    const { env } = apiEnv();
    const live = await db.listFwRules(env);
    expect((await api(env, "POST", "/firewall/draft/rules", web)).status).toBe(200);
    expect((await api(env, "PUT", "/firewall/draft/default", { action: "allow" })).status).toBe(200);
    const r = await api(env, "DELETE", "/firewall/draft");
    expect(r.status, r.text).toBe(200);
    expect(r.json.ok).toBe(true);
    expect((await fw(env)).draft).toBeNull();
    expect(await draftRows(env)).toEqual([]);
    expect(await policy(env)).toEqual({ live_version: 1, draft_base: null, draft_default: null });
    expect(await db.listFwRules(env)).toEqual(live);
    const again = await api(env, "DELETE", "/firewall/draft");
    expect(again.status).toBe(200);
    expect(again.json.ok).toBe(true);
  });

  it("simulate with policy draft uses draft rules and default", async () => {
    const { env } = apiEnv();
    const flow = { from: { kind: "zone", value: "clients" }, to: { kind: "cidr", value: "10.50.2.4" }, proto: "tcp", port: 443 };
    const outside = { from: { kind: "cidr", value: "198.51.100.7" }, to: { kind: "cidr", value: "10.50.2.9" }, proto: "tcp", port: 22 };

    const none = await api(env, "POST", "/firewall/simulate", { ...flow, policy: "draft" });
    expect(none.status).toBe(400);
    expect(none.json.error.field).toBe("policy");
    const odd = await api(env, "POST", "/firewall/simulate", { ...flow, policy: "both" });
    expect(odd.status).toBe(400);
    expect(odd.json.error.field).toBe("policy");

    expect((await api(env, "POST", "/firewall/draft/rules", { ...web, name: "No web", action: "deny" })).status).toBe(200);
    const added = (await fw(env)).draft.rules.at(-1);
    expect((await api(env, "POST", `/firewall/draft/rules/${added.id}/move`, { to: 0 })).status).toBe(200);
    expect((await api(env, "PUT", "/firewall/draft/default", { action: "allow" })).status).toBe(200);

    const live = await api(env, "POST", "/firewall/simulate", flow);
    expect(live.json).toMatchObject({ verdict: "allow", matched: { place: 2 } });
    expect((await api(env, "POST", "/firewall/simulate", { ...flow, policy: "live" })).json).toEqual(live.json);
    const draft = await api(env, "POST", "/firewall/simulate", { ...flow, policy: "draft" });
    expect(draft.status, draft.text).toBe(200);
    expect(draft.json).toMatchObject({ verdict: "deny", matched: { id: added.id, name: "No web", place: 1 } });

    expect((await api(env, "POST", "/firewall/simulate", outside)).json).toMatchObject({ verdict: "deny", matched: null });
    expect((await api(env, "POST", "/firewall/simulate", { ...outside, policy: "draft" })).json).toMatchObject({ verdict: "allow", matched: null });
  });

  it("after apply the policy state is pending until the agent reports the new hash", async () => {
    const { env, world } = apiEnv();
    const token = await deployWith(env, world);
    const oldHash = (await currentFirewall(env)).hash;
    await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: oldHash, counters: {}, drops: [] } });
    expect((await fw(env)).policy.state).toBe("applied");

    expect((await api(env, "POST", "/firewall/draft/rules", web)).status).toBe(200);
    // A draft alone does not reach the VM.
    expect((await fw(env)).policy).toMatchObject({ state: "applied", hash: oldHash });
    expect((await api(env, "POST", "/firewall/draft/apply", { baseVersion: 1 })).status).toBe(200);
    const pending = (await fw(env)).policy;
    expect(pending.state).toBe("pending");
    expect(pending.hash).not.toBe(oldHash);

    const reply = (await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: oldHash, counters: {}, drops: [] } })).body as { firewall?: { hash: string; nft_b64: string } };
    expect(reply.firewall?.hash).toBe(pending.hash);
    expect(atob(reply.firewall!.nft_b64)).toContain(web.name);
    await handleAgent(env, token, { dump: DUMP([]), firewall: { hash: pending.hash, counters: {}, drops: [] } });
    expect((await fw(env)).policy).toMatchObject({ state: "applied", hash: pending.hash });
  });
});
