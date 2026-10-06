// topology-capture.test.mjs
//
// Plain English: scripts/topology-capture.mjs, the integration's read-only
// capture of a running lab's Resource Graph rows into a test fixture (lab
// topology spec §6.1 (V), plan integration step 7). It runs the one query
// (shared/topology/query.ts), keeps only the columns and property paths the
// live rules read, drops tags but lab and project, and replaces the
// subscription id with a fake one, so a fixture holds nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_KEEP, captureRequest, captureRows, FAKE_SUBSCRIPTION, loadOwnsName } from "../topology-capture.mjs";

const SUB = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
const row = {
  id: `/subscriptions/${SUB}/resourceGroups/rg-lab-az104-14-peering-udr/providers/Microsoft.Compute/virtualMachines/vm-router`,
  name: "vm-router",
  type: "microsoft.compute/virtualmachines",
  kind: "",
  location: "uksouth",
  resourceGroup: "rg-lab-az104-14-peering-udr",
  subscriptionId: SUB,
  tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  sku: null,
  tags: { lab: "az104-14-peering-udr", project: "wg-admin-labs", session: "ls-20261006-abc", owner: "someone@contoso.onmicrosoft.com" },
  zones: null,
  identity: { type: "SystemAssigned", principalId: "11111111-2222-4333-8444-555555555555" },
  managedBy: "",
  properties: {
    provisioningState: "Succeeded",
    vmId: "99999999-8888-4777-8666-555555555555",
    hardwareProfile: { vmSize: "Standard_B1s" },
    osProfile: { computerName: "vm-router", adminUsername: "azureuser", customData: "I2Nsb3VkLWNvbmZpZw==", secrets: [] },
    storageProfile: { osDisk: { osType: "Linux", name: "vm-router_OsDisk_1_abc", managedDisk: { id: `/subscriptions/${SUB}/resourceGroups/rg-lab-az104-14-peering-udr/providers/Microsoft.Compute/disks/vm-router_OsDisk_1_abc` } }, imageReference: { offer: "ubuntu" } },
    networkProfile: { networkInterfaces: [{ id: `/subscriptions/${SUB}/resourceGroups/rg-lab-az104-14-peering-udr/providers/Microsoft.Network/networkInterfaces/nic-vm-router` }] },
    extended: { instanceView: { powerState: { code: "PowerState/running", displayStatus: "VM running" }, computerName: "vm-router" } },
  },
};

test("it keeps only the paths the rules read and fakes the subscription id", () => {
  const [out] = captureRows([row], { labId: "az104-14-peering-udr", ids: ["az104-14-peering-udr"], owns: (id, name) => name === `rg-lab-${id}` });
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, new RegExp(SUB), "the real subscription id is gone");
  assert.match(text, new RegExp(FAKE_SUBSCRIPTION));
  for (const gone of ["customData", "adminUsername", "vmId", "imageReference", "principalId", "tenantId", "subscriptionId", "ls-20261006", "someone@", "displayStatus", "computerName"]) assert.doesNotMatch(text, new RegExp(gone), gone);
  assert.deepEqual(out.tags, { lab: "az104-14-peering-udr", project: "wg-admin-labs" });
  assert.equal(out.identity, null);
  assert.deepEqual(out.properties, {
    provisioningState: "Succeeded",
    hardwareProfile: { vmSize: "Standard_B1s" },
    storageProfile: { osDisk: { osType: "Linux" } },
    networkProfile: { networkInterfaces: [{ id: `/subscriptions/${FAKE_SUBSCRIPTION}/resourceGroups/rg-lab-az104-14-peering-udr/providers/Microsoft.Network/networkInterfaces/nic-vm-router` }] },
    extended: { instanceView: { powerState: { code: "PowerState/running" } } },
  });
  assert.equal(out.name, "vm-router");
});

test("the keep list is property paths only, and covers what the core live rules read", () => {
  for (const p of CAPTURE_KEEP) assert.match(p, /^[A-Za-z][A-Za-z0-9]*(\[\])?(\.[A-Za-z][A-Za-z0-9]*(\[\])?)*$/, p);
  for (const p of ["subnets[].properties.addressPrefix", "virtualNetworkPeerings[].properties.peeringState", "routes[].properties.nextHopIpAddress", "ipConfigurations[].properties.privateIPAddress", "privateLinkServiceConnections[].properties.privateLinkServiceConnectionState.status", "privateLinkService.id", "loadBalancerFrontendIpConfigurations[].id", "serviceEndpointPolicyDefinitions[].properties.serviceResources", "subnets[].id"]) assert.ok(CAPTURE_KEEP.includes(p), p);
});

test("a list and an object of the same name each keep their own paths (a metric alert's actions[], a log alert's actions.actionGroups)", () => {
  const owns = (id, name) => name === `rg-lab-${id}`;
  const ag = `/subscriptions/${SUB}/resourceGroups/rg-lab-az104-14-peering-udr/providers/Microsoft.Insights/actionGroups/ag`;
  const metric = { ...row, properties: { actions: [{ actionGroupId: ag, webHookProperties: { secret: "x" } }] } };
  const log = { ...row, properties: { actions: { actionGroups: [ag], customProperties: { secret: "x" } } } };
  const [m, l] = captureRows([metric, log], { labId: "az104-14-peering-udr", ids: ["az104-14-peering-udr"], owns });
  const fake = ag.replace(SUB, FAKE_SUBSCRIPTION);
  assert.deepEqual(m.properties, { actions: [{ actionGroupId: fake }] });
  assert.deepEqual(l.properties, { actions: { actionGroups: [fake] } });
});

const LAB = "az104-14-peering-udr";
const IDS = ["az104-14-peering-udr", "az104-14-peering-udr-extra", "az104-13-vnets"];
const rowIn = (rg, name, extra = {}) => ({ ...row, id: `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${name}`, name, type: "microsoft.network/publicipaddresses", resourceGroup: rg, ...extra });

test("only the lab's own groups are kept (ownsName): another lab's, a longer id's and an outside group's rows are dropped", async () => {
  const owns = await loadOwnsName();
  const rows = [rowIn(`rg-lab-${LAB}`, "pip-a"), rowIn(`rg-lab-${LAB}-secondary`, "pip-b"), rowIn("rg-lab-az104-13-vnets", "pip-other"), rowIn(`rg-lab-${LAB}-extra`, "pip-longer"), rowIn("rg-wg-ondemand", "pip-wg")];
  const out = captureRows(rows, { labId: LAB, ids: IDS, owns });
  assert.deepEqual(out.map((r) => r.name), ["pip-a", "pip-b"]);
  assert.throws(() => captureRows(rows), /labId/);
});

test("public IPs become TEST-NET addresses, consistently; private, platform and TEST-NET addresses stay", async () => {
  const owns = await loadOwnsName();
  const rows = [
    rowIn(`rg-lab-${LAB}`, "pip-a", { properties: { ipAddress: "20.108.45.7", ipPrefix: "51.140.12.0/28", publicIPAllocationMethod: "Static" } }),
    rowIn(`rg-lab-${LAB}`, "pip-b", { properties: { ipAddress: "20.108.45.7", customDnsConfigs: [{ ipAddresses: ["10.64.0.4", "168.63.129.16", "203.0.113.9", "4.250.1.2"] }] } }),
  ];
  const out = captureRows(rows, { labId: LAB, ids: IDS, owns });
  const text = JSON.stringify(out);
  for (const real of ["20.108.45.7", "51.140.12.0", "4.250.1.2"]) assert.doesNotMatch(text, new RegExp(real.replace(/\./g, "\\.")), real);
  const a = out[0].properties.ipAddress;
  assert.match(a, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
  assert.equal(out[1].properties.ipAddress, a, "the same public IP maps to the same TEST-NET address");
  assert.match(out[0].properties.ipPrefix, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+\/28$/);
  const kept = out[1].properties.customDnsConfigs[0].ipAddresses;
  assert.deepEqual(kept.slice(0, 3), ["10.64.0.4", "168.63.129.16", "203.0.113.9"]);
  assert.match(kept[3], /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
  assert.notEqual(kept[3], a);
  assert.notEqual(kept[3], "203.0.113.9", "a mapped address never lands on one already in the capture");
});

test("the capture runs the one query topologyQuery writes, for the subscription named", async () => {
  const body = await captureRequest("sub-x", "az104-14-peering-udr");
  assert.deepEqual(body.subscriptions, ["sub-x"]);
  assert.equal(body.query, "resources | where resourceGroup =~ 'rg-lab-az104-14-peering-udr' or resourceGroup startswith 'rg-lab-az104-14-peering-udr-' | project id, name, type, kind, location, resourceGroup, sku, tags, zones, identity, managedBy, properties | union (resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' and (name =~ 'rg-lab-az104-14-peering-udr' or name startswith 'rg-lab-az104-14-peering-udr-') | project id, name, type, location, resourceGroup = name, tags) | order by id asc");
  await assert.rejects(() => captureRequest("sub-x", "rg-wg-ondemand"));
});

test("faking the subscription replaces only a subscription GUID, never the word after it (a group row's type)", () => {
  const sub = "/subscriptions/394c7881-dd1d-4cac-86c0-61cf3fc03f58";
  const groupRow = { id: `${sub}/resourceGroups/rg-lab-az104-14-peering-udr`, name: "rg-lab-az104-14-peering-udr", type: "microsoft.resources/subscriptions/resourcegroups", resourceGroup: "rg-lab-az104-14-peering-udr", location: "uksouth", tags: {}, properties: {} };
  const [out] = captureRows([groupRow], { labId: "az104-14-peering-udr", ids: ["az104-14-peering-udr"], owns: (id, name) => name === `rg-lab-${id}` });
  assert.equal(out.type, "microsoft.resources/subscriptions/resourcegroups");
  assert.equal(out.id, `/subscriptions/${FAKE_SUBSCRIPTION}/resourceGroups/rg-lab-az104-14-peering-udr`);
});
