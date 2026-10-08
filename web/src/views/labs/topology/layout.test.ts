// Lab topology plan T1.1: the packing layout (spec §8.1-§8.2). Pure; no DOM.
import { describe, expect, it } from "vitest";
import type { TopologyGraph, TopoNode, TopoKind, TopoPropValue } from "@shared/topology/model";
import type { TopologyLayout } from "@shared/topology/layout";
import { absoluteBoxes, COMPACT, fitZoomOf, CARD_GAP_X, CARD_GAP_Y, CARD_H, CARD_W, flowRanks, GAP, HEAD_GAP, HEADER, HEADER_MAX_W, PAD, RG_SHELF, ROOT_GAP, SAVED_PAD, SUBNET_HEADER, VNET_SHELF, headerWidth, layoutTopology, type LaidNode } from "./layout";
import { stackGraph } from "./stacks";
import { boundsOf, FIT_MAX_ZOOM, FIT_PADDING, MIN_FIT_ZOOM, startViewport } from "./viewport";

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

/** Every child inside its parent, with padding on every side and room below the header (less for saved positions). */
function expectContained(graph: TopologyGraph, laid: { nodes: LaidNode[] }, saved = false) {
  const at = byId(laid);
  for (const node of graph.nodes) {
    const c = at[node.id]!;
    if (!c.parent) continue;
    const p = at[c.parent]!;
    const kind = graph.nodes.find((x) => x.id === c.parent)!.kind;
    expect(c.x, `${node.id} left`).toBeGreaterThanOrEqual(saved ? SAVED_PAD : PAD);
    expect(c.y, `${node.id} top`).toBeGreaterThanOrEqual(headerOf(kind) + (saved ? 0 : HEAD_GAP));
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
    expect([CARD_W, CARD_H, HEADER, SUBNET_HEADER]).toEqual([200, 84, 36, 28]);
    // Generous room: cards well apart, roomy containers with space under their headers, corridors between containers.
    expect(CARD_GAP_X).toBeGreaterThanOrEqual(96);
    expect(CARD_GAP_Y).toBeGreaterThanOrEqual(80);
    expect(GAP).toBeGreaterThanOrEqual(64);
    expect(PAD).toBeGreaterThanOrEqual(28);
    expect(HEAD_GAP).toBeGreaterThanOrEqual(16);
    expect(ROOT_GAP).toBeGreaterThanOrEqual(96);
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
    // Width follows the columns: 2 cards = pad + 200 + card gap + 200 + pad.
    const r = byId(layoutTopology(g([n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vnet", "vnet", "rg"), n("s", "subnet", "vnet"), n("a", "vm", "s"), n("b", "vm", "s")]), null));
    expect(r.s!.w).toBe(PAD + CARD_W + CARD_GAP_X + CARD_W + PAD);
    expect(r.s!.h).toBe(SUBNET_HEADER + HEAD_GAP + CARD_H + PAD);
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

  it("VNets and resource groups shelf-pack to their shelf widths", () => {
    const nodes = [n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("vnet", "vnet", "rg")];
    for (let i = 0; i < 6; i++) nodes.push(n(`s${i}`, "subnet", "vnet", `s${i}`, { prefix: `10.0.${i}.0/24` }));
    for (let i = 0; i < 6; i++) nodes.push(n(`a${i}`, "storage", "rg", `a${i}`));
    const r = layoutTopology(g(nodes), null);
    const subnetRows = new Set(r.nodes.filter((x) => x.parent === "vnet").map((x) => x.y)).size;
    // 232-wide empty subnets: three fit on the VNet's shelf (232*3 + 2 gaps), four do not.
    expect(3 * 232 + 2 * GAP).toBeLessThanOrEqual(VNET_SHELF);
    expect(4 * 232 + 3 * GAP).toBeGreaterThan(VNET_SHELF);
    expect(subnetRows).toBe(2);
    const at = byId(r);
    for (const x of r.nodes.filter((y) => y.parent === "vnet")) expect(x.x + x.w).toBeLessThanOrEqual(PAD + VNET_SHELF);
    for (const x of r.nodes.filter((y) => y.parent === "rg")) expect(x.x + x.w).toBeLessThanOrEqual(PAD + Math.max(RG_SHELF, at.vnet!.w));
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
    // Tops aligned, ROOT_GAP apart.
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
    // Pulled in only as far as the old spacing's padding, so a layout saved with it stays exactly as saved.
    expect([r.vm1!.x, r.vm1!.y]).toEqual([SAVED_PAD, SUBNET_HEADER]);
    expectContained(graph, laid, true);
  });

  it("saved root positions apply with p null", () => {
    const r = byId(layoutTopology(g(sample()), layout({ [RG_KEY]: { x: 120, y: 80, p: null } })));
    expect([r.rg!.x, r.rg!.y]).toEqual([120, 80]);
  });
});

// ── Packing for the space the diagram is shown in ──────────────────────

/** The zoom at which the laid-out picture fits a W × H space (React Flow's fit with 8% padding, at most 100%). */
function fitZoom(laid: { nodes: LaidNode[] }, w: number, h: number): number {
  const roots = laid.nodes.filter((x) => !x.parent);
  const bw = Math.max(...roots.map((r) => r.x + r.w)) - Math.min(...roots.map((r) => r.x));
  const bh = Math.max(...roots.map((r) => r.y + r.h)) - Math.min(...roots.map((r) => r.y));
  return Math.min(1, w / (bw * 1.16), h / (bh * 1.16));
}

/** The Global lane, three groups (each a VNet with two subnets of two VMs, and a load balancer) and the Tenant lane. */
function wide(): TopoNode[] {
  const out: TopoNode[] = [n("lane/global", "lane", undefined, "Global", {}, "lane/global"), n("glb", "loadBalancer", "lane/global", "lb-global")];
  for (const [i, rg] of ["", "-secondary", "-third"].entries()) {
    out.push(n(`rg${i}`, "resourceGroup", undefined, `rg-lab-${LAB}${rg}`, { region: "uksouth" }, `microsoft.resources/resourcegroups/rg-lab-${LAB}${rg}`));
    out.push(n(`v${i}`, "vnet", `rg${i}`, `vnet-${i}`, { addressSpace: [`10.71.${i * 16}.0/20`] }));
    for (const s of [0, 1]) {
      out.push(n(`v${i}s${s}`, "subnet", `v${i}`, `snet-${s}`, { prefix: `10.71.${i * 16 + s}.0/24` }));
      for (const a of [0, 1]) out.push(n(`v${i}s${s}a${a}`, "vm", `v${i}s${s}`, `vm-${i}${s}${a}`));
    }
    out.push(n(`lb${i}`, "loadBalancer", `rg${i}`, `lb-${i}`));
  }
  out.push(n("lane/tenant", "lane", undefined, "Tenant and Entra ID", {}, "lane/tenant"), n("id", "managedIdentity", "lane/tenant", "id-app"));
  return out;
}

const PLANNED = import.meta.glob<TopologyGraph>("../../../../../shared/topology/planned/*.json", { eager: true, import: "default" });
const planned = (id: string) => stackGraph(Object.entries(PLANNED).find(([k]) => k.endsWith(`/${id}.json`))![1]).graph;
/** The spaces the diagram is shown in (canvas pixels): the lab panel's tab and the full screen at 1600 × 900 and 1100 × 600. */
const TAB = [550, 445] as const;
const FULL_1600 = [1535, 660] as const;
const FULL_1100 = [1035, 380] as const;

describe("packing for the space's shape", () => {
  it("in a tab-shaped space the top level and the groups wrap into rows, so the picture fits at a much larger zoom", () => {
    const graph = g(wide());
    const flat = layoutTopology(graph, null);
    const packed = layoutTopology(graph, null, { aspect: TAB[0] / TAB[1] });
    expect(new Set(flat.nodes.filter((x) => !x.parent).map((x) => x.y))).toEqual(new Set([0]));
    expect(new Set(packed.nodes.filter((x) => !x.parent).map((x) => x.y)).size).toBeGreaterThan(1);
    expect(fitZoom(packed, ...TAB)).toBeGreaterThan(fitZoom(flat, ...TAB) * 1.5);
    expectContained(graph, packed);
    // The root order still reads gateway, Global, groups, Tenant: row by row, left to right.
    const roots = packed.nodes.filter((x) => !x.parent).sort((a, b) => a.y - b.y || a.x - b.x).map((x) => x.id);
    expect(roots).toEqual(["lane/global", "rg0", "rg1", "rg2", "lane/tenant"]);
  });

  it("is deterministic for the same input and shape, in any order", () => {
    const a = layoutTopology(g(wide()), null, { aspect: 1.3 });
    for (const seed of [3, 11, 58]) expect(layoutTopology(g(shuffle(wide(), seed)), null, { aspect: 1.3 })).toEqual(a);
    expect(layoutTopology(g(wide()), null, { aspect: 2.3 })).not.toEqual(a);
  });

  it("nothing overlaps, at any shape", () => {
    for (const aspect of [0.6, 1, 1.25, 1.8, 2.3, 3]) {
      const laid = layoutTopology(g(wide()), null, { aspect });
      const byParent = new Map<string | null, LaidNode[]>();
      for (const x of laid.nodes) byParent.set(x.parent, [...(byParent.get(x.parent) ?? []), x]);
      for (const kids of byParent.values()) for (const p of kids) for (const q of kids) if (p !== q) expect(overlaps(p, q), `${aspect}: ${p.id} / ${q.id}`).toBe(false);
    }
  });

  it("saved positions still win", () => {
    const saved: TopologyLayout = { v: 1, nodes: { "k/v1s0a0": { x: 300, y: 200, p: "k/v1s0" }, "microsoft.resources/resourcegroups/rg-lab-az104-06-blob-security-third": { x: 0, y: 2000, p: null } } };
    const r = byId(layoutTopology(g(wide()), saved, { aspect: 1.25 }));
    expect([r.v1s0a0!.x, r.v1s0a0!.y]).toEqual([300, 200]);
    expect([r.rg2!.x, r.rg2!.y]).toEqual([0, 2000]);
  });

  it("a container is wide enough for its header's chips (up to a cap)", () => {
    const sn = n("s", "subnet", "v", "snet-nva", { prefix: "10.71.193.0/24", chips: ["no default outbound", "NSG nsg-nva"] });
    const laid = byId(layoutTopology(g([n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY), n("v", "vnet", "rg", "vnet-uks", { addressSpace: ["10.71.192.0/20"] }), sn, n("vm", "vm", "s", "vm-nva")]), null));
    expect(laid.s!.w).toBeGreaterThanOrEqual(headerWidth(sn));
    expect(headerWidth(sn)).toBeGreaterThan(CARD_W + 2 * PAD);
    expect(headerWidth(n("x", "subnet", "v", "snet", { chips: Array.from({ length: 30 }, (_, i) => `NSG nsg-${i}`) }))).toBe(HEADER_MAX_W);
    // A resource group's tags fold into "+N tags" rather than widen it.
    expect(headerWidth(n("x", "resourceGroup", undefined, "rg", { region: "uksouth", tags: ["lab: az700-40-lb-advanced", "project: wg-admin-labs", "+1 tag"] }))).toBeLessThan(260);
  });

  it("real labs: az104-06 reads at 70% or more in the lab dialog's tab; every lab fills the full screen readably (60% or more at 1600 × 900, 75% at 2000 × 1030)", () => {
    // The generous spacing costs zoom in a small space: the compact spacing steps in below the readable floor.
    const opts = (space: { w: number; h: number }, minZoom: number) => ({ space, maxZoom: 1.75, minZoom });
    expect(fitZoom(layoutTopology(planned("az104-06-blob-security"), null, opts(TAB_1600, 0.7)), TAB_1600.w, TAB_1600.h)).toBeGreaterThanOrEqual(0.7);
    for (const k of Object.keys(PLANNED)) {
      const id = k.split("/").at(-1)!.replace(".json", "");
      const graph = planned(id);
      const [w, h] = FULL_1600;
      expect(fitZoom(layoutTopology(graph, null, opts({ w, h }, 0.6)), w, h), `${id} at 1600 × 900`).toBeGreaterThanOrEqual(0.6);
      expect(fitZoom(layoutTopology(graph, null, opts(FULL_2000, 0.6)), FULL_2000.w, FULL_2000.h), `${id} at 2000 × 1030`).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("real labs, packed for the space: never worse than the fixed packing, and far better for a wide lab in a small tab", () => {
    // az700-40 has three VNets, eight cards and two lanes: packed, it is still too big for the tab at 70% (the view
    // starts there at the top-left: viewport.ts), but far bigger than the one long row.
    const lb = planned("az700-40-lb-advanced");
    expect(fitZoom(layoutTopology(lb, null, { aspect: TAB[0] / TAB[1] }), ...TAB)).toBeGreaterThan(fitZoom(layoutTopology(lb, null), ...TAB) * 1.6);
    for (const k of Object.keys(PLANNED)) {
      const id = k.split("/").at(-1)!.replace(".json", "");
      const graph = planned(id);
      // Never worse than the fixed packing.
      for (const [w, h] of [TAB, FULL_1600, FULL_1100]) expect(fitZoom(layoutTopology(graph, null, { aspect: w / h }), w, h) + 1e-9, `${id} ${w}`).toBeGreaterThanOrEqual(fitZoom(layoutTopology(graph, null), w, h));
    }
  });
});

// ── Generous room, flow order and filling the canvas (Steven's feedback on lab 16, 2026-10-08) ──

/** The full screen's canvas at 2000 × 1030 (less the panel row) and the lab dialog's Diagram tab at 1600 × 900. */
const FULL_2000 = { w: 1934, h: 746 };
const TAB_1600 = { w: 905, h: 500 };

describe("generous spacing", () => {
  it("the compact spacing (a big lab in a small space) is still roomy", () => {
    expect(COMPACT.cardX).toBeGreaterThanOrEqual(96);
    expect(COMPACT.cardY).toBeGreaterThanOrEqual(80);
    expect(COMPACT.gap).toBeGreaterThanOrEqual(64);
    expect(COMPACT.pad).toBeGreaterThanOrEqual(24);
  });

  it("lab 16 in the full screen at 2000 × 1030 gets the generous spacing; az700-40 in the tab falls back to the compact one", () => {
    const gapsOf = (id: string, space: { w: number; h: number }, minZoom: number) => {
      const graph = planned(id);
      const abs = absoluteBoxes(layoutTopology(graph, null, { space, maxZoom: 1.75, minZoom }));
      const vms = graph.nodes.filter((x) => x.kind === "vm").map((x) => abs.get(x.id)!);
      const lbs = graph.nodes.filter((x) => x.kind === "loadBalancer").map((x) => abs.get(x.id)!);
      return Math.min(...lbs.flatMap((l) => vms.map((v) => Math.max(v.x - (l.x + l.w), l.x - (v.x + v.w), v.y - (l.y + l.h), l.y - (v.y + v.h)))));
    };
    expect(gapsOf("az104-16-lb-appgw", FULL_2000, 0.6)).toBeGreaterThanOrEqual(CARD_GAP_X);
    const lab40 = planned("az700-40-lb-advanced");
    const roomy = layoutTopology(lab40, null, { space: TAB_1600, maxZoom: 1.75 });
    const fallback = layoutTopology(lab40, null, { space: TAB_1600, maxZoom: 1.75, minZoom: 0.7 });
    expect(fitZoomOf(fallback, TAB_1600, 1.75)).toBeGreaterThan(fitZoomOf(roomy, TAB_1600, 1.75));
  });

  it("every planned lab: no two cards come closer than the compact card gaps, at the full screen's and the tab's shapes", () => {
    for (const k of Object.keys(PLANNED)) {
      const id = k.split("/").at(-1)!.replace(".json", "");
      const graph = planned(id);
      for (const [space, minZoom] of [
        [FULL_2000, 0.6],
        [TAB_1600, 0.7],
      ] as const) {
        const laid = layoutTopology(graph, null, { space, maxZoom: 1.75, minZoom });
        const abs = absoluteBoxes(laid);
        const cards = graph.nodes.filter((x) => !["resourceGroup", "vnet", "subnet", "virtualHub", "lane"].includes(x.kind)).map((x) => ({ id: x.id, ...abs.get(x.id)! }));
        for (const a of cards)
          for (const b of cards) {
            if (a.id >= b.id) continue;
            const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
            const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
            // Side by side (overlapping rows): at least the horizontal gap; one above the other: at least the vertical gap.
            if (dy < 0) expect(dx, `${id} ${space.w}: ${a.id} / ${b.id} across`).toBeGreaterThanOrEqual(COMPACT.cardX);
            else if (dx < 0) expect(dy, `${id} ${space.w}: ${a.id} / ${b.id} down`).toBeGreaterThanOrEqual(COMPACT.cardY);
            else expect(Math.max(dx, dy), `${id} ${space.w}: ${a.id} / ${b.id} diagonal`).toBeGreaterThanOrEqual(COMPACT.cardY);
          }
      }
    }
  });

  it("sibling containers keep a corridor between them for lines", () => {
    const graph = planned("az104-16-lb-appgw");
    const laid = layoutTopology(graph, null, { space: FULL_2000, maxZoom: 1.75 });
    const subnets = laid.nodes.filter((x) => graph.nodes.find((y) => y.id === x.id)!.kind === "subnet");
    expect(subnets).toHaveLength(2);
    const [a, b] = [...subnets].sort((p, q) => p.x - q.x || p.y - q.y);
    const gap = Math.max(b!.x - (a!.x + a!.w), b!.y - (a!.y + a!.h));
    expect(gap).toBeGreaterThanOrEqual(GAP);
  });

  it("absoluteBoxes adds up the parents' positions", () => {
    const laid = layoutTopology(g(sample()), null);
    const abs = absoluteBoxes(laid);
    const r = byId(laid);
    expect(abs.get("vm1")).toEqual({ x: r.rg!.x + r.vnet!.x + r["snet-a"]!.x + r.vm1!.x, y: r.rg!.y + r.vnet!.y + r["snet-a"]!.y + r.vm1!.y, w: CARD_W, h: CARD_H });
  });
});

describe("flow-aware order", () => {
  it("flowRanks: sources before their targets, deterministic, cycles broken (a rule and its outbound return)", () => {
    const graph = planned("az700-40-lb-advanced");
    const rank = flowRanks(graph);
    const id = (label: string) => graph.nodes.find((x) => x.label === label)!.id;
    expect(rank.get(id("lb-global"))).toBe(0);
    expect(rank.get(id("lb-uks"))!).toBeLessThan(rank.get(id("vm-web1"))!);
    expect(rank.get(id("lb-uks"))!).toBeLessThan(rank.get(id("lb-gw"))!);
    expect(rank.get(id("lb-gw"))!).toBeLessThan(rank.get(id("vm-nva"))!);
    expect(flowRanks({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() })).toEqual(rank);
  });

  it("lab 16: the load balancer and the application gateway sit before (left of or above) the VMs they feed, so every line runs one way", () => {
    for (const space of [FULL_2000, TAB_1600]) {
      const graph = planned("az104-16-lb-appgw");
      const abs = absoluteBoxes(layoutTopology(graph, null, { space, maxZoom: 1.75 }));
      for (const e of graph.edges.filter((x) => x.kind === "traffic")) {
        const s = abs.get(e.from)!;
        const t = abs.get(e.to)!;
        const forward = s.x + s.w <= t.x || s.y + s.h <= t.y;
        expect(forward, `${space.w}: ${e.id} runs left to right or top to bottom`).toBe(true);
      }
    }
  });

  it("a subnet with sources and targets lays them out in flow columns, sources first", () => {
    const nodes = [
      n("rg", "resourceGroup", undefined, "rg", {}, RG_KEY),
      n("vnet", "vnet", "rg"),
      n("s", "subnet", "vnet"),
      n("vm1", "vm", "s", "vm-a"),
      n("vm2", "vm", "s", "vm-b"),
      n("lb", "loadBalancer", "s", "lb"),
    ];
    const graph: TopologyGraph = { ...g(nodes), edges: [{ id: "e1", from: "lb", to: "vm1", kind: "traffic" }, { id: "e2", from: "lb", to: "vm2", kind: "traffic" }] };
    const r = byId(layoutTopology(graph, null));
    expect(r.lb!.x).toBeLessThan(r.vm1!.x);
    expect(r.vm1!.x).toBe(r.vm2!.x);
    // The source sits level with the middle of its targets.
    expect(r.lb!.y + CARD_H / 2).toBe((r.vm1!.y + r.vm2!.y + CARD_H) / 2);
  });
});

describe("filling the canvas", () => {
  it("lab 16 full screen at 2000 × 1030: the fitted picture zooms in past 100% and fills most of the canvas", () => {
    const laid = layoutTopology(planned("az104-16-lb-appgw"), null, { space: FULL_2000, maxZoom: FIT_MAX_ZOOM.full });
    const b = boundsOf(laid.nodes.filter((x) => !x.parent))!;
    const v = startViewport(b, FULL_2000.w, FULL_2000.h + 44, { padding: FIT_PADDING.full, minZoom: MIN_FIT_ZOOM.full, maxZoom: FIT_MAX_ZOOM.full, reserveTop: 44 });
    expect(v.zoom).toBeGreaterThan(1.2);
    const fillW = (b.w * v.zoom) / FULL_2000.w;
    const fillH = (b.h * v.zoom) / FULL_2000.h;
    expect(Math.max(fillW, fillH)).toBeGreaterThanOrEqual(0.8);
  });
});
