// scripts/test/fixtures/labs/plans/labs.mjs
//
// Plain English: the first-deploy plan of each of labs 1-7, written out by
// hand from labs/<id>/terraform/main.tf with the values a real session gives
// (slot 1, uksouth, a name prefix, a UPN domain), and turned into a
// `terraform show -json` plan by realistic.mjs. What the plan knows is in
// `values`; what Terraform only knows after apply (ids, object ids, anything
// built from them, timestamp()) is in `unknown`; and every attribute the
// provider computes and main.tf leaves unset is added as unknown from the
// real provider schemas. lab-plans.test.mjs checks each description still
// matches its main.tf (resources and attribute names) and that lab-scope.mjs
// passes it, as lab.yml's "Plan and scope check" would.

//
// Batch 2's labs (8-19) each have their own file in labs/, named by the lab
// id, so content areas never edit this one: `export default () => ({ lab,
// variables, resources, data? })`, using common.mjs. LAB_PLANS merges them.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realisticPlan } from "./realistic.mjs";
import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, SUB, TENANT, UPN } from "./common.mjs";

const storage = (c, name, extra = {}) => ({
  account_kind: "StorageV2",
  account_tier: "Standard",
  account_replication_type: "LRS",
  min_tls_version: "TLS1_2",
  https_traffic_only_enabled: true,
  allow_nested_items_to_be_public: false,
  ...extra,
  name: `${c.prefix}${name}`,
  resource_group_name: c.rg,
  location: REGION,
});

function lab1() {
  const c = ctx("az104-01-identity", "01");
  const user = (who, department, job) => ({
    address: `azuread_user.${who}`,
    values: {
      display_name: `lab-${c.id}-${who}`,
      user_principal_name: `lab-${c.id}-${who}@${UPN}`,
      mail_nickname: `lab-${c.id}-${who}`,
      password: "(the session's admin password)",
      force_password_change: false,
      department,
      job_title: job,
      usage_location: "GB",
    },
    refs: { display_name: ["var.lab_id"], user_principal_name: ["var.lab_id", "var.upn_domain"], mail_nickname: ["var.lab_id"], password: ["var.admin_password"] },
    sensitive: ["password"],
  });
  return {
    lab: c.id,
    providers: ["azurerm", "azuread"],
    variables: c.variables,
    data: [
      {
        address: "data.azurerm_subscription.current",
        values: { id: `/subscriptions/${SUB}`, subscription_id: SUB, display_name: "Pay-As-You-Go", tenant_id: TENANT, state: "Enabled", location_placement_id: "Public_2014-09-01", quota_id: "PayAsYouGo_2014-09-01", spending_limit: "Off", tags: {} },
      },
    ],
    resources: [
      rgResource(c),
      { address: "azurerm_network_security_group.demo", values: { name: "nsg-lab-demo", location: REGION, resource_group_name: c.rg, tags: c.tags }, refs: IN_RG },
      user("ann", "Helpdesk", "Helpdesk analyst"),
      user("ben", "Operations", "VM operator"),
      {
        address: "azuread_group.helpdesk",
        values: { display_name: `lab-${c.id}-helpdesk`, mail_nickname: `lab-${c.id}-helpdesk`, description: `Lab group: Reader on rg-lab-${c.id}. Removed at tear-down.`, security_enabled: true },
        unknown: ["members"],
        refs: { display_name: ["var.lab_id"], mail_nickname: ["var.lab_id"], description: ["var.lab_id"], members: ref("azuread_user.ann", "object_id") },
      },
      {
        address: "azurerm_role_definition.vm_operator",
        values: {
          role_definition_id: "7331dcae-09d3-477e-8da7-2895697f0fc0",
          name: `lab-${c.id}-vm-operator`,
          scope: `/subscriptions/${SUB}`,
          description: "Lab custom role: see, start, stop and restart VMs, nothing else. Removed at tear-down.",
          permissions: [
            {
              actions: [
                "Microsoft.Resources/subscriptions/resourceGroups/read",
                "Microsoft.Compute/virtualMachines/read",
                "Microsoft.Compute/virtualMachines/start/action",
                "Microsoft.Compute/virtualMachines/powerOff/action",
                "Microsoft.Compute/virtualMachines/deallocate/action",
                "Microsoft.Compute/virtualMachines/restart/action",
              ],
              not_actions: [],
              data_actions: null,
              not_data_actions: null,
            },
          ],
        },
        unknown: ["assignable_scopes"],
        refs: { name: ["var.lab_id"], scope: ref("data.azurerm_subscription.current", "id"), assignable_scopes: ref("azurerm_resource_group.lab", "id") },
      },
      {
        address: "azurerm_role_assignment.helpdesk_reader",
        values: { role_definition_name: "Reader", principal_type: "Group" },
        unknown: ["scope", "principal_id"],
        refs: { scope: ref("azurerm_resource_group.lab", "id"), principal_id: ref("azuread_group.helpdesk", "object_id") },
      },
      {
        address: "azurerm_role_assignment.ben_vm_operator",
        values: { principal_type: "User" },
        unknown: ["scope", "role_definition_id", "principal_id"],
        refs: { scope: ref("azurerm_resource_group.lab", "id"), role_definition_id: ref("azurerm_role_definition.vm_operator", "role_definition_resource_id"), principal_id: ref("azuread_user.ben", "object_id") },
      },
    ],
  };
}

function lab2() {
  const c = ctx("az104-02-policy", "02");
  const params = JSON.stringify({
    effect: { allowedValues: ["Deny", "Audit", "Disabled"], defaultValue: "Deny", metadata: { description: "Deny refuses the change; Audit only reports it.", displayName: "Effect" }, type: "String" },
    tagName: { defaultValue: "costcentre", metadata: { description: "The tag every new resource must carry.", displayName: "Tag name" }, type: "String" },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_network_security_group.untagged", values: { name: "nsg-untagged", location: REGION, resource_group_name: c.rg, tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_policy_definition.require_costcentre_tag",
        values: {
          name: `lab-${c.id}-require-costcentre-tag`,
          policy_type: "Custom",
          mode: "Indexed",
          display_name: `lab-${c.id}: require a costcentre tag`,
          description: "Lab policy: resources need the tag named in tagName. Removed at tear-down.",
          metadata: JSON.stringify({ category: "Tags" }),
          parameters: params,
          policy_rule: JSON.stringify({ if: { exists: "false", field: "[concat('tags[', parameters('tagName'), ']')]" }, then: { effect: "[parameters('effect')]" } }),
        },
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"] },
      },
      {
        address: "azurerm_resource_group_policy_assignment.require_tag",
        values: {
          name: `lab-${c.id}-require-tag`,
          display_name: `lab-${c.id}: require a costcentre tag`,
          parameters: JSON.stringify({ effect: { value: "Deny" }, tagName: { value: "costcentre" } }),
          non_compliance_message: [{ content: "Lab policy: every resource in this group needs a costcentre tag." }],
        },
        unknown: ["resource_group_id", "policy_definition_id"],
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], resource_group_id: ref("azurerm_resource_group.lab", "id"), policy_definition_id: ref("azurerm_policy_definition.require_costcentre_tag", "id") },
      },
      {
        address: "azurerm_resource_group_policy_assignment.allowed_locations",
        values: {
          name: `lab-${c.id}-allowed-locations`,
          display_name: `lab-${c.id}: allowed locations`,
          policy_definition_id: "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c",
          parameters: JSON.stringify({ listOfAllowedLocations: { value: [REGION] } }),
          non_compliance_message: [{ content: `Lab policy: resources in this group may only be created in ${REGION}.` }],
        },
        unknown: ["resource_group_id"],
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], resource_group_id: ref("azurerm_resource_group.lab", "id"), policy_definition_id: ["local.allowed_locations_id"], parameters: ["var.region"] },
      },
      {
        address: "azurerm_storage_account.tagged",
        // main.tf leaves https_traffic_only_enabled to the provider's default here.
        values: (({ https_traffic_only_enabled, ...v }) => v)(storage(c, "tags", { access_tier: "Hot", tags: { ...c.tags, costcentre: "cc-1234" } })),
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
      {
        address: "azurerm_management_lock.no_delete",
        values: { name: `lab-${c.id}-no-delete`, lock_level: "CanNotDelete", notes: "Lab lock: try deleting the account. Tear-down removes it." },
        unknown: ["scope"],
        refs: { name: ["var.lab_id"], scope: ref("azurerm_storage_account.tagged", "id") },
      },
    ],
  };
}

function lab3() {
  const c = ctx("az104-03-mgmt-groups", "03");
  const mg = (n, child) => ({
    address: `azurerm_management_group.${n}`,
    values: { name: `lab-${c.id}-${n}`, display_name: `lab-${c.id}-${n}` },
    unknown: child ? ["parent_management_group_id"] : [],
    refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], ...(child ? { parent_management_group_id: ref("azurerm_management_group.root", "id") } : {}) },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      mg("root", false),
      mg("prod", true),
      mg("dev", true),
      {
        address: "azurerm_policy_definition.audit_environment_tag",
        values: {
          name: `lab-${c.id}-audit-environment-tag`,
          policy_type: "Custom",
          mode: "Indexed",
          display_name: `lab-${c.id}: audit resources without an environment tag`,
          description: "Lab policy: reports resources with no environment tag. Audit only. Removed at tear-down.",
          metadata: JSON.stringify({ category: "Tags" }),
          policy_rule: JSON.stringify({ if: { exists: "false", field: "tags['environment']" }, then: { effect: "audit" } }),
        },
        unknown: ["management_group_id"],
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], management_group_id: ref("azurerm_management_group.root", "id") },
      },
      {
        address: "azurerm_management_group_policy_assignment.audit_environment_tag",
        values: { name: "audit-environment-tag", display_name: `lab-${c.id}-audit-environment-tag`, non_compliance_message: [{ content: "Lab policy: tag resources with environment (for example prod or dev)." }] },
        unknown: ["management_group_id", "policy_definition_id"],
        refs: { display_name: ["var.lab_id"], management_group_id: ref("azurerm_management_group.root", "id"), policy_definition_id: ref("azurerm_policy_definition.audit_environment_tag", "id") },
      },
    ],
  };
}

function lab4() {
  const c = ctx("az104-04-cost", "04");
  const note = (threshold, threshold_type) => ({ enabled: true, threshold, operator: "GreaterThanOrEqualTo", threshold_type, contact_groups: ["(unknown)"] });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      {
        address: "azurerm_monitor_action_group.budget",
        values: { name: `lab-${c.id}-budget-alerts`, resource_group_name: c.rg, short_name: "labbudget", enabled: true, tags: c.tags },
        refs: { name: ["var.lab_id"], resource_group_name: IN_RG.resource_group_name, tags: ["var.tags"] },
      },
      {
        address: "azurerm_consumption_budget_resource_group.monthly",
        values: { name: `lab-${c.id}-monthly`, amount: 5, time_grain: "Monthly", time_period: [{ start_date: "(unknown)" }], notification: [note(50, "Actual"), note(80, "Actual"), note(100, "Forecasted")] },
        // timestamp() is only known at apply, so the start date is too.
        unknown: ["resource_group_id", "time_period.0.start_date", "notification.0.contact_groups", "notification.1.contact_groups", "notification.2.contact_groups"],
        refs: {
          name: ["var.lab_id"],
          resource_group_id: ref("azurerm_resource_group.lab", "id"),
          "notification.0.contact_groups": ref("azurerm_monitor_action_group.budget", "id"),
          "notification.1.contact_groups": ref("azurerm_monitor_action_group.budget", "id"),
          "notification.2.contact_groups": ref("azurerm_monitor_action_group.budget", "id"),
        },
      },
    ],
  };
}

function lab5() {
  const c = ctx("az104-05-storage", "05");
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_storage_account.hot", values: storage(c, "hot", { access_tier: "Hot", tags: c.tags }), refs: { ...IN_RG, name: ["var.name_prefix"] } },
      { address: "azurerm_storage_account.cool", values: storage(c, "cool", { account_replication_type: "GRS", access_tier: "Cool", tags: c.tags }), refs: { ...IN_RG, name: ["var.name_prefix"] } },
      { address: "azurerm_storage_container.samples", values: { name: "samples", container_access_type: "private" }, unknown: ["storage_account_id"], refs: { storage_account_id: ref("azurerm_storage_account.hot", "id") } },
      {
        address: "azurerm_storage_blob.hello",
        values: { name: "hello.txt", type: "Block", content_type: "text/plain", source_content: `Hello from ${c.rg}. Change my access tier, then read the lifecycle rule that would do it for you.\n` },
        unknown: ["storage_container_id"],
        refs: { storage_container_id: ref("azurerm_storage_container.samples", "id"), source_content: ["var.resource_group_name"] },
      },
      {
        address: "azurerm_storage_management_policy.hot",
        values: {
          rule: [
            {
              name: "cool-at-30-delete-at-365",
              enabled: true,
              filters: [{ blob_types: ["blockBlob"] }],
              actions: [{ base_blob: [{ tier_to_cool_after_days_since_modification_greater_than: 30, delete_after_days_since_modification_greater_than: 365 }] }],
            },
          ],
        },
        unknown: ["storage_account_id"],
        refs: { storage_account_id: ref("azurerm_storage_account.hot", "id") },
      },
    ],
  };
}

function lab6() {
  const c = ctx("az104-06-blob-security", "06");
  const sa = `${c.prefix}blob`;
  return {
    lab: c.id,
    providers: ["azurerm", "azuread"],
    variables: c.variables,
    resources: [
      rgResource(c),
      {
        address: "azurerm_storage_account.blob",
        values: storage(c, "blob", { access_tier: "Hot", shared_access_key_enabled: true, public_network_access_enabled: true, tags: c.tags }),
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
      { address: "azurerm_storage_container.private", values: { name: "private", container_access_type: "private" }, unknown: ["storage_account_id"], refs: { storage_account_id: ref("azurerm_storage_account.blob", "id") } },
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.endpoints",
        values: { name: "snet-endpoints", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"] },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.endpoints_cidr"] },
      },
      { address: "azurerm_private_dns_zone.blob", values: { name: "privatelink.blob.core.windows.net", resource_group_name: c.rg, tags: c.tags }, refs: { resource_group_name: IN_RG.resource_group_name, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.lab",
        values: { name: "link-vnet-lab", resource_group_name: c.rg, private_dns_zone_name: "privatelink.blob.core.windows.net", registration_enabled: false, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { resource_group_name: IN_RG.resource_group_name, private_dns_zone_name: ref("azurerm_private_dns_zone.blob", "name"), virtual_network_id: ref("azurerm_virtual_network.lab", "id"), tags: ["var.tags"] },
      },
      {
        address: "azurerm_private_endpoint.blob",
        values: {
          name: `pe-${sa}-blob`,
          resource_group_name: c.rg,
          location: REGION,
          custom_network_interface_name: `nic-pe-${sa}-blob`,
          tags: c.tags,
          private_service_connection: [{ name: "psc-blob", private_connection_resource_id: "(unknown)", subresource_names: ["blob"], is_manual_connection: false }],
          private_dns_zone_group: [{ name: "blob", private_dns_zone_ids: ["(unknown)"] }],
        },
        unknown: ["subnet_id", "private_service_connection.0.private_connection_resource_id", "private_dns_zone_group.0.private_dns_zone_ids"],
        refs: {
          ...IN_RG,
          name: ref("azurerm_storage_account.blob", "name"),
          custom_network_interface_name: ref("azurerm_storage_account.blob", "name"),
          subnet_id: ref("azurerm_subnet.endpoints", "id"),
          "private_service_connection.0.private_connection_resource_id": ref("azurerm_storage_account.blob", "id"),
          "private_dns_zone_group.0.private_dns_zone_ids": ref("azurerm_private_dns_zone.blob", "id"),
        },
      },
      {
        address: "azuread_group.readers",
        values: {
          display_name: `lab-${c.id}-readers`,
          mail_nickname: `lab-${c.id}-readers`,
          description: `wg-admin lab ${c.id}: Storage Blob Data Reader on ${c.rg}. Removed at tear-down.`,
          security_enabled: true,
        },
        refs: { display_name: ["var.lab_id"], mail_nickname: ["var.lab_id"], description: ["var.lab_id", "var.resource_group_name"] },
      },
      {
        address: "azurerm_role_assignment.readers",
        values: { role_definition_name: "Storage Blob Data Reader", principal_type: "Group" },
        unknown: ["scope", "principal_id"],
        refs: { scope: ref("azurerm_resource_group.lab", "id"), principal_id: ref("azuread_group.readers", "object_id") },
      },
    ],
  };
}

function lab7() {
  const c = ctx("az104-07-files", "07");
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.vms",
        values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"], service_endpoints: ["Microsoft.Storage"], default_outbound_access_enabled: true },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.vms_cidr"] },
      },
      {
        address: "azurerm_storage_account.files",
        values: storage(c, "files", {
          shared_access_key_enabled: true,
          public_network_access_enabled: true,
          tags: c.tags,
          network_rules: [{ default_action: "Deny", bypass: ["AzureServices"], virtual_network_subnet_ids: ["(unknown)"] }],
          share_properties: [{ retention_policy: [{ days: 7 }] }],
        }),
        unknown: ["network_rules.0.virtual_network_subnet_ids"],
        refs: { ...IN_RG, name: ["var.name_prefix"], "network_rules.0.virtual_network_subnet_ids": ref("azurerm_subnet.vms", "id") },
      },
      {
        address: "azurerm_storage_share.share",
        values: { name: "labshare", quota: 5, enabled_protocol: "SMB", access_tier: "TransactionOptimized" },
        unknown: ["storage_account_id"],
        refs: { storage_account_id: ref("azurerm_storage_account.files", "id") },
      },
      // The cloud-init holds the storage account's key, known only after apply.
      ...linuxVm(c, {
        name: "vm-files",
        key: "vm",
        subnet: "azurerm_subnet.vms",
        customData: [...ref("azurerm_storage_account.files", "name"), ...ref("azurerm_storage_account.files", "primary_file_host"), ...ref("azurerm_storage_share.share", "name"), ...ref("azurerm_storage_account.files", "primary_access_key")],
      }),
    ],
  };
}

const withPlan = (d) => ({ ...d, plan: realisticPlan(d) });

/**
 * Every <lab id>.mjs in `dir` (a path or file URL): { [lab]: { ...description, plan } }.
 * A file must be named by the lab id its description gives.
 */
export async function loadLabPlans(dir) {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir;
  let files = [];
  try {
    files = readdirSync(path).filter((f) => f.endsWith(".mjs")).sort();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const out = {};
  for (const f of files) {
    const mod = await import(pathToFileURL(join(path, f)).href);
    if (typeof mod.default !== "function") throw new Error(`${f}: export default () => ({ lab, variables, resources, data? })`);
    const d = mod.default();
    if (`${d?.lab}.mjs` !== f) throw new Error(`${f}: the file must be named by its lab id (it describes ${d?.lab})`);
    out[d.lab] = withPlan(d);
  }
  return out;
}

/** Each lab's description (resources as main.tf has them) and its realistic plan: labs 1-7 here, the rest from labs/. */
export const LAB_PLANS = {
  ...Object.fromEntries([lab1, lab2, lab3, lab4, lab5, lab6, lab7].map((f) => withPlan(f())).map((d) => [d.lab, d])),
  ...(await loadLabPlans(new URL("./labs/", import.meta.url))),
};
