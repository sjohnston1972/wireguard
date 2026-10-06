// labs-topology.test.mjs
//
// Plain English: "npm run labs-topology" (scripts/labs-topology.mjs), the
// generator of each lab's planned diagram (lab topology spec §5): the plan
// stream parsing (never printing or keeping the plan, which holds the mock
// admin password), the pinned hcl2json, --check, and that the committed
// planned files are fresh in shape. terraform and hcl2json are faked here; CI
// runs them for real (npm run labs-topology -- --check).

import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnostics, planFromTestStream, refsFromHcl, scrubChanges, PLAN_OUTPUTS } from "../lib/topology-stream.mjs";
import { hclResources } from "../../infra/ci/lab-scope.mjs";

const MOCK_PASSWORD = "Mock-Passw0rd-labs-tf-not-real";

/** A terraform test -verbose -json stream with one test_plan message, as Terraform 1.14.6 prints it. */
export function fakeStream({ plan = true, diag = [] } = {}) {
  const lines = [
    { "@level": "info", "@message": "Terraform 1.14.6", type: "version", terraform: "1.14.6" },
    { "@level": "info", "@message": "Found 1 file and 1 run block", type: "test_abstract", test_abstract: {} },
  ];
  for (const d of diag) lines.push({ "@level": "error", "@message": `Error: ${d.summary}`, type: "diagnostic", diagnostic: { severity: "error", summary: d.summary, detail: d.detail ?? "" } });
  if (plan) {
    lines.push({
      "@level": "info",
      "@message": "-verbose flag enabled, printing plan",
      type: "test_plan",
      test_plan: {
        plan_format_version: "1.2",
        resource_changes: [
          {
            address: "azurerm_linux_virtual_machine.app",
            mode: "managed",
            type: "azurerm_linux_virtual_machine",
            name: "app",
            provider_name: "registry.terraform.io/hashicorp/azurerm",
            change: {
              actions: ["create"],
              before: null,
              after: { name: "vm-app", size: "Standard_B1s", admin_password: MOCK_PASSWORD, custom_data: "I2Nsb3VkLWNvbmZpZw==", admin_ssh_key: [{ public_key: "ssh-ed25519 AAAA", username: "azureuser" }], tags: { lab: "x" } },
              after_unknown: { id: true, network_interface_ids: [true] },
              before_sensitive: false,
              after_sensitive: { admin_password: true, custom_data: true },
            },
          },
          {
            address: "data.azurerm_client_config.current",
            mode: "data",
            type: "azurerm_client_config",
            name: "current",
            change: { actions: ["read"], after: {}, after_unknown: {} },
          },
          {
            address: 'azurerm_subnet.spoke["a"]',
            mode: "managed",
            type: "azurerm_subnet",
            name: "spoke",
            index: "a",
            change: { actions: ["create"], after: { name: "snet-a", address_prefixes: ["10.71.192.0/24"], shared_access_key: "abc" }, after_unknown: { id: true }, after_sensitive: {} },
          },
        ],
        output_changes: {
          peer_vnet_id: { actions: ["create"], after_unknown: true },
          private_ips: { actions: ["create"], after: { "vm-app": "10.71.192.4" }, after_unknown: {} },
          connect: { actions: ["create"], after: ["ssh azureuser@10.71.192.4"], after_unknown: [false] },
        },
        relevant_attributes: [],
        provider_format_version: "1.0",
        provider_schemas: { "registry.terraform.io/hashicorp/azurerm": { resource_schemas: {} } },
      },
    });
  }
  lines.push({ "@level": "info", "@message": "Success! 1 passed, 0 failed.", type: "test_summary", test_summary: { status: "pass" } });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("planFromTestStream takes resource_changes and output_changes from the test_plan message", () => {
  const { changes, outputs } = planFromTestStream(fakeStream());
  assert.deepEqual(
    changes.map((c) => c.address),
    ["azurerm_linux_virtual_machine.app", 'azurerm_subnet.spoke["a"]'],
    "managed resources only, in order",
  );
  assert.equal(changes[1].index, "a");
  assert.deepEqual(changes[0].after_unknown, { id: true, network_interface_ids: [true] });
  // Outputs: only the ones the builder reads, unknown as null.
  assert.deepEqual(Object.keys(outputs).sort(), [...PLAN_OUTPUTS].sort());
  assert.equal(outputs.peer_vnet_id, null);
});

test("planFromTestStream fails without a test_plan message", () => {
  assert.throws(() => planFromTestStream(fakeStream({ plan: false })), /no test_plan message/);
  assert.throws(() => planFromTestStream("not json\n"), /no test_plan message/);
});

test("the changes it returns hold no sensitive, secret-named or secret-like value", () => {
  const { changes } = planFromTestStream(fakeStream());
  const text = JSON.stringify(changes);
  assert.doesNotMatch(text, /Mock-Passw0rd/);
  assert.doesNotMatch(text, /custom_data|admin_password|admin_ssh_key|shared_access_key/);
  assert.match(text, /Standard_B1s/);
  assert.match(text, /10\.71\.192\.0\/24/);
  // No provider schemas, before values or sensitivity maps travel on.
  assert.deepEqual(Object.keys(changes[0]).sort(), ["address", "after", "after_unknown", "index", "name", "type"]);
});

test("scrubChanges drops what after_sensitive marks, at any depth", () => {
  const [c] = scrubChanges([
    { address: "x.y", type: "x", name: "y", change: { after: { a: { b: "keep", c: "drop" }, list: [{ s: "drop" }, { s: "keep" }] }, after_unknown: {}, after_sensitive: { a: { c: true }, list: [{ s: true }, {}] } } },
  ]);
  assert.deepEqual(c.after, { a: { b: "keep" }, list: [{}, { s: "keep" }] });
});

test("refsFromHcl gives each resource's references by top-level attribute, and the outputs' references", () => {
  // hcl2json's shape for: a NIC in a subnet, a VM using it, and an output naming a VNet.
  const hcl = {
    resource: {
      azurerm_network_interface: { app: [{ name: "nic-app", resource_group_name: "${azurerm_resource_group.lab.name}", ip_configuration: [{ name: "c", subnet_id: "${azurerm_subnet.app.id}" }] }] },
      azurerm_linux_virtual_machine: { app: [{ name: "vm-app", admin_password: "${var.admin_password}", network_interface_ids: ["${azurerm_network_interface.app.id}"] }] },
    },
    data: { azurerm_client_config: { current: [{}] } },
    output: { peer_vnet_id: [{ value: "${azurerm_virtual_network.hub.id}" }], note: [{ value: "plain" }] },
  };
  const refs = refsFromHcl(hcl, "az104-13-vnets", hclResources);
  assert.deepEqual(refs, {
    "azurerm_linux_virtual_machine.app": { network_interface_ids: ["azurerm_network_interface.app"] },
    "azurerm_network_interface.app": { ip_configuration: ["azurerm_subnet.app"], resource_group_name: ["azurerm_resource_group.lab"] },
    "output.peer_vnet_id": { value: ["azurerm_virtual_network.hub"] },
  });
});

test("diagnostics prints only the stream's diagnostic messages, with the mock secrets redacted", () => {
  const text = fakeStream({ plan: true, diag: [{ summary: "Invalid value", detail: `got ${MOCK_PASSWORD}` }] });
  const d = diagnostics(text);
  assert.equal(d.length, 1);
  assert.match(d[0], /^error: Invalid value/);
  assert.doesNotMatch(d.join("\n"), /Mock-Passw0rd|Standard_B1s|resource_changes/);
});
