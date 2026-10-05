// labs/cost.ts
//
// Plain English: what labs really cost (labs spec §9.4). Once a day the lab
// watch asks Cost Management one question, unfiltered and grouped by
// resource group, and keeps the rg-lab-* rows in lab_cost_days (Azure's
// figures arrive 8 to 24 hours late, so the query reaches back as the
// gateway's does). A session shows its estimate (est_gbp_h × its length)
// until the day after it ended, once Azure has listed that day for the lab;
// then its actual: each day's figure for the lab, split over that day's
// sessions by how long each ran that day.

import type { Env } from "../env";
import { canAzure } from "../env";
import { costTimeframe } from "../azure";
import { LAB_ID_MAX, LAB_ID_RE, labIdFromName } from "../../../shared/labs";
import type { LabCostRow } from "../../../shared/api";
import { labIds } from "./catalogue";
import { arm, type Net } from "./net";
import { LIVE_SQL, type LabSessionRow } from "./store";
import { estimateSoFar, labTitle } from "./view";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * The lab a resource group or Entra name belongs to: the longest catalogue
 * id it fits (labIdFromName), else, for a lab gone from the catalogue, the
 * whole name after "rg-lab-" or "lab-" when that is a valid id. Narrowest
 * guess on purpose: a clean-up for it can only ever reach that one name's
 * prefix. Null when it is not a lab's name.
 */
export function labIdOf(name: string): string | null {
  const known = labIdFromName(name, labIds());
  if (known) return known;
  const n = name.toLowerCase();
  const rest = n.startsWith("rg-lab-") ? n.slice(7) : n.startsWith("lab-") ? n.slice(4) : null;
  return rest && rest.length <= LAB_ID_MAX && LAB_ID_RE.test(rest) ? rest : null;
}

/** The daily query (one call, plus a sign-in when the token has expired). Returns a log line, or null when not due. */
export async function fetchLabCostDays(env: Env, net: Net, now: Date): Promise<string | null> {
  if (!canAzure(env)) return null;
  const today = now.toISOString().slice(0, 10);
  if ((await env.STATUS.get("labs:cost_day")) === today) return null;
  const body = {
    type: "ActualCost",
    ...costTimeframe(now),
    dataset: { granularity: "Daily", aggregation: { totalCost: { name: "Cost", function: "Sum" } }, grouping: [{ type: "Dimension", name: "ResourceGroupName" }] },
  };
  const r = await arm(env, net, `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Azure refused the lab cost query (${r.status}).`);
  const data = (await r.json()) as { properties?: { columns?: { name: string }[]; rows?: (string | number)[][] } };
  const cols = (data.properties?.columns ?? []).map((c) => c.name);
  const [iCost, iDate, iRg] = ["Cost", "UsageDate", "ResourceGroupName"].map((c) => cols.indexOf(c));
  const at = now.toISOString();
  const keep = new Map<string, { day: string; rg: string; lab: string; gbp: number }>();
  for (const row of (data.properties?.rows ?? []).slice(0, 5000)) {
    const rg = String(row[iRg] ?? "").toLowerCase();
    if (!rg.startsWith("rg-lab-")) continue;
    const lab = labIdOf(rg);
    if (!lab) continue;
    const d = String(row[iDate]);
    const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const key = `${day}|${rg}`;
    const gbp = Number(row[iCost]) || 0;
    const have = keep.get(key);
    if (have) have.gbp += gbp;
    else keep.set(key, { day, rg, lab, gbp });
  }
  const stmts = [...keep.values()].map((k) =>
    env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (day, rg) DO UPDATE SET lab_id = excluded.lab_id, gbp = excluded.gbp, fetched_at = excluded.fetched_at").bind(k.day, k.rg, k.lab, k.gbp, at),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await env.STATUS.put("labs:cost_day", today, { expirationTtl: 2 * 86_400 });
  return `lab costs: ${stmts.length} row(s)`;
}

/** How long a session ran inside [from, to), in ms. */
function overlap(s: Pick<LabSessionRow, "requested_at" | "ended_at">, from: number, to: number, now: number): number {
  const a = Math.max(Date.parse(s.requested_at), from);
  const b = Math.min(s.ended_at ? Date.parse(s.ended_at) : now, to);
  return Math.max(0, b - a);
}

/**
 * Each session's cost so far and its basis (LabSession.costGbp/costBasis):
 * the estimate, or (ended, and Azure has listed its last day for the lab,
 * which it can only do from the day after) the actual split by duration.
 */
export async function sessionCosts(env: Env, sessions: LabSessionRow[], now: number): Promise<Map<string, { gbp: number | null; basis: "estimate" | "actual" }>> {
  const out = new Map<string, { gbp: number | null; basis: "estimate" | "actual" }>();
  for (const s of sessions) out.set(s.id, { gbp: estimateSoFar(s, now), basis: "estimate" });
  const ended = sessions.filter((s) => s.ended_at && now >= dayStart(s.ended_at.slice(0, 10)) + DAY);
  if (!ended.length) return out;
  const labs = [...new Set(ended.map((s) => s.lab_id))];
  const from = Math.min(...ended.map((s) => dayStart(s.requested_at.slice(0, 10))));
  const to = Math.max(...ended.map((s) => dayStart(s.ended_at!.slice(0, 10)) + DAY));
  const marks = labs.map((_, i) => `?${i + 3}`).join(", ");
  const [days, all] = await Promise.all([
    env.DB.prepare(`SELECT lab_id, day, SUM(gbp) AS gbp FROM lab_cost_days WHERE day >= ?1 AND day < ?2 AND lab_id IN (${marks}) GROUP BY lab_id, day`)
      .bind(new Date(from).toISOString().slice(0, 10), new Date(to).toISOString().slice(0, 10), ...labs)
      .all<{ lab_id: string; day: string; gbp: number }>(),
    env.DB.prepare(`SELECT id, lab_id, requested_at, ended_at FROM lab_sessions WHERE requested_at < ?2 AND (ended_at IS NULL OR ended_at > ?1) AND lab_id IN (${marks})`)
      .bind(new Date(from).toISOString(), new Date(to).toISOString(), ...labs)
      .all<Pick<LabSessionRow, "id" | "lab_id" | "requested_at" | "ended_at">>(),
  ]);
  const gbpOf = new Map(days.results.map((d) => [`${d.lab_id}|${d.day}`, d.gbp]));
  for (const s of ended) {
    const endDay = s.ended_at!.slice(0, 10);
    if (!gbpOf.has(`${s.lab_id}|${endDay}`)) continue;
    let sum = 0;
    for (let d = dayStart(s.requested_at.slice(0, 10)); d <= dayStart(endDay); d += DAY) {
      const gbp = gbpOf.get(`${s.lab_id}|${new Date(d).toISOString().slice(0, 10)}`) ?? 0;
      const mine = overlap(s, d, d + DAY, now);
      const everyone = all.results.filter((x) => x.lab_id === s.lab_id).reduce((n, x) => n + overlap(x, d, d + DAY, now), 0);
      if (mine > 0 && everyone > 0) sum += (gbp * mine) / everyone;
    }
    out.set(s.id, { gbp: round(sum), basis: "actual" });
  }
  return out;
}

/** CostResponse.labs: this calendar month (UTC) per lab, Azure's actual plus what it has not billed yet (live sessions included), largest first. */
export async function labCostRows(env: Env, nowDate: Date): Promise<LabCostRow[]> {
  const now = nowDate.getTime();
  const month = nowDate.toISOString().slice(0, 7);
  const monthStart = Date.parse(`${month}-01T00:00:00Z`);
  const monthEnd = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1);
  const nextMonth = new Date(monthEnd).toISOString().slice(0, 10);
  const [days, sessions] = await Promise.all([
    env.DB.prepare("SELECT lab_id, SUM(gbp) AS gbp, MAX(day) AS last FROM lab_cost_days WHERE day >= ?1 AND day < ?2 GROUP BY lab_id").bind(`${month}-01`, nextMonth).all<{ lab_id: string; gbp: number; last: string }>(),
    env.DB.prepare(`SELECT *, state IN (${LIVE_SQL}) AS live FROM lab_sessions WHERE requested_at < ?2 AND (ended_at IS NULL OR ended_at >= ?1)`).bind(new Date(monthStart).toISOString(), new Date(monthEnd).toISOString()).all<LabSessionRow & { live: number }>(),
  ]);
  const rows = new Map<string, { actual: number | null; estimate: number | null; sessions: number; running: boolean; billedTo: number }>();
  const row = (lab: string) => {
    let r = rows.get(lab);
    if (!r) rows.set(lab, (r = { actual: null, estimate: null, sessions: 0, running: false, billedTo: monthStart }));
    return r;
  };
  for (const d of days.results) {
    const r = row(d.lab_id);
    r.actual = round(d.gbp);
    r.billedTo = dayStart(d.last) + DAY;
  }
  for (const s of sessions.results) {
    const r = row(s.lab_id);
    if (Date.parse(s.requested_at) >= monthStart) r.sessions++;
    if (s.live) r.running = true;
    // What Azure has not billed yet: from where its figures stop (or the session began) to now or the end.
    const from = Math.max(Date.parse(s.requested_at), monthStart, r.billedTo);
    const to = Math.min(s.ended_at ? Date.parse(s.ended_at) : now, monthEnd);
    if (to > from && s.est_gbp_h > 0) r.estimate = round((r.estimate ?? 0) + (s.est_gbp_h * (to - from)) / HOUR);
  }
  return [...rows.entries()]
    .map(([labId, r]) => ({ labId, title: labTitle(labId), actualGbp: r.actual, estimateGbp: r.estimate, totalGbp: round((r.actual ?? 0) + (r.estimate ?? 0)), sessions: r.sessions, running: r.running }))
    .sort((a, b) => b.totalGbp - a.totalGbp || a.title.localeCompare(b.title));
}
