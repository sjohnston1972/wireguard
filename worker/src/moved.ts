// moved.ts
//
// Plain English: the dashboard moved from wg-admin.clydeford.net to
// cloudlabs.clydeford.net (issue #126). The old address stays wired up so the
// machines that know it keep working: a running VM's heartbeat, GitHub's
// callbacks and the single-use links in old alerts (all under /api/). People
// are sent on: the app's pages do that themselves (web/src/shell/moved.ts,
// because page loads are served as files and never reach this code), and the
// public showcase, which this Worker serves, answers with a permanent
// redirect so links already shared still land. Like a mail redirect that
// still lets the meter reader in.

export const OLD_HOST = "wg-admin.clydeford.net";
export const NEW_ORIGIN = "https://cloudlabs.clydeford.net";

/** Where a showcase request to the old address should go instead, or null when it stays where it is. */
export function movedTo(url: string, method: string): string | null {
  const u = new URL(url);
  if (u.hostname !== OLD_HOST || (method !== "GET" && method !== "HEAD")) return null;
  if (u.pathname !== "/showcase" && !u.pathname.startsWith("/showcase/")) return null;
  return NEW_ORIGIN + u.pathname + u.search;
}
