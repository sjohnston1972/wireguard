// labs/cards.ts
//
// Plain English: what each catalogue card says beyond lab.yaml (labs spec
// §10, §11.2): £/h now (fresh list prices where the lab has them), its live
// session, its last session, how often it has been run (sessions of 15
// minutes or more: "Ran 2×"), its newest release test and whether the
// current version has passed one ("Untested v2" until it has), why Deploy
// is unavailable and every blocker (labs redesign spec §6.1: availability's,
// then leftovers, then a full budget, the checks deployLab makes before its
// confirmation), and the catalogue's learning content and planned resources
// (§6.2). Everything is read once per request from D1 and KV.

import type { Env } from "../env";
import { effectiveConfig } from "../settings";
import { getSnapshot } from "../state";
import { budgetStatus } from "../budget";
import type { PriceRow } from "../insights/price";
import type { LabBlocker, LabCard, LabReleaseTest, LabSession } from "../../../shared/api";
import { LAB_COVERAGE_MIN, costMarker, estimateGbpH, type LabDef } from "../../../shared/labs";
import { availability, blockersOf, leftoversMessage, unavailableReason, type Availability } from "./availability";
import { catalogue } from "./catalogue";
import { readOrphans } from "./orphans";
import { budgetFull, budgetFullMessage } from "./warnings";
import { gbpHFrom, readLabPrices, retailPrice } from "./prices";
import { sessionCosts } from "./cost";
import { activeRuns, liveSessions, type LabRunDb, type LabSessionRow } from "./store";
import { labSession } from "./view";

interface TestRow {
  lab_id: string;
  version: number;
  at: string;
  run_id: string;
  result: string;
  deploy_seconds: number | null;
  destroy_seconds: number | null;
  est_gbp: number | null;
  leftovers_json: string | null;
}

function testOf(r: TestRow): LabReleaseTest {
  let leftovers: string[] = [];
  try {
    const v = JSON.parse(r.leftovers_json ?? "[]");
    if (Array.isArray(v)) leftovers = v.filter((x): x is string => typeof x === "string");
  } catch {
    leftovers = [];
  }
  return {
    labId: r.lab_id,
    version: r.version,
    at: r.at,
    runId: r.run_id,
    result: r.result === "pass" ? "pass" : "fail",
    clean: leftovers.length === 0 && r.result === "pass",
    deploySeconds: r.deploy_seconds,
    destroySeconds: r.destroy_seconds,
    estGbp: r.est_gbp,
    leftovers,
  };
}

/** Every lab's release tests, newest first. */
export async function releaseTests(env: Env): Promise<LabReleaseTest[]> {
  return (await env.DB.prepare("SELECT * FROM lab_release_tests ORDER BY at DESC").all<TestRow>()).results.map(testOf);
}

/** The card's release-test fields: the newest test, and whether the current version's newest test passed. */
export function releaseFields(def: LabDef, tests: LabReleaseTest[]): Pick<LabCard, "lastReleaseTest" | "released"> {
  const mine = tests.filter((t) => t.labId === def.id);
  const current = mine.find((t) => t.version === def.version);
  return { lastReleaseTest: mine[0] ?? null, released: current?.result === "pass" };
}

/** "Ran 2×": a session counts once it was ready for LAB_COVERAGE_MIN minutes or more (to its end, or now). */
export const RAN_SQL = `ready_at IS NOT NULL AND (julianday(COALESCE(ended_at, ?1)) - julianday(ready_at)) * 1440 >= ${LAB_COVERAGE_MIN} - 0.001`;

export interface CardContext {
  now: number;
  region: string;
  prices: PriceRow[];
  tests: LabReleaseTest[];
  avail: Availability;
  live: LabSessionRow[];
  runs: LabRunDb[];
  last: Map<string, LabSessionRow>;
  ran: Map<string, number>;
  costs: Map<string, { gbp: number | null; basis: "estimate" | "actual" }>;
  /** Labs with an ended_dirty session still holding a slot (deployLab refuses them). */
  dirty: Set<string>;
  /** Labs with an entry in KV labs:orphans (deployLab refuses them). */
  orphanIds: Set<string>;
  /** The full-budget sentence when the month is at or over budget; null otherwise, or when the budget could not be read. */
  budgetFull: string | null;
}

/** budgetFullMessage when the month is at or over budget; null under it, with no budget, or when it cannot be read (ruling 17: the deploy route re-checks). */
async function budgetBlocker(env: Env, cfg: Awaited<ReturnType<typeof effectiveConfig>>, now: number): Promise<string | null> {
  try {
    const b = await budgetStatus(env, cfg, await getSnapshot(env), new Date(now));
    return budgetFull(b) ? budgetFullMessage(b) : null;
  } catch {
    return null;
  }
}

/** Read everything the cards need, once. */
export async function cardContext(env: Env, now = Date.now()): Promise<CardContext> {
  const nowIso = new Date(now).toISOString();
  const cfg = await effectiveConfig(env);
  const [prices, tests, avail, live, runs, last, ran, dirty, orphans, budgetFull] = await Promise.all([
    readLabPrices(env, cfg.region),
    releaseTests(env),
    availability(env),
    liveSessions(env),
    activeRuns(env),
    env.DB.prepare(
      "SELECT * FROM lab_sessions s WHERE state IN ('ended', 'ended_dirty') AND requested_at = (SELECT MAX(requested_at) FROM lab_sessions x WHERE x.lab_id = s.lab_id AND x.state IN ('ended', 'ended_dirty'))",
    ).all<LabSessionRow>(),
    env.DB.prepare(`SELECT lab_id, COUNT(*) AS n FROM lab_sessions WHERE ${RAN_SQL} GROUP BY lab_id`).bind(nowIso).all<{ lab_id: string; n: number }>(),
    env.DB.prepare("SELECT DISTINCT lab_id FROM lab_sessions WHERE state = 'ended_dirty' AND slot IS NOT NULL").all<{ lab_id: string }>(),
    readOrphans(env),
    budgetBlocker(env, cfg, now),
  ]);
  const costs = await sessionCosts(env, [...live, ...last.results], now);
  return {
    now,
    region: cfg.region,
    prices,
    tests,
    avail,
    live,
    runs,
    last: new Map(last.results.map((s) => [s.lab_id, s])),
    ran: new Map(ran.results.map((r) => [r.lab_id, Number(r.n)])),
    costs,
    dirty: new Set(dirty.results.map((r) => r.lab_id)),
    orphanIds: new Set(orphans.map((o) => o.labId).filter((id): id is string => typeof id === "string")),
    budgetFull,
  };
}

/** A session with its cost, for the screens. */
export function sessionView(s: LabSessionRow, ctx: Pick<CardContext, "runs" | "costs" | "now">): LabSession {
  return labSession(s, ctx.runs.find((r) => r.session_id === s.id) ?? null, ctx.now, ctx.costs.get(s.id));
}

/** Every reason deployLab would refuse this lab before its confirmation, in its order (spec §6.1). */
export function cardBlockers(def: LabDef, ctx: Pick<CardContext, "avail" | "dirty" | "orphanIds" | "budgetFull">): LabBlocker[] {
  const out = blockersOf(def, ctx.avail);
  if (ctx.dirty.has(def.id) || ctx.orphanIds.has(def.id)) out.push({ kind: "leftovers", message: leftoversMessage(def) });
  if (ctx.budgetFull) out.push({ kind: "budget", message: ctx.budgetFull });
  return out;
}

/** The card's learning content (camelCase) and planned resources from the catalogue; null when it has none. */
export function catalogueExtras(id: string): Pick<LabCard, "learning" | "resources"> {
  const cat = catalogue();
  const l = cat.learning?.[id];
  return {
    learning: l ? { objective: l.objective, learn: [l.learn[0], l.learn[1], l.learn[2]], learningMin: l.learning_min } : null,
    resources: cat.resources?.[id] ? { ...cat.resources[id] } : null,
  };
}

/** One catalogue card. */
export function labCard(def: LabDef, ctx: CardContext): LabCard {
  const now = new Date(ctx.now);
  const estGbpH = gbpHFrom(def, ctx.prices, ctx.region, now);
  const pricey = def.cost.pricey ? def.cost.items.find((i) => i.name === def.cost.pricey) ?? null : null;
  const live = ctx.live.find((s) => s.lab_id === def.id) ?? null;
  const last = ctx.last.get(def.id) ?? null;
  return {
    id: def.id,
    number: def.number,
    version: def.version,
    title: def.title,
    summary: def.summary,
    exam: def.exam,
    exams: def.exams,
    skillAreas: def.skill_areas,
    level: def.level,
    type: def.type,
    prerequisites: def.prerequisites,
    peering: def.connectivity.peering,
    estGbpH,
    marker: costMarker(estGbpH, def.timing.deploy_min),
    pricey: pricey ? { item: pricey.name, gbpH: estimateGbpH([pricey], (i) => retailPrice(i, ctx.prices, ctx.region, now, def.regions.secondary)?.gbpH ?? null) } : null,
    timing: { deployMin: def.timing.deploy_min, destroyMin: def.timing.destroy_min, sessionH: def.timing.session_h, maxH: def.timing.max_h },
    running: live ? sessionView(live, ctx) : null,
    lastSession: last ? sessionView(last, ctx) : null,
    runs: ctx.ran.get(def.id) ?? 0,
    ...releaseFields(def, ctx.tests),
    unavailable: unavailableReason(def, ctx.avail),
    blockers: cardBlockers(def, ctx),
    ...catalogueExtras(def.id),
  };
}
