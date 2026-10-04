// settings.ts
//
// Plain English: the values the next deploy will use. Defaults come from
// wrangler.toml [vars]; anything changed on the Settings page is stored in
// D1 and wins. Kept separate from env.ts so env.ts stays synchronous.
//
// Cost rates: with rate_source "azure" (the default unless an hourly rate
// override was saved), every estimate uses Azure's list price for what is
// deployed (or, with nothing deployed, the configured region and size),
// while it is under 7 days old; otherwise the fixed rates (insights/price.ts).

import type { Env, Config } from "./env";
import { config } from "./env";
import { allSettings, setSetting } from "./db";
import { getSnapshot } from "./state";
import { priceInfo, rateSource, readPrices, testVmPrice } from "./insights/price";

/** The VM sizes the dashboard offers. */
export const VM_SIZES = ["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"];

/** Settings keys the UI may override, with a validator each. */
export const OVERRIDABLE: Record<string, (v: string) => boolean> = {
  region: (v) => /^[a-z]{2,20}$/.test(v),
  vm_size: (v) => /^Standard_[A-Za-z0-9_]{1,30}$/.test(v),
  auto_destroy_default_hours: (v) => Number(v) >= 0 && Number(v) <= 72,
  idle_destroy_minutes: (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 1440,
  monthly_budget_gbp: (v) => Number(v) >= 0,
  hourly_rate_gbp: (v) => Number(v) >= 0 && Number(v) < 10,
  standby_rate_gbp: (v) => Number(v) >= 0 && Number(v) < 10,
  expiry_action: (v) => v === "destroy" || v === "hibernate",
  standby_max_days: (v) => Number(v) >= 1 && Number(v) <= 60,
  test_vm: (v) => v === "1" || v === "0",
  firewall_default: (v) => v === "deny" || v === "allow",
  ssh_allowed_cidr: (v) => v === "" || /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v),
  rate_source: (v) => v === "azure" || v === "fixed",
  // Settings → Labs (labs spec §10; read through labsSettingsFrom in shared/labs.ts).
  labs_max_running: (v) => /^[1-5]$/.test(v),
  labs_default_peering: (v) => v === "1" || v === "0",
};

function fromOverrides(env: Env, ov: Record<string, string>): Config {
  const base = config(env);
  const num = (k: string, d: number) => (ov[k] !== undefined && ov[k] !== "" && Number.isFinite(Number(ov[k])) ? Number(ov[k]) : d);
  return {
    ...base,
    region: ov.region || base.region,
    vmSize: ov.vm_size || base.vmSize,
    autoDestroyDefaultHours: num("auto_destroy_default_hours", base.autoDestroyDefaultHours),
    idleDestroyMinutes: num("idle_destroy_minutes", base.idleDestroyMinutes),
    monthlyBudgetGbp: num("monthly_budget_gbp", base.monthlyBudgetGbp),
    hourlyRateGbp: num("hourly_rate_gbp", base.hourlyRateGbp),
    standbyRateGbp: num("standby_rate_gbp", base.standbyRateGbp),
    expiryAction: ov.expiry_action === "hibernate" ? "hibernate" : ov.expiry_action === "destroy" ? "destroy" : base.expiryAction,
    standbyMaxDays: num("standby_max_days", base.standbyMaxDays),
    testVm: ov.test_vm !== undefined ? ov.test_vm === "1" : base.testVm,
    firewallDefault: ov.firewall_default === "allow" ? "allow" : "deny",
    sshAllowedCidr: ov.ssh_allowed_cidr !== undefined ? ov.ssh_allowed_cidr : base.sshAllowedCidr,
  };
}

/** The settings with the fixed cost rates, whatever rate_source says (the Settings form edits these). */
export async function fixedConfig(env: Env): Promise<Config> {
  return fromOverrides(env, await allSettings(env));
}

/** The settings, with cost rates from Azure's list price when rate_source is azure and a fresh price exists. */
export async function effectiveConfig(env: Env): Promise<Config> {
  const ov = await allSettings(env);
  const cfg = fromOverrides(env, ov);
  if (rateSource(ov) !== "azure") return cfg;
  try {
    const rows = await readPrices(env.DB);
    if (!rows.length) return cfg;
    const snap = await getSnapshot(env);
    const deployed = snap.state !== "destroyed" && snap.region && snap.vm_size;
    const region = deployed ? snap.region! : cfg.region;
    const size = deployed ? snap.vm_size! : cfg.vmSize;
    const now = new Date();
    const p = priceInfo(rows, cfg, region, size, "azure", now);
    const test = testVmPrice(rows, region, now);
    return {
      ...cfg,
      ...(p.source === "azure" && p.totalGbpPerHour !== null && p.standbyGbpPerHour !== null ? { hourlyRateGbp: p.totalGbpPerHour, standbyRateGbp: p.standbyGbpPerHour } : {}),
      ...(test !== null ? { testVmRateGbp: test } : {}),
    };
  } catch {
    return cfg; // a price problem never stops the settings
  }
}

/** Validate and store a form's overrides. Returns the keys that were rejected. */
export async function saveOverrides(env: Env, form: Record<string, string>): Promise<string[]> {
  const rejected: string[] = [];
  for (const [k, ok] of Object.entries(OVERRIDABLE)) {
    if (!(k in form)) continue;
    const v = String(form[k] ?? "").trim();
    if (!ok(v)) {
      rejected.push(k);
      continue;
    }
    await setSetting(env, k, v);
  }
  return rejected;
}
