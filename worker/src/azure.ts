// azure.ts
//
// Plain English: the Worker's own eyes on Azure, independent of what
// Terraform said. It asks Azure directly: does the resource group exist, is
// the VM powered on, what is its public IP, and what has this month cost?
// Disagreement between this and our own state is "drift" and raises a flag.
//
// Auth is the service principal's client-credentials flow: swap the client
// id and secret for a short-lived bearer token, cached in KV until it expires.

import type { Env } from "./env";
import { config } from "./env";
import type { AzureInventory } from "./state";
import type { PublishedNsgRule } from "./firewall";

const ARM = "https://management.azure.com";

interface TokenCache {
  token: string;
  expiresAt: number;
}

export async function armToken(env: Env): Promise<string> {
  const cached = await env.STATUS.get<TokenCache>("azure:token", "json");
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.AZURE_CLIENT_ID ?? "",
    client_secret: env.AZURE_CLIENT_SECRET ?? "",
    scope: "https://management.azure.com/.default",
  });
  const r = await fetch(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Azure login failed (${r.status})`);
  const data = (await r.json()) as { access_token: string; expires_in: number };
  const rec: TokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  await env.STATUS.put("azure:token", JSON.stringify(rec), { expirationTtl: data.expires_in });
  return rec.token;
}

async function arm(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await armToken(env);
  return fetch(`${ARM}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export interface AzureView {
  rg_exists: boolean;
  vm_exists: boolean;
  power: string | null; // "running" | "deallocated" | "stopped" | ...
  public_ip: string | null;
  checked_at: string;
}

/** What actually exists right now. Never throws; a failed check is reported as unknown. */
export async function azureView(env: Env): Promise<AzureView & { error?: string }> {
  const cfg = config(env);
  const sub = env.AZURE_SUBSCRIPTION_ID;
  const base = `/subscriptions/${sub}/resourceGroups/${cfg.resourceGroup}`;
  const checked_at = new Date().toISOString();
  try {
    const rg = await arm(env, `${base}?api-version=2021-04-01`);
    if (rg.status === 404) return { rg_exists: false, vm_exists: false, power: null, public_ip: null, checked_at };
    if (!rg.ok) throw new Error(`RG check ${rg.status}`);

    const [vm, pip] = await Promise.all([
      arm(env, `${base}/providers/Microsoft.Compute/virtualMachines/vm-wg/instanceView?api-version=2024-07-01`),
      arm(env, `${base}/providers/Microsoft.Network/publicIPAddresses/pip-wg?api-version=2024-01-01`),
    ]);
    let power: string | null = null;
    if (vm.ok) {
      const iv = (await vm.json()) as { statuses?: { code: string }[] };
      const ps = iv.statuses?.find((s) => s.code.startsWith("PowerState/"));
      power = ps ? ps.code.replace("PowerState/", "") : null;
    }
    let public_ip: string | null = null;
    if (pip.ok) {
      const p = (await pip.json()) as { properties?: { ipAddress?: string } };
      public_ip = p.properties?.ipAddress ?? null;
    }
    return { rg_exists: true, vm_exists: vm.ok, power, public_ip, checked_at };
  } catch (e) {
    return { rg_exists: false, vm_exists: false, power: null, public_ip: null, checked_at, error: (e as Error).message };
  }
}

/**
 * Everything that exists in the resource group right now, one line each,
 * straight from Azure Resource Manager. This is the "show inventory" of the
 * headend: rack (RG), LAN (VNet, subnet), firewall (NSG), WAN address (PIP),
 * NIC, disk, the VM itself, and any route table. Never throws.
 */
export async function azureInventory(env: Env): Promise<AzureInventory> {
  const cfg = config(env);
  const sub = env.AZURE_SUBSCRIPTION_ID;
  const base = `/subscriptions/${sub}/resourceGroups/${cfg.resourceGroup}`;
  const checked_at = new Date().toISOString();
  const out: AzureInventory = { checked_at, resource_group: cfg.resourceGroup, exists: false, resources: [] };
  try {
    const rg = await arm(env, `${base}?api-version=2021-04-01`);
    if (rg.status === 404) return out;
    if (!rg.ok) throw new Error(`resource group check ${rg.status}`);
    const rgJson = (await rg.json()) as { location: string; tags?: Record<string, string> };
    out.exists = true;
    out.resources.push({ kind: "Resource group", name: cfg.resourceGroup, detail: `${rgJson.location}${rgJson.tags?.run_id ? `, run ${rgJson.tags.run_id}` : ""}` });

    const j = async (path: string) => {
      const r = await arm(env, path);
      return r.ok ? ((await r.json()) as Record<string, any>) : null;
    };
    const [vnet, nsg, pip, pip6, nic, vm, vmView, rt] = await Promise.all([
      j(`${base}/providers/Microsoft.Network/virtualNetworks/vnet-wg?api-version=2024-01-01`),
      j(`${base}/providers/Microsoft.Network/networkSecurityGroups/nsg-wg?api-version=2024-01-01`),
      j(`${base}/providers/Microsoft.Network/publicIPAddresses/pip-wg?api-version=2024-01-01`),
      j(`${base}/providers/Microsoft.Network/publicIPAddresses/pip-wg-v6?api-version=2024-01-01`),
      j(`${base}/providers/Microsoft.Network/networkInterfaces/nic-wg?api-version=2024-01-01`),
      j(`${base}/providers/Microsoft.Compute/virtualMachines/vm-wg?api-version=2024-07-01`),
      j(`${base}/providers/Microsoft.Compute/virtualMachines/vm-wg/instanceView?api-version=2024-07-01`),
      j(`${base}/providers/Microsoft.Network/routeTables/rt-wg-home?api-version=2024-01-01`),
    ]);

    if (vnet) {
      out.resources.push({ kind: "Virtual network", name: vnet.name, detail: (vnet.properties?.addressSpace?.addressPrefixes ?? []).join(", ") });
      for (const s of vnet.properties?.subnets ?? []) {
        out.resources.push({ kind: "Subnet", name: s.name, detail: `${s.properties?.addressPrefix ?? ""}${s.properties?.networkSecurityGroup ? ", NSG attached" : ""}${s.properties?.routeTable ? ", route table attached" : ""}` });
      }
    }
    if (nsg) {
      const rules = (nsg.properties?.securityRules ?? [])
        .sort((a: any, b: any) => a.properties.priority - b.properties.priority)
        .map((r: any) => `${r.properties.access === "Allow" ? "allow" : "deny"} ${r.properties.protocol.toLowerCase()} ${r.properties.destinationPortRange} from ${r.properties.sourceAddressPrefix}`);
      out.resources.push({ kind: "Network security group", name: nsg.name, detail: rules.join("; ") || "no rules" });
    }
    if (pip) {
      out.resources.push({ kind: "Public IP", name: pip.name, detail: `${pip.properties?.ipAddress ?? "not yet allocated"}, ${pip.sku?.name ?? ""} ${pip.properties?.publicIPAllocationMethod ?? ""}`.trim() });
    }
    if (pip6) {
      out.resources.push({ kind: "Public IPv6", name: pip6.name, detail: `${pip6.properties?.ipAddress ?? "not yet allocated"}, ${pip6.sku?.name ?? ""} ${pip6.properties?.publicIPAllocationMethod ?? ""}`.trim() });
    }
    if (nic) {
      const ipc = nic.properties?.ipConfigurations?.[0]?.properties ?? {};
      out.resources.push({ kind: "Network interface", name: nic.name, detail: `private ${ipc.privateIPAddress ?? "?"}, IP forwarding ${nic.properties?.enableIPForwarding ? "on" : "off"}` });
    }
    if (vm) {
      const hw = vm.properties?.hardwareProfile?.vmSize ?? "";
      const img = vm.properties?.storageProfile?.imageReference ?? {};
      const disk = vm.properties?.storageProfile?.osDisk ?? {};
      const power = (vmView?.statuses ?? []).find((s: any) => String(s.code).startsWith("PowerState/"))?.code?.replace("PowerState/", "") ?? "unknown";
      out.resources.push({ kind: "Virtual machine", name: vm.name, detail: `${hw}, ${img.offer ?? ""} ${img.sku ?? ""}, ${power}, admin ${vm.properties?.osProfile?.adminUsername ?? "?"}, SSH key only` });
      out.resources.push({ kind: "OS disk", name: disk.name ?? "osdisk", detail: `${disk.diskSizeGB ?? "?"} GB ${disk.managedDisk?.storageAccountType ?? ""}` });
    }
    if (rt) {
      const routes = (rt.properties?.routes ?? []).map((r: any) => `${r.properties.addressPrefix} via ${r.properties.nextHopIpAddress ?? r.properties.nextHopType}`);
      out.resources.push({ kind: "Route table", name: rt.name, detail: routes.join("; ") || "no routes" });
    }
    return out;
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
}

/**
 * Point the NSG's SSH rule at a new source. Creates the rule if the deploy had
 * none. This is a live change on the running VM; the next deploy starts from
 * the settings again.
 */
export async function setSshAllowedCidr(env: Env, cidr: string): Promise<void> {
  const cfg = config(env);
  const sub = env.AZURE_SUBSCRIPTION_ID;
  const path = `/subscriptions/${sub}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Network/networkSecurityGroups/nsg-wg/securityRules/allow-ssh-from-home?api-version=2024-01-01`;
  const body = {
    properties: {
      priority: 110,
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      sourcePortRange: "*",
      destinationPortRange: "22",
      sourceAddressPrefix: cidr,
      destinationAddressPrefix: "*",
    },
  };
  const r = await arm(env, path, { method: "PUT", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Azure refused the NSG change (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

/**
 * Power the VM down to "deallocated" (Standby) or back up. Deallocated means
 * Azure stops charging for the VM itself; the disk and the static IP stay,
 * so DNS and the VM's identity are unchanged. Like shutting a router down
 * but leaving it racked and cabled. Azure answers 202 and works in the
 * background; the dashboard polls the power state to see it finish.
 */
export async function vmPower(env: Env, op: "deallocate" | "start"): Promise<void> {
  const cfg = config(env);
  const sub = env.AZURE_SUBSCRIPTION_ID;
  const r = await arm(env, `/subscriptions/${sub}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Compute/virtualMachines/vm-wg/${op}?api-version=2024-07-01`, { method: "POST" });
  if (r.status !== 200 && r.status !== 202) throw new Error(`Azure refused to ${op} the VM (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

/**
 * Open (or close) the published ports at Azure's edge, kept in step with the
 * Firewall tab while the VM is running. One NSG rule per published port,
 * with the same protocol and "allowed from" as the tab, and aimed only at
 * the VM's private IPv4 address (the one the VM forwards from), so the edge
 * never opens more than the VM will forward.
 *
 * The whole NSG is read and written back in one go, with only the
 * "published-..." rules replaced; every other rule (WireGuard, SSH) is
 * passed back exactly as Azure had it. One write means Azure never sees a
 * half-finished set, and the etag check means a change made at the same
 * moment elsewhere is refused rather than overwritten.
 */
export async function setPublishedPorts(env: Env, rules: PublishedNsgRule[]): Promise<void> {
  const cfg = config(env);
  const sub = env.AZURE_SUBSCRIPTION_ID;
  const base = `/subscriptions/${sub}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.Network`;
  const g = await arm(env, `${base}/networkSecurityGroups/nsg-wg?api-version=2024-01-01`);
  if (!g.ok) throw new Error(`Azure would not show the NSG (${g.status})`);
  const nsg = (await g.json()) as any;
  const all: any[] = nsg.properties?.securityRules ?? [];
  const mine = (r: any) => String(r.name ?? "").startsWith("published-");
  const keep = all.filter((r) => !mine(r));
  const wantNames = rules.map((r) => r.name).sort();
  const haveNames = all.filter(mine).map((r) => String(r.name)).sort();
  if (!rules.length && !haveNames.length) return;

  let vmIp = "";
  if (rules.length) {
    const n = await arm(env, `${base}/networkInterfaces/nic-wg?api-version=2024-01-01`);
    if (!n.ok) throw new Error(`Azure would not show the VM's network card (${n.status})`);
    const nic = (await n.json()) as any;
    const ipc = (nic.properties?.ipConfigurations ?? []).find((c: any) => c.properties?.privateIPAddressVersion !== "IPv6" && c.properties?.privateIPAddress);
    vmIp = ipc?.properties?.privateIPAddress ?? "";
    if (!vmIp) throw new Error("could not find the VM's private address");
  }
  // Nothing to do if the same rules are already there, aimed the same way.
  const same =
    JSON.stringify(wantNames) === JSON.stringify(haveNames) &&
    rules.every((w) => {
      const h = all.find((r) => r.name === w.name)?.properties ?? {};
      return h.protocol === w.protocol && h.destinationPortRange === w.port && h.sourceAddressPrefix === w.source && h.destinationAddressPrefix === vmIp;
    });
  if (same) return;

  const used = new Set(keep.filter((r) => r.properties?.direction === "Inbound").map((r) => r.properties?.priority));
  let pri = 200;
  const added = rules.map((w) => {
    while (used.has(pri)) pri++;
    used.add(pri);
    return {
      name: w.name,
      properties: { priority: pri, direction: "Inbound", access: "Allow", protocol: w.protocol, sourcePortRange: "*", destinationPortRange: w.port, sourceAddressPrefix: w.source, destinationAddressPrefix: vmIp },
    };
  });
  const body = {
    location: nsg.location,
    tags: nsg.tags,
    properties: { securityRules: [...keep.map((r) => ({ name: r.name, properties: r.properties })), ...added] },
  };
  const r = await arm(env, `${base}/networkSecurityGroups/nsg-wg?api-version=2024-01-01`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: nsg.etag ? { "If-Match": nsg.etag } : {},
  });
  if (!r.ok) throw new Error(`Azure refused to update the published ports (${r.status}): ${(await r.text()).slice(0, 200)}`);
}

/** Daily actual cost for this resource group, month to date, via Cost Management. */
export async function costMonthToDate(env: Env): Promise<{ days: { day: string; gbp: number }[]; currency: string }> {
  const cfg = config(env);
  const sub = env.AZURE_SUBSCRIPTION_ID;
  const body = {
    type: "ActualCost",
    timeframe: "MonthToDate",
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      filter: { dimensions: { name: "ResourceGroupName", operator: "In", values: [cfg.resourceGroup] } },
    },
  };
  const r = await arm(env, `/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Cost query failed (${r.status})`);
  const data = (await r.json()) as { properties: { columns: { name: string }[]; rows: (string | number)[][] } };
  const cols = data.properties.columns.map((c) => c.name);
  const iCost = cols.indexOf("Cost");
  const iDate = cols.indexOf("UsageDate");
  const iCur = cols.indexOf("Currency");
  const days = data.properties.rows.map((row) => {
    const d = String(row[iDate]); // 20260922
    return { day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, gbp: Number(row[iCost]) || 0 };
  });
  const currency = data.properties.rows[0] ? String(data.properties.rows[0][iCur]) : "GBP";
  return { days, currency };
}
