// labs/act.ts
//
// Plain English: the two buttons on a lab's "ends in 15 minutes" push (labs
// spec §7.4): one more hour for that session, or tear it down. index.ts sends
// every lab link here once the one-time token is used up (actions.ts), and
// shows the phone what this returns.
//
// Contract stub (plan L0): says the buttons are not ready. The engine (plan
// L2) does the work, keeping this name and signature, and throws a RunError
// with a plain reason when it cannot (index.ts words it for the phone).

import type { Env } from "../env";
import type { LabQuickAction } from "../actions";

/** Do what a lab link says. Returns the sentence the phone shows. */
export async function runLabAction(_env: Env, action: LabQuickAction): Promise<string> {
  const sid = action.slice(action.indexOf(":") + 1);
  return `Lab buttons are not ready yet; open the dashboard to manage session ${sid}.`;
}
