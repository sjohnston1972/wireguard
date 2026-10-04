// prefs.test.ts
//
// Plain English: widget preferences in D1 (worker/src/prefs.ts): one row per
// user per page, a version that only ever rises, and a save that lands only
// on the version it was made from. Called directly here, below the API, so
// two identities and test-only widget lists can be used.
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import { getPrefs, putPrefs } from "../src/prefs";
import { REGISTRY, type Registry, type WidgetDef } from "../../shared/widgets";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const A = "steven@example.net";
const B = "someone@example.net";

async function row(env: Env, user: string, page: string) {
  return env.DB.prepare("SELECT user, page, json, version, updated_at FROM ui_prefs WHERE user = ?1 AND page = ?2").bind(user, page).first<{ user: string; page: string; json: string; version: number; updated_at: string }>();
}

describe("ui_prefs storage", () => {
  it("migration 0018 creates ui_prefs", async () => {
    const { env } = makeEnv();
    const cols = (await env.DB.prepare("PRAGMA table_info(ui_prefs)").all<{ name: string; type: string; notnull: number; pk: number }>()).results;
    expect(cols.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["user", "TEXT", 1, 1],
      ["page", "TEXT", 1, 2],
      ["json", "TEXT", 1, 0],
      ["version", "INTEGER", 1, 0],
      ["updated_at", "TEXT", 1, 0],
    ]);
    // Only the five widget pages.
    await expect(env.DB.prepare("INSERT INTO ui_prefs (user, page, json, version, updated_at) VALUES ('u', 'settings', '{}', 1, 'x')").run()).rejects.toThrow(/CHECK/);
  });

  it("a user with nothing saved has five pages at version 0", async () => {
    const { env } = makeEnv();
    const r = await getPrefs(env, A);
    expect(Object.keys(r.pages)).toEqual(["overview", "clients", "firewall", "activity", "cost"]);
    for (const p of Object.values(r.pages)) expect(p).toEqual({ version: 0, updatedAt: null, prefs: {} });
  });

  it("the first save inserts version 1, then each save adds one; the stored JSON is sparse", async () => {
    const { env } = makeEnv();
    const first = await putPrefs(env, A, "overview", 0, { widgets: { "overview.events": { v: 1, s: { rows: 7, detail: true } } } });
    expect(first).toEqual({ ok: true, page: { version: 1, updatedAt: expect.any(String), prefs: { widgets: { "overview.events": { v: 1, s: { rows: 7 } } } } } });
    const stored = await row(env, A, "overview");
    expect(JSON.parse(stored!.json)).toEqual({ widgets: { "overview.events": { v: 1, s: { rows: 7 } } } });
    expect(stored!.version).toBe(1);
    // An integer in D1, not 1.0 (a JS number bound as REAL would read back as a float there).
    expect(Number.isInteger(stored!.version)).toBe(true);
    const second = await putPrefs(env, A, "overview", 1, { layout: { hidden: ["overview.notes"] } });
    expect(second.ok && second.page.version).toBe(2);
    expect((await getPrefs(env, A)).pages.overview).toEqual({ version: 2, updatedAt: expect.any(String), prefs: { layout: { hidden: ["overview.notes"] } } });
  });

  it("a stale baseVersion changes nothing", async () => {
    const { env } = makeEnv();
    await putPrefs(env, A, "cost", 0, { layout: { hidden: ["cost.insights"] } });
    const before = await row(env, A, "cost");
    expect(await putPrefs(env, A, "cost", 0, { layout: { hidden: ["cost.forecast"] } })).toEqual({ ok: false, status: 409, code: "stale", message: "Changed on another device. Showing the latest." });
    expect(await putPrefs(env, A, "cost", 7, {})).toMatchObject({ ok: false, status: 409, code: "stale" });
    expect(await row(env, A, "cost")).toEqual(before);
  });

  it("reset writes {} and the version still rises", async () => {
    const { env } = makeEnv();
    await putPrefs(env, A, "firewall", 0, { layout: { hidden: ["firewall.zones"] } });
    const r = await putPrefs(env, A, "firewall", 1, {});
    expect(r).toMatchObject({ ok: true, page: { version: 2, prefs: {} } });
    expect(await row(env, A, "firewall")).toMatchObject({ json: "{}", version: 2 });
  });

  it("prefs are per user", async () => {
    const { env } = makeEnv();
    await putPrefs(env, A, "overview", 0, { layout: { hidden: ["overview.topology"] } });
    expect((await getPrefs(env, B)).pages.overview).toEqual({ version: 0, updatedAt: null, prefs: {} });
    // B's first save is B's own version 1, and does not touch A's.
    expect(await putPrefs(env, B, "overview", 0, { layout: { hidden: ["overview.notes"] } })).toMatchObject({ ok: true, page: { version: 1 } });
    expect((await getPrefs(env, A)).pages.overview.prefs).toEqual({ layout: { hidden: ["overview.topology"] } });
    expect((await getPrefs(env, B)).pages.overview.prefs).toEqual({ layout: { hidden: ["overview.notes"] } });
  });

  it("refuses with the field, outdated entries as 409", async () => {
    const { env } = makeEnv();
    expect(await putPrefs(env, A, "overview", 0, { widgets: { "overview.events": { v: 1, s: { rows: 11 } } } })).toEqual({ ok: false, status: 400, code: "bad_input", message: "Rows must be 3 to 10.", field: "widgets.overview.events.rows" });
    const v2: Registry = { ...REGISTRY, widgets: REGISTRY.widgets.map((w) => (w.id === "overview.events" ? { ...w, version: 2 } : w)) };
    expect(await putPrefs(env, A, "overview", 0, { widgets: { "overview.events": { v: 1, s: {} } } }, v2)).toEqual({
      ok: false,
      status: 409,
      code: "outdated",
      message: "This tab is running an older dashboard. Reload to change widget settings.",
      field: "widgets.overview.events.v",
    });
    expect(await putPrefs(env, A, "overview", -1, {})).toMatchObject({ ok: false, status: 400, field: "baseVersion" });
    expect(await putPrefs(env, A, "overview", 1.5, {})).toMatchObject({ ok: false, status: 400, field: "baseVersion" });
    expect(await row(env, A, "overview")).toBeNull();
  });

  it("a normalised page over 8 KiB is 400", async () => {
    const { env } = makeEnv();
    // A test-only widget whose one setting can hold more than 8 KiB of valid choices.
    const options = Array.from({ length: 400 }, (_, i) => ({ value: `choice-number-${String(i).padStart(4, "0")}`, label: `Choice ${i}` }));
    const big: WidgetDef = { id: "cost.big", page: "cost", title: "Big", version: 1, settings: [{ kind: "multi", key: "pick", label: "Pick", section: "data", options, minSelected: 0, default: [] }] };
    const reg: Registry = { widgets: [big], layouts: { cost: { page: "cost", rows: [{ id: "r1", items: [{ widget: "cost.big", weight: 1 }] }] } } };
    const many = options.map((x) => x.value);
    expect(JSON.stringify({ widgets: { "cost.big": { v: 1, s: { pick: many } } } }).length).toBeGreaterThan(8 * 1024);
    expect(await putPrefs(env, A, "cost", 0, { widgets: { "cost.big": { v: 1, s: { pick: many } } } }, reg)).toEqual({ ok: false, status: 400, code: "bad_input", message: expect.stringMatching(/8 KiB/), field: "prefs" });
    expect(await putPrefs(env, A, "cost", 0, { widgets: { "cost.big": { v: 1, s: { pick: many.slice(0, 10) } } } }, reg)).toMatchObject({ ok: true });
  });

  it("GET normalises a stored entry after a schema bump", async () => {
    const { env } = makeEnv();
    // Rows written by an older dashboard: an entry at a version with no migration, an unknown widget, a hidden pinned widget.
    const old = { layout: { hidden: ["overview.status", "overview.notes"] }, widgets: { "overview.events": { v: 0, s: { rows: 7 } }, "overview.gone": { v: 1, s: {} }, "overview.health": { v: 1, s: { ages: false } } } };
    await env.DB.prepare("INSERT INTO ui_prefs (user, page, json, version, updated_at) VALUES (?1, 'overview', ?2, 4, '2026-10-01T00:00:00.000Z')").bind(A, JSON.stringify(old)).run();
    await env.DB.prepare("INSERT INTO ui_prefs (user, page, json, version, updated_at) VALUES (?1, 'cost', 'not json', 2, '2026-10-01T00:00:00.000Z')").bind(A).run();
    const r = await getPrefs(env, A);
    expect(r.pages.overview).toEqual({ version: 4, updatedAt: "2026-10-01T00:00:00.000Z", prefs: { layout: { hidden: ["overview.notes"] }, widgets: { "overview.health": { v: 1, s: { ages: false } } } } });
    expect(r.pages.cost).toEqual({ version: 2, updatedAt: "2026-10-01T00:00:00.000Z", prefs: {} });
  });
});
