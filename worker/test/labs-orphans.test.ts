// labs-orphans.test.ts
//
// Plain English: plan L2.5. The hourly orphan sweep (spec §7.5): what it
// lists, what it ignores (Azure's own groups, anything not named for a lab,
// anything a live session owns, anything younger than 30 minutes), one note
// per lab, the Clean up button, and slots given back once Azure is clean.
// And Settings → Labs → Check permissions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { runLabWatch } from "../src/labs/watch";
import { sweepOrphans, SWEEP_CALLS } from "../src/labs/orphans";
import { ALLOWED_ROLES } from "../../shared/labs";
import { budgetedNet } from "../src/labs/net";
import { api, advance, freeze, labDispatches, labEnv, report, rows, runningLab, secrets, session, HOUR, MIN, NOW, TEST_CATALOGUE, TEST_LABS } from "./labs-helpers";
import type { Env } from "../src/env";
import type { World } from "./harness";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const orphans = async (env: Env) => JSON.parse((await env.STATUS.get("labs:orphans")) ?? "[]") as { labId: string | null; names: string[]; since: string }[];
const leftoverNotes = (env: Env) => rows(env, "SELECT kind, message FROM alerts WHERE message LIKE 'Lab leftovers%'");

/** A world with leftovers of lab 7 in every kind of listing, and some names that are not a lab's. */
function litter(world: World) {
  const old = new Date(Date.parse(NOW) - 2 * HOUR).toISOString();
  world.labAzure.groups.push({ name: "rg-lab-az104-07-files", createdTime: old }, { name: "NetworkWatcherRG", createdTime: old }, { name: "rg-wg-ondemand", createdTime: old }, { name: "rg-other-project", createdTime: old });
  world.graph.users.push({ id: "u1", displayName: "lab-az104-07-files-ann", userPrincipalName: "lab-az104-07-files-ann@contoso.onmicrosoft.com" }, { id: "u2", displayName: "Steven", userPrincipalName: "steven@contoso.onmicrosoft.com" });
  world.graph.groups.push({ id: "g1", displayName: "lab-az104-07-files-readers" }, { id: "g2", displayName: "Admins" });
  world.labAzure.managementGroups.push({ name: "lab-az104-01-identity-root" }, { name: "Tenant Root Group" });
  world.labAzure.roleDefinitions.push({ id: "11111111-1111-1111-1111-111111111111", roleName: "lab-az104-01-identity-vm-operator" }, { id: "22222222-2222-2222-2222-222222222222", roleName: "wg-admin labs governance" });
  world.labAzure.policyDefinitions.push({ name: "lab-az104-01-identity-require-tag" }, { name: "allowed-locations-org" });
  world.labAzure.policyAssignments.push({ name: "lab-az104-01-identity-tags", scope: "/subscriptions/sub/resourceGroups/rg-lab-az104-01-identity" });
}

describe("orphan sweep: Entra names matched by the field the safety net deletes by", () => {
  it("users by user principal name, groups by display name: a look-alike in another field is not a lab's", async () => {
    freeze();
    const { env, world } = await labEnv();
    await env.STATUS.put("azure:token", JSON.stringify({ token: "arm", expiresAt: Date.now() + 2 * HOUR }));
    await env.STATUS.put("labs:graph-token", JSON.stringify({ token: "graph", expiresAt: Date.now() + 2 * HOUR }));
    world.graph.users.push(
      // The safety net deletes this one (its UPN starts lab-<id>-), whatever its display name.
      { id: "u1", displayName: "Ann (lab 7)", userPrincipalName: "lab-az104-07-files-ann@contoso.onmicrosoft.com" },
      // The safety net never deletes this one (its UPN is a person's): not a leftover, however it is named.
      { id: "u2", displayName: "lab-az104-07-files-steven", userPrincipalName: "steven@contoso.onmicrosoft.com" },
    );
    world.graph.groups.push(
      { id: "g1", displayName: "lab-az104-07-files-readers", mailNickname: "readers7" },
      { id: "g2", displayName: "Admins", mailNickname: "lab-az104-07-files-admins" },
    );
    await sweepOrphans(env, budgetedNet(20), new Date());
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await orphans(env)).toEqual([expect.objectContaining({ labId: "az104-07-files", names: ["lab-az104-07-files-ann", "lab-az104-07-files-readers"] })]);
  });
});

describe("orphan sweep: fixed custom role GUIDs", () => {
  it("finds lab 1's custom role by its fixed GUID when the subscription's list does not show it (assignable only in its group)", async () => {
    freeze();
    const { env, world } = await labEnv();
    await env.STATUS.put("azure:token", JSON.stringify({ token: "arm", expiresAt: Date.now() + 2 * HOUR }));
    await env.STATUS.put("labs:graph-token", JSON.stringify({ token: "graph", expiresAt: Date.now() + 2 * HOUR }));
    world.labAzure.roleDefinitions.push({ id: "7331dcae-09d3-477e-8da7-2895697f0fc0", roleName: "lab-az104-01-identity-vm-operator", rgOnly: true });
    const net = budgetedNet(20);
    await sweepOrphans(env, net, new Date());
    expect(net.used()).toBe(SWEEP_CALLS);
    expect(SWEEP_CALLS).toBe(8 + ALLOWED_ROLES.custom.length);
    expect(world.calls.some((c) => c.path.toLowerCase().startsWith("/subscriptions/sub/providers/microsoft.authorization/roledefinitions/7331dcae-09d3-477e-8da7-2895697f0fc0"))).toBe(true);
    // Seen now; an orphan once it has been there 30 minutes.
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await orphans(env)).toEqual([expect.objectContaining({ labId: "az104-01-identity", names: ["lab-az104-01-identity-vm-operator"] })]);
    // Deleted: ARM answers 404 for the GUID, and the lab is clean again.
    world.labAzure.roleDefinitions.length = 0;
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await orphans(env)).toEqual([]);
  });
});

// AZ-700 plan Z0.7, scope exception S2 (approved by Steven 2026-10-05): lab 44's flow log lives in Azure's
// NetworkWatcherRG, outside every lab group, so the sweep lists flow logs too, by name (lab-<id>-*).
describe("orphan sweep: flow logs (S2)", () => {
  const withLab44 = () =>
    setCatalogueForTest({ ...TEST_CATALOGUE, labs: [...TEST_LABS, { ...TEST_LABS[1], id: "az700-44-flow-logs-bastion", number: 44, exam: "AZ-700", exams: ["AZ-700"], title: "VNet flow logs, IP flow verify and Bastion" }] });

  it("the sweep lists flow logs named lab- and reports them under their lab", async () => {
    freeze();
    const { env, world } = await labEnv();
    withLab44();
    world.labAzure.flowLogs = [{ name: "lab-az700-44-flow-logs-bastion-vnet", region: "uksouth" }];
    const net = budgetedNet(20);
    await sweepOrphans(env, net, new Date());
    // One listing for every flow log in the subscription, whichever region's watcher holds it.
    const call = world.calls.find((c) => c.path.toLowerCase().startsWith("/subscriptions/sub/resources"));
    expect(decodeURIComponent(call?.path ?? "")).toContain("$filter=resourceType eq 'Microsoft.Network/networkWatchers/flowLogs'");
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await orphans(env)).toEqual([expect.objectContaining({ labId: "az700-44-flow-logs-bastion", names: ["lab-az700-44-flow-logs-bastion-vnet (flow log)"] })]);
    expect((await leftoverNotes(env)).map((n) => n.message)).toEqual([expect.stringContaining("lab-az700-44-flow-logs-bastion-vnet (flow log)")]);
  });

  it("a flow log not named lab- is ignored", async () => {
    freeze();
    const { env, world } = await labEnv();
    withLab44();
    world.labAzure.flowLogs = [{ name: "fl-prod-hub", region: "uksouth" }, { name: "NetworkWatcher_uksouth-default", region: "uksouth" }, { name: "lab-unknown", region: "ukwest" }];
    await sweepOrphans(env, budgetedNet(20), new Date());
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await orphans(env)).toEqual([]);
  });

  it("SWEEP_CALLS is eight listings and one call per fixed custom role", () => {
    expect(SWEEP_CALLS).toBe(8 + ALLOWED_ROLES.custom.length);
  });
});

describe("orphan sweep: a tenant that refuses the management-group list", () => {
  // Live 2026-10-05: wg-admin's identity owns every management group it creates, so a
  // 403 AuthorizationFailed on the list means none of the labs' exist; the sweep still runs.
  it("counts a 403 AuthorizationFailed management-group list as none and still records the other leftovers", async () => {
    freeze();
    const { env, world } = await labEnv();
    litter(world);
    world.labAzure.managementGroups.length = 0;
    world.labAzure.managementGroupsForbidden = true;
    const summary = await sweepOrphans(env, budgetedNet(20), new Date());
    expect(summary).not.toMatch(/could not list/);
    const o = await orphans(env);
    expect(o).toEqual(expect.arrayContaining([expect.objectContaining({ labId: "az104-07-files", names: ["rg-lab-az104-07-files"] })]));
  });
});

describe("orphan sweep (L2.5)", () => {
  it("orphan sweep lists groups, Entra, management groups, roles, policies and flow logs hourly in SWEEP_CALLS calls (8 listings and each fixed custom role)", async () => {
    freeze();
    const { env, world } = await labEnv();
    litter(world);
    // A warm sign-in, so the count is the listings alone.
    await env.STATUS.put("azure:token", JSON.stringify({ token: "arm", expiresAt: Date.now() + 2 * HOUR }));
    await env.STATUS.put("labs:graph-token", JSON.stringify({ token: "graph", expiresAt: Date.now() + 2 * HOUR }));
    const net = budgetedNet(20);
    await sweepOrphans(env, net, new Date());
    expect(net.used()).toBe(SWEEP_CALLS);
    const hosts = world.calls.map((c) => `${c.host}${c.path.split("?")[0].toLowerCase()}`);
    expect(hosts).toEqual(expect.arrayContaining([
      "management.azure.com/subscriptions/sub/resourcegroups",
      "graph.microsoft.com/v1.0/users",
      "graph.microsoft.com/v1.0/groups",
      "management.azure.com/providers/microsoft.management/managementgroups",
      "management.azure.com/subscriptions/sub/providers/microsoft.authorization/roledefinitions",
      "management.azure.com/subscriptions/sub/providers/microsoft.authorization/policydefinitions",
      "management.azure.com/subscriptions/sub/providers/microsoft.authorization/policyassignments",
      "management.azure.com/subscriptions/sub/resources",
    ]));
    // Not again within the hour.
    advance(30 * MIN);
    const again = budgetedNet(20);
    await sweepOrphans(env, again, new Date());
    expect(again.used()).toBe(0);
    advance(31 * MIN);
    await sweepOrphans(env, again, new Date());
    expect(again.used()).toBe(SWEEP_CALLS);
  });

  it("orphan sweep ignores NetworkWatcherRG and non-lab names and waits 30 minutes", async () => {
    freeze();
    const { env, world } = await labEnv();
    litter(world);
    // A brand-new group (no creation time from Azure): seen now, an orphan only 30 minutes later.
    world.labAzure.groups.push({ name: "rg-lab-az104-05-storage" });
    await sweepOrphans(env, budgetedNet(20), new Date());
    let o = await orphans(env);
    // Only the group Azure says is two hours old counts yet; the rest were first seen just now.
    expect(o).toEqual([{ labId: "az104-07-files", names: ["rg-lab-az104-07-files"], since: new Date(Date.parse(NOW) - 2 * HOUR).toISOString() }]);
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    o = await orphans(env);
    const names = o.flatMap((x) => x.names);
    for (const n of ["NetworkWatcherRG", "rg-wg-ondemand", "rg-other-project", "Steven", "Admins", "Tenant Root Group", "wg-admin labs governance", "allowed-locations-org"]) expect(names).not.toContain(n);
    expect(o.find((x) => x.labId === "az104-07-files")!.names).toEqual(["lab-az104-07-files-ann", "lab-az104-07-files-readers", "rg-lab-az104-07-files"]);
    expect(o.find((x) => x.labId === "az104-05-storage")!.names).toEqual(["rg-lab-az104-05-storage"]);
    expect(o.find((x) => x.labId === "az104-01-identity")!.names).toEqual(["lab-az104-01-identity-require-tag", "lab-az104-01-identity-root", "lab-az104-01-identity-tags", "lab-az104-01-identity-vm-operator"]);
  });

  it("owned by a live session is not an orphan", async () => {
    freeze();
    const { env, world } = await labEnv();
    litter(world);
    await runningLab(env, world, "az104-07-files");
    await sweepOrphans(env, budgetedNet(20), new Date());
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    const o = await orphans(env);
    expect(o.find((x) => x.labId === "az104-07-files")).toBeUndefined();
    expect(o.find((x) => x.labId === "az104-01-identity")).toBeTruthy();
  });

  it("one note per lab, with names", async () => {
    freeze();
    const { env, world } = await labEnv();
    litter(world);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await leftoverNotes(env)).toHaveLength(1);
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    let notes = await leftoverNotes(env);
    // Lab 7's names grew (its Entra objects are now 30 minutes old): a new note; lab 1's first.
    expect(notes).toHaveLength(3);
    expect(notes.every((n) => n.kind === "cost_guard")).toBe(true);
    const seven = notes.find((n) => n.message.includes("lab-az104-07-files-ann"))!;
    expect(seven.message).toContain("rg-lab-az104-07-files");
    expect(seven.message).not.toContain("lab-az104-01-identity");
    // The same leftovers an hour later: no new note. A new name: a new note for that lab.
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect(await leftoverNotes(env)).toHaveLength(3);
    world.graph.users.push({ id: "u3", displayName: "lab-az104-07-files-ben", userPrincipalName: "lab-az104-07-files-ben@contoso.onmicrosoft.com" });
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    notes = await leftoverNotes(env);
    expect(notes).toHaveLength(4);
    // The watch runs the sweep (hourly) as part of its run.
    advance(61 * MIN);
    await runLabWatch(env, new Date());
    expect((await orphans(env)).length).toBe(2);
  });

  it("a policy assignment is a lab's by its display name or its scope, not only its name", async () => {
    freeze();
    const { env, world } = await labEnv();
    // Azure caps assignment names at 24 characters, so labs name them plainly (lab 3: audit-environment-tag).
    world.labAzure.policyAssignments.push(
      { name: "audit-environment-tag", displayName: "lab-az104-01-identity-audit-environment-tag", scope: "/providers/Microsoft.Management/managementGroups/lab-az104-01-identity-root" },
      { name: "require-tag", displayName: "Require a tag", scope: "/subscriptions/sub/resourceGroups/rg-lab-az104-05-storage" },
      { name: "audit-environment-tag", displayName: "Audit environment tag", scope: "/subscriptions/sub" },
    );
    await sweepOrphans(env, budgetedNet(20), new Date());
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    const o = await orphans(env);
    expect(o.find((x) => x.labId === "az104-01-identity")!.names).toEqual(["lab-az104-01-identity-audit-environment-tag"]);
    expect(o.find((x) => x.labId === "az104-05-storage")!.names).toEqual(["require-tag (rg-lab-az104-05-storage)"]);
    // The organisation's own assignment at subscription scope is nobody's leftover.
    expect(o.flatMap((x) => x.names).some((n) => n.startsWith("Audit environment tag") || n === "audit-environment-tag")).toBe(false);
    expect(o).toHaveLength(2);
  });

  it("cleanup dispatches a destroy for a lab gone from the catalogue", async () => {
    freeze();
    const { env, world } = await labEnv();
    const old = new Date(Date.parse(NOW) - 2 * HOUR).toISOString();
    world.labAzure.groups.push({ name: "rg-lab-az104-09-vmss", createdTime: old });
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect((await orphans(env)).map((o) => o.labId)).toEqual(["az104-09-vmss"]);
    const r = await api(env, "POST", "/labs/orphans/cleanup", { lab_id: "az104-09-vmss" });
    expect(r.status, r.text).toBe(200);
    const d = labDispatches(world);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ action: "destroy", payload: { lab_id: "az104-09-vmss", slot_cidr: null } });
    const s = (await session(env, d[0].payload.session_id as string))!;
    expect(s).toMatchObject({ state: "tearing_down", end_reason: "orphan", slot: null });
    // Clean: the leftovers are gone from the list.
    const sec = await secrets(env, world, d[0].payload.run_id as string);
    await report(env, d[0].payload.run_id as string, sec.callback_token, "success", { clean: true, leftovers: [] });
    expect((await session(env, s.id))!.state).toBe("ended");
    expect(await orphans(env)).toEqual([]);
    // A lab id nobody knows, or one whose prefix would reach a catalogue lab, is refused.
    expect((await api(env, "POST", "/labs/orphans/cleanup", { lab_id: "az104-11-containers" })).status).toBe(404);
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "az104-07-x", names: ["rg-lab-az104-07-x"], since: NOW }]));
    setCatalogueForTest({ schema: 1, skillAreas: [], labs: [{ ...(await import("./labs-helpers")).TEST_LABS[3], id: "az104-07-x-files" }], readmes: {} });
    const prefix = await api(env, "POST", "/labs/orphans/cleanup", { lab_id: "az104-07-x" });
    expect(prefix.status).toBe(409);
    expect(prefix.json.error.message).toMatch(/az104-07-x-files/);
  });

  it("a clean sweep releases ended_dirty slots", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage");
    await api(env, "POST", "/labs/az104-05-storage/destroy", { confirm: true });
    const runId = labDispatches(world).at(-1)!.payload.run_id as string;
    const s = await secrets(env, world, runId);
    await report(env, runId, s.callback_token, "success", { clean: false, leftovers: ["rg-lab-az104-05-storage"] });
    expect((await session(env, up.sid))!).toMatchObject({ state: "ended_dirty", slot: 0 });
    // Azure still has it: the slot stays.
    world.labAzure.groups.push({ name: "rg-lab-az104-05-storage" });
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect((await rows(env, "SELECT session_id FROM lab_slots WHERE slot = 0"))[0].session_id).toBe(up.sid);
    // A deploy of a lab with leftovers in Azure is refused until they are cleaned up.
    expect((await api(env, "POST", "/labs/az104-05-storage/deploy", { hours: 1, peer: false })).status).toBe(409);
    // Gone (deleted by hand, say): the next sweep gives the slot back.
    world.labAzure.groups.length = 0;
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect((await rows(env, "SELECT session_id FROM lab_slots WHERE slot = 0"))[0].session_id).toBeNull();
    expect((await session(env, up.sid))!.state).toBe("ended_dirty");
    // A sweep that could not list everything releases nothing.
    const up2 = await runningLab(env, world, "az104-06-blob-security");
    await api(env, "POST", "/labs/az104-06-blob-security/destroy", { confirm: true });
    const run2 = labDispatches(world).at(-1)!.payload.run_id as string;
    const s2 = await secrets(env, world, run2);
    await report(env, run2, s2.callback_token, "success", { clean: false, leftovers: ["lab-az104-06-blob-security-readers"] });
    world.graph.fail = 403;
    advance(61 * MIN);
    await sweepOrphans(env, budgetedNet(20), new Date());
    expect((await session(env, up2.sid))!.slot).not.toBeNull();
    expect((await rows(env, "SELECT session_id FROM lab_slots WHERE session_id = ?1", up2.sid))).toHaveLength(1);
  });
});

describe("permissions (L2.5)", () => {
  /** An unsigned JWT-shaped token carrying an object id, as Azure's tokens do. */
  const jwt = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.sig`;

  it("permissions check reads the role assignment for the token's oid and makes two Graph reads", async () => {
    freeze();
    const { env, world } = await labEnv();
    await env.STATUS.delete("labs:permissions");
    await env.STATUS.put("azure:token", JSON.stringify({ token: jwt({ oid: "oid-1" }), expiresAt: Date.now() + 2 * HOUR }));
    world.labAzure.roleDefinitions.push({ id: "22222222-2222-2222-2222-222222222222", roleName: "wg-admin labs governance" });
    world.labAzure.roleAssignments.push({ principalId: "oid-1", roleDefinitionId: "/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/22222222-2222-2222-2222-222222222222", scope: "/subscriptions/sub" });
    world.graph.users.push({ id: "u", displayName: "Steven", userPrincipalName: "s@contoso.onmicrosoft.com" });
    const r = await api(env, "POST", "/labs/permissions/check");
    expect(r.status, r.text).toBe(200);
    expect(r.json.permissions).toMatchObject({ role: true, users: true, groups: true, message: null, checkedAt: NOW });
    const graph = world.calls.filter((c) => c.host === "graph.microsoft.com");
    expect(graph.map((c) => c.path)).toEqual(["/v1.0/users?$top=1", "/v1.0/groups?$top=1"]);
    expect(world.calls.some((c) => /roleassignments/i.test(c.path) && c.path.includes("oid-1"))).toBe(true);
    // Kept in KV for the Labs tab and the deploy check.
    expect((await api(env, "GET", "/labs")).json.permissions).toMatchObject({ role: true, users: true, groups: true });
    // Graph refusing, and no governance role: each ticked off, with the reason.
    world.graph.fail = 403;
    world.labAzure.roleAssignments.length = 0;
    const no = await api(env, "POST", "/labs/permissions/check");
    expect(no.status).toBe(200);
    expect(no.json.permissions).toMatchObject({ role: false, users: false, groups: false });
    expect(no.json.permissions.message).toMatch(/governance/);
    expect(no.json.permissions.message).toMatch(/Graph/);
  });
});
