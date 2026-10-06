// Lab topology plan T1.1: the packing layout (spec §8.1-§8.2). Pure; no DOM.
import { describe, expect, it } from "vitest";
import type { TopologyGraph, TopoNode, TopoKind, TopoPropValue } from "@shared/topology/model";
import type { TopologyLayout } from "@shared/topology/layout";
import { CARD_H, CARD_W, GAP, HEADER, PAD, ROOT_GAP, SUBNET_HEADER, layoutTopology, type LaidNode } from "./layout";

const LAB = "az104-06-blob-security";
const RG_KEY = `microsoft.resources/resourcegroups/rg-lab-${LAB}`;

function n(id: string, kind: TopoKind, parent: string | undefined, label = id, props: Record<string, TopoPropValue> = {}, key = `k/${id}`): TopoNode {
  return { id, key, kind, label, props, ...(parent ? { parent } : {}) };
}
const g = (nodes: TopoNode[]): TopologyGraph => ({ schema: 1, labId: LAB, version: 1, source: "planned", at: null, nodes, edges: [] });

/** One RG, one VNet, two subnets, three VMs, a storage account. */
function sample(): TopoNode[] {
  return [
    n("rg", "resourceGroup", undefined, `rg-lab-${LAB}`, { region: "uksouth" }, RG_KEY),
    n("vnet", "vnet", "rg", "vnet-lab", { addressSpace: ["10.71.192.0/20"] }),
    n("snet-b", "subnet", "vnet", "snet-b", { prefix: "10.71.193.0/24" }),
    n("snet-a", "subnet", "vnet", "snet-a", { prefix: "10.71.192.0/24" }),
    n("vm1", "vm", "snet-a", "vm-1"),
    n("vm2", "vm", "snet-a", "vm-2"),
    n("vm3", "vm", "snet-b", "vm-3"),
    n("st", "storage", "rg", "st"),
  ];
}

const byId = (r: { nodes: LaidNode[] }) => Object.fromEntries(r.nodes.map((x) => [x.id, x]));

/** A seeded shuffle (deterministic, so a failure reproduces). */
function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function headerOf(kind: TopoKind) {
  return kind === "subnet" ? SUBNET_HEADER : HEADER;
}

/** Every child inside its parent, with padding on every side and below the header. */
function expectContained(graph: TopologyGraph, laid: { nodes: LaidNode[] }) {
  const at = byId(laid);
  for (const node of graph.nodes) {
    const c = at[node.id]!;
    if (!c.parent) continue;
    const p = at[c.parent]!;
    const kind = graph.nodes.find((x) => x.id === c.parent)!.kind;
    expect(c.x, `${node.id} left`).toBeGreaterThanOrEqual(PAD);
    expect(c.y, `${node.id} top`).toBeGreaterThanOrEqual(headerOf(kind));
    expect(c.x + c.w, `${node.id} right`).toBeLessThanOrEqual(p.w - PAD);
    expect(c.y + c.h, `${node.id} bottom`).toBeLessThanOrEqual(p.h - PAD);
  }
}

function overlaps(a: LaidNode, b: LaidNode) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("layoutTopology", () => {
  it("the same graph in any order lays out identically", () => {
    const base = layoutTopology(g(sample()), null);
    for (const seed of [1, 7, 42, 99]) expect(layoutTopology(g(shuffle(sample(), seed)), null)).toEqual(base);
  });

  it("lays parents out before their children, positions relative to the parent", () => {
    const r = layoutTopology(g(sample()), null);
    const seen = new Set<string>();
    for (const x of r.nodes) {
      if (x.parent) expect(seen.has(x.parent), `${x.id} after its parent`).toBe(true);
      seen.add(x.id);
    }
    expect(byId(r).vm1!.parent).toBe("snet-a");
    expect(byId(r).rg!.parent).toBeNull();
  });

  it("asset cards are 200 × 84", () => {
    const r = byId(layoutTopology(g(sample()), null));
    expect([r.vm1!.w, r.vm1!.h]).toEqual([CARD_W, CARD_H]);
    expect([CARD_W, CARD_H, GAP, PAD, HEADER, SUBNET_HEADER, ROOT_GAP]).toEqual([200, 84, 16, 16, 36, 28, 48]);
  });

  it("children always sit inside their parent with padding", () => {
    const graph = g(sample());
    expectContained(graph, layoutTopology(graph, null));
  });

  it("an empty subnet is 232 × 72", () => {
    const r = byId(layoutTopology(g([n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vnet", "vnet", "rg"), n("s", "subnet", "vnet")]), null));
    expect([r.s!.w, r.s!.h]).toEqual([232, 72]);
  });

  it("subnet columns are min(3, ceil(√n))", () => {
    const cols = (count: number) => {
      const nodes = [n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vnet", "vnet", "rg"), n("s", "subnet", "vnet")];
      for (let i = 0; i < count; i++) nodes.push(n(`vm${String(i).padStart(2, "0")}`, "vm", "s"));
      const r = layoutTopology(g(nodes), null);
      return new Set(r.nodes.filter((x) => x.parent === "s").map((x) => x.x)).size;
    };
    expect([1, 2, 3, 4, 5, 8].map(cols)).toEqual([1, 2, 2, 2, 3, 3]);
    // Width follows the columns: 2 cards = 16 + 200 + 16 + 200 + 16.
    const r = byId(layoutTopology(g([n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vnet", "vnet", "rg"), n("s", "subnet", "vnet"), n("a", "vm", "s"), n("b", "vm", "s")]), null));
    expect(r.s!.w).toBe(PAD + CARD_W + GAP + CARD_W + PAD);
    expect(r.s!.h).toBe(SUBNET_HEADER + CARD_H + PAD);
  });

  it("orders assets in a container by kind order, then label, then id", () => {
    const nodes = [n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("st", "storage", "rg", "aaa"), n("lb", "loadBalancer", "rg", "zzz"), n("kv", "keyVault", "rg", "bbb")];
    const r = layoutTopology(g(nodes), null);
    const order = r.nodes.filter((x) => x.parent === "rg").sort((a, b) => a.y - b.y || a.x - b.x).map((x) => x.id);
    expect(order).toEqual(["lb", "st", "kv"]);
  });

  it("VNets order subnets by numeric prefix", () => {
    const nodes = [
      n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY),
      n("vnet", "vnet", "rg"),
      n("s10", "subnet", "vnet", "a-last", { prefix: "10.71.200.0/24" }),
      n("s9", "subnet", "vnet", "z-first", { prefix: "10.71.9.0/24" }),
      n("s100", "subnet", "vnet", "m-mid", { prefix: "10.71.100.0/24" }),
      n("dns", "dnsResolver", "vnet", "dnspr"),
    ];
    const r = layoutTopology(g(nodes), null);
    const order = r.nodes.filter((x) => x.parent === "vnet").sort((a, b) => a.y - b.y || a.x - b.x).map((x) => x.id);
    // Subnets first (numeric, not text, order), then the VNet-attached resolver.
    expect(order).toEqual(["s9", "s100", "s10", "dns"]);
  });

  it("VNets shelf-pack to 760 and resource groups to 1000", () => {
    const nodes = [n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vnet", "vnet", "rg")];
    for (let i = 0; i < 6; i++) nodes.push(n(`s${i}`, "subnet", "vnet", `s${i}`, { prefix: `10.0.${i}.0/24` }));
    for (let i = 0; i < 6; i++) nodes.push(n(`a${i}`, "storage", "rg", `a${i}`));
    const r = layoutTopology(g(nodes), null);
    const subnetRows = new Set(r.nodes.filter((x) => x.parent === "vnet").map((x) => x.y)).size;
    // 232-wide empty subnets: three fit in 760 (232*3 + 32 = 728), four do not.
    expect(subnetRows).toBe(2);
    const at = byId(r);
    for (const x of r.nodes.filter((y) => y.parent === "vnet")) expect(x.x + x.w).toBeLessThanOrEqual(PAD + 760);
    for (const x of r.nodes.filter((y) => y.parent === "rg")) expect(x.x + x.w).toBeLessThanOrEqual(PAD + Math.max(1000, at.vnet!.w));
  });

  it("orders VNets in a group by address space", () => {
    const nodes = [
      n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY),
      n("v2", "vnet", "rg", "a", { addressSpace: ["10.71.200.0/22"] }),
      n("v1", "vnet", "rg", "b", { addressSpace: ["10.71.8.0/22"] }),
    ];
    const r = byId(layoutTopology(g(nodes), null));
    expect(r.v1!.y < r.v2!.y || (r.v1!.y === r.v2!.y && r.v1!.x < r.v2!.x)).toBe(true);
  });

  it("root order is gateway, Global, primary RG, secondary RGs, Tenant", () => {
    const nodes = [
      n("lane/tenant", "lane", undefined, "Tenant and Entra ID", {}, "lane/tenant"),
      n("rg2", "resourceGroup", undefined, "rg-lab-x-secondary", { chips: ["secondary"] }, "microsoft.resources/resourcegroups/rg-lab-x-secondary"),
      n("rgz", "resourceGroup", undefined, "aaa-other", {}, "microsoft.resources/resourcegroups/aaa-other"),
      n("rg", "resourceGroup", undefined, `rg-lab-${LAB}`, {}, RG_KEY),
      n("lane/global", "lane", undefined, "Global", {}, "lane/global"),
      n("wg/gateway", "gateway", undefined, "WireGuard gateway VNet", {}, "wg/gateway"),
    ];
    const r = layoutTopology(g(nodes), null);
    const roots = r.nodes.filter((x) => x.parent === null);
    expect([...roots].sort((a, b) => a.x - b.x).map((x) => x.id)).toEqual(["wg/gateway", "lane/global", "rg", "rg2", "rgz", "lane/tenant"]);
    // Tops aligned, 48 apart.
    expect(new Set(roots.map((x) => x.y))).toEqual(new Set([0]));
    const sorted = [...roots].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.x - (sorted[i - 1]!.x + sorted[i - 1]!.w)).toBe(ROOT_GAP);
  });

  it("a node whose parent is missing goes to the root", () => {
    const r = byId(layoutTopology(g([n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vm", "vm", "nowhere")]), null));
    expect(r.vm!.parent).toBeNull();
  });
});

describe("saved positions", () => {
  const layout = (nodes: Record<string, { x: number; y: number; p: string | null }>): TopologyLayout => ({ v: 1, nodes });

  it("a saved position is applied under the parent key it was saved under", () => {
    const r = byId(layoutTopology(g(sample()), layout({ "k/st": { x: 400, y: 300, p: RG_KEY } })));
    expect([r.st!.x, r.st!.y]).toEqual([400, 300]);
  });

  it("a saved position under another parent is ignored", () => {
    const fresh = byId(layoutTopology(g(sample()), null));
    const r = byId(layoutTopology(g(sample()), layout({ "k/vm1": { x: 500, y: 500, p: "k/snet-b" } })));
    expect([r.vm1!.x, r.vm1!.y]).toEqual([fresh.vm1!.x, fresh.vm1!.y]);
  });

  it("a refresh with one new node moves no saved node", () => {
    const saved = layout({ "k/vm1": { x: 16, y: 140, p: "k/snet-a" }, "k/st": { x: 600, y: 40, p: RG_KEY }, "k/vnet": { x: 16, y: 200, p: RG_KEY } });
    const before = byId(layoutTopology(g(sample()), saved));
    const after = byId(layoutTopology(g([...sample(), n("vm4", "vm", "snet-a", "vm-0-new"), n("kv", "keyVault", "rg", "kv")]), saved));
    for (const id of ["vm1", "st", "vnet"]) expect([after[id]!.x, after[id]!.y], id).toEqual([before[id]!.x, before[id]!.y]);
  });

  it("a new node never overlaps a saved sibling", () => {
    const saved = layout({ "k/vm1": { x: 16, y: 28, p: "k/snet-a" }, "k/vm2": { x: 232, y: 28, p: "k/snet-a" } });
    const r = layoutTopology(g([...sample(), n("vm0", "vm", "snet-a", "vm-0"), n("vm5", "vm", "snet-a", "vm-5")]), saved);
    const kids = r.nodes.filter((x) => x.parent === "snet-a");
    for (const a of kids) for (const b of kids) if (a !== b) expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
  });

  it("containers grow to hold a child moved far, and a moved child is pulled inside the padding", () => {
    const saved = layout({ "k/st": { x: 1800, y: 900, p: RG_KEY }, "k/vm1": { x: -50, y: 2, p: "k/snet-a" } });
    const graph = g(sample());
    const laid = layoutTopology(graph, saved);
    const r = byId(laid);
    expect(r.rg!.w).toBe(1800 + CARD_W + PAD);
    // Unsaved siblings (the VNet) go below the saved one's box, and the group grows round them all.
    expect(r.vnet!.y).toBe(900 + CARD_H + GAP);
    expect(r.rg!.h).toBe(r.vnet!.y + r.vnet!.h + PAD);
    expect([r.vm1!.x, r.vm1!.y]).toEqual([PAD, SUBNET_HEADER]);
    expectContained(graph, laid);
  });

  it("saved root positions apply with p null", () => {
    const r = byId(layoutTopology(g(sample()), layout({ [RG_KEY]: { x: 120, y: 80, p: null } })));
    expect([r.rg!.x, r.rg!.y]).toEqual([120, 80]);
  });
});
