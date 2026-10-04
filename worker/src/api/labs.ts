// api/labs.ts
//
// Plain English: the Labs tab's data API (labs spec §7.2 and plan ruling 7),
// under /api/v1 behind the login like every other route.
//
//   GET  /labs                      catalogue cards, live sessions, slots, permissions, orphans
//   GET  /labs/sessions?lab=&limit= history (registered before /labs/:id)
//   GET  /labs/coverage             per exam and skill area: labs available and run
//   GET  /labs/:id                  one lab: readme blocks, priced items, warnings, session, runs
//   GET  /labs/:id/secret           the admin password and lab user names, while running
//   POST /labs/:id/deploy | extend | destroy | peer | unpeer | test | cancel
//   PUT  /labs/sessions/:sid/note
//   POST /labs/repeer | /labs/permissions/check | /labs/orphans/cleanup
//
// Contract stubs (plan L0): every route checks its input exactly as the
// engine will (400 bad_input naming the field, an unknown key included) and
// answers the shapes in shared/api.ts from the catalogue, lab_slots, the
// settings and KV (`labs:permissions`, `labs:orphans`). Anything that would
// start a run or call Azure answers 501 not_implemented until the engine
// (plan L2) replaces it here.

import type { Context, Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import * as db from "../db";
import { fixedConfig } from "../settings";
import { getSnapshot } from "../state";
import { REGIONS } from "../region";
import { catalogue, labDef, labReadme } from "../labs/catalogue";
import { availability, cancelLab, deployLab, destroyLab, unavailableReason, type DeployInput } from "../labs/engine";
import { liveSessionOf } from "../labs/store";
import { releaseFields, releaseTests } from "../labs/cards";
import {
  LAB_HOURS_MAX,
  LAB_ID_MAX,
  LAB_ID_RE,
  LAB_NOTE_MAX,
  LAB_SLOTS,
  costMarker,
  estimateGbpH,
  labsSettingsFrom,
  type LabDef,
} from "../../../shared/labs";
import type { ApiOk, LabCard, LabCoverageResponse, LabDetail, LabOrphan, LabPermissions, LabSecretResponse, LabsResponse, LabSessionsResponse } from "../../../shared/api";

type C = Context<ApiEnv>;
const bad = (c: C, message: string, field?: string) => fail(c, 400, "bad_input", message, field);
const notFound = (c: C, what = "No such lab.") => fail(c, 404, "not_found", what);
const notYet = (c: C) => fail(c, 501, "not_implemented", "Labs are not built yet.");

// ── Input checks (kept by the engine) ────────────────────────────────────

type Check = (v: unknown) => boolean;
interface Field {
  check: Check;
  message: string;
  required?: boolean;
}

const wholeHours: Check = (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= LAB_HOURS_MAX;
const isBool: Check = (v) => typeof v === "boolean";

/**
 * The body as a plain object, or a refusal: a key not in `fields` names
 * itself; a missing required field or a wrong value names that field.
 * No body at all is {} (so only routes with required fields refuse it).
 */
async function readBody(c: C, fields: Record<string, Field>): Promise<{ ok: true; b: Record<string, unknown> } | { ok: false; res: Response }> {
  const b = ((await body<Record<string, unknown>>(c)) ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!Object.hasOwn(fields, k)) return { ok: false, res: bad(c, `${k} is not something this takes.`, k) };
  for (const [k, f] of Object.entries(fields)) {
    if (b[k] === undefined) {
      if (f.required) return { ok: false, res: bad(c, f.message, k) };
      continue;
    }
    if (!f.check(b[k])) return { ok: false, res: bad(c, f.message, k) };
  }
  return { ok: true, b };
}

const DEPLOY: Record<string, Field> = {
  hours: { check: wholeHours, message: `Session length is whole hours, 1 to ${LAB_HOURS_MAX}.`, required: true },
  peer: { check: isBool, message: "peer is true or false.", required: true },
  region: { check: (v) => typeof v === "string" && Object.hasOwn(REGIONS, v), message: "That is not a region on offer." },
  overBudgetOk: { check: isBool, message: "overBudgetOk is true or false." },
  capacityOk: { check: isBool, message: "capacityOk is true or false." },
};
const EXTEND: Record<string, Field> = {
  hours: { check: wholeHours, message: `Extend by whole hours, 1 to ${LAB_HOURS_MAX}.` },
  toMax: { check: (v) => v === true, message: "toMax is true, or leave it out." },
};
const DESTROY: Record<string, Field> = { confirm: { check: (v) => v === true, message: "Send confirm: true to tear the lab down.", required: true } };
const NOTE: Record<string, Field> = { note: { check: (v) => typeof v === "string" && v.length <= LAB_NOTE_MAX, message: `A note is text of at most ${LAB_NOTE_MAX} characters.`, required: true } };
const CLEANUP: Record<string, Field> = { lab_id: { check: (v) => typeof v === "string" && isLabId(v), message: "lab_id is a lab id such as az104-05-storage.", required: true } };
const NOTHING: Record<string, Field> = {};

const isLabId = (v: string) => v.length <= LAB_ID_MAX && LAB_ID_RE.test(v);

// ── Shapes ───────────────────────────────────────────────────────────────

/** A catalogue card with nothing run yet (the engine adds sessions, runs and release tests). */
function card(def: LabDef): LabCard {
  const estGbpH = estimateGbpH(def.cost.items);
  const pricey = def.cost.pricey ? def.cost.items.find((i) => i.name === def.cost.pricey) ?? null : null;
  return {
    id: def.id,
    number: def.number,
    version: def.version,
    title: def.title,
    summary: def.summary,
    exam: def.exam,
    skillAreas: def.skill_areas,
    level: def.level,
    type: def.type,
    prerequisites: def.prerequisites,
    peering: def.connectivity.peering,
    estGbpH,
    marker: costMarker(estGbpH, def.timing.deploy_min),
    pricey: pricey ? { item: pricey.name, gbpH: estimateGbpH([pricey]) } : null,
    timing: { deployMin: def.timing.deploy_min, destroyMin: def.timing.destroy_min, sessionH: def.timing.session_h, maxH: def.timing.max_h },
    running: null,
    lastSession: null,
    runs: 0,
    lastReleaseTest: null,
    released: false,
    unavailable: null,
  };
}

const NO_PERMISSIONS: LabPermissions = { checkedAt: null, role: null, users: null, groups: null, message: null };

async function kvJson<T>(c: C, key: string, fallback: T): Promise<T> {
  try {
    const v = await c.env.STATUS.get(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function registerLabs(api: Hono<ApiEnv>): void {
  api.get("/labs", async (c) => {
    const avail = await availability(c.env);
    const [stored, used, tests] = await Promise.all([
      db.allSettings(c.env),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL").first<{ n: number }>(),
      releaseTests(c.env),
    ]);
    const out: LabsResponse = {
      now: new Date().toISOString(),
      labs: catalogue().labs.map((d) => ({ ...card(d), ...releaseFields(d, tests), unavailable: unavailableReason(d, avail) })),
      running: [],
      slots: { used: Number(used?.n ?? 0), total: LAB_SLOTS },
      maxRunning: labsSettingsFrom(stored).labsMaxRunning,
      permissions: await kvJson(c, "labs:permissions", NO_PERMISSIONS),
      orphans: await kvJson<LabOrphan[]>(c, "labs:orphans", []),
    };
    return c.json(out);
  });

  api.get("/labs/sessions", async (c) => {
    const lab = c.req.query("lab");
    const limitText = c.req.query("limit");
    if (lab !== undefined && lab !== "" && !isLabId(lab)) return bad(c, "lab is a lab id such as az104-05-storage.", "lab");
    const limit = limitText === undefined || limitText === "" ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return bad(c, "limit is a whole number from 1 to 200.", "limit");
    const out: LabSessionsResponse = { sessions: [] };
    return c.json(out);
  });

  api.get("/labs/coverage", (c) => {
    const cat = catalogue();
    const exams = (["AZ-104", "AZ-305"] as const)
      .map((exam) => ({
        exam,
        areas: cat.skillAreas
          .filter((a) => a.exam === exam)
          .map((a) => {
            const labs = cat.labs.filter((l) => l.skill_areas.includes(a.key)).map((l) => ({ id: l.id, number: l.number, title: l.title, run: false }));
            return { key: a.key, name: a.name, labs, run: 0, available: labs.length };
          }),
      }))
      .filter((e) => e.areas.length > 0);
    const out: LabCoverageResponse = { exams };
    return c.json(out);
  });

  api.post("/labs/repeer", async (c) => {
    const r = await readBody(c, NOTHING);
    if (!r.ok) return r.res;
    const waiting = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM lab_sessions WHERE state IN ('deploying', 'running') AND peering IN ('waiting', 'disconnected')").first<{ n: number }>();
    if (Number(waiting?.n ?? 0) > 0) return notYet(c);
    const out: ApiOk = { ok: true, message: "No labs are waiting to peer." };
    return c.json(out);
  });

  api.post("/labs/permissions/check", async (c) => {
    const r = await readBody(c, NOTHING);
    if (!r.ok) return r.res;
    return notYet(c);
  });

  api.post("/labs/orphans/cleanup", async (c) => {
    const r = await readBody(c, CLEANUP);
    if (!r.ok) return r.res;
    return notYet(c);
  });

  api.put("/labs/sessions/:sid/note", async (c) => {
    const r = await readBody(c, NOTE);
    if (!r.ok) return r.res;
    const sid = c.req.param("sid");
    const row = await c.env.DB.prepare("SELECT id FROM lab_sessions WHERE id = ?1").bind(sid).first<{ id: string }>();
    if (!row) return notFound(c, "No such lab session.");
    await c.env.DB.prepare("UPDATE lab_sessions SET note = ?1 WHERE id = ?2").bind(String(r.b.note) || null, sid).run();
    const out: ApiOk = { ok: true, message: r.b.note ? "Note saved." : "Note cleared." };
    return c.json(out);
  });

  api.get("/labs/:id", async (c) => {
    const def = labDef(c.req.param("id"));
    if (!def) return notFound(c);
    const [cfg, stored, snap] = await Promise.all([fixedConfig(c.env), db.allSettings(c.env), getSnapshot(c.env)]);
    const peer = def.connectivity.peering === "required" ? true : def.connectivity.peering === "off" ? false : labsSettingsFrom(stored).labsDefaultPeering;
    const items = def.cost.items.map((i) => ({ ...i, gbpH: i.gbp_h, source: "authored" as const, priceAge: null }));
    const out: LabDetail = {
      card: card(def),
      readme: labReadme(def.id),
      cost: { items, gbpH: estimateGbpH(def.cost.items) },
      connectivity: def.connectivity,
      identity: def.identity,
      warnings: [],
      defaults: { region: cfg.region, peer, hours: def.timing.session_h },
      gatewayUp: snap.state === "running" || snap.state === "standby",
      session: null,
      runs: [],
      resources: null,
      portalUrl: null,
    };
    return c.json(out);
  });

  // The admin password and lab user names: only while the session is running, fetched on Show, never cached.
  api.get("/labs/:id/secret", async (c) => {
    const def = labDef(c.req.param("id"));
    if (!def) return notFound(c);
    const s = await liveSessionOf(c.env, def.id);
    const deploy = s?.state === "running" ? await c.env.DB.prepare("SELECT admin_password FROM lab_runs WHERE session_id = ?1 AND action = 'deploy' AND status = 'succeeded' ORDER BY requested_at DESC LIMIT 1").bind(s.id).first<{ admin_password: string | null }>() : null;
    if (!s || !deploy?.admin_password) return fail(c, 409, "not_running", `${def.title} is not running, so it has no password.`);
    let users: Record<string, string> = {};
    try {
      users = (JSON.parse(s.outputs_json ?? "{}") as { users?: Record<string, string> }).users ?? {};
    } catch {
      users = {};
    }
    const out: LabSecretResponse = { adminPassword: deploy.admin_password, users };
    return c.json(out);
  });

  // The actions: check the body, then the lab, then do it (RunError becomes the error answer, api/app.ts).
  type Handler = (c: C, def: LabDef, b: Record<string, unknown>) => Promise<Response>;
  const action = (path: string, fields: Record<string, Field>, extra?: ((b: Record<string, unknown>, c: C) => Response | null) | null, handle: Handler = async (c) => notYet(c)) =>
    api.post(`/labs/:id/${path}`, async (c) => {
      const r = await readBody(c, fields);
      if (!r.ok) return r.res;
      const more = extra?.(r.b, c);
      if (more) return more;
      const def = labDef(c.req.param("id"));
      if (!def) return notFound(c);
      return handle(c, def, r.b);
    });
  const done = (c: C, message: string, run?: { id: string; session_id: string }) => c.json({ ok: true, message, ...(run ? { runId: run.id, sessionId: run.session_id } : {}) });
  api.post("/labs/:id/deploy", async (c) => {
    const r = await readBody(c, DEPLOY);
    if (!r.ok) return r.res;
    const def = labDef(c.req.param("id"));
    if (!def) return notFound(c);
    const b = r.b as unknown as DeployInput;
    if (b.hours > def.timing.max_h) return bad(c, `${def.title} runs for at most ${def.timing.max_h} hours.`, "hours");
    const { session, run } = await deployLab(c.env, def.id, b, c.get("user"));
    return c.json({ ok: true, message: `Deploying ${def.title}.`, sessionId: session.id, runId: run.id });
  });
  action("extend", EXTEND, (b, c) => {
    if (b.hours !== undefined && b.toMax !== undefined) return bad(c, "Extend by hours or to the maximum, not both.", "toMax");
    if (b.hours === undefined && b.toMax === undefined) return bad(c, "Say how many hours, or toMax: true.", "hours");
    return null;
  });
  action("destroy", DESTROY, null, async (c, def) => done(c, `Tearing down ${def.title}.`, await destroyLab(c.env, def.id, "manual", c.get("user"))));
  action("peer", NOTHING);
  action("unpeer", NOTHING);
  action("test", NOTHING, null, async (c, def) => {
    const { run } = await deployLab(c.env, def.id, { hours: def.timing.session_h, peer: def.connectivity.peering !== "off" }, c.get("user"), true);
    return done(c, `Release test of ${def.title} v${def.version} started: deploy, check, tear down and verify clean.`, run);
  });
  action("cancel", NOTHING, null, async (c, def) => done(c, `Cancelled; tearing down ${def.title}.`, await cancelLab(c.env, def.id, c.get("user"))));
}
