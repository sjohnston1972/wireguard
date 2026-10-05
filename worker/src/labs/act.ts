// labs/act.ts
//
// Plain English: the two buttons on a lab's "ends in 15 minutes" push (labs
// spec §7.4): one more hour for that session, or tear it down. index.ts sends
// every lab link here once the one-time token is used up (actions.ts), and
// shows the phone what this returns. The hour never passes the session's
// maximum lifetime: it stops there and says so. A refusal is a RunError with
// a plain reason (index.ts words it for the phone).

import type { Env } from "../env";
import type { LabQuickAction } from "../actions";
import { RunError } from "../runs";
import { destroySession, extendSession, hhmm } from "./engine";
import { getSession } from "./store";
import { labTitle } from "./view";

/** Do what a lab link says. Returns the sentence the phone shows. */
export async function runLabAction(env: Env, action: LabQuickAction): Promise<string> {
  const sid = action.slice(action.indexOf(":") + 1);
  const s = await getSession(env, sid);
  if (!s || s.state === "ended" || s.state === "ended_dirty") throw new RunError("That lab session has already ended.");
  const title = labTitle(s.lab_id);
  if (action.startsWith("lab-destroy:")) {
    await destroySession(env, s, "manual", "phone notification", "button on the phone");
    return `Tearing down ${title}.`;
  }
  const r = await extendSession(env, s, { hours: 1, clamp: true });
  return r.clamped ? `Extended ${title} to its maximum lifetime: it now ends at ${hhmm(Date.parse(r.until))}.` : `Extended ${title} by an hour: it now ends at ${hhmm(Date.parse(r.until))}.`;
}
