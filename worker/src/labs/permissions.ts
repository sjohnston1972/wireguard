// labs/permissions.ts
//
// Plain English: Settings → Labs → Check permissions (labs spec §8.2 step 5).
// Three ticks, each from a harmless read:
//   role    the service principal (the "oid" in its own Azure token) holds the
//           custom role "wg-admin labs governance" (the custom roles, then its
//           role assignments: 2 ARM reads);
//   users   Graph answers /users?$top=1;
//   groups  Graph answers /groups?$top=1.
// With AWS labs in the catalogue, three AWS ticks (AWS labs spec §6), 4 reads:
//   awsRole      iam:GetRole wg-admin-labs answers;
//   awsBoundary  iam:GetPolicy wg-admin-lab-boundary (in the Worker's own
//                account, from STS) answers;
//   awsCostTag   the cloudlabs-lab cost allocation tag is Active (a warning
//                only: until then AWS lab actuals show as estimates).
// The Azure part runs only with Azure connected, the AWS part only with the
// Worker's AWS keys. The result is kept in KV labs:permissions; until every
// tick a lab needs is there, Deploy is unavailable for it, with the reason
// (an AWS lab needs awsRole and awsBoundary). Nothing is written
// to Azure, Entra or AWS, and no token or id is ever shown.

import type { Env } from "../env";
import { canAws, canAzure } from "../env";
import type { LabPermissions } from "../../../shared/api";
import { arm, graph, token, type Net } from "./net";
import { catalogue } from "./catalogue";
import { awsAccountId, costTagStatus, iamPolicyExists, iamRoleExists } from "./awsReads";
import { awsPlainError } from "../insights/aws/common";
import { AWS_BOUNDARY, AWS_LABS_ROLE, LAB_TAG } from "../../../shared/labs";

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

type AzureTicks = Pick<LabPermissions, "role" | "users" | "groups">;
type AwsTicks = Pick<LabPermissions, "awsRole" | "awsBoundary" | "awsCostTag">;

/** The three Azure ticks and what failed. */
async function azureTicks(env: Env, net: Net): Promise<{ ticks: AzureTicks; problems: string[] }> {
  if (!canAzure(env)) return { ticks: { role: false, users: false, groups: false }, problems: ["Azure is not connected yet: add the service principal in Settings > Setup."] };
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
  return { ticks: { role: role.ok, users, groups }, problems };
}

const BOOTSTRAP = "run node scripts/aws-bootstrap.mjs --labs.";

/**
 * The three AWS ticks (AWS labs spec §6 Permissions check), 4 reads: the account id, then iam:GetRole wg-admin-labs,
 * iam:GetPolicy wg-admin-lab-boundary and whether the cloudlabs-lab cost tag is Active (a warning only: until then
 * AWS lab actuals show as estimates). Asked only while the catalogue has AWS labs; with none, the three stay
 * unchecked (null) and nothing is said.
 */
async function awsTicks(env: Env, net: Net): Promise<{ ticks: AwsTicks; problems: string[] }> {
  if (!catalogue().labs.some((l) => l.cloud === "aws")) return { ticks: { awsRole: null, awsBoundary: null, awsCostTag: null }, problems: [] };
  if (!canAws(env)) return { ticks: { awsRole: false, awsBoundary: false, awsCostTag: null }, problems: ["AWS is not connected: the Worker has no AWS keys."] };
  const problems: string[] = [];
  /** One read; undefined (and the reason said) when AWS would not answer. */
  const asked = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      problems.push(`AWS could not say ${what}: ${awsPlainError(e)}`);
      return undefined;
    }
  };
  const account = await asked("which account the Worker is in", () => awsAccountId(env, net));
  const role = await asked(`whether the ${AWS_LABS_ROLE} role exists`, () => iamRoleExists(env, net, AWS_LABS_ROLE));
  const boundary = account ? await asked(`whether the ${AWS_BOUNDARY} policy exists`, () => iamPolicyExists(env, net, `arn:aws:iam::${account}:policy/${AWS_BOUNDARY}`)) : undefined;
  const tag = await asked(`whether the ${LAB_TAG} cost tag is active`, () => costTagStatus(env, net, LAB_TAG));
  if (role === false) problems.push(`AWS: the ${AWS_LABS_ROLE} role does not exist yet: ${BOOTSTRAP}`);
  if (boundary === false) problems.push(`AWS: the ${AWS_BOUNDARY} policy does not exist yet: ${BOOTSTRAP}`);
  if (tag === "Inactive" || tag === null) problems.push(`AWS: the ${LAB_TAG} cost tag is not active yet, so AWS lab actuals show as estimates.`);
  return { ticks: { awsRole: role === true, awsBoundary: boundary === true, awsCostTag: tag === "Active" }, problems };
}

/** Run the check, keep it in KV, and return it. */
export async function checkLabPermissions(env: Env, net: Net, now = new Date()): Promise<LabPermissions> {
  const az = await azureTicks(env, net);
  const aws = await awsTicks(env, net);
  const problems = [...az.problems, ...aws.problems];
  const out: LabPermissions = { checkedAt: now.toISOString(), ...az.ticks, ...aws.ticks, message: problems.length ? problems.join(" ") : null };
  await env.STATUS.put("labs:permissions", JSON.stringify(out));
  return out;
}
