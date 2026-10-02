// api/lifecycle.ts
//
// Plain English: the buttons: deploy, move, hibernate, resume, tear down,
// clean up, cancel, check Azure, extend the timer, speed test, and allow
// SSH from this browser's address. Each answers { ok, message } or a
// refusal with the right status, and every press counts as Steven having
// read the watchman's notes (seen.ts), as on the pages.

import type { Hono, Context } from "hono";
import { body, fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { startDeploy, startDestroy, cancelActive, reconcile, extendAutoDestroy, refreshInventory, RunError } from "../runs";
import { startHibernate, startResume } from "../standby";
import { startMove, resolveDeployTarget } from "../profiles";
import { startSpeedTest } from "../speedtest";
import { setSshAllowedCidr } from "../azure";
import { requireBudgetOk } from "../budget";
import { regionName } from "../region";
import { markActed } from "../seen";
import type { ApiOk } from "../../../shared/api";

/** Hours for a timer: null for none (absent, null or 0), a number above 0 up to a week, or "invalid". */
export function parseHours(v: unknown): number | null | "invalid" {
  if (v === undefined || v === null || v === 0) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 168) return "invalid";
  return v;
}

const HOURS_PROBLEM = "Hours must be a number from 0 (no limit) to 168.";

/** Run an action, answer its message, and count the press as having read the notes. */
async function act(c: Context<ApiEnv>, fn: () => Promise<string>) {
  try {
    const out: ApiOk = { ok: true, message: await fn() };
    return c.json(out);
  } finally {
    await markActed(c.env).catch((e) => console.error("mark acted:", e));
  }
}

export function registerLifecycle(api: Hono<ApiEnv>): void {
  api.post("/deploy", async (c) => {
    const b = (await body<{ hours?: unknown; profileId?: unknown; region?: unknown; overBudgetOk?: unknown }>(c)) ?? {};
    const hours = parseHours(b.hours);
    if (hours === "invalid") return fail(c, 400, "bad_input", HOURS_PROBLEM, "hours");
    if (b.profileId !== undefined && b.profileId !== null && !Number.isInteger(b.profileId)) return fail(c, 400, "bad_input", "profileId must be a whole number.", "profileId");
    if (b.region !== undefined && b.region !== null && typeof b.region !== "string") return fail(c, 400, "bad_input", "region must be a region name.", "region");
    const user = c.get("user");
    return act(c, async () => {
      const t = await resolveDeployTarget(c.env, { profileId: (b.profileId as number | null | undefined) ?? null, region: typeof b.region === "string" ? b.region : null });
      await requireBudgetOk(c.env, b.overBudgetOk === true);
      const run = await startDeploy(c.env, { hours, requesterIp: c.req.header("CF-Connecting-IP") ?? null, requestedBy: user, region: t.region, vmSize: t.vmSize, profile: t.profile });
      return `Deploy started${t.profile ? `: ${t.profile}` : ""} in ${regionName(t.region ?? (await effectiveConfig(c.env)).region)} (${run.id}). About 4 minutes.`;
    });
  });

  api.post("/move", async (c) => {
    const b = (await body<{ profileId?: unknown }>(c)) ?? {};
    if (!Number.isInteger(b.profileId)) return fail(c, 400, "bad_input", "Pick a profile to move to.", "profileId");
    const user = c.get("user");
    return act(c, async () => {
      const cfg = await effectiveConfig(c.env);
      return startMove(c.env, { profileId: b.profileId as number, hours: cfg.autoDestroyDefaultHours > 0 ? cfg.autoDestroyDefaultHours : null, by: user, requesterIp: c.req.header("CF-Connecting-IP") ?? null });
    });
  });

  api.post("/hibernate", async (c) => {
    const user = c.get("user");
    return act(c, () => startHibernate(c.env, user, "dashboard"));
  });

  api.post("/resume", async (c) => {
    const hours = parseHours(((await body<{ hours?: unknown }>(c)) ?? {}).hours);
    if (hours === "invalid") return fail(c, 400, "bad_input", HOURS_PROBLEM, "hours");
    const user = c.get("user");
    return act(c, () => startResume(c.env, user, hours));
  });

  api.post("/destroy", async (c) => {
    const b = (await body<{ confirm?: unknown }>(c)) ?? {};
    if (String(b.confirm ?? "").trim().toLowerCase() !== "destroy") return fail(c, 422, "confirm_required", 'Type "destroy" to confirm.', "confirm");
    const user = c.get("user");
    return act(c, async () => `Tear-down started (${(await startDestroy(c.env, user, "dashboard")).id}).`);
  });

  api.post("/cleanup", async (c) => {
    const user = c.get("user");
    return act(c, async () => `Clean-up started (${(await startDestroy(c.env, user, "clean up after failure")).id}).`);
  });

  api.post("/cancel", (c) => act(c, () => cancelActive(c.env)));

  api.post("/reconcile", async (c) => {
    const user = c.get("user");
    return act(c, () => reconcile(c.env, user));
  });

  api.post("/extend", async (c) => {
    const hours = parseHours(((await body<{ hours?: unknown }>(c)) ?? {}).hours);
    if (hours === "invalid") return fail(c, 400, "bad_input", HOURS_PROBLEM, "hours");
    return act(c, async () => {
      const at = await extendAutoDestroy(c.env, hours);
      return at ? `Auto-destroy set for ${new Date(at).toLocaleString("en-GB", { timeZone: "Europe/London" })}.` : "Auto-destroy cleared. It runs until you tear it down.";
    });
  });

  api.post("/speedtest", (c) => act(c, () => startSpeedTest(c.env)));

  api.post("/allow-ssh", async (c) => {
    const user = c.get("user");
    const addr = c.req.header("CF-Connecting-IP") ?? null;
    return act(c, async () => {
      if (!addr || addr.includes(":")) throw new RunError("Could not read an IPv4 address for this browser.");
      if ((await getSnapshot(c.env)).state !== "running") throw new RunError("Nothing is running.");
      try {
        await setSshAllowedCidr(c.env, `${addr}/32`);
      } catch (e) {
        throw new RunError(`Azure did not accept the change: ${(e as Error).message}`, "upstream");
      }
      await db.addAlert(c.env, "info", `SSH allowed from ${addr} by ${user} (live NSG change).`);
      await refreshInventory(c.env);
      return `SSH now allowed from ${addr}. Takes effect within a few seconds.`;
    });
  });
}
