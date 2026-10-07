// views/labs/topics.ts
//
// Plain English: what a lab is about, from what it deploys (labs redesign
// spec §7). labs-build counts each lab's planned diagram by kind into the
// catalogue (LabCard.resources); here those kinds become topic chips (in a
// fixed priority order: specific services first, VMs and VNets last), the
// card's monochrome topic icon (by the first topic's family) and the details'
// "Resources deployed" list (words and sprite icons from the diagram's KINDS).
// Pure: no fetch, no React state.

import { Activity, ArchiveRestore, Container, Database, FlaskConical, HardDrive, MessagesSquare, Network, ScrollText, Server, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { KINDS } from "@shared/topology/kinds";
import type { TopoKind } from "@shared/topology/model";

export type TopicFamily = "identity" | "governance" | "security" | "networking" | "monitoring" | "continuity" | "storage" | "data" | "messaging" | "containers" | "compute";

export interface Topic {
  topic: string;
  family: TopicFamily;
  kinds: TopoKind[];
}

const t = (topic: string, family: TopicFamily, ...kinds: TopoKind[]): Topic => ({ topic, family, kinds });

/** Kind -> topic, in priority order (spec §7). resourceGroup, subnet, lane, gateway and generic have no topic. */
export const TOPICS: readonly Topic[] = [
  t("Entra ID", "identity", "entraPrincipal"),
  t("RBAC", "identity", "role"),
  t("Managed identities", "identity", "managedIdentity"),
  t("Azure Policy", "governance", "policy"),
  t("Management groups", "governance", "managementGroup"),
  t("Key Vault", "security", "keyVault"),
  t("Azure Firewall", "security", "firewall", "firewallPolicy"),
  t("WAF", "security", "wafPolicy"),
  t("Bastion", "security", "bastion"),
  t("VPN", "networking", "vpnGateway", "localNetworkGateway"),
  t("Virtual WAN", "networking", "virtualWan", "virtualHub"),
  t("Route Server", "networking", "routeServer"),
  t("Network Manager", "networking", "networkManager"),
  t("NAT gateway", "networking", "natGateway"),
  t("Load Balancer", "networking", "loadBalancer"),
  t("Application Gateway", "networking", "appGateway"),
  t("Front Door", "networking", "frontDoor"),
  t("Traffic Manager", "networking", "trafficManager"),
  t("Private Link", "networking", "privateEndpoint", "privateLinkService"),
  t("DNS", "networking", "dnsZone", "privateDnsZone", "dnsResolver", "dnsRuleset"),
  t("Routing", "networking", "routeTable"),
  t("Public IPs", "networking", "publicIp", "publicIpPrefix"),
  t("NSGs", "networking", "nsg"),
  t("Flow logs", "monitoring", "flowLog"),
  t("Azure Monitor", "monitoring", "monitor"),
  t("Log Analytics", "monitoring", "logAnalytics"),
  t("Backup and recovery", "continuity", "recoveryVault"),
  t("Storage", "storage", "storage"),
  t("Azure SQL", "data", "sqlServer", "sqlDatabase"),
  t("Cosmos DB", "data", "cosmos"),
  t("Service Bus", "messaging", "serviceBus"),
  t("Event Grid", "messaging", "eventGrid"),
  t("AKS", "containers", "aks"),
  t("Container Apps", "containers", "containerApp", "containerAppEnv", "containerAppJob"),
  t("Container Instances", "containers", "containerGroup"),
  t("Container Registry", "containers", "registry"),
  t("App Service", "compute", "appServicePlan"),
  t("Scale sets", "compute", "vmss"),
  t("Virtual machines", "compute", "vm"),
  t("Virtual networks", "networking", "vnet"),
];

/** The card's topic icon by family (decorative, currentColor); `none` for a lab with no topic. */
export const FAMILY_ICON: Record<TopicFamily | "none", LucideIcon> = {
  identity: UserRound,
  governance: ScrollText,
  security: ShieldCheck,
  networking: Network,
  monitoring: Activity,
  continuity: ArchiveRestore,
  storage: HardDrive,
  data: Database,
  messaging: MessagesSquare,
  containers: Container,
  compute: Server,
  none: FlaskConical,
};

type Resources = Record<string, number> | null | undefined;
const has = (r: Resources, k: string) => !!r && (r[k] ?? 0) > 0;

/** The distinct topics of a lab's kinds, in TOPICS order; [] without resources. */
export function labTopics(resources: Resources): string[] {
  return TOPICS.filter((x) => x.kinds.some((k) => has(resources, k))).map((x) => x.topic);
}

/** The first topic's family (the card's icon), or null when the lab has no topic. */
export function labFamily(resources: Resources): TopicFamily | null {
  return TOPICS.find((x) => x.kinds.some((k) => has(resources, k)))?.family ?? null;
}

/** A card's chips: the first `n` topics and how many more ("+N", aria-label "N more topics"). */
export function topicChips(topics: readonly string[], n = 3): { shown: string[]; more: number } {
  return { shown: topics.slice(0, n), more: Math.max(0, topics.length - n) };
}

export interface ResourceLine {
  kind: string;
  /** KINDS word for 1, plural otherwise; "Other resource(s)" for generic and unknown kinds. */
  label: string;
  count: number;
  /** Sprite symbol id without its "az-" prefix (KINDS[kind].icon). */
  icon: string;
}

/** Group kinds go after the assets, in this order. */
const GROUP_ORDER = ["vnet", "subnet", "virtualHub", "resourceGroup"];

/**
 * "Resources deployed": asset kinds by KINDS order, then the group kinds (vnet, subnet,
 * virtualHub, resourceGroup), then generic (with any kind this app does not know) as
 * "Other resources". [] without resources (the panel then says "Resource list unavailable").
 */
export function resourceSummary(resources: Resources): ResourceLine[] {
  if (!resources) return [];
  const known = (k: string): k is TopoKind => Object.hasOwn(KINDS, k) && k !== "lane" && k !== "gateway" && k !== "generic";
  let other = 0;
  const assets: ResourceLine[] = [];
  const groups: ResourceLine[] = [];
  for (const [k, count] of Object.entries(resources)) {
    if (!(count > 0)) continue;
    if (!known(k)) {
      if (k !== "lane" && k !== "gateway") other += count;
      continue;
    }
    const line = { kind: k, label: count === 1 ? KINDS[k].word : KINDS[k].plural, count, icon: KINDS[k].icon };
    (GROUP_ORDER.includes(k) ? groups : assets).push(line);
  }
  assets.sort((a, b) => KINDS[a.kind as TopoKind].order - KINDS[b.kind as TopoKind].order || (a.kind < b.kind ? -1 : 1));
  groups.sort((a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind));
  const out = [...assets, ...groups];
  if (other > 0) out.push({ kind: "generic", label: other === 1 ? "Other resource" : "Other resources", count: other, icon: KINDS.generic.icon });
  return out;
}
