// topology-live-data.test.ts: T3.4 private access and data (lab topology plan T3.4). Live derivation of private
// endpoints (group id, approval state), SQL servers and databases (status), storage (firewall subnets, service endpoint
// policy), Cosmos DB, Key Vault (access policies matched to identities) and managed identities, from Resource Graph row
// fixtures (fixtures/topology/live/data.json), and the round trip of the family's labs (5, 6, 22, 23, 24, 25, 43).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { AZURE_MADE } from "../../shared/topology/rules/live";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/data.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az305-23-sql-failover"));

const all = (graph: TopologyGraph, label: string) => graph.nodes.filter((x) => x.label === label);
const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = all(graph, label)[0];
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edgesBetween = (graph: TopologyGraph, from: string, to: string) => graph.edges.filter((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id);

describe("live private access and data (T3.4)", () => {
  it("a private endpoint shows its group id and IP; its edge to the target carries the approval state; its NIC (any name) folds in", () => {
    const pe = byLabel(g, "pe-blob");
    expect(parentLabel(g, pe)).toBe("snet-pe");
    expect(pe.props).toMatchObject({ groupId: "blob", privateIp: "10.66.192.5" });
    expect(pe.folded?.map((f) => f.label)).toEqual(["nic-pe-blob"]);
    expect(edgesBetween(g, "pe-blob", "l23rt7xyst")).toMatchObject([{ label: "blob", state: { tone: "warn", word: "Pending approval" } }]);
    expect(edgesBetween(g, "pe-sqlp", "l23rt7xy-sqlp")[0]?.state).toEqual({ tone: "ok", word: "Approved" });
  });

  it("SQL databases are cards in their own group with status as health and a dependency edge to their server; master folds into the server", () => {
    const dbs = all(g, "appdb");
    expect(dbs.map((d) => parentLabel(g, d)).sort()).toEqual(["rg-lab-az305-23-sql-failover", "rg-lab-az305-23-sql-failover-secondary"]);
    expect(dbs.map((d) => d.key).sort()).toEqual(["microsoft.sql/servers/databases/{p}-sqlp/appdb", "microsoft.sql/servers/databases/{p}-sqls/appdb#secondary"]);
    expect(dbs[0]!.props).toMatchObject({ status: "Online", sku: "Basic" });
    const scratch = byLabel(g, "scratch");
    expect(scratch.health).toEqual({ tone: "warn", word: "Paused" });
    expect(edgesBetween(g, "scratch", "l23rt7xy-sqls")).toMatchObject([{ kind: "dependency", label: "server" }]);
    expect(g.nodes.some((n) => n.label === "master")).toBe(false);
    expect(byLabel(g, "l23rt7xy-sqlp").folded?.map((f) => f.label)).toEqual(["master"]);
    expect(byLabel(g, "l23rt7xy-sqls").props).toMatchObject({ publicAccess: false });
  });

  it("storage shows kind, SKU, tier; its firewall's subnet and the subnet's service endpoint policy are dependency edges; the policy folds into the subnet", () => {
    expect(byLabel(g, "l23rt7xyst").props).toMatchObject({ accountKind: "StorageV2", sku: "Standard_RAGRS", accessTier: "Hot", publicAccess: true });
    expect(edgesBetween(g, "snet-client", "l23rt7xyst").map((e) => e.label).sort()).toEqual(["service endpoint", "service endpoint policy"]);
    expect(byLabel(g, "snet-client").folded?.map((f) => f.label)).toEqual(["sep-storage"]);
    expect(g.nodes.some((n) => n.label === "sep-storage")).toBe(false);
  });

  it("Cosmos DB shows its API and consistency", () => {
    expect(byLabel(g, "l23rt7xy-cosmos")).toMatchObject({ kind: "cosmos", props: { apiKind: "NoSQL", consistency: "Session" } });
  });

  it("Key Vault shows SKU and model; an access policy whose object id is an identity here is an edge from it, others are not drawn", () => {
    const kv = byLabel(g, "l23rt7xykv");
    expect(kv.props).toMatchObject({ sku: "standard", mode: "access policies" });
    expect(edgesBetween(g, "id-l23rt7xy-app", "l23rt7xykv")).toMatchObject([{ kind: "dependency", label: "access policy" }]);
    expect(g.edges.filter((e) => e.to === kv.id)).toHaveLength(1);
  });

  it("a VM's user-assigned identity is a dependency edge", () => {
    expect(edgesBetween(g, "vm-app", "id-l23rt7xy-app")).toMatchObject([{ kind: "dependency", label: "identity" }]);
  });

  it("the master database is made by Azure", () => {
    expect(AZURE_MADE.some((m) => m.test(rows.find((r) => r.name === "master")!, new Set()))).toBe(true);
  });

  it("the deny check passes: no object ids, permissions or endpoints leak; nothing is drawn plainly", () => {
    expect(denyProblems(g)).toEqual([]);
    const text = JSON.stringify(g);
    expect(text).not.toMatch(/aaaaaaaa-1111|bbbbbbbb-2222|33333333-3333|vault\.azure\.net|sqlp\.database\.windows\.net|documents\.azure\.com/);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: the data labs", () => {
  for (const id of ["az104-05-storage", "az104-06-blob-security", "az305-22-keyvault-mi", "az305-23-sql-failover", "az305-24-cosmos", "az305-25-storage-design", "az700-43-private-link"]) {
    it(`${id}: planned → rows → live has no added and no missing node, and passes the deny check`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }
});
