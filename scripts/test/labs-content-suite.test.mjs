// labs-content-suite.test.mjs
//
// Plain English: the shared content checks every batch 2 lab runs
// (fixtures/labs/content.mjs, labContentSuite), proved on a batch 1 lab that
// already passes its own: lab 7, a VM, a share and a VNet, at the £ marker.
// Batch 1's own content tests (labs-storage, labs-content-identity) stay as
// they are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_TYPES, costMarker, estimateGbpH, lab, labContentSuite, resources } from "./fixtures/labs/content.mjs";

labContentSuite("az104-07-files", { marker: "£" });

test("CHILD_TYPES lists batch 1's child types and batch 2's (types with no tags of their own)", () => {
  for (const t of [
    "azurerm_storage_container",
    "azurerm_subnet",
    "azurerm_role_assignment",
    "azurerm_subnet_network_security_group_association",
    "azurerm_subnet_route_table_association",
    "azurerm_network_interface_application_security_group_association",
    "azurerm_lb_backend_address_pool",
    "azurerm_lb_probe",
    "azurerm_lb_rule",
    "azurerm_network_interface_backend_address_pool_association",
    "azurerm_virtual_machine_extension",
    "azurerm_virtual_machine_data_disk_attachment",
    "azurerm_virtual_network_peering",
    "azurerm_dns_a_record",
    "azurerm_private_dns_a_record",
    "azurerm_monitor_data_collection_rule_association",
    "azurerm_backup_policy_vm",
    "azurerm_backup_protected_vm",
  ]) {
    assert.ok(CHILD_TYPES.has(t), t);
  }
  assert.ok(!CHILD_TYPES.has("azurerm_linux_virtual_machine"));
});

test("the suite's estimate and marker follow the catalogue's rules (£ under £0.05/h, ££ under £0.50/h)", () => {
  assert.equal(estimateGbpH([{ gbp_h: 0.0092, qty: 2 }, { gbp_h: 0.0018 }]), 0.0202);
  assert.equal(costMarker(0.049, 5), "£");
  assert.equal(costMarker(0.05, 5), "££");
  assert.equal(costMarker(0.49, 12), "££");
  assert.equal(costMarker(0.5, 5), "£££");
  assert.equal(costMarker(0.01, 30), "£££");
  const l = lab("az104-07-files");
  assert.equal(resources(l, "azurerm_linux_virtual_machine").length, 1);
});
