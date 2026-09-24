// settings.ts
//
// Plain English: the values the next deploy will use. Defaults come from
// wrangler.toml [vars]; anything changed on the Settings page is stored in
// D1 and wins. Kept separate from env.ts so env.ts stays synchronous.

import type { Env, Config } from "./env";
import { config } from "./env";
import { allSettings, setSetting } from "./db";

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
};

export async function effectiveConfig(env: Env): Promise<Config> {
  const base = config(env);
  const ov = await allSettings(env);
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
