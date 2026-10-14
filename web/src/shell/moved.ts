// moved.ts
//
// Plain English: the dashboard moved from wg-admin.clydeford.net to
// cloudlabs.clydeford.net (issue #126). A page opened on the old address
// (a bookmark, the phone app installed from there) goes straight on to the
// same page at the new one, before anything draws. The Worker keeps the old
// address for the machines; see worker/src/moved.ts.

export const OLD_HOST = "wg-admin.clydeford.net";
export const NEW_ORIGIN = "https://cloudlabs.clydeford.net";

/** The same page at the new address when this is the old one, else null. */
export function newAddress(loc: Pick<Location, "hostname" | "pathname" | "search" | "hash">): string | null {
  return loc.hostname === OLD_HOST ? NEW_ORIGIN + loc.pathname + loc.search + loc.hash : null;
}
