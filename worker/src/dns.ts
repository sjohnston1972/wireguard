// dns.ts
//
// Plain English: Terraform owns the wg.clydeford.net record; this file only
// checks it. Two views: what Cloudflare's API says the record is, and what
// the public resolver 1.1.1.1 actually answers. "DNS live" means both agree
// with the VM's real address. Like checking both the config and "show ip
// route" rather than trusting one.

import type { Env } from "./env";
import { config, canDns } from "./env";

/** Where the name points while nothing is deployed: TEST-NET-1, reserved and non-routable. */
export const PARKED_IP = "192.0.2.1";

export interface DnsCheck {
  api: string | null; // record content per Cloudflare API (null = no record)
  resolver: string | null; // answer from 1.1.1.1 (null = NXDOMAIN)
  live: boolean; // both present and equal to expected (if expected given)
  checked_at: string;
  error?: string;
}

export async function recordViaApi(env: Env): Promise<string | null> {
  const cfg = config(env);
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(cfg.dnsName)}`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_DNS_TOKEN}` } }
  );
  if (!r.ok) throw new Error(`Cloudflare DNS API ${r.status}`);
  const data = (await r.json()) as { result: { content: string }[] };
  return data.result[0]?.content ?? null;
}

export async function recordViaResolver(name: string): Promise<string | null> {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, {
    headers: { accept: "application/dns-json" },
    cf: { cacheTtl: 0 },
  } as RequestInit);
  if (!r.ok) throw new Error(`DoH ${r.status}`);
  const data = (await r.json()) as { Answer?: { type: number; data: string }[] };
  return data.Answer?.find((a) => a.type === 1)?.data ?? null;
}

export async function checkDns(env: Env, expectedIp: string | null): Promise<DnsCheck> {
  const cfg = config(env);
  const checked_at = new Date().toISOString();
  try {
    const [api, resolver] = await Promise.all([canDns(env) ? recordViaApi(env) : Promise.resolve(null), recordViaResolver(cfg.dnsName)]);
    const live = !!resolver && resolver !== PARKED_IP && (expectedIp ? resolver === expectedIp : true) && (canDns(env) ? api === resolver : true);
    return { api, resolver, live, checked_at };
  } catch (e) {
    return { api: null, resolver: null, live: false, checked_at, error: (e as Error).message };
  }
}
