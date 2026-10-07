// topics.test.ts
//
// Plain English: labs redesign spec §7. A lab's topic chips, its card icon's
// family and its "Resources deployed" list all come from the planned
// diagram's kinds (counted into the catalogue at build time). Every one of the
// real 43 planned diagrams gives at least one topic and one resource.

import { describe, expect, it } from "vitest";
import type { TopologyGraph } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { FAMILY_ICON, TOPICS, labFamily, labTopics, resourceSummary, topicChips, type TopicFamily } from "./topics";

const PLANNED = import.meta.glob<TopologyGraph>("../../../../shared/topology/planned/*.json", { eager: true, import: "default" });

/** What labs-build counts (scripts/lib/labs.mjs countPlanned): each node's kind, lanes and the gateway left out. */
function counts(g: TopologyGraph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of g.nodes) if (n.kind !== "lane" && n.kind !== "gateway") out[n.kind] = (out[n.kind] ?? 0) + 1;
  return out;
}

describe("TOPICS (spec §7 table)", () => {
  it("covers every kind but the groups, lanes, the gateway and generic, once each", () => {
    const listed = TOPICS.flatMap((t) => t.kinds);
    expect(new Set(listed).size).toBe(listed.length);
    const none = ["resourceGroup", "subnet", "lane", "gateway", "generic"];
    for (const k of Object.keys(KINDS)) expect(listed.includes(k as never), k).toBe(!none.includes(k));
  });

  it("is in priority order: specific services first, VMs and VNets last", () => {
    const words = TOPICS.map((t) => t.topic);
    expect(words.slice(0, 4)).toEqual(["Entra ID", "RBAC", "Managed identities", "Azure Policy"]);
    expect(words.slice(-3)).toEqual(["Scale sets", "Virtual machines", "Virtual networks"]);
    expect(TOPICS.find((t) => t.topic === "DNS")!.kinds).toEqual(["dnsZone", "privateDnsZone", "dnsResolver", "dnsRuleset"]);
  });

  it("each family has a lucide icon, and no topic falls back to the flask", () => {
    const families: TopicFamily[] = ["identity", "governance", "security", "networking", "monitoring", "continuity", "storage", "data", "messaging", "containers", "compute"];
    for (const f of families) expect(FAMILY_ICON[f], f).toBeTruthy();
    expect(FAMILY_ICON.none).toBeTruthy();
    expect(new Set(TOPICS.map((t) => t.family))).toEqual(new Set(families));
  });
});

describe("labTopics and topicChips", () => {
  it("topics follow TOPICS order and the card shows 3 plus +N", () => {
    const t = labTopics({ vm: 2, vnet: 1, keyVault: 1, nsg: 1, storage: 1, resourceGroup: 1, subnet: 2 });
    expect(t).toEqual(["Key Vault", "NSGs", "Storage", "Virtual machines", "Virtual networks"]);
    expect(topicChips(t)).toEqual({ shown: ["Key Vault", "NSGs", "Storage"], more: 2 });
    expect(topicChips(["DNS", "NSGs"])).toEqual({ shown: ["DNS", "NSGs"], more: 0 });
  });

  it("two kinds of one topic give it once", () => {
    expect(labTopics({ firewall: 1, firewallPolicy: 1, publicIp: 2, publicIpPrefix: 1 })).toEqual(["Azure Firewall", "Public IPs"]);
  });

  it("no resources, or only groups, give no topics and the flask family", () => {
    expect(labTopics(null)).toEqual([]);
    expect(labTopics({ resourceGroup: 1, subnet: 1, generic: 3 })).toEqual([]);
    expect(labFamily(null)).toBeNull();
    expect(labFamily({ resourceGroup: 1 })).toBeNull();
  });

  it("the family is the first topic's", () => {
    expect(labFamily({ vm: 1, keyVault: 1 })).toBe("security");
    expect(labFamily({ vm: 1, vnet: 1 })).toBe("compute");
    expect(labFamily({ entraPrincipal: 2, storage: 1 })).toBe("identity");
  });
});

describe("resourceSummary", () => {
  it("resourceSummary puts assets before groups and plural words for counts over 1", () => {
    const s = resourceSummary({ resourceGroup: 1, subnet: 3, vnet: 2, vm: 2, storage: 1, privateEndpoint: 1, entraPrincipal: 1, generic: 2 });
    expect(s.map((r) => [r.kind, r.label, r.count])).toEqual([
      ["vm", "VMs", 2],
      ["storage", "Storage account", 1],
      ["privateEndpoint", "Private endpoint", 1],
      ["entraPrincipal", "Entra principal", 1],
      ["vnet", "Virtual networks", 2],
      ["subnet", "Subnets", 3],
      ["resourceGroup", "Resource group", 1],
      ["generic", "Other resources", 2],
    ]);
    expect(s[0].icon).toBe(KINDS.vm.icon);
    expect(resourceSummary({ generic: 1 })).toEqual([{ kind: "generic", label: "Other resource", count: 1, icon: KINDS.generic.icon }]);
  });

  it("null resources give an empty list; an unknown kind counts as other", () => {
    expect(resourceSummary(null)).toEqual([]);
    expect(resourceSummary({ quantumComputer: 1, generic: 1 }).map((r) => [r.kind, r.count])).toEqual([["generic", 2]]);
  });
});

describe("the real planned diagrams", () => {
  it("every one of the 43 planned graphs gives at least one topic and one resource", () => {
    const graphs = Object.values(PLANNED);
    expect(graphs.length).toBe(43);
    for (const g of graphs) {
      const c = counts(g);
      expect(labTopics(c).length, g.labId).toBeGreaterThan(0);
      expect(resourceSummary(c).length, g.labId).toBeGreaterThan(0);
      expect(labFamily(c), g.labId).not.toBeNull();
    }
  });
});
