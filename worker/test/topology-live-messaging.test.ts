// topology-live-messaging.test.ts: AZ-305 batch 4, lab 30 (messaging and events). Live derivation of a Service Bus
// namespace, an Event Grid system topic and an event-driven Container Apps job from Resource Graph row fixtures
// (fixtures/topology/live/messaging.json): their kinds and props, the job's edge to the namespace whose queues its KEDA
// rules watch, the topic's edge to its source account, the environment's edge to its workspace; and the lab's round trip.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { denyProblems } from "../../shared/topology/props";
import { KINDS, kindOfArm, kindOfTf } from "../../shared/topology/kinds";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/messaging.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az305-30-messaging"));

const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = graph.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edgesBetween = (graph: TopologyGraph, from: string, to: string) => graph.edges.filter((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id);

describe("kinds for messaging and events", () => {
  it("Service Bus namespaces, Event Grid system topics and Container Apps jobs have kinds of their own, with icons", () => {
    expect(kindOfArm("Microsoft.ServiceBus/namespaces")).toBe("serviceBus");
    expect(kindOfArm("microsoft.eventgrid/systemtopics")).toBe("eventGrid");
    expect(kindOfArm("Microsoft.EventGrid/topics")).toBe("eventGrid");
    expect(kindOfArm("Microsoft.App/jobs")).toBe("containerAppJob");
    expect(kindOfTf("azurerm_servicebus_namespace")).toBe("serviceBus");
    expect(kindOfTf("azurerm_eventgrid_system_topic")).toBe("eventGrid");
    expect(kindOfTf("azurerm_container_app_job")).toBe("containerAppJob");
    expect(KINDS.serviceBus).toMatchObject({ icon: "service-bus", placement: "rg", liveVisible: true });
    expect(KINDS.eventGrid).toMatchObject({ icon: "event-grid-system-topics", placement: "rg", liveVisible: true });
    // No job icon in the pack: a job is drawn with the container app icon.
    expect(KINDS.containerAppJob).toMatchObject({ icon: "container-apps", placement: "rg", liveVisible: true });
  });
});

describe("live messaging and events (lab 30)", () => {
  it("the namespace is a Service Bus card in its group with its tier", () => {
    const n = byLabel(g, "sb-l30rt7xy");
    expect(n.kind).toBe("serviceBus");
    expect(parentLabel(g, n)).toBe("rg-lab-az305-30-messaging");
    expect(n.props).toMatchObject({ sku: "Standard" });
  });

  it("the system topic depends on its source account", () => {
    const t = byLabel(g, "egst-storage");
    expect(t.kind).toBe("eventGrid");
    expect(edgesBetween(g, "egst-storage", "l30rt7xyevt")).toMatchObject([{ kind: "dependency", label: "source" }]);
  });

  it("the job is an event-driven card that reads the queues its KEDA rules watch, in the namespace they name", () => {
    const j = byLabel(g, "caj-consumer");
    expect(j.kind).toBe("containerAppJob");
    expect(j.props).toMatchObject({ cpu: 0.25, chips: ["event-driven"] });
    expect(edgesBetween(g, "caj-consumer", "sb-l30rt7xy")).toMatchObject([{ kind: "traffic", label: "orders, blob-events" }]);
    expect(edgesBetween(g, "caj-consumer", "cae-lab")).toMatchObject([{ kind: "dependency", label: "environment" }]);
  });

  it("the environment sends its logs to the workspace with its customer id", () => {
    expect(edgesBetween(g, "cae-lab", "log-lab")).toMatchObject([{ kind: "dependency", label: "logs" }]);
  });

  it("the deny check passes and nothing is generic", () => {
    expect(denyProblems(g)).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: lab 30", () => {
  it("az305-30-messaging: planned → rows → live has no added and no missing node, and passes the deny check", () => {
    const r = roundTrip("az305-30-messaging");
    expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
  });
});
