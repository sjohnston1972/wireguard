// api/session.ts
//
// Plain English: who is signed in, which build of the dashboard is
// running, which secrets are missing (names only), and the watchman notes
// nobody has read; plus "mark them read".

import type { Hono } from "hono";
import type { ApiEnv } from "./app";
import * as db from "../db";
import { missingSecrets } from "../env";
import { BUILD } from "../build";
import { ackWatchedNotes } from "../seen";
import type { ApiOk, SessionResponse } from "../../../shared/api";

export function registerSession(api: Hono<ApiEnv>): void {
  api.get("/session", async (c) => {
    await ackWatchedNotes(c.env).catch((e) => console.error("ack watched notes:", e));
    const out: SessionResponse = {
      user: c.get("user"),
      build: BUILD,
      now: new Date().toISOString(),
      setupMissing: missingSecrets(c.env),
      notes: await db.unacknowledgedAlerts(c.env),
    };
    return c.json(out);
  });

  api.post("/notes/ack", async (c) => {
    await db.acknowledgeAlerts(c.env);
    const out: ApiOk = { ok: true, message: "Notes marked as read." };
    return c.json(out);
  });
}
