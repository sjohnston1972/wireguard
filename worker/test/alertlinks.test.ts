// Where a tap on an alert lands: the button's url is the page that explains
// the alert (spec section 9), and the push payload's url is the same one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { dashboardButton } from "../src/actions";
import { notify } from "../src/notify";
import { startDeploy, issueRunSecrets, handleCallback } from "../src/runs";
import { runScheduled } from "../src/monitor";
import { checkBudget } from "../src/budget";
import { effectiveConfig } from "../src/settings";
import { sendTestAlert } from "../src/pushsubs";
import { saveSnapshot } from "../src/state";

const pushed: { url?: string; title: string }[] = [];
vi.mock("../src/webpush", () => ({
  canPush: () => true,
  sendPush: async (_env: unknown, _sub: unknown, msg: { url?: string; title: string }) => {
    pushed.push(msg);
    return "ok";
  },
}));

const BASE = "https://wg-admin.example";
let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
  pushed.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

/** The "view" button urls of every webhook note whose title matches. */
const viewUrls = (re: RegExp) => world.notes.filter((n) => re.test(n.title)).flatMap((n) => ((n.actions ?? []) as { action: string; url: string }[]).filter((a) => a.action === "view").map((a) => a.url));

async function toRunning() {
  await db.addPeer(env, { name: "Phone", public_key: "P".repeat(43) + "=", ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  return { run, sec };
}

describe("alert links", () => {
  it("dashboardButton defaults to the dashboard root", () => {
    expect(dashboardButton(env)).toEqual({ label: "Open dashboard", url: `${BASE}/`, kind: "view" });
  });

  it("a path becomes publicUrl + path", () => {
    expect(dashboardButton(env, "Open the run", "/activity/runs/7")).toEqual({ label: "Open the run", url: `${BASE}/activity/runs/7`, kind: "view" });
    expect(dashboardButton(env, "Open dashboard", "/").url).toBe(`${BASE}/`);
  });

  it("a failed run's alert opens its run", async () => {
    const { run, sec } = await toRunning();
    await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "failure" });
    expect(viewUrls(/apply failed/)).toEqual([`${BASE}/activity/runs/${run.id}`]);
  });

  it("budget alerts open /cost", async () => {
    const cfg = await effectiveConfig(env);
    await db.upsertCostDay(env, "2026-09-01", 5);
    await db.upsertCostDay(env, "2026-09-02", 3.5);
    await checkBudget(env, cfg, new Date("2026-09-20T12:00:00Z"));
    expect(viewUrls(/budget/)).toEqual([`${BASE}/cost`]);
  });

  it("unreachable and drift open /", async () => {
    await toRunning();
    await saveSnapshot(env, { state: "standby", standby_since: new Date().toISOString() });
    world.azure.power = "running"; // drift: a "standby" VM at full rate
    await runScheduled(env);
    expect(viewUrls(/drift/)).toEqual([`${BASE}/`]);

    ({ env, world } = makeEnv());
    await toRunning();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    await saveSnapshot(env, { state: "running", running_since: old, since: old, last_agent_at: null });
    await runScheduled(env);
    expect(viewUrls(/unreachable/)).toEqual([`${BASE}/`]);
  });

  it("the test alert opens /settings/mobile", async () => {
    await sendTestAlert(env);
    expect(viewUrls(/test alert/)).toEqual([`${BASE}/settings/mobile`]);
  });

  it("the push payload url is the view button's url", async () => {
    await db.savePushSub(env, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "x", auth: "y", label: "Pixel" });
    await notify(env, "wg-admin: test", "b", { buttons: [dashboardButton(env, "Open", "/settings/mobile")] });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].url).toBe(`${BASE}/settings/mobile`);
  });
});
