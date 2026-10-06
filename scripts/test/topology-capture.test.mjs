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
import { CAPTURE_KEEP, captureRequest, captureRows, FAKE_SUBSCRIPTION } from "../topology-capture.mjs";

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
  const [out] = captureRows([row]);
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
  for (const p of CAPTURE_KEEP) assert.match(p, /^[A-Za-z]+(\[\])?(\.[A-Za-z]+(\[\])?)*$/, p);
  for (const p of ["subnets[].properties.addressPrefix", "virtualNetworkPeerings[].properties.peeringState", "routes[].properties.nextHopIpAddress", "ipConfigurations[].properties.privateIPAddress", "privateLinkServiceConnections[].properties.privateLinkServiceConnectionState.status"]) assert.ok(CAPTURE_KEEP.includes(p), p);
});

test("the capture runs the one query topologyQuery writes, for the subscription named", async () => {
  const body = await captureRequest("sub-x", "az104-14-peering-udr");
  assert.deepEqual(body.subscriptions, ["sub-x"]);
  assert.equal(body.query, "resources | where resourceGroup =~ 'rg-lab-az104-14-peering-udr' or resourceGroup startswith 'rg-lab-az104-14-peering-udr-' | project id, name, type, kind, location, resourceGroup, sku, tags, zones, identity, managedBy, properties | union (resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' and (name =~ 'rg-lab-az104-14-peering-udr' or name startswith 'rg-lab-az104-14-peering-udr-') | project id, name, type, location, resourceGroup = name, tags) | order by id asc");
  await assert.rejects(() => captureRequest("sub-x", "rg-wg-ondemand"));
});
