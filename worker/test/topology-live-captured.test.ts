// topology-live-captured.test.ts: the live builder on Resource Graph rows captured from real running labs
// (scripts/topology-capture.mjs → fixtures/topology/live/captured/<lab id>.json), lab topology spec §6.1 (V).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor } from "./fixtures/topology/round-trip";

/** The captured labs and the name prefix their session had. */
export const CAPTURED: Record<string, string> = { "az104-14-peering-udr": "l14rt7xy", "az700-43-private-link": "l43qvmkk" };

export const capturedRows = (labId: string): ArgRow[] => (JSON.parse(readFileSync(new URL(`./fixtures/topology/live/captured/${labId}.json`, import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
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
});
