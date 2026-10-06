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

  // ── T3.3 Hybrid and hubs ──
  "az700-33-vnet-manager": {
    nodes: [
      "networkManager avnm-l33… < rg-lab-az700-33-vnet-manager",
      "resourceGroup rg-lab-az700-33-vnet-manager",
      "subnet snet-app < vnet-spoke1",
      "subnet snet-app < vnet-spoke2",
      "subnet snet-shared < vnet-hub",
      "vm vm-spoke1 < snet-app",
      "vm vm-spoke2 < snet-app",
      "vnet vnet-hub < rg-lab-az700-33-vnet-manager",
      "vnet vnet-spoke1 < rg-lab-az700-33-vnet-manager",
      "vnet vnet-spoke2 < rg-lab-az700-33-vnet-manager",
    ],
    edges: ["avnm-l33… ..> vnet-spoke1 : member", "avnm-l33… ..> vnet-spoke2 : member", "vnet-hub -> vnet-spoke1 : peering (AVNM)", "vnet-hub -> vnet-spoke2 : peering (AVNM)"],
  },
  "az700-34-route-server": {
    nodes: [
      "resourceGroup rg-lab-az700-34-route-server",
      "routeServer rs-hub < RouteServerSubnet",
      "subnet RouteServerSubnet < vnet-hub",
      "subnet snet-app < vnet-spoke",
      "subnet snet-nva < vnet-hub",
      "vm vm-app < snet-app",
      "vm vm-nva < snet-nva",
      "vnet vnet-hub < rg-lab-az700-34-route-server",
      "vnet vnet-spoke < rg-lab-az700-34-route-server",
    ],
    edges: ["rs-hub -> vm-nva : BGP 65010", "vnet-hub -> vnet-spoke : peering (gateway transit)"],
  },
  "az700-36-s2s-vpn": {
    nodes: [
      "localNetworkGateway lgw-azure < rg-lab-az700-36-s2s-vpn",
      "localNetworkGateway lgw-onprem < rg-lab-az700-36-s2s-vpn",
      "resourceGroup rg-lab-az700-36-s2s-vpn",
      "subnet GatewaySubnet < vnet-azure",
      "subnet GatewaySubnet < vnet-onprem",
      "subnet snet-app < vnet-azure",
      "subnet snet-onprem < vnet-onprem",
      "vm vm-azure < snet-app",
      "vm vm-onprem < snet-onprem",
      "vnet vnet-azure < rg-lab-az700-36-s2s-vpn",
      "vnet vnet-onprem < rg-lab-az700-36-s2s-vpn",
      "vpnGateway vpngw-azure < GatewaySubnet",
      "vpnGateway vpngw-onprem < GatewaySubnet",
    ],
    edges: ["lgw-azure ..> vpngw-azure : gateway address", "lgw-onprem ..> vpngw-onprem : gateway address", "vpngw-azure -> lgw-onprem : IPsec, BGP", "vpngw-onprem -> lgw-azure : IPsec, BGP"],
  },
  "az700-37-p2s-vpn": {
    nodes: [
      "entraPrincipal lab-az700-37-p2s-vpn-vpnuser < Tenant and Entra ID",
      "lane Tenant and Entra ID",
      "resourceGroup rg-lab-az700-37-p2s-vpn",
      "subnet GatewaySubnet < vnet-hub",
      "subnet snet-app < vnet-hub",
      "vm vm-app < snet-app",
      "vnet vnet-hub < rg-lab-az700-37-p2s-vpn",
      "vpnGateway vpngw-hub < GatewaySubnet",
    ],
    edges: [],
  },
  "az700-38-hub-firewall": {
    nodes: [
      "firewall afw-hub < AzureFirewallSubnet",
      "firewallPolicy fwp-base < rg-lab-az700-38-hub-firewall",
      "firewallPolicy fwp-hub < rg-lab-az700-38-hub-firewall",
      "logAnalytics log-hub < rg-lab-az700-38-hub-firewall",
      "resourceGroup rg-lab-az700-38-hub-firewall",
      "subnet AzureFirewallManagementSubnet < vnet-hub",
      "subnet AzureFirewallSubnet < vnet-hub",
      "subnet snet-workload < vnet-spoke1",
      "subnet snet-workload < vnet-spoke2",
      "vm vm-spoke1 < snet-workload",
      "vm vm-spoke2 < snet-workload",
      "vnet vnet-hub < rg-lab-az700-38-hub-firewall",
      "vnet vnet-spoke1 < rg-lab-az700-38-hub-firewall",
      "vnet vnet-spoke2 < rg-lab-az700-38-hub-firewall",
    ],
    edges: [
      "afw-hub ..> fwp-hub : policy",
      "afw-hub ..> log-hub : diagnostics",
      "fwp-base ..> fwp-hub : base policy",
      "snet-workload -> afw-hub : 0.0.0.0/0",
      "snet-workload -> afw-hub : 0.0.0.0/0",
      "snet-workload -> afw-hub : 10.71.208.0/20",
      "snet-workload -> afw-hub : 10.71.224.0/20",
      "vnet-hub -> vnet-spoke1 : peering",
      "vnet-hub -> vnet-spoke2 : peering",
    ],
  },
  "az700-39-vwan-secured-hub": {
    nodes: [
      "firewall afw-vhub < vhub-lab",
      "firewallPolicy fwp-vhub < rg-lab-az700-39-vwan-secured-hub",
      "resourceGroup rg-lab-az700-39-vwan-secured-hub",
      "subnet snet-workload < vnet-spoke1",
      "subnet snet-workload < vnet-spoke2",
      "virtualHub vhub-lab < rg-lab-az700-39-vwan-secured-hub",
      "virtualWan vwan-lab < rg-lab-az700-39-vwan-secured-hub",
      "vm vm-spoke1 < snet-workload",
      "vm vm-spoke2 < snet-workload",
      "vnet vnet-spoke1 < rg-lab-az700-39-vwan-secured-hub",
      "vnet vnet-spoke2 < rg-lab-az700-39-vwan-secured-hub",
    ],
    edges: ["afw-vhub ..> fwp-vhub : policy", "vhub-lab -> vnet-spoke1 : hub connection", "vhub-lab -> vnet-spoke2 : hub connection", "vwan-lab ..> vhub-lab : virtual hub"],
  },

  // ── T3.4 Private access and data (lab 6 is with the network core above) ──
  "az104-05-storage": {
    nodes: ["resourceGroup rg-lab-az104-05-storage", "storage l05…cool < rg-lab-az104-05-storage", "storage l05…hot < rg-lab-az104-05-storage"],
    edges: [],
  },
  "az305-22-keyvault-mi": {
    nodes: [
      "keyVault l22…kv < rg-lab-az305-22-keyvault-mi",
      "managedIdentity id-l22…-app < rg-lab-az305-22-keyvault-mi",
      "resourceGroup rg-lab-az305-22-keyvault-mi",
      "subnet snet-vms < vnet-lab",
      "vm vm-app < snet-vms",
      "vnet vnet-lab < rg-lab-az305-22-keyvault-mi",
    ],
    edges: ["id-l22…-app ..> l22…kv : role: Key Vault Secrets User (one secret)", "vm-app ..> id-l22…-app : identity", "vm-app ..> l22…kv : role: Key Vault Secrets User"],
  },
  "az305-23-sql-failover": {
    nodes: [
      "privateDnsZone privatelink.database.windows.net < rg-lab-az305-23-sql-failover",
      "privateEndpoint pe-l23…-sqlp < snet-pe",
      "privateEndpoint pe-l23…-sqls < snet-pe",
      "resourceGroup rg-lab-az305-23-sql-failover",
      "resourceGroup rg-lab-az305-23-sql-failover-secondary",
      "sqlDatabase appdb < rg-lab-az305-23-sql-failover",
      "sqlDatabase appdb < rg-lab-az305-23-sql-failover-secondary",
      "sqlDatabase scratch < rg-lab-az305-23-sql-failover-secondary",
      "sqlServer l23…-sqlp < rg-lab-az305-23-sql-failover",
      "sqlServer l23…-sqls < rg-lab-az305-23-sql-failover-secondary",
      "subnet snet-pe < vnet-lab",
      "vnet vnet-lab < rg-lab-az305-23-sql-failover",
    ],
    edges: [
      "appdb ..> appdb : geo-replica",
      "appdb ..> l23…-sqlp : server",
      "appdb ..> l23…-sqls : server",
      "l23…-sqlp ..> l23…-sqls : failover group",
      "pe-l23…-sqlp ..> privatelink.database.windows.net : DNS zone group",
      "pe-l23…-sqlp -> l23…-sqlp : sqlServer",
      "pe-l23…-sqls ..> privatelink.database.windows.net : DNS zone group",
      "pe-l23…-sqls -> l23…-sqls : sqlServer",
      "privatelink.database.windows.net ..> vnet-lab : link",
      "scratch ..> l23…-sqls : server",
    ],
  },
  "az305-24-cosmos": {
    nodes: ["cosmos l24…-cosmos < rg-lab-az305-24-cosmos", "resourceGroup rg-lab-az305-24-cosmos"],
    edges: [],
  },
  "az305-25-storage-design": {
    nodes: ["resourceGroup rg-lab-az305-25-storage-design", "storage l25…lake < rg-lab-az305-25-storage-design", "storage l25…rec < rg-lab-az305-25-storage-design"],
    edges: [],
  },
  "az700-43-private-link": {
    nodes: [
      "loadBalancer lb-svc < snet-svc",
      "privateDnsZone privatelink.blob.core.windows.net < rg-lab-az700-43-private-link",
      "privateEndpoint pe-blob < snet-pe",
      "privateEndpoint pe-svc < snet-pe",
      "privateLinkService pls-svc < snet-pls",
      "resourceGroup rg-lab-az700-43-private-link",
      "storage l43…other < rg-lab-az700-43-private-link",
      "storage l43…st < rg-lab-az700-43-private-link",
      "subnet snet-client < vnet-consumer",
      "subnet snet-pe < vnet-consumer",
      "subnet snet-pls < vnet-provider",
      "subnet snet-svc < vnet-provider",
      "vm vm-client < snet-client",
      "vm vm-svc < snet-svc",
      "vnet vnet-consumer < rg-lab-az700-43-private-link",
      "vnet vnet-provider < rg-lab-az700-43-private-link",
    ],
    edges: [
      "lb-svc -> vm-svc : TCP 80→80",
      "pe-blob ..> privatelink.blob.core.windows.net : DNS zone group",
      "pe-blob -> l43…st : blob",
      "pe-svc -> pls-svc : private link",
      "pls-svc -> lb-svc : frontend",
      "privatelink.blob.core.windows.net ..> vnet-consumer : link",
      "snet-client ..> l43…st : service endpoint policy",
    ],
  },
};

describe("golden: each lab's planned graph has its reviewed shape", () => {
  for (const [id, want] of Object.entries(GOLDEN)) {
    it(`${id}: the expected kinds and edges`, () => {
      expect(shape(plannedOf(id))).toEqual({ nodes: [...want.nodes].sort(), edges: [...want.edges].sort() });
    });
  }
});
