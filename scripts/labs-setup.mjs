// scripts/labs-setup.mjs   (npm run labs-setup)
//
// Plain English: gets the labs' one-time identity setup ready to paste (labs
// spec §8.2; README "Labs: one-time setup"). It writes two files next to the
// committed templates in labs/setup/, both gitignored (*.local.*):
//
//   governance-role.local.json      the custom role "wg-admin labs governance",
//                                   with your subscription id filled in; paste
//                                   it into the portal's Add custom role > JSON tab
//   governance-condition.local.txt  the ABAC condition for its role assignment:
//                                   only the allowed roles (labs/setup/allowed-roles.json),
//                                   only to users, groups and service principals
//
// The subscription id comes from .env (AZURE_SUBSCRIPTION_ID). It prints only
// the file names, never the id.
//
//   node scripts/labs-setup.mjs              write the two local files
//   node scripts/labs-setup.mjs --condition  also rewrite the committed
//                                            labs/setup/governance-condition.txt
//                                            (after allowed-roles.json changes)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, PLACEHOLDER } from "./lib/env.mjs";
import { ALLOWED_ROLES } from "./lib/labs.mjs";

const SETUP_DIR = fileURLToPath(new URL("../labs/setup/", import.meta.url));

/** The custom role's actions (spec §8.1). Contributor already covers everything else a lab builds. */
export const GOVERNANCE_ACTIONS = [
  "Microsoft.Authorization/roleAssignments/write",
  "Microsoft.Authorization/roleAssignments/delete",
  "Microsoft.Authorization/roleDefinitions/write",
  "Microsoft.Authorization/roleDefinitions/delete",
  "Microsoft.Authorization/policyDefinitions/*",
  "Microsoft.Authorization/policySetDefinitions/*",
  "Microsoft.Authorization/policyAssignments/*",
  "Microsoft.Authorization/policyExemptions/*",
  "Microsoft.Authorization/locks/*",
  "Microsoft.Management/managementGroups/read",
  "Microsoft.Management/managementGroups/write",
  "Microsoft.Management/managementGroups/delete",
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Roles that hand out access. Never allowed (spec §8.1). */
const FORBIDDEN = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "Role Based Access Control Administrator",
};

/** Problems with an allowed-roles.json object: malformed or repeated GUIDs, forbidden roles, badly named custom roles. */
export function allowedRolesProblems(allowed) {
  const out = [];
  const all = [...(allowed.builtIn ?? []), ...(allowed.custom ?? [])];
  const seen = new Map();
  for (const r of all) {
    if (!GUID.test(String(r.id))) out.push(`${r.name}: id ${r.id} is malformed (want a lower-case GUID)`);
    if (seen.has(r.id)) out.push(`${r.name}: id ${r.id} is listed twice (also ${seen.get(r.id)})`);
    seen.set(r.id, r.name);
    const forbidden = FORBIDDEN[String(r.id).toLowerCase()] ?? Object.values(FORBIDDEN).find((n) => n === r.name);
    if (forbidden) out.push(`${r.name}: ${forbidden} can never be on the list`);
  }
  for (const r of allowed.custom ?? []) if (!String(r.name).startsWith(`lab-${r.lab}-`)) out.push(`${r.name}: a custom role is named lab-${r.lab}-...`);
  return out;
}

/**
 * The role-assignment condition (ABAC, version 2.0) in the portal's code-view
 * syntax: writing or deleting a role assignment is allowed only for the
 * listed role definitions and principal types.
 */
export function conditionText(allowed) {
  const ids = [...allowed.builtIn, ...allowed.custom].map((r) => r.id).join(", ");
  const types = allowed.principalTypes.map((t) => `'${t}'`).join(", ");
  const block = (action, source) =>
    [
      "(",
      " (",
      `  !(ActionMatches{'Microsoft.Authorization/roleAssignments/${action}'})`,
      " )",
      " OR",
      " (",
      `  @${source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ids}}`,
      "  AND",
      `  @${source}[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {${types}}`,
      " )",
      ")",
    ].join("\n");
  return `${block("write", "Request")}\nAND\n${block("delete", "Resource")}\n`;
}

/** Write the two local files into `dir` with the subscription id filled in. Returns their paths; logs only names. */
export function setup({ subscriptionId, dir = SETUP_DIR, log = console.log }) {
  if (!subscriptionId || PLACEHOLDER.test(subscriptionId) || !GUID.test(subscriptionId.toLowerCase())) {
    throw new Error("AZURE_SUBSCRIPTION_ID in .env is missing or not a subscription id; fill it in first");
  }
  const problems = allowedRolesProblems(ALLOWED_ROLES);
  if (problems.length) throw new Error(`labs/setup/allowed-roles.json: ${problems.join("; ")}`);
  const template = readFileSync(join(SETUP_DIR, "governance-role.json"), "utf8");
  const role = template.split("{subscriptionId}").join(subscriptionId);
  JSON.parse(role); // still valid JSON
  const files = [join(dir, "governance-role.local.json"), join(dir, "governance-condition.local.txt")];
  writeFileSync(files[0], role);
  writeFileSync(files[1], conditionText(ALLOWED_ROLES));
  for (const f of files) log(`wrote ${f.split(/[\\/]/).slice(-3).join("/")}`);
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes("--condition")) {
      writeFileSync(join(SETUP_DIR, "governance-condition.txt"), conditionText(ALLOWED_ROLES));
      console.log("wrote labs/setup/governance-condition.txt");
    }
    setup({ subscriptionId: loadEnv().AZURE_SUBSCRIPTION_ID ?? "" });
    console.log("Next: follow README.md, 'Labs: one-time setup'. The .local files are gitignored.");
  } catch (e) {
    console.error(`labs-setup: ${e.message}`);
    process.exitCode = 1;
  }
}
