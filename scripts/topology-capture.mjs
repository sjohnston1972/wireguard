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
// given). Reads only; free. Extend CAPTURE_KEEP with the rules.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_SUBSCRIPTION = "00000000-0000-4000-8000-000000000000";

/** The columns kept as they are (identity is dropped, tags filtered, properties cut to CAPTURE_KEEP). */
const COLUMNS = ["id", "name", "type", "kind", "location", "resourceGroup", "sku", "zones", "managedBy"];

/** Property paths the live rules read ("[]" = every member of a list). */
export const CAPTURE_KEEP = [
  "provisioningState",
  "status",
  "connectionStatus",
  "operationalState",
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
  "virtualMachine.id",
  "privateEndpoint.id",
  "ipConfigurations[].id",
  "ipConfigurations[].name",
  "ipConfigurations[].properties.privateIPAddress",
  "ipConfigurations[].properties.privateIPAllocationMethod",
  "ipConfigurations[].properties.subnet.id",
  "ipConfigurations[].properties.publicIPAddress.id",
  "hardwareProfile.vmSize",
  "storageProfile.osDisk.osType",
  "extended.instanceView.powerState.code",
  "networkProfile.networkInterfaces[].id",
  "networkInterfaces[].id",
  "securityRules[].name",
  "routes[].id",
  "routes[].name",
  "routes[].properties.addressPrefix",
  "routes[].properties.nextHopType",
  "routes[].properties.nextHopIpAddress",
  "ipConfiguration.id",
  "natGateway.id",
  "ipAddress",
  "publicIPAllocationMethod",
  "ipPrefix",
  "frontendIPConfigurations[].id",
  "frontendIPConfigurations[].properties.privateIPAddress",
  "frontendIPConfigurations[].properties.subnet.id",
  "frontendIPConfigurations[].properties.publicIPAddress.id",
  "backendAddressPools[].id",
  "backendAddressPools[].properties.backendIPConfigurations[].id",
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
  "privateLinkServiceConnections[].id",
  "privateLinkServiceConnections[].properties.privateLinkServiceId",
  "privateLinkServiceConnections[].properties.groupIds",
  "privateLinkServiceConnections[].properties.privateLinkServiceConnectionState.status",
  "manualPrivateLinkServiceConnections[].id",
  "manualPrivateLinkServiceConnections[].properties.privateLinkServiceId",
  "manualPrivateLinkServiceConnections[].properties.groupIds",
  "manualPrivateLinkServiceConnections[].properties.privateLinkServiceConnectionState.status",
  "customDnsConfigs[].ipAddresses",
  "subnet.id",
  "virtualNetwork.id",
  "registrationEnabled",
  "gatewayIPConfigurations[].properties.subnet.id",
  "accessTier",
  "allowBlobPublicAccess",
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

const fakeSub = (v) => (typeof v === "string" ? v.replace(/\/subscriptions\/[^/]+/gi, `/subscriptions/${FAKE_SUBSCRIPTION}`) : Array.isArray(v) ? v.map(fakeSub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fakeSub(x)])) : v);

/** Rows reduced to what the rules read, with the subscription faked. */
export function captureRows(rows, keep = CAPTURE_KEEP) {
  const tree = keepTree(keep);
  return rows.map((r) => {
    const out = {};
    for (const c of COLUMNS) out[c] = r[c] ?? null;
    const tags = {};
    for (const [k, v] of Object.entries(r.tags ?? {})) if (["lab", "project"].includes(k.toLowerCase())) tags[k] = v;
    out.tags = tags;
    out.identity = null;
    out.properties = cut(r.properties ?? {}, tree) ?? {};
    return fakeSub(out);
  });
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
    const rows = captureRows(JSON.parse(r.stdout).data ?? []);
    const out = outArg ?? fileURLToPath(new URL(`../worker/test/fixtures/topology/live/captured/${labId}.json`, import.meta.url));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ _about: `Resource Graph rows of a running ${labId}, captured read-only by scripts/topology-capture.mjs (subscription faked, only rule-read paths kept).`, rows }, null, 1) + "\n");
    console.log(`wrote ${rows.length} rows to ${out}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
