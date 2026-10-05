// scripts/test/fixtures/labs/plans/labs/az305-20-landing-zone.mjs
//
// Plain English: lab 20's first-deploy plan, as `terraform show -json` prints
// it (realistic.mjs adds what azurerm 4.81.0 computes). Six management groups
// (every parent id unknown until the parent exists), a custom audit and an
// initiative stored at lab-<id>-root, two management group assignments, two
// custom roles defined at the subscription (read at plan, so its id is known)
// and assignable at rg-lab-<id>, two user-assigned identities and the two role
// assignments that give each identity its role. Nested block references are
// listed under the block's attribute (policy_definition_reference.N.x).

import { IN_RG, REGION, SUB, TENANT, ctx, ref, rgResource } from "../common.mjs";

const NOT_ALLOWED_TYPES = "/providers/Microsoft.Authorization/policyDefinitions/6c112d4e-5bc7-47ae-a041-ea2d9dccd749";
const ALLOWED_LOCATIONS = "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c";
const RG_TAG = "/providers/Microsoft.Authorization/policyDefinitions/96670d01-0a4d-4649-9c89-2d3abc0a5025";

export default () => {
  const c = ctx("az305-20-landing-zone", "20");
  const mg = (n, parent) => ({
    address: `azurerm_management_group.${n}`,
    values: { name: `lab-${c.id}-${n}`, display_name: `lab-${c.id}-${n}` },
    unknown: parent ? ["parent_management_group_id"] : [],
    refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], ...(parent ? { parent_management_group_id: ref(`azurerm_management_group.${parent}`, "id") } : {}) },
  });
  const role = (key, guid, description, actions) => ({
    address: `azurerm_role_definition.${key}`,
    values: {
      role_definition_id: guid,
      name: `lab-${c.id}-${key}`,
      scope: `/subscriptions/${SUB}`,
      description,
      permissions: [{ actions, not_actions: [], data_actions: null, not_data_actions: null }],
    },
    unknown: ["assignable_scopes"],
    refs: { name: ["var.lab_id"], scope: ref("data.azurerm_subscription.current", "id"), assignable_scopes: ref("azurerm_resource_group.lab", "id") },
  });
  const identity = (key) => ({
    address: `azurerm_user_assigned_identity.${key}`,
    values: { name: `id-${c.prefix}-${key}`, resource_group_name: c.rg, location: REGION, tags: c.tags },
    refs: { ...IN_RG, name: ["var.name_prefix"] },
  });
  const assignment = (key) => ({
    address: `azurerm_role_assignment.${key}`,
    values: { principal_type: "ServicePrincipal", skip_service_principal_aad_check: true },
    unknown: ["scope", "role_definition_id", "principal_id"],
    refs: {
      scope: ref("azurerm_resource_group.lab", "id"),
      role_definition_id: ref(`azurerm_role_definition.${key}`, "role_definition_resource_id"),
      principal_id: ref(`azurerm_user_assigned_identity.${key}`, "principal_id"),
    },
  });
  return {
    lab: c.id,
    variables: c.variables,
    data: [
      {
        address: "data.azurerm_subscription.current",
        values: { id: `/subscriptions/${SUB}`, subscription_id: SUB, display_name: "Pay-As-You-Go", tenant_id: TENANT, state: "Enabled", location_placement_id: "Public_2014-09-01", quota_id: "PayAsYouGo_2014-09-01", spending_limit: "Off", tags: {} },
      },
    ],
    resources: [
      rgResource(c),
      mg("root", null),
      mg("platform", "root"),
      mg("landingzones", "root"),
      mg("corp", "landingzones"),
      mg("online", "landingzones"),
      mg("sandbox", "root"),
      {
        address: "azurerm_policy_definition.audit_costcentre",
        values: {
          name: `lab-${c.id}-audit-costcentre`,
          policy_type: "Custom",
          mode: "Indexed",
          display_name: `lab-${c.id}: audit resources without a costcentre tag`,
          description: "Lab policy: reports resources with no costcentre tag. Audit only. Removed at tear-down.",
          metadata: JSON.stringify({ category: "Tags" }),
          policy_rule: JSON.stringify({ if: { exists: "false", field: "tags['costcentre']" }, then: { effect: "audit" } }),
        },
        unknown: ["management_group_id"],
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], management_group_id: ref("azurerm_management_group.root", "id") },
      },
      {
        address: "azurerm_management_group_policy_set_definition.baseline",
        values: {
          name: `lab-${c.id}-baseline`,
          policy_type: "Custom",
          display_name: `lab-${c.id}: landing zone baseline`,
          description: "Lab initiative: where resources may live and how they are tagged. Removed at tear-down.",
          metadata: JSON.stringify({ category: "General" }),
          policy_definition_group: [
            { name: "location", display_name: "Location", description: "Where resources may be created.", category: null, additional_metadata_resource_id: null },
            { name: "tagging", display_name: "Tagging", description: "The cost centre tag every landing zone uses.", category: null, additional_metadata_resource_id: null },
          ],
          policy_definition_reference: [
            { policy_definition_id: ALLOWED_LOCATIONS, reference_id: "allowedLocations", policy_group_names: ["location"], parameter_values: JSON.stringify({ listOfAllowedLocations: { value: [REGION] } }) },
            { policy_definition_id: RG_TAG, reference_id: "requireCostcentreOnGroups", policy_group_names: ["tagging"], parameter_values: JSON.stringify({ tagName: { value: "costcentre" } }) },
            { reference_id: "auditCostcentre", policy_group_names: ["tagging"], parameter_values: null },
          ],
        },
        unknown: ["management_group_id", "policy_definition_reference.2.policy_definition_id"],
        refs: {
          name: ["var.lab_id"],
          display_name: ["var.lab_id"],
          management_group_id: ref("azurerm_management_group.root", "id"),
          "policy_definition_reference.0.parameter_values": ["var.region"],
          "policy_definition_reference.2.policy_definition_id": ref("azurerm_policy_definition.audit_costcentre", "id"),
        },
      },
      {
        address: "azurerm_management_group_policy_assignment.baseline",
        values: { name: "lz-baseline", display_name: `lab-${c.id}-lz-baseline`, non_compliance_message: [{ content: "Lab policy: landing zones use the session's region and a costcentre tag.", policy_definition_reference_id: null }] },
        unknown: ["management_group_id", "policy_definition_id"],
        refs: {
          display_name: ["var.lab_id"],
          management_group_id: ref("azurerm_management_group.landingzones", "id"),
          policy_definition_id: ref("azurerm_management_group_policy_set_definition.baseline", "id"),
        },
      },
      {
        address: "azurerm_management_group_policy_assignment.sandbox_no_pip",
        values: {
          name: "sandbox-no-pip",
          display_name: `lab-${c.id}-sandbox-no-pip`,
          policy_definition_id: NOT_ALLOWED_TYPES,
          parameters: JSON.stringify({ listOfResourceTypesNotAllowed: { value: ["Microsoft.Network/publicIPAddresses"] } }),
          non_compliance_message: [{ content: "Lab policy: sandboxes get no public IP addresses.", policy_definition_reference_id: null }],
        },
        unknown: ["management_group_id"],
        refs: { display_name: ["var.lab_id"], management_group_id: ref("azurerm_management_group.sandbox", "id"), policy_definition_id: ["local.not_allowed_types_id"] },
      },
      role("netops", "60bdbc03-b25a-4a83-9fce-b2c5afff563c", "Lab custom role: read the network and change NSG rules and routes, nothing else. Removed at tear-down.", [
        "Microsoft.Network/*/read",
        "Microsoft.Network/networkSecurityGroups/securityRules/write",
        "Microsoft.Network/networkSecurityGroups/securityRules/delete",
        "Microsoft.Network/routeTables/routes/write",
        "Microsoft.Network/routeTables/routes/delete",
        "Microsoft.Resources/subscriptions/resourceGroups/read",
      ]),
      role("appops", "bd52e05a-22cb-4bd5-b56c-3396add9b7c0", "Lab custom role: see VMs and their metrics, start, restart and deallocate them, nothing else. Removed at tear-down.", [
        "Microsoft.Compute/*/read",
        "Microsoft.Compute/virtualMachines/start/action",
        "Microsoft.Compute/virtualMachines/restart/action",
        "Microsoft.Compute/virtualMachines/deallocate/action",
        "Microsoft.Insights/metrics/read",
        "Microsoft.Resources/subscriptions/resourceGroups/read",
      ]),
      identity("netops"),
      identity("appops"),
      assignment("netops"),
      assignment("appops"),
    ],
  };
};
