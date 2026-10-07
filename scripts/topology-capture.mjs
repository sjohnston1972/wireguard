// scripts/topology-capture.mjs   (node scripts/topology-capture.mjs <lab id> [out.json])
//
// Plain English: the integration's read-only capture of a running lab's
// Resource Graph rows (lab topology spec §6.1 (V), plan integration steps
// 7-8), so the live rules can be tested on real shapes. It runs the one
// query the Worker runs (shared/topology/query.ts: the lab's own groups,
// in the signed-in `az` account's subscription) with `az rest`, then keeps
// only the columns and the property paths the live rules read
// (CAPTURE_KEEP), tags but lab and project dropped, the identity column
// dropped, and the subscription id replaced with a fake one, and writes the
// rows to worker/test/fixtures/topology/live/captured/<id>.json (or the path
// given). Only rows in the lab's own groups are kept (ownsName, as the
// Worker re-checks), and every public IP is mapped to a TEST-NET address.
// Reads only; free. Extend CAPTURE_KEEP with the rules:
// worker/test/topology-capture-keep.test.ts fails when the live builder or
// a rule reads a property path this list drops.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { labFolders } from "./lib/labs.mjs";

export const FAKE_SUBSCRIPTION = "00000000-0000-4000-8000-000000000000";

/** The columns kept as they are (identity is dropped, tags filtered, properties cut to CAPTURE_KEEP). */
export const CAPTURE_COLUMNS = ["id", "name", "type", "kind", "location", "resourceGroup", "sku", "zones", "managedBy"];

/** Property paths the live rules read ("[]" = every member of a list). */
export const CAPTURE_KEEP = [
  // ── Health, and what every row may say about where it sits ──
  "provisioningState",
  "status",
  "connectionStatus",
  "operationalState",
  "sku",
  "type",
  "subnet",
  "virtualNetwork",
  "ipConfigurations[].id",
  "ipConfigurations[].name",
  "ipConfigurations[].privateIpAddress",
  "ipConfigurations[].properties.privateIPAddress",
  "ipConfigurations[].properties.privateIPAllocationMethod",
  "ipConfigurations[].properties.subnet",
  "ipConfigurations[].properties.publicIPAddress.id",
  "ipConfigurations[].properties.applicationSecurityGroups[].id",
  "frontendIPConfigurations[].id",
  "frontendIPConfigurations[].properties.privateIPAddress",
  "frontendIPConfigurations[].properties.subnet",
  "frontendIPConfigurations[].properties.publicIPAddress.id",
  "frontendIPConfigurations[].properties.gatewayLoadBalancer.id",
  "gatewayIPConfigurations[].properties.subnet",
  // ── VNets, peerings, subnets ──
  "addressSpace.addressPrefixes",
  "dhcpOptions.dnsServers",
  "subnets[].id",
  "subnets[].name",
  "subnets[].properties.addressPrefix",
  "subnets[].properties.addressPrefixes",
  "subnets[].properties.networkSecurityGroup.id",
  "subnets[].properties.routeTable.id",
  "subnets[].properties.natGateway.id",
  "subnets[].properties.delegations[].properties.serviceName",
  "subnets[].properties.serviceEndpoints[].service",
  "subnets[].properties.defaultOutboundAccess",
  "virtualNetworkPeerings[].id",
  "virtualNetworkPeerings[].name",
  "virtualNetworkPeerings[].properties.peeringState",
  "virtualNetworkPeerings[].properties.allowGatewayTransit",
  "virtualNetworkPeerings[].properties.useRemoteGateways",
  "virtualNetworkPeerings[].properties.allowForwardedTraffic",
  "virtualNetworkPeerings[].properties.remoteVirtualNetwork.id",
  // ── NICs, VMs, scale sets ──
  "virtualMachine.id",
  "privateEndpoint.id",
  "privateLinkService.id",
  "networkSecurityGroup.id",
  "hardwareProfile.vmSize",
  "storageProfile.osDisk.osType",
  "extended.instanceView.powerState.code",
  "networkProfile.networkInterfaces[].id",
  "networkInterfaces[].id",
  "virtualMachineScaleSet.id",
  "virtualMachineProfile.networkProfile",
  "virtualMachineProfile.storageProfile.osDisk.osType",
  "targetResourceUri",
  "profiles[].capacity.minimum",
  "profiles[].capacity.maximum",
  "principalId",
  // ── NSGs, route tables, public IPs and prefixes, NAT ──
  "securityRules[].name",
  "routes[].id",
  "routes[].name",
  "routes[].properties.addressPrefix",
  "routes[].properties.nextHopType",
  "routes[].properties.nextHopIpAddress",
  "ipConfiguration.id",
  "natGateway.id",
  "loadBalancerFrontendIpConfiguration.id",
  "ipAddress",
  "publicIPAllocationMethod",
  "ipPrefix",
  // ── Load balancers ──
  "backendAddressPools[].id",
  "backendAddressPools[].properties.backendIPConfigurations[].id",
  "backendAddressPools[].properties.loadBalancerBackendAddresses[].properties.loadBalancerFrontendIPConfiguration.id",
  "backendAddressPools[].properties.backendAddresses[].ipAddress",
  "loadBalancingRules[].id",
  "loadBalancingRules[].properties.protocol",
  "loadBalancingRules[].properties.frontendPort",
  "loadBalancingRules[].properties.backendPort",
  "loadBalancingRules[].properties.backendAddressPool.id",
  "loadBalancingRules[].properties.backendAddressPools[].id",
  "inboundNatRules[].id",
  "inboundNatRules[].properties.protocol",
  "inboundNatRules[].properties.frontendPort",
  "inboundNatRules[].properties.frontendPortRangeStart",
  "inboundNatRules[].properties.frontendPortRangeEnd",
  "inboundNatRules[].properties.backendPort",
  "inboundNatRules[].properties.backendIPConfiguration.id",
  "inboundNatRules[].properties.backendAddressPool.id",
  "outboundRules[].id",
  "outboundRules[].properties.backendAddressPool.id",
  // ── Private endpoints, Private Link services, service endpoint policies ──
  "privateLinkServiceConnections[].id",
  "privateLinkServiceConnections[].properties.privateLinkServiceId",
  "privateLinkServiceConnections[].properties.groupIds",
  "privateLinkServiceConnections[].properties.privateLinkServiceConnectionState.status",
  "manualPrivateLinkServiceConnections[].id",
  "manualPrivateLinkServiceConnections[].properties.privateLinkServiceId",
  "manualPrivateLinkServiceConnections[].properties.groupIds",
  "manualPrivateLinkServiceConnections[].properties.privateLinkServiceConnectionState.status",
  "customDnsConfigs[].ipAddresses",
  "loadBalancerFrontendIpConfigurations[].id",
  "serviceEndpointPolicyDefinitions[].properties.serviceResources",
  // ── Application gateways, WAF policies, Front Door, Traffic Manager ──
  "autoscaleConfiguration.minCapacity",
  "autoscaleConfiguration.maxCapacity",
  "httpListeners[].id",
  "httpListeners[].properties.protocol",
  "httpListeners[].properties.frontendPort.id",
  "frontendPorts[].id",
  "frontendPorts[].properties.port",
  "backendHttpSettingsCollection[].id",
  "backendHttpSettingsCollection[].properties.port",
  "requestRoutingRules[].id",
  "requestRoutingRules[].properties.priority",
  "requestRoutingRules[].properties.httpListener.id",
  "requestRoutingRules[].properties.backendAddressPool.id",
  "requestRoutingRules[].properties.backendHttpSettings.id",
  "policySettings.mode",
  "applicationGateways[].id",
  "securityPolicyLinks[].id",
  "hostName",
  "sharedPrivateLinkResource.privateLink.id",
  "sharedPrivateLinkResource.status",
  "trafficRoutingMethod",
  "endpoints[].id",
  "endpoints[].properties.targetResourceId",
  "endpoints[].properties.target",
  "endpoints[].properties.priority",
  "endpoints[].properties.weight",
  "endpoints[].properties.endpointMonitorStatus",
  // ── DNS ──
  "registrationEnabled",
  "numberOfRecordSets",
  "dnsResolverOutboundEndpoints[].id",
  // ── Monitoring ──
  "retentionInDays",
  "workspaceCapping.dailyQuotaGb",
  "scopes",
  "actions[].actionGroupId",
  "actions.actionGroups",
  "destinations.logAnalytics[].workspaceResourceId",
  "targetResourceId",
  "storageId",
  "retentionPolicy.enabled",
  "retentionPolicy.days",
  "flowAnalyticsConfiguration.networkWatcherFlowAnalyticsConfiguration.enabled",
  "flowAnalyticsConfiguration.networkWatcherFlowAnalyticsConfiguration.workspaceResourceId",
  // ── Containers ──
  "containers[].properties.resources.requests.cpu",
  "containers[].properties.resources.requests.memoryInGB",
  "subnetIds[].id",
  "workloadProfiles[].workloadProfileType",
  "vnetConfiguration.infrastructureSubnetId",
  "configuration.ingress",
  // Lab 28's tiers: plain env values naming the next app or a SQL server (a secretRef has no value), the FQDNs they name.
  "template.containers[].env[].value",
  "latestRevisionFqdn",
  "fullyQualifiedDomainName",
  "configuration.registries[].server",
  "managedEnvironmentId",
  "environmentId",
  "loginServer",
  // AKS (lab 29): the first pool's size, count, autoscale range and subnet; pod networking; the node resource group.
  "agentPoolProfiles[].vmSize",
  "agentPoolProfiles[].count",
  "agentPoolProfiles[].enableAutoScaling",
  "agentPoolProfiles[].minCount",
  "agentPoolProfiles[].maxCount",
  "agentPoolProfiles[].vnetSubnetID",
  "networkProfile.networkPlugin",
  "networkProfile.networkPluginMode",
  "nodeResourceGroup",
  // A Container Apps environment's infrastructure group (lab 28): with the node group, what makes a group Azure's.
  "infrastructureResourceGroup",
  // A job's trigger and the queues its KEDA rules name (never the rules' auth or the secrets); an environment's
  // workspace (by customer id) and the workspace's; a system topic's source (lab 30)
  "configuration.triggerType",
  "configuration.eventTriggerConfig.scale.rules[].type",
  "configuration.eventTriggerConfig.scale.rules[].metadata.namespace",
  "configuration.eventTriggerConfig.scale.rules[].metadata.queueName",
  "configuration.eventTriggerConfig.scale.rules[].metadata.topicName",
  "template.containers[].resources.cpu",
  "appLogsConfiguration.logAnalyticsConfiguration.customerId",
  "customerId",
  "source",
  // ── Data ──
  "accessTier",
  "allowBlobPublicAccess",
  "publicNetworkAccess",
  "networkAcls.virtualNetworkRules[].id",
  "capabilities[].name",
  "consistencyPolicy.defaultConsistencyLevel",
  "enableRbacAuthorization",
  "accessPolicies[].objectId",
  // ── VPN, hubs, BGP, firewalls, AVNM ──
  "enableBgp",
  "bgpSettings.asn",
  "vpnType",
  "vpnClientConfiguration.vpnClientAddressPool.addressPrefixes",
  "localNetworkAddressSpace.addressPrefixes",
  "gatewayIpAddress",
  "connectionType",
  "virtualNetworkGateway1.id",
  "virtualNetworkGateway2.id",
  "localNetworkGateway2.id",
  "peer.id",
  "addressPrefix",
  "virtualRouterAsn",
  "virtualRouterIps",
  "virtualWan.id",
  "peerIp",
  "peerAsn",
  "connectionState",
  "virtualHub.id",
  "hubIPAddresses.privateIPAddress",
  "firewallPolicy.id",
  "basePolicy.id",
  "ruleCollectionGroups[].id",
  "networkManagerScopeAccesses",
];

/** The kept paths as a tree: { name: true | subtree }, "[]" marking a list. */
function keepTree(paths) {
  const root = {};
  for (const p of paths) {
    let node = root;
    const parts = p.split(".");
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      node[part] = last ? true : node[part] && node[part] !== true ? node[part] : {};
      if (!last) node = node[part];
    });
  }
  return root;
}

function cut(value, tree) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, sub] of Object.entries(tree)) {
    const list = key.endsWith("[]");
    const name = list ? key.slice(0, -2) : key;
    if (!(name in value)) continue;
    const v = value[name];
    if (list) {
      if (!Array.isArray(v)) continue;
      out[name] = v.map((x) => (sub === true ? x : (cut(x, sub) ?? {})));
    } else if (sub === true) out[name] = v;
    else {
      const c = cut(v, sub);
      if (c !== undefined) out[name] = c;
    }
  }
  return out;
}

const fakeSub = (v) => (typeof v === "string" ? v.replace(/\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, `/subscriptions/${FAKE_SUBSCRIPTION}`) : Array.isArray(v) ? v.map(fakeSub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fakeSub(x)])) : v);

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const TEST_NETS = ["203.0.113", "198.51.100", "192.0.2"];

/** Addresses that stay as they are: private, shared, loopback, link-local, Azure's platform address, TEST-NET, 0/8, multicast and above. */
function keepIp(a, b, c) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 168 && b === 63 && c === 129) return true;
  return TEST_NETS.includes(`${a}.${b}.${c}`);
}

/** Every public IPv4 in a value (deep) replaced by a TEST-NET address, the same one each time it appears. */
function testNetIps(rows) {
  const used = new Set(JSON.stringify(rows).match(IPV4) ?? []);
  const map = new Map();
  let next = 0;
  const fresh = () => {
    for (;;) {
      const net = TEST_NETS[Math.floor(next / 254)];
      if (!net) throw new Error("more public IPs than TEST-NET has room for");
      const ip = `${net}.${(next++ % 254) + 1}`;
      if (!used.has(ip)) return ip;
    }
  };
  const swap = (s) =>
    s.replace(IPV4, (m, a, b, c, d) => {
      const n = [a, b, c, d].map(Number);
      if (n.some((x) => x > 255) || keepIp(n[0], n[1], n[2])) return m;
      if (!map.has(m)) map.set(m, fresh());
      return map.get(m);
    });
  const walk = (v) => (typeof v === "string" ? swap(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(rows);
}

/** ownsName (shared/labs.ts), through Vite's module runner. */
export async function loadOwnsName() {
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport(fileURLToPath(new URL("../shared/labs.ts", import.meta.url)), { configFile: false, logLevel: "error" });
  return module.ownsName;
}

/**
 * Rows reduced to what the rules read: only rows in `labId`'s own groups
 * (owns = ownsName, ids = the catalogue's ids, as the Worker re-checks),
 * the subscription faked and every public IP mapped to TEST-NET.
 */
export function captureRows(rows, { labId, ids, owns, keep = CAPTURE_KEEP } = {}) {
  if (!labId || !Array.isArray(ids) || typeof owns !== "function") throw new Error("captureRows needs { labId, ids, owns } to keep only the lab's own rows");
  const tree = keepTree(keep);
  const mine = rows.filter((r) => typeof r?.resourceGroup === "string" && owns(labId, r.resourceGroup, ids));
  return testNetIps(
    mine.map((r) => {
      const out = {};
      for (const c of CAPTURE_COLUMNS) out[c] = r[c] ?? null;
      const tags = {};
      for (const [k, v] of Object.entries(r.tags ?? {})) if (["lab", "project"].includes(k.toLowerCase())) tags[k] = v;
      out.tags = tags;
      out.identity = null;
      out.properties = cut(r.properties ?? {}, tree) ?? {};
      return fakeSub(out);
    }),
  );
}

/** The Resource Graph request body: the one query, from shared/topology/query.ts. */
export async function captureRequest(subscriptionId, labId) {
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport(fileURLToPath(new URL("../shared/topology/query.ts", import.meta.url)), { configFile: false, logLevel: "error" });
  return module.topologyRequest(subscriptionId, labId);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [labId, outArg] = process.argv.slice(2);
  if (!labId) {
    console.error("usage: node scripts/topology-capture.mjs <lab id> [out.json]");
    process.exit(2);
  }
  const win = process.platform === "win32";
  const az = (args) => spawnSync("az", args, { encoding: "utf8", shell: win, maxBuffer: 64 * 1024 * 1024 });
  const sub = az(["account", "show", "--query", "id", "-o", "tsv"]);
  if (sub.status !== 0) {
    console.error("az is not signed in (az login), or not installed");
    process.exit(1);
  }
  const { ARG_API } = (await (await import("vite")).runnerImport(fileURLToPath(new URL("../shared/topology/query.ts", import.meta.url)), { configFile: false, logLevel: "error" })).module;
  const body = await captureRequest(sub.stdout.trim(), labId);
  const scratch = mkdtempSync(join(tmpdir(), "topology-capture-"));
  try {
    const file = join(scratch, "body.json");
    writeFileSync(file, JSON.stringify(body));
    const r = az(["rest", "--method", "post", "--url", `https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API}`, "--body", `@${file}`]);
    if (r.status !== 0) {
      console.error(`Resource Graph refused the query (az rest exit ${r.status}); nothing written`);
      process.exit(1);
    }
    const ids = labFolders(fileURLToPath(new URL("../labs/", import.meta.url)));
    const rows = captureRows(JSON.parse(r.stdout).data ?? [], { labId, ids, owns: await loadOwnsName() });
    const out = outArg ?? fileURLToPath(new URL(`../worker/test/fixtures/topology/live/captured/${labId}.json`, import.meta.url));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ _about: `Resource Graph rows of a running ${labId}, captured read-only by scripts/topology-capture.mjs (subscription faked, only rule-read paths kept).`, rows }, null, 1) + "\n");
    console.log(`wrote ${rows.length} rows to ${out}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
