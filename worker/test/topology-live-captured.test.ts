// topology-live-captured.test.ts: the live builder on Resource Graph rows captured from real running labs
// (scripts/topology-capture.mjs → fixtures/topology/live/captured/<lab id>.json), lab topology spec §6.1 (V).

import { describe, expect, it } from "vitest";
import { liveGraph } from "../../shared/topology/live";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { rebaseSlot } from "../../shared/topology/diff";
import { liveCtxFor, plannedOf } from "./fixtures/topology/round-trip";
import { CAPTURED, CAPTURED_SLOT, capturedRows } from "./fixtures/topology/captured";

const capturedGraph = (labId: string): TopologyGraph => liveGraph(capturedRows(labId), liveCtxFor(labId, { namePrefix: CAPTURED[labId]! }));

const byLabel = (g: TopologyGraph, label: string): TopoNode => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${g.nodes.map((x) => x.label).join(", ")}`);
  return n;
};

/**
 * Planned edges the live view cannot draw: a child or link Resource Graph does not return (diff.ts mergeForView shows
 * them from the plan, "Not listed by the live view"). Only the labels the captured labs have.
 */
const NOT_LISTED_BY_LIVE = new Set(["DNS zone group"]);

/** An edge as its kind, its ends' keys (an undirected peering in key order) and its label. */
const edgeKeys = (g: TopologyGraph): string[] => {
  const key = new Map(g.nodes.map((n) => [n.id, n.key]));
  return g.edges
    .map((e) => {
      let [a, b] = [key.get(e.from) ?? `?${e.from}`, key.get(e.to) ?? `?${e.to}`];
      if (e.label?.startsWith("peering") && b < a) [a, b] = [b, a];
      return `${e.kind} ${a} → ${b} (${e.label ?? ""})`;
    })
    .sort();
};

describe("golden live check: each captured lab's live graph is its planned graph (rebased to the captured slot)", () => {
  for (const labId of Object.keys(CAPTURED)) {
    describe(labId, () => {
      const live = capturedGraph(labId);
      const planned = rebaseSlot(plannedOf(labId), CAPTURED_SLOT);

      it("the same node keys; anything live only is made by Azure", () => {
        const plannedKeys = new Set(planned.nodes.map((n) => n.key));
        const liveOnly = live.nodes.filter((n) => !plannedKeys.has(n.key));
        expect(liveOnly.filter((n) => n.madeBy !== "azure").map((n) => n.key)).toEqual([]);
        expect(live.nodes.filter((n) => n.madeBy !== "azure").map((n) => n.key).sort()).toEqual([...plannedKeys].sort());
      });

      it("the same edges, but those the live view does not list", () => {
        const plannedEdges = planned.edges.filter((e) => !NOT_LISTED_BY_LIVE.has(e.label ?? ""));
        expect(edgeKeys(live)).toEqual(edgeKeys({ ...planned, edges: plannedEdges }));
      });
    });
  }
});

describe("captured lab 43 (Private Link)", () => {
  const g = capturedGraph("az700-43-private-link");

  it("the Private Link service's Azure-made NIC folds into it: no stray card, listed in its folded list", () => {
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
    expect(g.nodes.some((n) => /^pls-svc\.nic\./.test(n.label))).toBe(false);
    expect(byLabel(g, "pls-svc").folded?.map((f) => f.label)).toEqual(["pls-svc.nic.1473d5c3-1fc8-4aee-8bd7-7d26c2899c75"]);
  });

  it("the client subnet → the one storage account its service endpoint policy allows (the policy folds into the subnet)", () => {
    const sep = g.edges.filter((e) => e.label === "service endpoint policy");
    expect(sep).toMatchObject([{ kind: "dependency", from: byLabel(g, "snet-client").id, to: byLabel(g, "l43qvmkkst").id }]);
    expect(byLabel(g, "snet-client").folded?.map((f) => f.label)).toContain("sep-storage");
  });

  it("the Private Link service → its load balancer (frontend)", () => {
    expect(g.edges.filter((e) => e.from === byLabel(g, "pls-svc").id && e.to === byLabel(g, "lb-svc").id)).toMatchObject([{ kind: "traffic", label: "frontend" }]);
  });
});
