// topology-live-compute.test.ts: T3.5 compute and containers (lab topology plan T3.5). Live derivation of VMs (sizes,
// power words, disks and extensions folded), scale sets (one card, instances, autoscale; flexible VMs folded), container
// groups, container apps and environments, registries and Recovery Services vaults, from Resource Graph row fixtures
// (fixtures/topology/live/compute.json), and the round trip of the family's labs (7, 8, 9, 11, 19, 26, 27; lab 18 is with governance).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/compute.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az104-11-containers"));

const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = graph.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edgesBetween = (graph: TopologyGraph, from: string, to: string) => graph.edges.filter((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id);

describe("live compute and containers (T3.5)", () => {
  it("lab 9's VMSS is one card in its subnet with its size, instance count and autoscale range; the autoscale setting folds in", () => {
    const s = byLabel(g, "vmss-web");
    expect(s.kind).toBe("vmss");
    expect(parentLabel(g, s)).toBe("snet-vms");
    expect(s.props).toMatchObject({ size: "Standard_B1s", instances: 2, autoscale: "1-3", zones: ["1", "2"] });
    expect(s.folded?.map((f) => f.label)).toEqual(["autoscale-vmss-web"]);
    expect(edgesBetween(g, "lb-web", "vmss-web").map((e) => e.label)).toEqual(["TCP 80→80"]);
  });

  it("a flexible scale set's VMs (and their NICs) fold into it", () => {
    const f = byLabel(g, "vmss-flex");
    expect(f.folded?.map((x) => x.label).sort()).toEqual(["vmss-flex_a1b2c3d4", "vmss-flex_a1b2c3d4-nic01"]);
    expect(g.nodes.some((n) => n.label === "vmss-flex_a1b2c3d4")).toBe(false);
    expect(parentLabel(g, f)).toBe("snet-vms");
  });

  it("a VM shows its size and power word; its data disk, OS disk and extension fold into it", () => {
    const vm = byLabel(g, "vm-backup");
    expect(vm.props).toMatchObject({ size: "Standard_B2s", privateIp: "10.66.192.30", zones: ["1"] });
    expect(vm.health).toEqual({ tone: "warn", word: "Stopped" });
    expect(vm.folded?.map((f) => f.label).sort()).toEqual(["AzureMonitorLinuxAgent", "disk-data", "nic-vm-backup", "vm-backup_OsDisk_1_0f1e2d3c4b5a69788796a5b4c3d2e1f0"]);
  });

  it("a VNet-injected container group sits in its subnet with CPU, memory and a private-IP chip; a public one sits in its group", () => {
    const c = byLabel(g, "aci-hello");
    expect(parentLabel(g, c)).toBe("snet-aci");
    expect(c.props).toMatchObject({ cpu: 0.75, memoryGb: 1, privateIp: "10.66.193.4", chips: ["private IP"] });
    expect(edgesBetween(g, "aci-hello", "id-aci")).toMatchObject([{ kind: "dependency", label: "identity" }]);
    const p = byLabel(g, "aci-public");
    expect(parentLabel(g, p)).toBe("rg-lab-az104-11-containers");
    expect(p.props).toMatchObject({ cpu: 1, memoryGb: 1.5, publicIp: "203.0.113.90", hostName: "l11rt7xy-public.uksouth.azurecontainer.io", chips: ["public IP"] });
  });

  it("a Container Apps environment sits in its infrastructure subnet; an app depends on it and on the registry it pulls from", () => {
    const e = byLabel(g, "cae-lab");
    expect(parentLabel(g, e)).toBe("snet-cae");
    expect(e.props).toMatchObject({ sku: "Consumption" });
    const a = byLabel(g, "ca-hello");
    expect(a.props).toMatchObject({ ingress: "external", targetPort: 80 });
    expect(edgesBetween(g, "ca-hello", "cae-lab")).toMatchObject([{ kind: "dependency", label: "environment" }]);
    expect(edgesBetween(g, "ca-hello", "l11rt7xyacr")).toMatchObject([{ kind: "dependency", label: "pulls images" }]);
    expect(byLabel(g, "l11rt7xyacr").props).toMatchObject({ sku: "Basic" });
  });

  it("a Recovery Services vault shows its SKU", () => {
    expect(byLabel(g, "rsv-lab")).toMatchObject({ kind: "recoveryVault", props: { sku: "RS0" } });
  });

  it("the deny check passes and nothing here is drawn plainly", () => {
    expect(denyProblems(g)).toEqual([]);
    expect(JSON.stringify(g)).not.toMatch(/cccccccc-3333|azurecr\.io\/hello/);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: the compute labs", () => {
  for (const id of ["az104-07-files", "az104-08-vms", "az104-09-vmss", "az104-11-containers", "az104-19-backup", "az305-26-site-recovery", "az305-27-multi-region"]) {
    it(`${id}: planned → rows → live has no added and no missing node, and passes the deny check`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }
});
