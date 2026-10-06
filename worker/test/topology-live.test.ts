// topology-live.test.ts: the live builder's core rules (lab topology spec §6.1-§6.2, rulings 12-16), from Resource
// Graph row fixtures (worker/test/fixtures/topology/live/core.json).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow, type LiveCtx } from "../../shared/topology/live";
import { AZURE_MADE, healthOf } from "../../shared/topology/rules/live";
import { ARG_API, ARG_TOP, topologyQuery } from "../../shared/topology/query";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/core.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const SUB = "/subscriptions/00000000-0000-4000-8000-000000000000";
const ctx: LiveCtx = {
  labId: "az700-35-forced-tunnel-fix",
  version: 2,
  namePrefix: "l35abcde",
  region: "uksouth",
  secondaryRegion: "ukwest",
  catalogueIds: ["az700-35-forced-tunnel-fix", "az700-35-forced-tunnel-fix-extra", "az700-36-s2s-vpn"],
  gatewayVnetId: `${SUB}/resourceGroups/rg-wg-ondemand/providers/Microsoft.Network/virtualNetworks/vnet-wg`,
  at: "2026-10-06T12:00:00.000Z",
};
const byLabel = (g: TopologyGraph, label: string): TopoNode => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${g.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentOf = (g: TopologyGraph, n: TopoNode) => g.nodes.find((x) => x.id === n.parent);

describe("live graph", () => {
  const g = liveGraph(rows, ctx);

  it("is a live graph at the fetch time, sorted, ids lower-case ARM ids", () => {
    expect(g).toMatchObject({ schema: 1, labId: ctx.labId, version: 2, source: "live", at: ctx.at });
    expect(g.nodes.map((n) => n.id)).toEqual([...g.nodes.map((n) => n.id)].sort());
    const vm = byLabel(g, "vm-nva");
    expect(vm.id).toBe(`${SUB}/resourceGroups/rg-lab-az700-35-forced-tunnel-fix/providers/Microsoft.Compute/virtualMachines/vm-nva`.toLowerCase());
  });

  it("subnets come from the VNet row", () => {
    const hub = byLabel(g, "vnet-hub");
    expect(hub.kind).toBe("vnet");
    expect(hub.props.addressSpace).toEqual(["10.64.192.0/20"]);
    const snet = byLabel(g, "snet-nva");
    expect(snet).toMatchObject({ kind: "subnet", parent: hub.id, props: { prefix: "10.64.192.0/24" } });
    expect(snet.key).toBe("microsoft.network/virtualnetworks/subnets/vnet-hub/snet-nva");
    expect(byLabel(g, "snet-app").props.chips).toEqual(expect.arrayContaining(["route table rt-spoke", "no default outbound"]));
  });

  it("a VM sits in its NIC's subnet with its private IP and power state word", () => {
    const nva = byLabel(g, "vm-nva");
    expect(parentOf(g, nva)?.label).toBe("snet-nva");
    expect(nva.props).toMatchObject({ privateIp: "10.64.192.4", size: "Standard_B1s", os: "Linux" });
    expect(nva.health).toEqual({ tone: "ok", word: "Running" });
    expect(nva.folded?.map((f) => f.label)).toEqual(expect.arrayContaining(["nic-vm-nva", "vm-nva_OsDisk_1_0123456789abcdef0123456789abcdef"]));
    const app = byLabel(g, "vm-app");
    expect(parentOf(g, app)?.label).toBe("snet-app");
    expect(app.health).toEqual({ tone: "warn", word: "Stopped (deallocated)" });
    expect(app.props.privateIp).toBe("10.64.208.4");
    expect(nva.props.resourceId).toBe(`${SUB}/resourceGroups/rg-lab-az700-35-forced-tunnel-fix/providers/Microsoft.Compute/virtualMachines/vm-nva`);
  });

  it("peerings are one edge per pair with their state, and the next hop goes from the subnet to the appliance", () => {
    const peer = g.edges.filter((e) => e.label?.startsWith("peering") && e.to !== "wg/gateway" && e.from !== "wg/gateway");
    expect(peer).toHaveLength(1);
    expect(peer[0]!.state).toEqual({ tone: "ok", word: "Connected" });
    const hop = g.edges.find((e) => e.label === "0.0.0.0/0");
    expect(hop).toMatchObject({ from: byLabel(g, "snet-app").id, to: byLabel(g, "vm-nva").id, kind: "traffic" });
  });

  it("a peering to vnet-wg joins the peer VNet to the gateway node", () => {
    const gw = g.nodes.find((n) => n.id === "wg/gateway");
    expect(gw).toMatchObject({ kind: "gateway", key: "wg/gateway" });
    expect(gw?.parent).toBeUndefined();
    const e = g.edges.find((x) => x.from === "wg/gateway" || x.to === "wg/gateway");
    expect([e?.from, e?.to].sort()).toEqual([byLabel(g, "vnet-hub").id, "wg/gateway"].sort());
  });

  it("provisioningState Failed is bad, Updating warn", () => {
    expect(byLabel(g, "widget-1").health).toEqual({ tone: "bad", word: "Failed" });
    expect(byLabel(g, "pip-handmade").health).toEqual({ tone: "warn", word: "Updating" });
    expect(healthOf({ type: "microsoft.storage/storageaccounts", properties: { provisioningState: "Succeeded" } } as unknown as ArgRow)).toEqual({ tone: "ok", word: "Ready" });
    expect(healthOf({ type: "microsoft.storage/storageaccounts", properties: {} } as unknown as ArgRow)).toEqual({ tone: "unknown", word: "No data" });
  });

  it("rows outside the lab's groups are dropped (ruling 16), a longer lab id's group included", () => {
    expect(g.nodes.some((n) => n.label === "vnet-onprem")).toBe(false);
    expect(g.nodes.some((n) => n.label === "l99abcdefst" || n.label === "rg-lab-az700-35-forced-tunnel-fix-extra")).toBe(false);
    expect(g.nodes.filter((n) => n.kind === "resourceGroup").map((n) => n.label)).toEqual(["rg-lab-az700-35-forced-tunnel-fix"]);
  });

  it("an unknown type is a generic card: in the subnet its properties name, else in its group", () => {
    const w = byLabel(g, "widget-1");
    expect(w.kind).toBe("generic");
    expect(parentOf(g, w)?.label).toBe("snet-app");
    const gd = byLabel(g, "gadget-1");
    expect(gd.kind).toBe("generic");
    expect(parentOf(g, gd)?.kind).toBe("resourceGroup");
    expect(gd.armType).toBe("microsoft.contoso/gadgets");
  });

  it("an unattached public IP is a card with its address", () => {
    expect(byLabel(g, "pip-handmade")).toMatchObject({ kind: "publicIp", props: { publicIp: "203.0.113.10", sku: "Standard" } });
  });

  it("an OS disk Azure made folds into its VM and is never a card", () => {
    expect(g.nodes.some((n) => n.label.includes("OsDisk"))).toBe(false);
    expect(AZURE_MADE.length).toBeGreaterThan(0);
  });

  it("the deny check passes on the output: no raw properties, no custom data, no connection string", () => {
    expect(denyProblems(g)).toEqual([]);
    const text = JSON.stringify(g);
    expect(text).not.toMatch(/customData|I2Nsb3Vk|SharedAccessKey|connectionString|session/);
  });

  it("is deterministic in any row order", () => {
    expect(JSON.stringify(liveGraph([...rows].reverse(), ctx))).toBe(JSON.stringify(g));
  });

  it("keys replace the session's prefix and regions", () => {
    const sa = liveGraph(
      [{ id: `${SUB}/resourceGroups/rg-lab-az700-35-forced-tunnel-fix/providers/Microsoft.Storage/storageAccounts/l35abcdediag`, name: "l35abcdediag", type: "microsoft.storage/storageaccounts", kind: "StorageV2", location: "uksouth", resourceGroup: "rg-lab-az700-35-forced-tunnel-fix", properties: {} } as ArgRow],
      ctx,
    ).nodes.find((n) => n.kind === "storage");
    expect(sa?.key).toBe("microsoft.storage/storageaccounts/{p}diag");
  });
});

describe("the query", () => {
  it("names only rg-lab-<id> and rg-lab-<id>-*, in one fixed form", () => {
    expect(topologyQuery("az104-13-vnets")).toBe(
      "resources | where resourceGroup =~ 'rg-lab-az104-13-vnets' or resourceGroup startswith 'rg-lab-az104-13-vnets-' | project id, name, type, kind, location, resourceGroup, sku, tags, zones, identity, managedBy, properties | order by id asc",
    );
    expect(ARG_API).toBe("2022-10-01");
    expect(ARG_TOP).toBe(1000);
  });

  it("refuses anything that is not a lab id", () => {
    for (const bad of ["az104-13-vnets' or 1==1 //", "rg-wg", "", "AZ104-13-VNETS", "az104-13-vnets\n"]) expect(() => topologyQuery(bad), bad).toThrow();
  });
});
