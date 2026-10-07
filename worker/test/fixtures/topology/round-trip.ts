// round-trip.ts: shared by the topology-live-*.test.ts families (lab topology plan T3). A lab's committed planned graph,
// turned into the rows a running session answers with (rows-from-planned.ts), back through liveGraph and diffed with
// the planned graph: nothing "added by hand", nothing "not deployed".

import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow, type LiveCtx } from "../../../../shared/topology/live";
import { diffGraphs } from "../../../../shared/topology/diff";
import { denyProblems } from "../../../../shared/topology/props";
import type { TopologyGraph } from "../../../../shared/topology/model";
import { rowsCtx, rowsFromPlanned, SUB } from "./rows-from-planned";

export const LAB_IDS = [
  "az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az104-04-cost", "az104-05-storage", "az104-06-blob-security",
  "az104-07-files", "az104-08-vms", "az104-09-vmss", "az104-11-containers", "az104-12-bicep", "az104-13-vnets",
  "az104-14-peering-udr", "az104-15-dns", "az104-16-lb-appgw", "az104-17-netwatcher-fix", "az104-18-monitor", "az104-19-backup",
  "az305-20-landing-zone", "az305-21-monitoring-scale", "az305-22-keyvault-mi", "az305-23-sql-failover", "az305-24-cosmos",
  "az305-25-storage-design", "az305-26-site-recovery", "az305-27-multi-region", "az305-28-three-tier", "az700-31-ip-nat-outbound", "az700-32-dns-resolver",
  "az700-33-vnet-manager", "az700-34-route-server", "az700-35-forced-tunnel-fix", "az700-36-s2s-vpn", "az700-37-p2s-vpn",
  "az700-38-hub-firewall", "az700-39-vwan-secured-hub", "az700-40-lb-advanced", "az700-41-appgw-waf", "az700-42-frontdoor-private",
  "az700-43-private-link", "az700-44-flow-logs-bastion",
] as const;

export const plannedOf = (labId: string): TopologyGraph => JSON.parse(readFileSync(new URL(`../../../../shared/topology/planned/${labId}.json`, import.meta.url), "utf8")) as TopologyGraph;

export const liveCtxFor = (labId: string, over: Partial<LiveCtx> = {}): LiveCtx => ({
  labId,
  version: plannedOf(labId).version,
  namePrefix: rowsCtx(labId).prefix,
  region: "uksouth",
  secondaryRegion: "ukwest",
  catalogueIds: LAB_IDS,
  gatewayVnetId: `${SUB}/resourceGroups/rg-wg-ondemand/providers/Microsoft.Network/virtualNetworks/vnet-wg`,
  at: "2026-10-06T12:00:00.000Z",
  ...over,
});

export interface RoundTrip {
  planned: TopologyGraph;
  rows: ArgRow[];
  live: TopologyGraph;
  added: string[];
  missing: string[];
  deny: string[];
}

/** The round trip of one lab. */
export function roundTrip(labId: string): RoundTrip {
  const planned = plannedOf(labId);
  const rows = rowsFromPlanned(planned);
  const live = liveGraph(rows, liveCtxFor(labId));
  const { status } = diffGraphs(planned, live);
  const keys = (s: string) => Object.entries(status).filter(([, v]) => v === s).map(([k]) => k).sort();
  return { planned, rows, live, added: keys("added"), missing: keys("missing"), deny: denyProblems(live) };
}
