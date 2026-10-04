// labs/permissions.ts
//
// Plain English: Settings → Labs → Check permissions (labs spec §8.2 step 5).
// Three ticks, each from a harmless read:
//   role    the service principal (the "oid" in its own Azure token) holds the
//           custom role "wg-admin labs governance" (the custom roles, then its
//           role assignments: 2 ARM reads);
//   users   Graph answers /users?$top=1;
//   groups  Graph answers /groups?$top=1.
// The result is kept in KV labs:permissions; until every tick a lab needs is
// there, Deploy is unavailable for it, with the reason. Nothing is written
// to Azure or Entra, and no token or id is ever shown.

import type { Env } from "../env";
import { canAzure } from "../env";
import type { LabPermissions } from "../../../shared/api";
import { arm, graph, token, type Net } from "./net";

/** The custom role the one-time setup creates (labs spec §8.1). */
export const GOVERNANCE_ROLE = "wg-admin labs governance";

/** The object id inside a JWT (no signature check: it is our own token, fresh from Azure). */
export function oidOf(jwt: string): string | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as { oid?: unknown };
    return typeof json.oid === "string" && /^[0-9a-zA-Z-]{1,64}$/.test(json.oid) ? json.oid : null;
  } catch {
    return null;
  }
}

async function roleHeld(env: Env, net: Net): Promise<{ ok: boolean; why: string | null }> {
  const oid = oidOf(await token(env, net, "arm"));
  if (!oid) return { ok: false, why: "could not read the service principal's object id from its Azure token" };
  const sub = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/providers/Microsoft.Authorization`;
  const defs = await arm(env, net, `${sub}/roleDefinitions?api-version=2022-04-01&$filter=${encodeURIComponent("type eq 'CustomRole'")}`);
  if (!defs.ok) return { ok: false, why: `Azure refused to list custom roles (${defs.status})` };
  const role = (((await defs.json()) as { value?: { name?: string; properties?: { roleName?: string } }[] }).value ?? []).find((d) => d.properties?.roleName === GOVERNANCE_ROLE);
  if (!role?.name) return { ok: false, why: `the custom role "${GOVERNANCE_ROLE}" does not exist yet` };
  const ra = await arm(env, net, `${sub}/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${oid}'`)}`);
  if (!ra.ok) return { ok: false, why: `Azure refused to list the role assignments (${ra.status})` };
  const held = (((await ra.json()) as { value?: { properties?: { roleDefinitionId?: string } }[] }).value ?? []).some((a) => (a.properties?.roleDefinitionId ?? "").toLowerCase().endsWith(`/${role.name!.toLowerCase()}`));
  return held ? { ok: true, why: null } : { ok: false, why: `the governance role "${GOVERNANCE_ROLE}" is not assigned to wg-admin's service principal` };
}

async function graphReads(env: Env, net: Net, what: "users" | "groups"): Promise<boolean> {
  try {
    return (await graph(env, net, `/${what}?$top=1`)).ok;
  } catch {
    return false;
  }
}

/** Run the check, keep it in KV, and return it. */
export async function checkLabPermissions(env: Env, net: Net, now = new Date()): Promise<LabPermissions> {
  if (!canAzure(env)) {
    const out: LabPermissions = { checkedAt: now.toISOString(), role: false, users: false, groups: false, message: "Azure is not connected yet: add the service principal in Settings > Setup." };
    await env.STATUS.put("labs:permissions", JSON.stringify(out));
    return out;
  }
  let role: { ok: boolean; why: string | null };
  try {
    role = await roleHeld(env, net);
  } catch (e) {
    role = { ok: false, why: (e as Error).message };
  }
  const users = await graphReads(env, net, "users");
  const groups = await graphReads(env, net, "groups");
  const problems = [
    ...(role.ok ? [] : [`Role: ${role.why}.`]),
    ...(users && groups ? [] : [`Microsoft Graph refused to read ${[!users ? "users" : "", !groups ? "groups" : ""].filter(Boolean).join(" and ")}: grant User.ReadWrite.All, User.DeleteRestore.All and Group.ReadWrite.All with admin consent.`]),
  ];
  const out: LabPermissions = { checkedAt: now.toISOString(), role: role.ok, users, groups, message: problems.length ? problems.join(" ") : null };
  await env.STATUS.put("labs:permissions", JSON.stringify(out));
  return out;
}
