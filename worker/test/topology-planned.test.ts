// topology-planned.test.ts: the planned builder's core rules (lab topology spec §4.4-§4.6, §5 step 3), on inputs cut
// from real mock-plan runs (worker/test/fixtures/topology/plan/*.json: { changes, outputs, refs }, scrubbed by
// scripts/lib/topology-stream.mjs as the generator does).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { plannedGraph, representedIds, type PlannedInput, type ResourceChange } from "../../shared/topology/planned";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/topology/plan/${name}.json`, import.meta.url), "utf8")) as Omit<PlannedInput, "labId" | "version" | "number">;
const lab35 = (): PlannedInput => ({ labId: "az700-35-forced-tunnel-fix", version: 2, number: "35", ...fixture("az700-35") });
const lab13 = (): PlannedInput => ({ labId: "az104-13-vnets", version: 3, number: "13", ...fixture("az104-13") });

const byLabel = (g: TopologyGraph, label: string): TopoNode => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${g.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentOf = (g: TopologyGraph, n: TopoNode) => g.nodes.find((x) => x.id === n.parent);

describe("planned graph: lab 35 (hub, spoke, forced tunnel)", () => {
  const g = plannedGraph(lab35());

  it("is a planned graph of the lab's version, sorted, with no timestamp", () => {
    expect(g).toMatchObject({ schema: 1, labId: "az700-35-forced-tunnel-fix", version: 2, source: "planned", at: null });
    expect(g.nodes.map((n) => n.id)).toEqual([...g.nodes.map((n) => n.id)].sort());
    expect(g.edges.map((e) => e.id)).toEqual([...g.edges.map((e) => e.id)].sort());
  });

  it("lab 35 has two VNets, two subnets, two VMs in their subnets, one peering edge and a 0.0.0.0/0 next-hop edge from snet-app to vm-nva", () => {
    expect(g.nodes.filter((n) => n.kind === "vnet").map((n) => n.label).sort()).toEqual(["vnet-hub", "vnet-spoke"]);
    expect(g.nodes.filter((n) => n.kind === "subnet").map((n) => n.label).sort()).toEqual(["snet-app", "snet-nva"]);
    expect(g.nodes.filter((n) => n.kind === "vm").map((n) => n.label).sort()).toEqual(["vm-app", "vm-nva"]);
    const nva = byLabel(g, "vm-nva");
    const app = byLabel(g, "vm-app");
    expect(parentOf(g, nva)?.label).toBe("snet-nva");
    expect(parentOf(g, app)?.label).toBe("snet-app");
    expect(parentOf(g, parentOf(g, nva)!)?.label).toBe("vnet-hub");
    expect(parentOf(g, parentOf(g, parentOf(g, nva)!)!)?.kind).toBe("resourceGroup");

    const peerings = g.edges.filter((e) => e.label?.startsWith("peering"));
    expect(peerings).toHaveLength(1);
    expect([peerings[0]!.from, peerings[0]!.to].sort()).toEqual([byLabel(g, "vnet-hub").id, byLabel(g, "vnet-spoke").id].sort());
    expect(peerings[0]!.kind).toBe("traffic");

    const hop = g.edges.filter((e) => e.label === "0.0.0.0/0");
    expect(hop).toHaveLength(1);
    expect(hop[0]).toMatchObject({ from: byLabel(g, "snet-app").id, to: nva.id, kind: "traffic", via: "tf:azurerm_route.default" });
  });

  it("NICs are folded into their VMs and the VM shows its private IP when it is static", () => {
    const nva = byLabel(g, "vm-nva");
    const app = byLabel(g, "vm-app");
    expect(nva.folded?.map((f) => f.id)).toContain("tf:azurerm_network_interface.nva");
    expect(app.folded?.map((f) => f.id)).toContain("tf:azurerm_network_interface.app");
    expect(g.nodes.some((n) => n.id === "tf:azurerm_network_interface.nva")).toBe(false);
    expect(nva.props.privateIp).toBe("10.71.192.4");
    expect(app.props.privateIp).toBeUndefined();
    expect(nva.props.size).toBe("Standard_B1s");
    expect(nva.armType).toBe("Microsoft.Compute/virtualMachines");
  });

  it("the route table folds into the subnet it serves, as a chip", () => {
    const snet = byLabel(g, "snet-app");
    expect(snet.folded?.map((f) => f.id)).toEqual(expect.arrayContaining(["tf:azurerm_route_table.spoke", "tf:azurerm_route.default", "tf:azurerm_subnet_route_table_association.app"]));
    expect(snet.props.chips).toEqual(expect.arrayContaining(["route table rt-spoke", "no default outbound"]));
    expect(snet.props.prefix).toBe("10.71.208.0/24");
  });

  it("the peer target VNet is marked from the peer_vnet_id output", () => {
    expect(byLabel(g, "vnet-hub").props.peerTarget).toBe(true);
    expect(byLabel(g, "vnet-spoke").props.peerTarget).toBeUndefined();
  });

  it("keys follow ruling 6", () => {
    expect(byLabel(g, "vm-nva").key).toBe("microsoft.compute/virtualmachines/vm-nva");
    expect(byLabel(g, "snet-app").key).toBe("microsoft.network/virtualnetworks/subnets/vnet-spoke/snet-app");
    const rg = g.nodes.find((n) => n.kind === "resourceGroup")!;
    expect(rg.key).toBe("microsoft.resources/resourcegroups/rg-lab-az700-35-forced-tunnel-fix");
    expect(rg.props.region).toBe("uksouth");
    expect(rg.props.tags).toEqual(["lab: az700-35-forced-tunnel-fix", "project: wg-admin-labs", "+1 tag"]);
  });

  it("every address in the input is represented (node, folded or edge via)", () => {
    const ids = representedIds(g);
    for (const c of lab35().changes) expect(ids.has(`tf:${c.address}`), c.address).toBe(true);
  });

  it("passes the deny check", () => {
    expect(denyProblems(g)).toEqual([]);
  });

  it("is deterministic: the same input in another order gives the same graph", () => {
    const i = lab35();
    const again = plannedGraph({ ...i, changes: [...i.changes].reverse() });
    expect(JSON.stringify(again)).toBe(JSON.stringify(g));
  });
});

describe("planned graph: lab 13 (NSGs and ASGs)", () => {
  const g = plannedGraph(lab13());

  it("lab 13's NSGs are subnet chips and ASGs fold into the VMs", () => {
    expect(g.nodes.some((n) => n.kind === "nsg")).toBe(false);
    expect(byLabel(g, "snet-web").props.chips).toEqual(expect.arrayContaining(["NSG nsg-web"]));
    expect(byLabel(g, "snet-app").props.chips).toEqual(expect.arrayContaining(["NSG nsg-app"]));
    // The NSG and its rules fold into the subnet.
    expect(byLabel(g, "snet-web").folded?.map((f) => f.id)).toEqual(expect.arrayContaining(["tf:azurerm_network_security_group.web", "tf:azurerm_network_security_rule.web_http"]));
    const web = byLabel(g, "vm-web");
    expect(web.folded?.map((f) => f.id)).toEqual(expect.arrayContaining(["tf:azurerm_application_security_group.web", "tf:azurerm_network_interface_application_security_group_association.web"]));
    expect(web.props.chips).toEqual(["ASG asg-web"]);
    expect(g.nodes.some((n) => n.label === "asg-web")).toBe(false);
  });

  it("every address in the input is represented", () => {
    const ids = representedIds(g);
    for (const c of lab13().changes) expect(ids.has(`tf:${c.address}`), c.address).toBe(true);
  });
});

describe("planned graph: the rest of the core", () => {
  const base = lab35();
  const extra = (changes: ResourceChange[], refs: PlannedInput["refs"] = {}): TopologyGraph =>
    plannedGraph({ ...base, changes: [...base.changes, ...changes], refs: { ...base.refs, ...refs } });

  it("a resource of an unruled type becomes a generic card in its group", () => {
    const g = extra([{ address: "azurerm_contoso_widget.w", type: "azurerm_contoso_widget", name: "w", index: null, after: { name: "widget-1", resource_group_name: "rg-lab-az700-35-forced-tunnel-fix" }, after_unknown: {} }]);
    const w = byLabel(g, "widget-1");
    expect(w.kind).toBe("generic");
    expect(parentOf(g, w)?.kind).toBe("resourceGroup");
    expect(w.key).toBe("terraform/azurerm_contoso_widget/widget-1");
  });

  it("an unruled type that references a subnet is a generic card in that subnet", () => {
    const g = extra(
      [{ address: "azurerm_contoso_box.b", type: "azurerm_contoso_box", name: "b", index: null, after: { name: "box-1", resource_group_name: "rg-lab-az700-35-forced-tunnel-fix" }, after_unknown: { subnet_id: true } }],
      { "azurerm_contoso_box.b": { subnet_id: ["azurerm_subnet.app"] } },
    );
    expect(parentOf(g, byLabel(g, "box-1"))?.label).toBe("snet-app");
  });

  it("random_password and data sources are ignored", () => {
    const g = extra([
      { address: "random_password.p", type: "random_password", name: "p", index: null, after: { length: 20 }, after_unknown: { result: true } },
      { address: "time_sleep.s", type: "time_sleep", name: "s", index: null, after: {}, after_unknown: {} },
      { address: "data.azurerm_client_config.c", type: "azurerm_client_config", name: "c", index: null, after: {}, after_unknown: {} },
    ]);
    expect(g.nodes.some((n) => /random|time_sleep|client_config/.test(n.id))).toBe(false);
    expect(JSON.stringify(g)).not.toMatch(/random_password|client_config/);
  });

  it("an unattached public IP is a card; one on an LB frontend folds into the LB, whose rule draws a port edge to its backend", () => {
    const rg = "rg-lab-az700-35-forced-tunnel-fix";
    const g = extra(
      [
        { address: "azurerm_public_ip.loose", type: "azurerm_public_ip", name: "loose", index: null, after: { name: "pip-loose", resource_group_name: rg, sku: "Standard", allocation_method: "Static" }, after_unknown: {} },
        { address: "azurerm_public_ip.lb", type: "azurerm_public_ip", name: "lb", index: null, after: { name: "pip-lb", resource_group_name: rg, sku: "Standard" }, after_unknown: {} },
        { address: "azurerm_lb.web", type: "azurerm_lb", name: "web", index: null, after: { name: "lb-web", resource_group_name: rg, sku: "Standard", frontend_ip_configuration: [{ name: "fe" }] }, after_unknown: {} },
        { address: "azurerm_lb_backend_address_pool.web", type: "azurerm_lb_backend_address_pool", name: "web", index: null, after: { name: "pool" }, after_unknown: {} },
        { address: "azurerm_lb_probe.web", type: "azurerm_lb_probe", name: "web", index: null, after: { name: "probe", port: 80 }, after_unknown: {} },
        { address: "azurerm_lb_rule.http", type: "azurerm_lb_rule", name: "http", index: null, after: { name: "http", protocol: "Tcp", frontend_port: 80, backend_port: 8080 }, after_unknown: {} },
        { address: "azurerm_network_interface_backend_address_pool_association.app", type: "azurerm_network_interface_backend_address_pool_association", name: "app", index: null, after: { ip_configuration_name: "ipconfig1" }, after_unknown: {} },
      ],
      {
        "azurerm_lb.web": { frontend_ip_configuration: ["azurerm_public_ip.lb"], resource_group_name: ["azurerm_resource_group.lab"] },
        "azurerm_lb_backend_address_pool.web": { loadbalancer_id: ["azurerm_lb.web"] },
        "azurerm_lb_probe.web": { loadbalancer_id: ["azurerm_lb.web"] },
        "azurerm_lb_rule.http": { loadbalancer_id: ["azurerm_lb.web"], backend_address_pool_ids: ["azurerm_lb_backend_address_pool.web"], probe_id: ["azurerm_lb_probe.web"] },
        "azurerm_network_interface_backend_address_pool_association.app": { network_interface_id: ["azurerm_network_interface.app"], backend_address_pool_id: ["azurerm_lb_backend_address_pool.web"] },
      },
    );
    expect(byLabel(g, "pip-loose").kind).toBe("publicIp");
    const lb = byLabel(g, "lb-web");
    expect(lb.kind).toBe("loadBalancer");
    expect(parentOf(g, lb)?.kind).toBe("resourceGroup");
    expect(lb.folded?.map((f) => f.id)).toEqual(expect.arrayContaining(["tf:azurerm_public_ip.lb", "tf:azurerm_lb_backend_address_pool.web", "tf:azurerm_lb_probe.web", "tf:azurerm_lb_rule.http"]));
    expect(g.nodes.some((n) => n.label === "pip-lb")).toBe(false);
    expect(g.edges.filter((e) => e.from === lb.id)).toEqual([expect.objectContaining({ to: byLabel(g, "vm-app").id, label: "TCP 80→8080", kind: "traffic", via: "tf:azurerm_lb_rule.http" })]);
    const ids = representedIds(g);
    expect(ids.has("tf:azurerm_network_interface_backend_address_pool_association.app")).toBe(true);
  });

  it("an NSG attached to nothing is a card with its rule count", () => {
    const rg = "rg-lab-az700-35-forced-tunnel-fix";
    const g = extra(
      [
        { address: "azurerm_network_security_group.x", type: "azurerm_network_security_group", name: "x", index: null, after: { name: "nsg-x", resource_group_name: rg, security_rule: [{ name: "a" }, { name: "b" }] }, after_unknown: {} },
      ],
      {},
    );
    expect(byLabel(g, "nsg-x")).toMatchObject({ kind: "nsg", props: { counts: ["rules: 2"] } });
  });

  it("a resource in a group outside the lab is scope outside, in a group of its own", () => {
    const g = extra([
      { address: "azurerm_network_watcher_flow_log.vnet", type: "azurerm_network_watcher_flow_log", name: "vnet", index: null, after: { name: "lab-az700-35-forced-tunnel-fix-flowlog", resource_group_name: "NetworkWatcherRG", network_watcher_name: "NetworkWatcher_uksouth" }, after_unknown: {} },
    ]);
    const f = byLabel(g, "lab-az700-35-forced-tunnel-fix-flowlog");
    expect(f.scope).toBe("outside");
    expect(parentOf(g, f)).toMatchObject({ kind: "resourceGroup", label: "NetworkWatcherRG", scope: "outside" });
  });

  it("a private endpoint sits in its subnet with an edge to its target; a zone link folds into the zone with a link edge; a role assignment is a dependency edge", () => {
    const rg = "rg-lab-az700-35-forced-tunnel-fix";
    const g = extra(
      [
        { address: "azurerm_storage_account.sa", type: "azurerm_storage_account", name: "sa", index: null, after: { name: "l35k3x9qblob", resource_group_name: rg }, after_unknown: {} },
        { address: "azurerm_storage_container.c", type: "azurerm_storage_container", name: "c", index: null, after: { name: "private" }, after_unknown: {} },
        { address: "azurerm_private_endpoint.pe", type: "azurerm_private_endpoint", name: "pe", index: null, after: { name: "pe-blob", resource_group_name: rg, private_service_connection: [{ name: "psc", subresource_names: ["blob"] }] }, after_unknown: {} },
        { address: "azurerm_private_dns_zone.z", type: "azurerm_private_dns_zone", name: "z", index: null, after: { name: "privatelink.blob.core.windows.net", resource_group_name: rg }, after_unknown: {} },
        { address: "azurerm_private_dns_zone_virtual_network_link.l", type: "azurerm_private_dns_zone_virtual_network_link", name: "l", index: null, after: { name: "link-hub", resource_group_name: rg, registration_enabled: false }, after_unknown: {} },
        { address: "azuread_group.readers", type: "azuread_group", name: "readers", index: null, after: { display_name: "lab-az700-35-forced-tunnel-fix-readers" }, after_unknown: {} },
        { address: "azurerm_role_assignment.r", type: "azurerm_role_assignment", name: "r", index: null, after: { role_definition_name: "Storage Blob Data Reader" }, after_unknown: {} },
      ],
      {
        "azurerm_storage_container.c": { storage_account_id: ["azurerm_storage_account.sa"] },
        "azurerm_private_endpoint.pe": { subnet_id: ["azurerm_subnet.app"], private_service_connection: ["azurerm_storage_account.sa"], private_dns_zone_group: ["azurerm_private_dns_zone.z"] },
        "azurerm_private_dns_zone_virtual_network_link.l": { private_dns_zone_name: ["azurerm_private_dns_zone.z"], virtual_network_id: ["azurerm_virtual_network.hub"] },
        "azurerm_role_assignment.r": { scope: ["azurerm_resource_group.lab"], principal_id: ["azuread_group.readers"] },
      },
    );
    const pe = byLabel(g, "pe-blob");
    expect(pe).toMatchObject({ kind: "privateEndpoint", props: { groupId: "blob" } });
    expect(parentOf(g, pe)?.label).toBe("snet-app");
    const sa = byLabel(g, "l35…blob");
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: pe.id, to: sa.id, kind: "traffic", label: "blob" })]));
    expect(sa.folded?.map((f) => f.id)).toEqual(["tf:azurerm_storage_container.c"]);
    const zone = byLabel(g, "privatelink.blob.core.windows.net");
    expect(zone.kind).toBe("privateDnsZone");
    expect(zone.folded?.map((f) => f.id)).toEqual(["tf:azurerm_private_dns_zone_virtual_network_link.l"]);
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: zone.id, to: byLabel(g, "vnet-hub").id, kind: "dependency", label: "link" })]));
    const group = byLabel(g, "lab-az700-35-forced-tunnel-fix-readers");
    expect(group.kind).toBe("entraPrincipal");
    expect(parentOf(g, group)).toMatchObject({ kind: "lane", key: "lane/tenant" });
    const rgNode = g.nodes.find((n) => n.kind === "resourceGroup")!;
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: group.id, to: rgNode.id, kind: "dependency", label: "role: Storage Blob Data Reader", via: "tf:azurerm_role_assignment.r" })]));
  });

  it("Key Vault secrets, keys and certificates fold into the vault as counts, never by name (ruling 22)", () => {
    const rg = "rg-lab-az700-35-forced-tunnel-fix";
    const g = extra(
      [
        { address: "azurerm_key_vault.kv", type: "azurerm_key_vault", name: "kv", index: null, after: { name: "kv-l35k3x9q", resource_group_name: rg, sku_name: "standard", enable_rbac_authorization: true }, after_unknown: {} },
        { address: "azurerm_key_vault_secret.db", type: "azurerm_key_vault_secret", name: "db", index: null, after: { name: "app-db-password" }, after_unknown: {} },
        { address: "azurerm_key_vault_secret.api", type: "azurerm_key_vault_secret", name: "api", index: null, after: { name: "reports-api-key" }, after_unknown: {} },
        { address: "azurerm_key_vault_key.k", type: "azurerm_key_vault_key", name: "k", index: null, after: { name: "cmk" }, after_unknown: {} },
      ],
      { "azurerm_key_vault_secret.db": { key_vault_id: ["azurerm_key_vault.kv"] }, "azurerm_key_vault_secret.api": { key_vault_id: ["azurerm_key_vault.kv"] }, "azurerm_key_vault_key.k": { key_vault_id: ["azurerm_key_vault.kv"] } },
    );
    const kv = byLabel(g, "kv-l35…");
    expect(kv).toMatchObject({ kind: "keyVault", props: { sku: "standard", counts: ["keys: 1", "secrets: 2"] } });
    expect(kv.folded?.map((f) => f.label).sort()).toEqual(["key", "secret", "secret"]);
    expect(JSON.stringify(g)).not.toMatch(/app-db-password|reports-api-key|"cmk"/);
    expect(representedIds(g).has("tf:azurerm_key_vault_secret.db")).toBe(true);
  });

  it("names carrying the mock prefix are shown as l35…", () => {
    const g = extra([
      { address: "azurerm_storage_account.sa", type: "azurerm_storage_account", name: "sa", index: null, after: { name: "l35k3x9qdiag", resource_group_name: "rg-lab-az700-35-forced-tunnel-fix", account_kind: "StorageV2", account_tier: "Standard", account_replication_type: "LRS" }, after_unknown: {} },
    ]);
    const sa = byLabel(g, "l35…diag");
    expect(sa.key).toBe("microsoft.storage/storageaccounts/{p}diag");
    expect(sa.kind).toBe("storage");
  });
});
