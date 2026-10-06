// topology-arm.test.ts: Bicep labs' resources on the planned diagram (lab topology spec ruling 24). Lab 12's
// main.bicep, built by the pinned Bicep (scripts/lib/bicep.mjs, 0.47.16) into
// worker/test/fixtures/topology/arm/az104-12-main.json, expanded by the minimal ARM evaluator.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateArm, expandTemplate, UnsupportedArm } from "../../shared/topology/armTemplate";
import { plannedGraph, representedIds } from "../../shared/topology/planned";
import { denyProblems } from "../../shared/topology/props";

const main = JSON.parse(readFileSync(new URL("./fixtures/topology/arm/az104-12-main.json", import.meta.url), "utf8"));
const params = { vnetCidr: "10.71.192.0/20", namePrefix: "l12k3x9q", tags: { lab: "az104-12-bicep", project: "wg-admin-labs", session: "ls-labs-tf-mock" } };

describe("expandTemplate", () => {
  it("lab 12's compiled template expands to the storage account, the NSG, the VNet and its two subnets with names from parameters", () => {
    const rs = expandTemplate(main, params, "uksouth");
    expect(rs.map((r) => `${r.type}/${r.name}`).sort()).toEqual(["Microsoft.Network/networkSecurityGroups/nsg-bicep", "Microsoft.Network/virtualNetworks/vnet-bicep", "Microsoft.Storage/storageAccounts/l12k3x9qbicep"]);
    const sa = rs.find((r) => r.type === "Microsoft.Storage/storageAccounts")!;
    expect(sa.properties.accessTier).toBe("Hot"); // the parameter's default
    expect(sa.kind).toBe("StorageV2");
    expect(sa.location).toBe("uksouth"); // resourceGroup().location
    const vnet = rs.find((r) => r.type === "Microsoft.Network/virtualNetworks")!;
    expect(vnet.properties.addressSpace).toEqual({ addressPrefixes: ["10.71.192.0/20"] });
    expect(vnet.properties.subnets).toEqual([
      { name: "snet-web", properties: { addressPrefix: "10.71.192.0/24", networkSecurityGroup: { id: "/providers/Microsoft.Network/networkSecurityGroups/nsg-bicep" } } },
      { name: "snet-app", properties: { addressPrefix: "10.71.193.0/24", networkSecurityGroup: { id: "/providers/Microsoft.Network/networkSecurityGroups/nsg-bicep" } } },
    ]);
    expect(vnet.refs).toEqual(["Microsoft.Network/networkSecurityGroups/nsg-bicep"]);
  });

  it("a nested deployment's inline template is expanded, its parameters evaluated outside (scope inner)", () => {
    const t = {
      parameters: { p: { type: "string" } },
      variables: { names: ["a", "b"] },
      resources: [
        {
          type: "Microsoft.Resources/deployments",
          name: "inner",
          properties: {
            expressionEvaluationOptions: { scope: "inner" },
            parameters: { q: { value: "[concat(parameters('p'), '-x')]" }, names: { value: "[variables('names')]" } },
            template: {
              parameters: { q: { type: "string" }, names: { type: "array" } },
              resources: [{ type: "Microsoft.Network/routeTables", name: "[format('rt-{0}-{1}', parameters('q'), parameters('names')[copyIndex()])]", copy: { name: "rts", count: "[length(parameters('names'))]" }, properties: {} }],
            },
          },
        },
      ],
    };
    expect(expandTemplate(t, { p: "hub" }, "uksouth").map((r) => r.name)).toEqual(["rt-hub-x-a", "rt-hub-x-b"]);
  });

  it("symbolic-name templates (languageVersion 2.0, resources as an object) expand too", () => {
    const t = { languageVersion: "2.0", resources: { sa: { type: "Microsoft.Storage/storageAccounts", name: "[toLower('SA1')]", properties: {} } } };
    expect(expandTemplate(t, {}, "uksouth").map((r) => r.name)).toEqual(["sa1"]);
  });

  it("an unsupported expression throws UnsupportedArm naming it", () => {
    const t = { resources: [{ type: "Microsoft.Storage/storageAccounts", name: "[uniqueString(resourceGroup().id)]", properties: {} }] };
    let caught: unknown;
    try {
      expandTemplate(t, {}, "uksouth");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedArm);
    expect((caught as UnsupportedArm).expression).toContain("uniqueString");
    expect((caught as Error).message).toContain("uniqueString");
    // A linked template cannot be read offline either.
    expect(() => expandTemplate({ resources: [{ type: "Microsoft.Resources/deployments", name: "l", properties: { templateLink: { uri: "https://x" } } }] }, {}, "uksouth")).toThrow(UnsupportedArm);
  });

  it("the evaluator: literals, escapes, indexing, cidrSubnet, if and equals", () => {
    const ctx = { parameters: { a: [{ n: 1 }], c: "10.0.0.0/16" }, variables: {}, location: "uksouth" };
    expect(evaluateArm("[[not an expression]", ctx)).toBe("[not an expression]");
    expect(evaluateArm("['it''s']", ctx)).toBe("it's");
    expect(evaluateArm("[parameters('a')[0].n]", ctx)).toBe(1);
    expect(evaluateArm("[cidrSubnet(parameters('c'), 24, 3)]", ctx)).toBe("10.0.3.0/24");
    expect(evaluateArm("[if(equals(1, 1), 'y', 'n')]", ctx)).toBe("y");
    expect(evaluateArm("[resourceId('Microsoft.Network/virtualNetworks/subnets', 'v', 's')]", ctx)).toBe("/providers/Microsoft.Network/virtualNetworks/v/subnets/s");
    expect(evaluateArm("plain", ctx)).toBe("plain");
  });
});

describe("lab 12 on the planned diagram", () => {
  const rg = "rg-lab-az104-12-bicep";
  const g = plannedGraph({
    labId: "az104-12-bicep",
    version: 1,
    number: "12",
    outputs: { peer_vnet_id: null },
    refs: { "azurerm_resource_group_template_deployment.bicep": { resource_group_name: ["azurerm_resource_group.lab"] } },
    changes: [
      { address: "azurerm_resource_group.lab", type: "azurerm_resource_group", name: "lab", index: null, after: { name: rg, location: "uksouth", tags: params.tags } },
      {
        address: "azurerm_resource_group_template_deployment.bicep",
        type: "azurerm_resource_group_template_deployment",
        name: "bicep",
        index: null,
        after: { name: "bicep-main", resource_group_name: rg, deployment_mode: "Incremental", template_content: JSON.stringify(main), parameters_content: JSON.stringify({ vnetCidr: { value: params.vnetCidr }, namePrefix: { value: params.namePrefix }, tags: { value: params.tags } }) },
      },
    ],
  });

  it("draws the template's VNet with both subnets, the NSG as their chip, and the storage account, keyed as live will be", () => {
    const vnet = g.nodes.find((n) => n.kind === "vnet")!;
    expect(vnet).toMatchObject({ label: "vnet-bicep", key: "microsoft.network/virtualnetworks/vnet-bicep", props: { addressSpace: ["10.71.192.0/20"] } });
    const subnets = g.nodes.filter((n) => n.kind === "subnet");
    expect(subnets.map((s) => [s.label, s.props.prefix, s.parent]).sort()).toEqual([
      ["snet-app", "10.71.193.0/24", vnet.id],
      ["snet-web", "10.71.192.0/24", vnet.id],
    ]);
    for (const s of subnets) expect(s.props.chips).toEqual(["NSG nsg-bicep"]);
    expect(g.nodes.some((n) => n.kind === "nsg")).toBe(false);
    const sa = g.nodes.find((n) => n.kind === "storage")!;
    expect(sa).toMatchObject({ label: "l12…bicep", key: "microsoft.storage/storageaccounts/{p}bicep", props: { accountKind: "StorageV2", accessTier: "Hot", publicAccess: false } });
    expect(g.nodes.find((n) => n.id === sa.parent)?.kind).toBe("resourceGroup");
  });

  it("the deployment folds into its group; everything is represented; no secret", () => {
    const rgNode = g.nodes.find((n) => n.kind === "resourceGroup")!;
    expect(rgNode.folded?.map((f) => f.id)).toContain("tf:azurerm_resource_group_template_deployment.bicep");
    expect(representedIds(g).has("tf:azurerm_resource_group_template_deployment.bicep")).toBe(true);
    expect(denyProblems(g)).toEqual([]);
  });
});
