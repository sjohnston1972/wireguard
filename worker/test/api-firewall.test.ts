// api-firewall.test.ts
//
// Plain English: the Firewall screen's data and its published-port and
// packet-capture actions (/api/v1/firewall...), plus the old page routes
// they share logic with, pinned so the refactor changes nothing there:
// the rule table with hits and policy state, recent drops, published ports
// (saved, then Azure told; a refusal from Azure is a warning, not a loss),
// captures, and clearing the counters.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import worker from "../src/index";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent, currentFirewall } from "../src/runs";
import { getSnapshot } from "../src/state";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const PHONE = "P".repeat(43) + "=";
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

/** An old page route, posted as a form the way the browser does. */
async function page(env: Env, path: string, form: Record<string, string> = {}): Promise<string> {
  const r = await worker.fetch(
    new Request(base + path, { method: "POST", body: new URLSearchParams(form).toString(), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" } }),
    env,
    ctx,
  );
  return r.text();
}

async function deployWith(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

const fwd = { name: "Test VM web", proto: "tcp", public_port: 8080, target_ip: "10.50.2.4" };

describe("the old firewall page routes (pinned before the refactor)", () => {
  it("publish: refuses an empty name, a bad target and a bad source with the same words", async () => {
    const { env } = apiEnv();
    expect(await page(env, "/firewall/forwards", { name: " ", proto: "tcp", public_port: "8080", target_ip: "10.50.2.4" })).toContain("Not published: Give it a name.");
    expect(await page(env, "/firewall/forwards", { name: "x", public_port: "0", target_ip: "10.50.2.4" })).toContain("Not published: Ports are 1 to 65535.");
    expect(await page(env, "/firewall/forwards", { name: "x", public_port: "51820", target_ip: "10.50.2.4" })).toContain("Not published: Port 51820 is");
    expect(await page(env, "/firewall/forwards", { name: "x", public_port: "80", target_ip: "8.8.8.8" })).toContain("Not published: The target must be an address in the Azure VNet (10.50.0.0/16)");
    expect(await page(env, "/firewall/forwards", { name: "x", public_port: "80", target_ip: "10.50.2.4", allow_from: "nope" })).toContain("Not published: Allowed from must be an IPv4 address or network, or blank for anywhere.");
    expect(await db.listForwards(env)).toEqual([]);
  });

  it("publish: saves, audits, and refuses a duplicate", async () => {
    const { env } = apiEnv();
    expect(await page(env, "/firewall/forwards", { name: "Web", proto: "tcp", public_port: "8080", target_ip: "10.50.2.4", allow_from: "203.0.113.7" })).toContain("Published TCP 8080 → 10.50.2.4:8080. It works within 30 seconds.");
    expect(await db.listForwards(env)).toMatchObject([{ name: "Web", target_port: 8080, allow_from: "203.0.113.7/32" }]);
    expect((await db.listAudit(env, { limit: 10 })).map((a) => a.action)).toContain("firewall.forward.add");
    expect(await page(env, "/firewall/forwards", { name: "Again", proto: "tcp", public_port: "8080", target_ip: "10.50.2.4" })).toContain("Not published: TCP 8080 is already published.");
  });

  it("capture: a client's traffic is filtered by its address, and a bad filter is refused", async () => {
    const { env, world } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    await deployWith(env, world);
    expect(await page(env, "/firewall/capture", { iface: "wg0", who: "any", filter: "-w /x", seconds: "30" })).toContain("That filter has characters a capture filter never needs.");
    expect(await page(env, "/firewall/capture", { iface: "wg0", who: `client:${p.id}`, filter: "tcp port 443", seconds: "30" })).toContain("Capture started");
    expect((await getSnapshot(env)).capture_req?.filter).toBe("host 10.13.13.2 and (tcp port 443)");
  });

  it("clear counters: says so and audits", async () => {
    const { env } = apiEnv();
    expect(await page(env, "/firewall/clear")).toContain("Counters cleared. Hits count from zero again.");
    expect((await db.listAudit(env, { limit: 10 })).map((a) => a.action)).toContain("firewall.counters.clear");
  });
});
