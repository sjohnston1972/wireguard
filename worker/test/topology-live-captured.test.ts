// topology-live-captured.test.ts: the live builder on Resource Graph rows captured from real running labs
// (scripts/topology-capture.mjs → fixtures/topology/live/captured/<lab id>.json), lab topology spec §6.1 (V).

import { describe, expect, it } from "vitest";
import { liveGraph } from "../../shared/topology/live";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor } from "./fixtures/topology/round-trip";
import { CAPTURED, capturedRows } from "./fixtures/topology/captured";

const capturedGraph = (labId: string): TopologyGraph => liveGraph(capturedRows(labId), liveCtxFor(labId, { namePrefix: CAPTURED[labId]! }));

const byLabel = (g: TopologyGraph, label: string): TopoNode => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${g.nodes.map((x) => x.label).join(", ")}`);
  return n;
};

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
