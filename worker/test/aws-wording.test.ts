// aws-wording.test.ts
//
// Plain English: on an AWS headend the messages name AWS and what AWS has
// (things tagged wg-admin=vpn), never Azure or a resource group: drift,
// captures, published-port warnings and the Cost page's projection.
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { detectDrift } from "../src/runs";
import { startCapture } from "../src/capture";
import { saveSnapshot } from "../src/state";
import { projection } from "../src/costview";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const NOW = "2026-10-14T12:00:00Z";
const fwd = { name: "web", proto: "tcp", public_port: 8080, target_ip: "10.50.2.4" };

describe("drift on an AWS headend", () => {
  it("Running with nothing tagged in AWS says so, not 'no resource group'", async () => {
    const { env, world } = makeEnv();
    world.aws.exists = false;
    await saveSnapshot(env, { state: "running", cloud: "aws" });
    expect(await detectDrift(env)).toBe("The dashboard says Running but nothing tagged wg-admin=vpn is in AWS. Something deleted it outside this app.");
  });
  it("Standby with nothing tagged in AWS says so too", async () => {
    const { env, world } = makeEnv();
    world.aws.exists = false;
    await saveSnapshot(env, { state: "standby", cloud: "aws" });
    expect(await detectDrift(env)).toBe("The dashboard says Standby but nothing tagged wg-admin=vpn is in AWS. Something deleted it outside this app.");
  });
  it("an Azure headend still names its resource group", async () => {
    const { env, world } = makeEnv();
    world.azure.rg = false;
    await saveSnapshot(env, { state: "running", cloud: "azure" });
    expect(await detectDrift(env)).toBe("The dashboard says Running but Azure has no resource group. Something deleted it outside this app.");
  });
});

describe("capture on an AWS headend", () => {
  it("the cloud-side interface is 'the AWS side'", async () => {
    const { env } = makeEnv();
    await saveSnapshot(env, { state: "running", cloud: "aws" });
    expect(await startCapture(env, { iface: "eth0", filter: "", seconds: 30, by: "steven" })).toBe("Capture started: 30 s on the AWS side. It appears below when done.");
  });
  it("on Azure it stays 'the Azure side'", async () => {
    const { env } = makeEnv();
    await saveSnapshot(env, { state: "running", cloud: "azure" });
    expect(await startCapture(env, { iface: "eth0", filter: "", seconds: 30, by: "steven" })).toMatch(/on the Azure side\./);
  });
});

describe("published-port warnings on an AWS headend", () => {
  it("add, edit and remove each say AWS did not take it", async () => {
    const { env, world } = apiEnv();
    world.aws.exists = true;
    await saveSnapshot(env, { state: "running", cloud: "aws" });
    world.awsFail = "UnauthorizedOperation";
    const add = await api(env, "POST", "/firewall/forwards", fwd);
    expect(add.status).toBe(200);
    expect(add.json.warning).toMatch(/^Saved, but AWS did not open the port: AWS refused/);
    const id = (await db.listForwards(env))[0].id;
    const edit = await api(env, "PUT", `/firewall/forwards/${id}`, { enabled: false });
    expect(edit.json.warning).toMatch(/^Saved, but AWS did not update: /);
    const del = await api(env, "DELETE", `/firewall/forwards/${id}`);
    expect(del.json.warning).toMatch(/^Saved, but AWS did not update: /);
    expect(JSON.stringify([add.json, edit.json, del.json])).not.toMatch(/Azure/);
  });
  it("a restore says AWS refused the published ports", async () => {
    const { env, world } = apiEnv();
    world.aws.exists = true;
    await db.addForward(env, { name: "web", proto: "tcp", public_port: 8443, target_ip: "10.50.2.4", target_port: 443, allow_from: "" });
    const file = JSON.parse((await api(env, "GET", "/backup/export")).text);
    await saveSnapshot(env, { state: "running", cloud: "aws" });
    world.awsFail = "UnauthorizedOperation";
    const p = await api(env, "POST", "/backup/restore/preview", file);
    const c = await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" });
    expect(c.status).toBe(200);
    expect(c.json.warning).toMatch(/^Restored, but AWS refused the published ports: /);
  });
});

describe("the Cost page's projection names the clouds that reported", () => {
  const now = new Date(NOW);
  const day = (d: string, gbp: number) => ({ day: d, gbp, fetched_at: NOW });
  it("Azure alone, AWS alone, and both", () => {
    expect(projection([day("2026-10-01", 0.3)], now)!.basis).toMatch(/the 1 day Azure has reported so far/);
    expect(projection([day("2026-10-01", 0.3)], now, ["AWS"])!.basis).toMatch(/the 1 day AWS has reported so far/);
    expect(projection([day("2026-10-02", 0.3)], now, ["Azure", "AWS"])!.basis).toMatch(/the 2 days Azure and AWS have reported so far/);
  });
  it("GET /cost: an AWS-only month says AWS", async () => {
    vi.setSystemTime(new Date(NOW));
    const { env } = apiEnv();
    await db.upsertAwsCostDay(env, "2026-10-05", 1.5, 2);
    const r = (await api(env, "GET", "/cost?range=month")).json;
    expect(r.projection.basis).toMatch(/AWS has reported so far this month/);
    expect(r.projection.basis).not.toMatch(/Azure/);
  });
  it("GET /cost: both clouds this month says both", async () => {
    vi.setSystemTime(new Date(NOW));
    const { env } = apiEnv();
    await db.upsertCostDay(env, "2026-10-05", 0.4);
    await db.upsertAwsCostDay(env, "2026-10-06", 0.75, 1);
    const r = (await api(env, "GET", "/cost?range=month")).json;
    expect(r.projection.basis).toMatch(/Azure and AWS have reported so far this month/);
  });
  it("GET /cost: meta.asOfDay is AWS's last pull when only AWS has pulled, and the older of the two when both have", async () => {
    vi.setSystemTime(new Date(NOW));
    const { env } = apiEnv();
    await env.STATUS.put("cost:aws_fetched_day", "2026-10-14");
    expect((await api(env, "GET", "/cost?range=month")).json.meta.asOfDay).toBe("2026-10-14");
    // Both: the figures are only complete as of the older pull.
    await env.STATUS.put("cost:fetched_day", "2026-10-12");
    expect((await api(env, "GET", "/cost?range=month")).json.meta.asOfDay).toBe("2026-10-12");
  });
});
