// topology-golden.test.ts: the golden suite (lab topology plan T3.8). For every lab folder, its committed planned graph
// (shared/topology/planned/<id>.json, written by npm run labs-topology) against a reviewed expectation of its shape:
// every node as "kind label < parent label", every edge as "from -> to : label" (traffic) or "from ..> to : label"
// (dependency), written from the lab's readme ("What it deploys") and reviewed, so a rule change that moves, drops or
// rewires anything fails here first.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import type { TopologyGraph } from "../../shared/topology/model";
import { representedIds } from "../../shared/topology/planned";
import { denyProblems } from "../../shared/topology/props";
import { KINDS } from "../../shared/topology/kinds";
import { tfIgnored } from "../../shared/topology/rules/planned";
// @ts-expect-error: a plain .mjs test fixture with no type declarations (scripts/ is frozen)
import { LAB_PLANS } from "../../scripts/test/fixtures/labs/plans/labs.mjs";
import { LAB_IDS, plannedOf } from "./fixtures/topology/round-trip";

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
  // Lab 28 (AZ-305 batch 4, ruling 41): Front Door Standard + WAF to the web tier; the app tier and the database are private.
  "az305-28-three-tier": {
    nodes: [
      "containerApp ca-app < rg-lab-az305-28-three-tier",
      "containerApp ca-web < rg-lab-az305-28-three-tier",
      "containerAppEnv cae-lab < snet-apps",
      "frontDoor afd-lab < Global",
      "lane Global",
      "privateDnsZone privatelink.database.windows.net < rg-lab-az305-28-three-tier",
      "privateEndpoint pe-l28…-sql < snet-pe",
      "resourceGroup rg-lab-az305-28-three-tier",
      "sqlDatabase appdb < rg-lab-az305-28-three-tier",
      "sqlServer l28…-sql < rg-lab-az305-28-three-tier",
      "subnet snet-apps < vnet-lab",
      "subnet snet-pe < vnet-lab",
      "vnet vnet-lab < rg-lab-az305-28-three-tier",
      "wafPolicy waflab < Global",
    ],
    edges: [
      "afd-lab -> ca-web : HTTPS",
      "appdb ..> l28…-sql : server",
      "ca-app ..> cae-lab : environment",
      "ca-web ..> cae-lab : environment",
      "pe-l28…-sql ..> privatelink.database.windows.net : DNS zone group",
      "pe-l28…-sql -> l28…-sql : sqlServer",
      "privatelink.database.windows.net ..> vnet-lab : link",
      "waflab ..> afd-lab : WAF policy",
    ],
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

  // ── T3.5 Compute and containers (7, 8 with the network core; 27 with delivery; 18 with governance) ──
  // Lab 12 is the Bicep lab: its template deployment folds into the group and its resources are expanded (ruling 24).
  "az104-12-bicep": {
    nodes: ["resourceGroup rg-lab-az104-12-bicep", "storage l12…bicep < rg-lab-az104-12-bicep", "subnet snet-app < vnet-bicep", "subnet snet-web < vnet-bicep", "vnet vnet-bicep < rg-lab-az104-12-bicep"],
    edges: [],
  },
  "az104-09-vmss": {
    nodes: ["resourceGroup rg-lab-az104-09-vmss", "subnet snet-vms < vnet-lab", "vmss vmss-web < snet-vms", "vnet vnet-lab < rg-lab-az104-09-vmss"],
    edges: [],
  },
  "az104-11-containers": {
    nodes: [
      "containerApp ca-hello < rg-lab-az104-11-containers",
      "containerAppEnv cae-lab < rg-lab-az104-11-containers",
      "containerGroup aci-hello < snet-aci",
      "registry l11…acr < rg-lab-az104-11-containers",
      "resourceGroup rg-lab-az104-11-containers",
      "subnet snet-aci < vnet-lab",
      "vnet vnet-lab < rg-lab-az104-11-containers",
    ],
    edges: ["ca-hello ..> cae-lab : environment"],
  },
  "az104-19-backup": {
    nodes: [
      "recoveryVault rsv-lab < rg-lab-az104-19-backup",
      "resourceGroup rg-lab-az104-19-backup",
      "storage l19…stage < rg-lab-az104-19-backup",
      "subnet snet-vms < vnet-lab",
      "vm vm-backup < snet-vms",
      "vnet vnet-lab < rg-lab-az104-19-backup",
    ],
    edges: ["rsv-lab ..> vm-backup : backup"],
  },
  "az305-26-site-recovery": {
    nodes: [
      "recoveryVault rsv-lab < rg-lab-az305-26-site-recovery-secondary",
      "resourceGroup rg-lab-az305-26-site-recovery",
      "resourceGroup rg-lab-az305-26-site-recovery-secondary",
      "storage l26…cache < rg-lab-az305-26-site-recovery",
      "subnet snet-vms < vnet-source",
      "subnet snet-vms < vnet-target",
      "subnet snet-vms < vnet-test",
      "vm vm-app < snet-vms",
      "vnet vnet-source < rg-lab-az305-26-site-recovery",
      "vnet vnet-target < rg-lab-az305-26-site-recovery-secondary",
      "vnet vnet-test < rg-lab-az305-26-site-recovery-secondary",
    ],
    edges: ["rsv-lab ..> vm-app : replication", "vnet-source ..> vnet-target : network mapping"],
  },

  // ── T3.6 Governance and monitoring ──
  "az104-01-identity": {
    nodes: [
      "entraPrincipal lab-az104-01-identity-ann < Tenant and Entra ID",
      "entraPrincipal lab-az104-01-identity-ben < Tenant and Entra ID",
      "entraPrincipal lab-az104-01-identity-helpdesk < Tenant and Entra ID",
      "lane Tenant and Entra ID",
      "nsg nsg-lab-demo < rg-lab-az104-01-identity",
      "resourceGroup rg-lab-az104-01-identity",
      "role lab-az104-01-identity-vm-operator < Tenant and Entra ID",
    ],
    edges: [
      "lab-az104-01-identity-ann ..> lab-az104-01-identity-helpdesk : member",
      "lab-az104-01-identity-ben ..> rg-lab-az104-01-identity : role: lab-az104-01-identity-vm-operator",
      "lab-az104-01-identity-helpdesk ..> rg-lab-az104-01-identity : role: Reader",
    ],
  },
  "az104-02-policy": {
    nodes: [
      "lane Tenant and Entra ID",
      "nsg nsg-untagged < rg-lab-az104-02-policy",
      "policy lab-az104-02-policy-allowed-locations < rg-lab-az104-02-policy",
      "policy lab-az104-02-policy-require-costcentre-tag < Tenant and Entra ID",
      "policy lab-az104-02-policy-require-tag < rg-lab-az104-02-policy",
      "resourceGroup rg-lab-az104-02-policy",
      "storage l02…tags < rg-lab-az104-02-policy",
    ],
    edges: ["lab-az104-02-policy-require-tag ..> lab-az104-02-policy-require-costcentre-tag : assigns"],
  },
  "az104-03-mgmt-groups": {
    nodes: [
      "lane Tenant and Entra ID",
      "managementGroup lab-az104-03-mgmt-groups-dev < Tenant and Entra ID",
      "managementGroup lab-az104-03-mgmt-groups-prod < Tenant and Entra ID",
      "managementGroup lab-az104-03-mgmt-groups-root < Tenant and Entra ID",
      "policy audit-environment-tag < Tenant and Entra ID",
      "policy lab-az104-03-mgmt-groups-audit-environment-tag < Tenant and Entra ID",
      "resourceGroup rg-lab-az104-03-mgmt-groups",
    ],
    edges: [
      "audit-environment-tag ..> lab-az104-03-mgmt-groups-audit-environment-tag : assigns",
      "audit-environment-tag ..> lab-az104-03-mgmt-groups-root : scope",
      "lab-az104-03-mgmt-groups-dev ..> lab-az104-03-mgmt-groups-root : parent",
      "lab-az104-03-mgmt-groups-prod ..> lab-az104-03-mgmt-groups-root : parent",
    ],
  },
  "az104-04-cost": {
    nodes: ["monitor lab-az104-04-cost-budget-alerts < rg-lab-az104-04-cost", "resourceGroup rg-lab-az104-04-cost"],
    edges: ["rg-lab-az104-04-cost ..> lab-az104-04-cost-budget-alerts : budget alert"],
  },
  "az104-18-monitor": {
    nodes: [
      "logAnalytics log-lab < rg-lab-az104-18-monitor",
      "monitor ag-lab < rg-lab-az104-18-monitor",
      "monitor alert-vm-cpu-high < rg-lab-az104-18-monitor",
      "monitor alert-vm-restart < rg-lab-az104-18-monitor",
      "monitor dcr-vm-linux < rg-lab-az104-18-monitor",
      "resourceGroup rg-lab-az104-18-monitor",
      "subnet snet-vms < vnet-lab",
      "vm vm-monitor < snet-vms",
      "vnet vnet-lab < rg-lab-az104-18-monitor",
    ],
    edges: [
      "alert-vm-cpu-high ..> ag-lab : notifies",
      "alert-vm-cpu-high ..> vm-monitor : alert",
      "alert-vm-restart ..> ag-lab : notifies",
      "alert-vm-restart ..> rg-lab-az104-18-monitor : alert",
      "dcr-vm-linux ..> log-lab : sends to",
      "dcr-vm-linux ..> vm-monitor : collects from",
    ],
  },
  "az305-20-landing-zone": {
    nodes: [
      "lane Tenant and Entra ID",
      "managedIdentity id-l20…-appops < rg-lab-az305-20-landing-zone",
      "managedIdentity id-l20…-netops < rg-lab-az305-20-landing-zone",
      "managementGroup lab-az305-20-landing-zone-corp < Tenant and Entra ID",
      "managementGroup lab-az305-20-landing-zone-landingzones < Tenant and Entra ID",
      "managementGroup lab-az305-20-landing-zone-online < Tenant and Entra ID",
      "managementGroup lab-az305-20-landing-zone-platform < Tenant and Entra ID",
      "managementGroup lab-az305-20-landing-zone-root < Tenant and Entra ID",
      "managementGroup lab-az305-20-landing-zone-sandbox < Tenant and Entra ID",
      "policy lab-az305-20-landing-zone-audit-costcentre < Tenant and Entra ID",
      "policy lab-az305-20-landing-zone-baseline < Tenant and Entra ID",
      "policy lz-baseline < Tenant and Entra ID",
      "policy sandbox-no-pip < Tenant and Entra ID",
      "resourceGroup rg-lab-az305-20-landing-zone",
      "role lab-az305-20-landing-zone-appops < Tenant and Entra ID",
      "role lab-az305-20-landing-zone-netops < Tenant and Entra ID",
    ],
    edges: [
      "id-l20…-appops ..> rg-lab-az305-20-landing-zone : role: lab-az305-20-landing-zone-appops",
      "id-l20…-netops ..> rg-lab-az305-20-landing-zone : role: lab-az305-20-landing-zone-netops",
      "lab-az305-20-landing-zone-baseline ..> lab-az305-20-landing-zone-audit-costcentre : includes",
      "lab-az305-20-landing-zone-corp ..> lab-az305-20-landing-zone-landingzones : parent",
      "lab-az305-20-landing-zone-landingzones ..> lab-az305-20-landing-zone-root : parent",
      "lab-az305-20-landing-zone-online ..> lab-az305-20-landing-zone-landingzones : parent",
      "lab-az305-20-landing-zone-platform ..> lab-az305-20-landing-zone-root : parent",
      "lab-az305-20-landing-zone-sandbox ..> lab-az305-20-landing-zone-root : parent",
      "lz-baseline ..> lab-az305-20-landing-zone-baseline : assigns",
      "lz-baseline ..> lab-az305-20-landing-zone-landingzones : scope",
      "sandbox-no-pip ..> lab-az305-20-landing-zone-sandbox : scope",
    ],
  },
  "az305-21-monitoring-scale": {
    nodes: [
      "keyVault l21…kv < rg-lab-az305-21-monitoring-scale",
      "lane Tenant and Entra ID",
      "logAnalytics log-central < rg-lab-az305-21-monitoring-scale",
      "policy lab-az305-21-monitoring-scale-kv-diagnostics < Tenant and Entra ID",
      "policy lab-az305-21-monitoring-scale-kv-diagnostics < rg-lab-az305-21-monitoring-scale",
      "policy lab-az305-21-monitoring-scale-kv-logs-audit < rg-lab-az305-21-monitoring-scale",
      "resourceGroup rg-lab-az305-21-monitoring-scale",
    ],
    edges: [
      "lab-az305-21-monitoring-scale-kv-diagnostics ..> lab-az305-21-monitoring-scale-kv-diagnostics : assigns",
      "lab-az305-21-monitoring-scale-kv-diagnostics ..> log-central : parameter",
      "lab-az305-21-monitoring-scale-kv-diagnostics ..> rg-lab-az305-21-monitoring-scale : role: Monitoring Contributor",
    ],
  },
  "az700-44-flow-logs-bastion": {
    nodes: [
      "bastion bas-hub < AzureBastionSubnet",
      "flowLog lab-az700-44-flow-logs-bastion-vnet < NetworkWatcherRG",
      "logAnalytics log-flow < rg-lab-az700-44-flow-logs-bastion",
      "resourceGroup NetworkWatcherRG",
      "resourceGroup rg-lab-az700-44-flow-logs-bastion",
      "storage l44…flow < rg-lab-az700-44-flow-logs-bastion",
      "subnet AzureBastionSubnet < vnet-hub",
      "subnet snet-app < vnet-hub",
      "subnet snet-web < vnet-hub",
      "vm vm-app < snet-app",
      "vm vm-web < snet-web",
      "vnet vnet-hub < rg-lab-az700-44-flow-logs-bastion",
    ],
    edges: [
      "lab-az700-44-flow-logs-bastion-vnet ..> l44…flow : stores logs",
      "lab-az700-44-flow-logs-bastion-vnet ..> log-flow : traffic analytics",
      "lab-az700-44-flow-logs-bastion-vnet ..> vnet-hub : watches",
    ],
  },
};

const LABS_DIR = new URL("../../labs/", import.meta.url);
const SHAPES_DIR = new URL("../../scripts/test/fixtures/labs/plans/shapes/", import.meta.url);
const labFolders = readdirSync(LABS_DIR)
  .filter((d) => /^az\d{3}-\d{2}-[a-z0-9-]+$/.test(d))
  .sort();
const shapeFiles = readdirSync(SHAPES_DIR);
const planFixtures = LAB_PLANS as Record<string, { resources: { address: string }[] }>;

/** The configuration addresses (type.name) and instance addresses a graph represents: nodes, folded entries, edge vias. */
function represented(g: TopologyGraph): { configs: Set<string>; instances: Set<string>; opaque: Map<string, number> } {
  const all = [...representedIds(g)].filter((x) => x.startsWith("tf:")).map((x) => x.slice(3).split("/")[0]!);
  // Opaque, counted folded ids (a Key Vault secret: "azurerm_key_vault_secret#1") stand for that many instances of the type.
  const opaque = new Map<string, number>();
  for (const a of all) {
    const m = /^([a-z0-9_]+)#\d+$/.exec(a);
    if (m) opaque.set(m[1]!, (opaque.get(m[1]!) ?? 0) + 1);
  }
  const instances = new Set(all.filter((a) => !a.includes("#")));
  return { instances, configs: new Set([...instances].map((a) => a.replace(/\[[^\]]*\]/g, ""))), opaque };
}
/** Addresses not represented: by address, or (an opaque type) by count, `n` instances of the type needing `n` entries. */
function unrepresented(addresses: string[], r: ReturnType<typeof represented>, set: Set<string>): string[] {
  const typeOf = (a: string) => a.split(".")[0]!;
  const out = addresses.filter((a) => !r.opaque.has(typeOf(a)) && !set.has(a));
  const byType = new Map<string, number>();
  for (const a of new Set(addresses)) if (r.opaque.has(typeOf(a))) byType.set(typeOf(a), (byType.get(typeOf(a)) ?? 0) + 1);
  for (const [t, n] of byType) if ((r.opaque.get(t) ?? 0) < n) out.push(`${t}: ${n} instances, ${r.opaque.get(t)} folded entries`);
  return out;
}
/** Every managed resource block in a lab's Terraform (data sources and never-drawn helpers left out). */
function tfAddresses(lab: string): string[] {
  const dir = new URL(`${lab}/terraform/`, LABS_DIR);
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tf")).sort())
    for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"/gm)) if (!tfIgnored(m[1]!)) out.push(`${m[1]}.${m[2]}`);
  return out;
}

describe("golden: every lab folder", () => {
  it("the table, the round trip's list and the planned files cover exactly the lab folders", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(labFolders);
    expect([...LAB_IDS].sort()).toEqual(labFolders);
    const files = readdirSync(new URL("../../shared/topology/planned/", import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    expect(files).toEqual(labFolders);
  });

  for (const id of labFolders) {
    describe(id, () => {
      const g = plannedOf(id);
      const text = readFileSync(new URL(`../../shared/topology/planned/${id}.json`, import.meta.url), "utf8");

      it(`${id}: the planned graph exists, is fresh for its lab.yaml version and passes the deny check`, () => {
        const version = Number((parse(readFileSync(new URL(`${id}/lab.yaml`, LABS_DIR), "utf8")) as { version?: unknown }).version);
        expect(g).toMatchObject({ schema: 1, labId: id, version, source: "planned", at: null });
        expect(denyProblems(g)).toEqual([]);
      });

      it(`${id}: every resource address in its Terraform is represented`, () => {
        const r = represented(g);
        expect(unrepresented(tfAddresses(id), r, r.configs)).toEqual([]);
        // Instance counts (count / for_each) from the lab's plan fixture, where there is one.
        const fixture = planFixtures[id];
        if (fixture) expect(unrepresented(fixture.resources.map((x) => x.address).filter((a) => !a.startsWith("data.") && !tfIgnored(a.split(".")[0]!)), r, r.instances)).toEqual([]);
      });

      it(`${id}: every address in its recorded real plan shape is represented`, () => {
        const file = new URL(`${id}.json`, SHAPES_DIR);
        if (!shapeFiles.includes(`${id}.json`)) return; // no recorded shape for this lab (labs 1-12)
        const shapeAddrs = Object.keys((JSON.parse(readFileSync(file, "utf8")) as { resources: Record<string, unknown> }).resources);
        const r = represented(g);
        expect(unrepresented(shapeAddrs.filter((a) => !a.startsWith("data.") && !tfIgnored(a.split(".")[0]!)), r, r.instances)).toEqual([]);
      });

      it(`${id}: no card the live view can list has a Terraform-only key (it would read "not deployed")`, () => {
        expect(g.nodes.filter((n) => n.key.startsWith("terraform/") && n.kind !== "lane" && KINDS[n.kind].liveVisible && n.scope !== "outside").map((n) => n.key)).toEqual([]);
      });

      it(`${id}: no Key Vault secret, key or certificate (or Front Door secret) is named by its Terraform address`, () => {
        expect(text).not.toMatch(/tf:azurerm_(key_vault_secret|key_vault_key|key_vault_certificate|cdn_frontdoor_secret)\./);
      });

      it(`${id}: the planned file is under 16 kB gzip`, () => {
        expect(gzipSync(new TextEncoder().encode(text)).length).toBeLessThan(16_000);
      });
    });
  }
});

describe("golden: each lab's planned graph has its reviewed shape", () => {
  for (const [id, want] of Object.entries(GOLDEN)) {
    it(`${id}: the expected kinds and edges`, () => {
      expect(shape(plannedOf(id))).toEqual({ nodes: [...want.nodes].sort(), edges: [...want.edges].sort() });
    });
  }
});
