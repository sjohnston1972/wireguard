// api/backup.ts
//
// Plain English: the dashboard's own backups: download the data as a file,
// fetch one of the nightly copies from R2, and put a file back. A restore is
// two steps, as on the page: send the file to preview (it answers how many
// rows of each kind the file holds next to what is here now, never the rows
// themselves, which include push keys), then confirm with the word
// "restore". The checked file waits in KV for 15 minutes under a random
// token. If the database refuses the file, nothing at all is changed.

import type { Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import * as db from "../db";
import { randomToken } from "../auth";
import { backupRoot, buildExport, exportFileName, checkRestoreFile, applyRestore, currentCounts, restoreBlocked, MAX_RESTORE_BYTES, TABLE_LABEL, type RestorePlan } from "../backup";
import { syncPublished } from "../published";
import type { ApiOk, RestorePreviewResponse } from "../../../shared/api";

const TOO_BIG = "That file is too big to be a wg-admin export.";

export function registerBackup(api: Hono<ApiEnv>): void {
  api.get("/backup/export", async (c) => {
    const exp = await buildExport(c.env);
    return c.body(JSON.stringify(exp, null, 1), 200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${exportFileName(exp.exported_at.slice(0, 10))}"`, "Cache-Control": "no-store" });
  });

  api.get("/backup/config/:day", async (c) => {
    const day = c.req.param("day");
    const obj = /^\d{4}-\d{2}-\d{2}$/.test(day) ? await c.env.STATE.get(`${await backupRoot(c.env)}config-backups/${day}.json`) : null;
    if (!obj) return fail(c, 404, "not_found", "That nightly export is no longer kept.");
    return new Response(obj.body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${exportFileName(day)}"`, "Cache-Control": "no-store" } });
  });

  api.post("/backup/restore/preview", async (c) => {
    // The body is the export file itself, so it is read as text for checkRestoreFile.
    if (Number(c.req.header("Content-Length") ?? 0) > MAX_RESTORE_BYTES + 10_000) return fail(c, 400, "bad_input", TOO_BIG);
    const text = await c.req.text();
    if (text.length > MAX_RESTORE_BYTES) return fail(c, 400, "bad_input", TOO_BIG);
    if (!text.trim()) return fail(c, 400, "bad_input", "Send the export file as the request body.");
    if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return fail(c, 400, "bad_input", "Send the request body as JSON (Content-Type: application/json).");
    const blocked = await restoreBlocked(c.env);
    if (blocked) return fail(c, 409, "blocked", blocked);
    const plan = await checkRestoreFile(c.env, text);
    if (typeof plan === "string") return fail(c, 400, "bad_input", plan);
    // The checked file waits in KV for 15 minutes under a random name, so
    // the confirm step does not have to send it again.
    const token = randomToken();
    await c.env.STATUS.put(`restore:${token}`, JSON.stringify(plan), { expirationTtl: 900 });
    const out: RestorePreviewResponse = { token, exportedAt: plan.exported_at, file: plan.counts, current: await currentCounts(c.env), labels: TABLE_LABEL };
    return c.json(out);
  });

  api.post("/backup/restore/confirm", async (c) => {
    const b = await body<{ token?: unknown; confirm?: unknown }>(c);
    if (!b) return fail(c, 400, "bad_input", "Send { token, confirm } as JSON.");
    if (typeof b.token !== "string") return fail(c, 400, "bad_input", "token must be the text the preview gave.", "token");
    if (typeof b.confirm !== "string") return fail(c, 400, "bad_input", 'confirm must be the word "restore".', "confirm");
    const token = b.token;
    const plan = /^[0-9a-f]{64}$/.test(token) ? await c.env.STATUS.get<RestorePlan>(`restore:${token}`, "json") : null;
    if (!plan) return fail(c, 404, "expired", "That upload has expired (they are kept 15 minutes). Send the file again.");
    if (b.confirm.trim().toLowerCase() !== "restore") return fail(c, 422, "confirm_required", 'Not restored: type "restore" to confirm.', "confirm");
    const blocked = await restoreBlocked(c.env);
    if (blocked) return fail(c, 409, "blocked", blocked);
    try {
      await applyRestore(c.env, plan);
    } catch (e) {
      return fail(c, 400, "restore_failed", `Nothing was changed: the database refused the file (${(e as Error).message}).`);
    }
    await c.env.STATUS.delete(`restore:${token}`);
    await db.audit(c.env, c.get("user"), "config.restore", "backup", null, { exported_at: plan.exported_at, counts: plan.counts });
    await db.addAlert(c.env, "info", `Dashboard data restored from an export of ${plan.exported_at} by ${c.get("user")}: ${plan.counts.peers} client(s), ${plan.counts.fw_rules} firewall rule(s).`);
    // The restored published ports must reach Azure too; if Azure refuses, say so.
    const err = await syncPublished(c.env);
    const out: ApiOk = { ok: true, message: `Restored from an export of ${plan.exported_at}.`, ...(err ? { warning: `Restored, but Azure refused the published ports: ${err}` } : {}) };
    return c.json(out);
  });
}
