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
