// topology-golden.test.ts: the golden suite (lab topology plan T3.8). For every lab folder, its committed planned graph
// (shared/topology/planned/<id>.json, written by npm run labs-topology) against a reviewed expectation of its shape:
// every node as "kind label < parent label", every edge as "from -> to : label" (traffic) or "from ..> to : label"
// (dependency), written from the lab's readme ("What it deploys") and reviewed, so a rule change that moves, drops or
// rewires anything fails here first.

import { describe, expect, it } from "vitest";
import type { TopologyGraph } from "../../shared/topology/model";
import { plannedOf } from "./fixtures/topology/round-trip";

/** A graph in the table's form. */
function shape(g: TopologyGraph): { nodes: string[]; edges: string[] } {
  const label = new Map(g.nodes.map((n) => [n.id, n.label]));
  return {
    nodes: g.nodes.map((n) => `${n.kind} ${n.label}${n.parent ? ` < ${label.get(n.parent)}` : ""}`).sort(),
    edges: g.edges.map((e) => `${label.get(e.from) ?? e.from} ${e.kind === "traffic" ? "->" : "..>"} ${label.get(e.to) ?? e.to}${e.label ? ` : ${e.label}` : ""}`).sort(),
  };
}

const GOLDEN: Record<string, { nodes: string[]; edges: string[] }> = {
  // ── T3.1 Network core ──
  "az104-06-blob-security": {
    nodes: [
      "entraPrincipal lab-az104-06-blob-security-readers < Tenant and Entra ID",
      "lane Tenant and Entra ID",
      "privateDnsZone privatelink.blob.core.windows.net < rg-lab-az104-06-blob-security",
      "privateEndpoint pe-l06…blob-blob < snet-endpoints",
      "resourceGroup rg-lab-az104-06-blob-security",
      "storage l06…blob < rg-lab-az104-06-blob-security",
      "subnet snet-endpoints < vnet-lab",
      "vnet vnet-lab < rg-lab-az104-06-blob-security",
    ],
    edges: [
      "lab-az104-06-blob-security-readers ..> rg-lab-az104-06-blob-security : role: Storage Blob Data Reader",
      "pe-l06…blob-blob ..> privatelink.blob.core.windows.net : DNS zone group",
      "pe-l06…blob-blob -> l06…blob : blob",
      "privatelink.blob.core.windows.net ..> vnet-lab : link",
    ],
  },
  "az104-07-files": {
    nodes: [
      "resourceGroup rg-lab-az104-07-files",
      "storage l07…files < rg-lab-az104-07-files",
      "subnet snet-vms < vnet-lab",
      "vm vm-files < snet-vms",
      "vnet vnet-lab < rg-lab-az104-07-files",
    ],
    edges: ["snet-vms ..> l07…files : service endpoint"],
  },
  "az104-08-vms": {
    nodes: ["resourceGroup rg-lab-az104-08-vms", "subnet snet-vms < vnet-lab", "vm vm-zone1 < snet-vms", "vm vm-zone2 < snet-vms", "vnet vnet-lab < rg-lab-az104-08-vms"],
    edges: [],
  },
  "az104-13-vnets": {
    nodes: [
      "resourceGroup rg-lab-az104-13-vnets",
      "subnet snet-app < vnet-lab",
      "subnet snet-web < vnet-lab",
      "vm vm-app < snet-app",
      "vm vm-web < snet-web",
      "vnet vnet-lab < rg-lab-az104-13-vnets",
    ],
    edges: [],
  },
  "az104-14-peering-udr": {
    nodes: [
      "resourceGroup rg-lab-az104-14-peering-udr",
      "subnet snet-router < vnet-hub",
      "subnet snet-workload < vnet-spoke1",
      "subnet snet-workload < vnet-spoke2",
      "vm vm-router < snet-router",
      "vm vm-spoke1 < snet-workload",
      "vm vm-spoke2 < snet-workload",
      "vnet vnet-hub < rg-lab-az104-14-peering-udr",
      "vnet vnet-spoke1 < rg-lab-az104-14-peering-udr",
      "vnet vnet-spoke2 < rg-lab-az104-14-peering-udr",
    ],
    edges: ["snet-workload -> vm-router : 10.71.208.0/20", "snet-workload -> vm-router : 10.71.224.0/20", "vnet-hub -> vnet-spoke1 : peering", "vnet-hub -> vnet-spoke2 : peering"],
  },
  "az104-15-dns": {
    nodes: [
      "dnsZone l15….example.com < Global",
      "lane Global",
      "privateDnsZone lab15.internal < rg-lab-az104-15-dns",
      "resourceGroup rg-lab-az104-15-dns",
      "subnet snet-vms < vnet-lab",
      "vm vm-web < snet-vms",
      "vnet vnet-lab < rg-lab-az104-15-dns",
    ],
    edges: ["lab15.internal ..> vm-web : A www", "lab15.internal ..> vnet-lab : link (auto-registration)"],
  },
  "az104-17-netwatcher-fix": {
    nodes: ["resourceGroup rg-lab-az104-17-netwatcher-fix", "subnet snet-app < vnet-lab", "subnet snet-db < vnet-lab", "vm vm-app < snet-app", "vm vm-db < snet-db", "vnet vnet-lab < rg-lab-az104-17-netwatcher-fix"],
    edges: [],
  },
  "az700-31-ip-nat-outbound": {
    nodes: [
      "loadBalancer lb-out < rg-lab-az700-31-ip-nat-outbound",
      "natGateway ng-hub < rg-lab-az700-31-ip-nat-outbound",
      "resourceGroup rg-lab-az700-31-ip-nat-outbound",
      "subnet snet-lb < vnet-hub",
      "subnet snet-nat < vnet-hub",
      "vm vm-lb < snet-lb",
      "vm vm-nat < snet-nat",
      "vnet vnet-hub < rg-lab-az700-31-ip-nat-outbound",
    ],
    edges: ["snet-nat -> ng-hub : outbound", "vm-lb -> lb-out : outbound"],
  },
  "az700-32-dns-resolver": {
    nodes: [
      "dnsResolver dnspr-hub < vnet-hub",
      "dnsRuleset frs-onprem < rg-lab-az700-32-dns-resolver",
      "privateDnsZone azure.lab32.internal < rg-lab-az700-32-dns-resolver",
      "resourceGroup rg-lab-az700-32-dns-resolver",
      "subnet snet-app < vnet-hub",
      "subnet snet-in < vnet-hub",
      "subnet snet-onprem < vnet-onprem",
      "subnet snet-out < vnet-hub",
      "vm vm-app < snet-app",
      "vm vm-dns < snet-onprem",
      "vnet vnet-hub < rg-lab-az700-32-dns-resolver",
      "vnet vnet-onprem < rg-lab-az700-32-dns-resolver",
    ],
    edges: [
      "azure.lab32.internal ..> vnet-hub : link (auto-registration)",
      "frs-onprem ..> dnspr-hub : outbound endpoint",
      "frs-onprem ..> vnet-hub : link",
      "frs-onprem -> vm-dns : DNS 53",
      "vnet-hub -> vnet-onprem : peering",
    ],
  },
  "az700-35-forced-tunnel-fix": {
    nodes: [
      "resourceGroup rg-lab-az700-35-forced-tunnel-fix",
      "subnet snet-app < vnet-spoke",
      "subnet snet-nva < vnet-hub",
      "vm vm-app < snet-app",
      "vm vm-nva < snet-nva",
      "vnet vnet-hub < rg-lab-az700-35-forced-tunnel-fix",
      "vnet vnet-spoke < rg-lab-az700-35-forced-tunnel-fix",
    ],
    edges: ["snet-app -> vm-nva : 0.0.0.0/0", "vnet-hub -> vnet-spoke : peering"],
  },

  // ── T3.2 Delivery ──
  "az104-16-lb-appgw": {
    nodes: [
      "appGateway agw-web < snet-appgw",
      "loadBalancer lbi-web < snet-web",
      "resourceGroup rg-lab-az104-16-lb-appgw",
      "subnet snet-appgw < vnet-lab",
      "subnet snet-web < vnet-lab",
      "vm vm-web1 < snet-web",
      "vm vm-web2 < snet-web",
      "vnet vnet-lab < rg-lab-az104-16-lb-appgw",
    ],
    edges: ["agw-web -> vm-web1 : HTTP 80→80", "agw-web -> vm-web2 : HTTP 80→80", "lbi-web -> vm-web1 : TCP 80→80", "lbi-web -> vm-web2 : TCP 80→80"],
  },
  "az305-27-multi-region": {
    nodes: [
      "containerGroup ci-uks < rg-lab-az305-27-multi-region",
      "containerGroup ci-ukw < rg-lab-az305-27-multi-region-secondary",
      "frontDoor afd-lab < Global",
      "lane Global",
      "resourceGroup rg-lab-az305-27-multi-region",
      "resourceGroup rg-lab-az305-27-multi-region-secondary",
      "trafficManager l27…-tm < Global",
    ],
    edges: ["afd-lab -> ci-uks : HTTP", "afd-lab -> ci-ukw : HTTP", "l27…-tm -> ci-uks : priority 1", "l27…-tm -> ci-ukw : priority 2"],
  },
  "az700-40-lb-advanced": {
    nodes: [
      "lane Global",
      "loadBalancer lb-global < Global",
      "loadBalancer lb-gw < snet-nva",
      "loadBalancer lb-uks < rg-lab-az700-40-lb-advanced",
      "loadBalancer lb-ukw < rg-lab-az700-40-lb-advanced-secondary",
      "resourceGroup rg-lab-az700-40-lb-advanced",
      "resourceGroup rg-lab-az700-40-lb-advanced-secondary",
      "subnet snet-nva < vnet-uks",
      "subnet snet-web < vnet-uks",
      "subnet snet-web < vnet-ukw",
      "vm vm-nva < snet-nva",
      "vm vm-web1 < snet-web",
      "vm vm-web2 < snet-web",
      "vnet vnet-uks < rg-lab-az700-40-lb-advanced",
      "vnet vnet-ukw < rg-lab-az700-40-lb-advanced-secondary",
    ],
    edges: [
      "lb-global -> lb-uks : TCP 80→80",
      "lb-global -> lb-ukw : TCP 80→80",
      "lb-gw -> vm-nva : HA ports",
      "lb-uks -> lb-gw : chain",
      "lb-uks -> vm-web1 : TCP 8081-8090→8080",
      "lb-uks -> vm-web1 : TCP 80→80",
      "lb-ukw -> vm-web2 : TCP 80→80",
      "vm-web1 -> lb-uks : outbound",
      "vm-web2 -> lb-ukw : outbound",
    ],
  },
  "az700-41-appgw-waf": {
    nodes: [
      "appGateway agw-hub < snet-agw",
      "keyVault l41…kv < rg-lab-az700-41-appgw-waf",
      "logAnalytics log-agw < rg-lab-az700-41-appgw-waf",
      "managedIdentity id-l41…-agw < rg-lab-az700-41-appgw-waf",
      "privateDnsZone lab41.internal < rg-lab-az700-41-appgw-waf",
      "resourceGroup rg-lab-az700-41-appgw-waf",
      "subnet snet-agw < vnet-hub",
      "subnet snet-web < vnet-hub",
      "vm vm-web1 < snet-web",
      "vm vm-web2 < snet-web",
      "vnet vnet-hub < rg-lab-az700-41-appgw-waf",
      "wafPolicy waf-hub < rg-lab-az700-41-appgw-waf",
    ],
    edges: [
      "agw-hub ..> id-l41…-agw : identity",
      "agw-hub ..> l41…kv : TLS certificate",
      "agw-hub ..> log-agw : diagnostics",
      "agw-hub -> vm-web1 : HTTPS 443→80",
      "agw-hub -> vm-web2 : HTTPS 443→80",
      "id-l41…-agw ..> l41…kv : access policy",
      "lab41.internal ..> agw-hub : A app",
      "lab41.internal ..> vnet-hub : link",
      "waf-hub ..> agw-hub : WAF policy",
    ],
  },
  "az700-42-frontdoor-private": {
    nodes: [
      "frontDoor afd-premium < Global",
      "lane Global",
      "loadBalancer lb-int < snet-web",
      "privateLinkService pls-web < snet-pls",
      "resourceGroup rg-lab-az700-42-frontdoor-private",
      "subnet snet-pls < vnet-app",
      "subnet snet-web < vnet-app",
      "vm vm-web < snet-web",
      "vnet vnet-app < rg-lab-az700-42-frontdoor-private",
      "wafPolicy wafpremium < Global",
    ],
    edges: ["afd-premium -> pls-web : Private Link", "lb-int -> vm-web : TCP 80→80", "pls-web -> lb-int : frontend", "wafpremium ..> afd-premium : WAF policy"],
  },
};

describe("golden: each lab's planned graph has its reviewed shape", () => {
  for (const [id, want] of Object.entries(GOLDEN)) {
    it(`${id}: the expected kinds and edges`, () => {
      expect(shape(plannedOf(id))).toEqual({ nodes: [...want.nodes].sort(), edges: [...want.edges].sort() });
    });
  }
});
