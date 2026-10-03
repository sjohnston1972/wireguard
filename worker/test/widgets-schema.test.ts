// widgets-schema.test.ts
//
// Plain English: the widget registry (shared/widgets.ts) that both the app
// and the Worker read. Every widget the spec lists exists with its settings
// and defaults; the lenient reader (normalise) repairs what an older or
// newer dashboard saved; the strict checker (validate) refuses anything it
// would have to repair, naming the field.
import { describe, it, expect } from "vitest";
import {
  WIDGETS,
  LAYOUTS,
  PAGE_IDS,
  REGISTRY,
  widgetDef,
  widgetDefaults,
  pageWidgets,
  rowItemKeys,
  normalisePagePrefs,
  validatePagePrefs,
  thresholdTone,
  EVENT_TYPES,
  AUDIT_KIND_OPTIONS,
  CAPTURE_IFACE_OPTIONS,
  MAX_PREFS_BODY_BYTES,
  MAX_PAGE_PREFS_BYTES,
  type PageId,
  type Registry,
  type WidgetDef,
} from "../../shared/widgets";
import type { PagePrefs } from "../../shared/api";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_KINDS, type EventType } from "../src/activity";
import { CAPTURE_IFACES } from "../src/firewall";

/** Every widget id a page layout names, stacks and nested rows included. */
function layoutWidgetIds(page: PageId): string[] {
  const out: string[] = [];
  for (const row of LAYOUTS[page].rows)
    for (const it of row.items) {
      if ("widget" in it) out.push(it.widget);
      else for (const m of it.widgets) if (m.includes(".")) out.push(m);
    }
  return out;
}

describe("the catalogue (spec section 8)", () => {
  it("has 37 widgets: Overview 10, Clients 5, Firewall 7, Activity 7, Cost 8; four pinned", () => {
    expect(WIDGETS).toHaveLength(37);
    const count = (p: PageId) => WIDGETS.filter((w) => w.page === p).length;
    expect(PAGE_IDS.map(count)).toEqual([10, 5, 7, 7, 8]);
    expect(WIDGETS.filter((w) => w.pinned).map((w) => w.id).sort()).toEqual(["activity.list", "clients.table", "firewall.rules", "overview.status"]);
    // Every widget is at version 1 but Spend breakdown (its percentages changed meaning: version 2).
    expect(WIDGETS.filter((w) => w.version !== 1).map((w) => [w.id, w.version])).toEqual([["cost.breakdown", 2]]);
  });

  it("cost.breakdown v2: percentages default on (today's share column); a v1 entry keeps its group by and loses percentages", () => {
    expect(widgetDefaults("cost.breakdown")).toEqual({ groupBy: "auto", percentages: true });
    // v1's percentages added a second share beside the amount; v2's on is today's legend, so neither v1 value carries over.
    expect(normalisePagePrefs("cost", { widgets: { "cost.breakdown": { v: 1, s: { groupBy: "region", percentages: true } } } })).toEqual({ widgets: { "cost.breakdown": { v: 2, s: { groupBy: "region" } } } });
    expect(normalisePagePrefs("cost", { widgets: { "cost.breakdown": { v: 1, s: { percentages: false } } } })).toEqual({});
    expect(normalisePagePrefs("cost", { widgets: { "cost.breakdown": { v: 2, s: { percentages: false } } } })).toEqual({ widgets: { "cost.breakdown": { v: 2, s: { percentages: false } } } });
    expect(validatePagePrefs("cost", { widgets: { "cost.breakdown": { v: 1, s: { groupBy: "region" } } } })).toMatchObject({ field: "widgets.cost.breakdown.v", outdated: true });
  });

  it("every shots prefs fixture (scripts/shots-prefs) is valid for the current schema", () => {
    const dir = fileURLToPath(new URL("../../scripts/shots-prefs/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const all = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, PagePrefs>;
      for (const [page, prefs] of Object.entries(all)) {
        expect(PAGE_IDS, `${f}: ${page}`).toContain(page);
        expect(validatePagePrefs(page as PageId, prefs), `${f}: ${page}`).toBeNull();
      }
    }
  });

  it("money thresholds step in pennies: a session's cost (Cost per session, Overview's cost impact) takes £0.07", () => {
    const pennies = { warn: 0.07, bad: 0.13 };
    expect(validatePagePrefs("cost", { widgets: { "cost.perSession": { v: 1, s: { session: pennies } } } })).toBeNull();
    expect(validatePagePrefs("overview", { widgets: { "overview.costImpact": { v: 1, s: { session: pennies } } } })).toBeNull();
    // Still refused below a penny.
    expect(validatePagePrefs("cost", { widgets: { "cost.perSession": { v: 1, s: { session: { warn: 0.075, bad: null } } } } })).toMatchObject({ field: "widgets.cost.perSession.session.warn" });
  });

  it("every widget id is page.camelCase, unique, and appears once in its page layout", () => {
    const ids = WIDGETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of WIDGETS) {
      expect(w.id, w.id).toMatch(/^(overview|clients|firewall|activity|cost)\.[a-z][A-Za-z0-9]*$/);
      expect(w.id.split(".")[0], w.id).toBe(w.page);
    }
    for (const p of PAGE_IDS) {
      const inLayout = layoutWidgetIds(p);
      expect(new Set(inLayout).size, p).toBe(inLayout.length);
      expect([...inLayout].sort(), p).toEqual(WIDGETS.filter((w) => w.page === p).map((w) => w.id).sort());
    }
  });

  it("lays out each page's rows with today's weights", () => {
    const shape = (p: PageId) =>
      LAYOUTS[p].rows.map((r) => ({
        id: r.id,
        ...(r.in ? { in: r.in } : {}),
        items: r.items.map((i) => ("widget" in i ? `${i.widget}:${i.weight}` : `${i.stack}[${i.widgets.join(",")}]:${i.weight}`)),
      }));
    expect(shape("overview")).toEqual([
      { id: "r1", items: ["overview.status:1"] },
      { id: "r2", items: ["overview.topology:1", "overview.keyMetrics:1"] },
      { id: "r3", items: ["overview.run:41", "overview.traffic:45", "side[overview.events,overview.speedTest]:32"] },
      { id: "r4", items: ["overview.health:54", "overview.costImpact:32", "overview.notes:32"] },
    ]);
    expect(shape("clients")).toEqual([
      { id: "r1", items: ["clients.kpis:1"] },
      { id: "r2", items: ["clients.table:1"] },
      { id: "r3", items: ["clients.talkers:1", "clients.statusDonut:1", "clients.sessionTraffic:1"] },
    ]);
    expect(shape("firewall")).toEqual([
      { id: "r1", items: ["firewall.kpis:1"] },
      { id: "r2", items: ["left[firewall.rules,bottom]:9", "right[firewall.drops,firewall.ports,firewall.capture]:3"] },
      { id: "bottom", in: "left", items: ["firewall.zones:1", "firewall.simulator:1"] },
    ]);
    expect(shape("activity")).toEqual([
      { id: "r1", items: ["activity.kpis:1"] },
      { id: "r2", items: ["left[activity.timeline,activity.list]:8", "right[activity.stream,activity.changeLog]:4"] },
      { id: "r3", items: ["activity.runDetails:3", "activity.liveOutput:2"] },
    ]);
    expect(shape("cost")).toEqual([
      { id: "r1", items: ["cost.kpis:1"] },
      { id: "r2", items: ["cost.spend:5", "cost.breakdown:4", "cost.forecast:3"] },
      { id: "r3", items: ["cost.split:4", "cost.perSession:4", "cost.insights:4"] },
      { id: "r4", items: ["cost.sessions:1"] },
    ]);
    expect(rowItemKeys("overview", "r3")).toEqual(["overview.run", "overview.traffic", "side"]);
    expect(pageWidgets("cost").map((w) => w.id)).toEqual(["cost.kpis", "cost.spend", "cost.breakdown", "cost.forecast", "cost.split", "cost.perSession", "cost.insights", "cost.sessions"]);
  });

  it("every setting key is unique within its widget, and every default validates", () => {
    for (const w of WIDGETS) {
      const keys = w.settings.map((s) => s.key);
      expect(new Set(keys).size, w.id).toBe(keys.length);
      const all: PagePrefs = { widgets: { [w.id]: { v: w.version, s: widgetDefaults(w.id) } } };
      expect(validatePagePrefs(w.page, all), w.id).toBeNull();
      // A default equals no setting at all: nothing is stored.
      expect(normalisePagePrefs(w.page, all), w.id).toEqual({});
    }
  });

  it("states today's defaults (a sample from each page; each area asserts its own in full)", () => {
    expect(widgetDefaults("overview.keyMetrics")).toEqual({
      range: "live",
      tiles: ["endpoint", "clients", "latency", "dns", "heartbeat", "sessionCost", "availability"],
      charts: true,
      subLines: true,
      availability: { warn: 99, bad: 90 },
      dnsUp: { warn: 100, bad: null },
      latency: { warn: null, bad: null },
    });
    expect(widgetDefaults("overview.events")).toMatchObject({ rows: 5, range: "24h", types: ["deploy", "destroy", "failure", "config", "firewall", "watchman"], detail: true });
    expect(widgetDefaults("clients.table")).toMatchObject({ filter: "all", sort: "nameAsc", columns: ["address", "handshake", "latency", "traffic", "allowedIps", "expires"], density: "comfortable" });
    expect(widgetDefaults("firewall.simulator")).toEqual({ from: "clients", to: "home", proto: "tcp", port: 22 });
    expect(widgetDefaults("firewall.capture")).toEqual({ iface: "wg0", seconds: 30, recent: 5 });
    expect(widgetDefaults("activity.kpis")).toMatchObject({ successRate: { warn: 90, bad: 70 }, failedRuns: { warn: null, bad: 1 }, watchman: { warn: 1, bad: null } });
    expect(widgetDefaults("activity.liveOutput")).toEqual({ lines: 60, wrap: false, timestamps: true, levelTags: true });
    expect(widgetDefaults("cost.kpis")).toMatchObject({ budgetUsed: { warn: 80, bad: 100 } });
    expect(widgetDefaults("cost.forecast")).toEqual({ chart: true, forecast: { warn: null, bad: 100 } });
    expect(widgetDefaults("cost.insights")).toEqual({});
    expect(() => widgetDefaults("overview.nope")).toThrow(/No widget overview\.nope/);
  });

  it("change kind options match AUDIT_KINDS (All is 'all', since a select cannot hold an empty value)", () => {
    expect(AUDIT_KIND_OPTIONS).toEqual(AUDIT_KINDS.map((k) => ({ value: k.value || "all", label: k.label })));
    const kind = widgetDef("activity.changeLog")!.settings.find((s) => s.key === "kind")!;
    expect(kind.kind === "enum" && kind.options).toEqual(AUDIT_KIND_OPTIONS);
  });

  it("capture interfaces match CAPTURE_IFACES", () => {
    expect(CAPTURE_IFACE_OPTIONS.map((o) => o.value)).toEqual(Object.keys(CAPTURE_IFACES));
    expect(CAPTURE_IFACE_OPTIONS.map((o) => o.label)).toEqual(Object.keys(CAPTURE_IFACES));
  });

  it("event types match EventType", () => {
    // A Record over EventType: the type checker fails this file if a type is added or removed.
    const every: Record<EventType, true> = { deploy: true, destroy: true, failure: true, config: true, firewall: true, watchman: true };
    expect(EVENT_TYPES.map((e) => e.value)).toEqual(Object.keys(every));
    expect(EVENT_TYPES.map((e) => e.label)).toEqual(["Deploy", "Tear down", "Failure", "Config", "Firewall", "Watchman"]);
  });
});

describe("normalisePagePrefs (lenient: every read, on both sides)", () => {
  it("answers {} for anything that is not preferences", () => {
    for (const raw of [null, undefined, 3, "x", [], [1]]) expect(normalisePagePrefs("overview", raw)).toEqual({});
  });

  it("normalise drops unknown keys and invalid values", () => {
    const raw = {
      junk: 1,
      layout: { order: { r3: ["overview.traffic", "overview.run", "side"], r9: ["x"], r1: ["overview.status"] }, hidden: ["overview.notes", "overview.nope", "cost.spend", "overview.notes", 7], extra: true },
      widgets: {
        "overview.keyMetrics": { v: 1, s: { range: "24h", tiles: ["latency", "endpoint", "latency", "bogus"], charts: "yes", wat: 1, availability: { warn: 98, bad: 99 } } },
        "overview.events": { v: 1, s: { rows: 7, range: "2h", types: [] } },
        "overview.speedTest": { v: 1, s: { shown: 3 } },
        "overview.nope": { v: 1, s: { a: 1 } },
        "cost.spend": { v: 1, s: { legend: false } },
        "overview.notes": "garbage",
      },
    };
    expect(normalisePagePrefs("overview", raw)).toEqual({
      layout: { order: { r3: ["overview.traffic", "overview.run", "side"] }, hidden: ["overview.notes"] },
      widgets: {
        // Unknown values out, duplicates out, multi in the options' order; a bad threshold pair falls back.
        "overview.keyMetrics": { v: 1, s: { range: "24h", tiles: ["endpoint", "latency"] } },
        "overview.events": { v: 1, s: { rows: 7 } },
      },
    });
  });

  it("normalise drops an entry whose version has no migration", () => {
    const raw = { widgets: { "overview.events": { v: 0, s: { rows: 7 } }, "overview.notes": { v: 2, s: { times: false } }, "overview.health": { v: 1, s: { ages: false } } } };
    expect(normalisePagePrefs("overview", raw)).toEqual({ widgets: { "overview.health": { v: 1, s: { ages: false } } } });
  });

  it("normalise runs migrate from v1 to v2 (a test-only def)", () => {
    const v2: WidgetDef = {
      id: "overview.events",
      page: "overview",
      title: "Recent events",
      version: 2,
      settings: [{ kind: "number", key: "count", label: "Rows", section: "data", min: 3, max: 10, step: 1, default: 5 }],
      migrate: (from, s) => (from === 1 ? { count: s.rows } : null),
    };
    const reg: Registry = { widgets: [v2], layouts: { overview: { page: "overview", rows: [{ id: "r1", items: [{ widget: "overview.events", weight: 1 }] }] } } };
    expect(normalisePagePrefs("overview", { widgets: { "overview.events": { v: 1, s: { rows: 8 } } } }, reg)).toEqual({ widgets: { "overview.events": { v: 2, s: { count: 8 } } } });
    // A migration that gives up, or throws, drops the entry.
    expect(normalisePagePrefs("overview", { widgets: { "overview.events": { v: 0, s: { rows: 8 } } } }, reg)).toEqual({});
    const throwing: Registry = { ...reg, widgets: [{ ...v2, migrate: () => { throw new Error("boom"); } }] };
    expect(normalisePagePrefs("overview", { widgets: { "overview.events": { v: 1, s: { rows: 8 } } } }, throwing)).toEqual({});
    // What a migration answers is checked like anything else read.
    expect(normalisePagePrefs("overview", { widgets: { "overview.events": { v: 1, s: { rows: 99 } } } }, reg)).toEqual({});
  });

  it("normalise inserts a new widget missing from a stored order at its declared index and removes pinned ids from hidden", () => {
    // Stored before notes existed, and before costImpact: both come back at their declared places.
    expect(normalisePagePrefs("overview", { layout: { order: { r4: ["overview.health"] } } })).toEqual({});
    // Traffic is declared second, so it goes back second.
    expect(normalisePagePrefs("overview", { layout: { order: { r3: ["side", "overview.run"] } } })).toEqual({ layout: { order: { r3: ["side", "overview.traffic", "overview.run"] } } });
    // Run missing (declared first) goes back first; the result is the default order, so nothing is kept.
    expect(normalisePagePrefs("overview", { layout: { order: { r3: ["overview.traffic", "side"] } } })).toEqual({});
    expect(normalisePagePrefs("overview", { layout: { order: { r4: ["overview.notes", "overview.health"] } } })).toEqual({ layout: { order: { r4: ["overview.notes", "overview.costImpact", "overview.health"] } } });
    expect(normalisePagePrefs("overview", { layout: { hidden: ["overview.status", "overview.topology"] } })).toEqual({ layout: { hidden: ["overview.topology"] } });
    // Hidden comes back in the page's own order, whatever order it was saved in.
    expect(normalisePagePrefs("cost", { layout: { hidden: ["cost.insights", "cost.spend"] } })).toEqual({ layout: { hidden: ["cost.spend", "cost.insights"] } });
  });

  it("the order of a one-item row, or the default order, is not kept", () => {
    expect(normalisePagePrefs("cost", { layout: { order: { r1: ["cost.kpis"], r2: ["cost.spend", "cost.breakdown", "cost.forecast"] } } })).toEqual({});
  });
});

describe("validatePagePrefs (strict: every save)", () => {
  const ok = (page: PageId, prefs: unknown) => expect(validatePagePrefs(page, prefs)).toBeNull();
  it("accepts real preferences", () => {
    ok("overview", {});
    ok("overview", {
      layout: { order: { r3: ["side", "overview.traffic", "overview.run"], r2: ["overview.keyMetrics", "overview.topology"] }, hidden: ["overview.speedTest", "overview.events"] },
      widgets: {
        "overview.keyMetrics": { v: 1, s: { range: "7d", tiles: ["latency"], availability: { warn: 99.5, bad: null }, latency: { warn: 50, bad: 120 } } },
        "overview.costImpact": { v: 1, s: { sessions: 30, session: { warn: 1.5, bad: 2 } } },
      },
    });
    ok("firewall", { layout: { order: { bottom: ["firewall.simulator", "firewall.zones"] } }, widgets: { "firewall.capture": { v: 1, s: { seconds: 300, iface: "any" } } } });
    ok("clients", { widgets: { "clients.table": { v: 1, s: { columns: [] } } } });
  });

  // Spec section 6.3, one row per refusal: the page, the body, the field named, and part of the message.
  const refusals: [string, PageId, unknown, string, RegExp][] = [
    ["not an object", "overview", [], "prefs", /object/],
    ["an unknown top-level key", "overview", { theme: "dark" }, "theme", /Unknown/],
    ["an unknown layout key", "overview", { layout: { sizes: {} } }, "layout.sizes", /Unknown/],
    ["layout not an object", "overview", { layout: [] }, "layout", /object/],
    ["widgets not an object", "overview", { widgets: [] }, "widgets", /object/],
    ["a widget id not on that page", "overview", { widgets: { "cost.spend": { v: 1, s: {} } } }, "widgets.cost.spend", /No widget cost\.spend on the Overview page/],
    ["an entry that is not {v, s}", "overview", { widgets: { "overview.events": { v: 1, s: {}, x: 1 } } }, "widgets.overview.events", /\{ v, s \}/],
    ["a version from a newer dashboard", "overview", { widgets: { "overview.events": { v: 2, s: {} } } }, "widgets.overview.events.v", /version/],
    ["an unknown setting key", "overview", { widgets: { "overview.events": { v: 1, s: { colour: "red" } } } }, "widgets.overview.events.colour", /Unknown setting/],
    ["the wrong type", "overview", { widgets: { "overview.events": { v: 1, s: { detail: "on" } } } }, "widgets.overview.events.detail", /true or false/],
    ["an enum value that is not among the options", "overview", { widgets: { "overview.keyMetrics": { v: 1, s: { range: "2h" } } } }, "widgets.overview.keyMetrics.range", /one of: live, 1h, 24h, 7d, 30d/],
    ["a number that is not finite", "overview", { widgets: { "overview.events": { v: 1, s: { rows: "5" } } } }, "widgets.overview.events.rows", /number/],
    ["a number out of range", "overview", { widgets: { "overview.events": { v: 1, s: { rows: 1e9 } } } }, "widgets.overview.events.rows", /3 to 10/],
    ["a number off step", "firewall", { widgets: { "firewall.capture": { v: 1, s: { seconds: 31 } } } }, "widgets.firewall.capture.seconds", /steps of 5/],
    ["a multi-select with an unknown value", "clients", { widgets: { "clients.table": { v: 1, s: { columns: ["address", "password"] } } } }, "widgets.clients.table.columns", /password/],
    ["a multi-select with a duplicate", "clients", { widgets: { "clients.table": { v: 1, s: { columns: ["address", "address"] } } } }, "widgets.clients.table.columns", /twice/],
    ["a multi-select under minSelected", "overview", { widgets: { "overview.keyMetrics": { v: 1, s: { tiles: [] } } } }, "widgets.overview.keyMetrics.tiles", /at least 1/],
    ["a multi-select that is not a list", "overview", { widgets: { "overview.keyMetrics": { v: 1, s: { tiles: "latency" } } } }, "widgets.overview.keyMetrics.tiles", /list/],
    ["a threshold out of range", "overview", { widgets: { "overview.keyMetrics": { v: 1, s: { availability: { warn: 101, bad: null } } } } }, "widgets.overview.keyMetrics.availability.warn", /0 to 100/],
    ["a threshold off step", "cost", { widgets: { "cost.perSession": { v: 1, s: { session: { warn: 1.255, bad: null } } } } }, "widgets.cost.perSession.session.warn", /steps of 0\.01/],
    ["thresholds in the wrong order (above)", "cost", { widgets: { "cost.kpis": { v: 1, s: { budgetUsed: { warn: 100, bad: 80 } } } } }, "widgets.cost.kpis.budgetUsed", /Warn must be below Bad/],
    ["thresholds in the wrong order (below)", "activity", { widgets: { "activity.kpis": { v: 1, s: { successRate: { warn: 70, bad: 90 } } } } }, "widgets.activity.kpis.successRate", /Warn must be above Bad/],
    ["a threshold with other keys", "cost", { widgets: { "cost.kpis": { v: 1, s: { budgetUsed: { warn: 80, bad: 100, at: 1 } } } } }, "widgets.cost.kpis.budgetUsed", /warn and bad/],
    ["an order that is not a permutation of its row", "overview", { layout: { order: { r3: ["overview.run", "overview.traffic"] } } }, "layout.order.r3", /each of overview\.run, overview\.traffic, side once/],
    ["an order with a stranger", "overview", { layout: { order: { r3: ["overview.run", "overview.traffic", "overview.notes"] } } }, "layout.order.r3", /once/],
    ["an order for a row that does not exist", "overview", { layout: { order: { r9: [] } } }, "layout.order.r9", /No row r9/],
    ["a pinned widget in hidden", "overview", { layout: { hidden: ["overview.status"] } }, "layout.hidden", /Status banner can't be hidden/],
    ["an unknown widget in hidden", "overview", { layout: { hidden: ["overview.nope"] } }, "layout.hidden", /No widget overview\.nope/],
    ["a duplicate in hidden", "overview", { layout: { hidden: ["overview.notes", "overview.notes"] } }, "layout.hidden", /twice/],
  ];
  it("validate names the field for each refusal kind", () => {
    for (const [what, page, body, field, message] of refusals) {
      const p = validatePagePrefs(page, body);
      expect(p, what).not.toBeNull();
      expect(p!.field, what).toBe(field);
      expect(p!.message, what).toMatch(message);
      expect(p!.outdated, what).toBeUndefined();
    }
  });

  it("an entry saved by an older dashboard is outdated, checked before anything else", () => {
    const v2: Registry = { ...REGISTRY, widgets: REGISTRY.widgets.map((w) => (w.id === "overview.events" ? { ...w, version: 2 } : w)) };
    const p = validatePagePrefs("overview", { widgets: { "overview.events": { v: 1, s: { rows: 99 } } }, junk: 1 }, v2);
    expect(p).toEqual({ field: "widgets.overview.events.v", message: expect.stringMatching(/older dashboard/), outdated: true });
  });

  it("refuses everything normalise would have to repair", () => {
    // Anything valid comes through normalise unchanged except for stripping defaults and canonical order.
    const prefs = { layout: { hidden: ["overview.topology"] }, widgets: { "overview.events": { v: 1, s: { rows: 6, types: ["watchman", "deploy"] } } } };
    expect(validatePagePrefs("overview", prefs)).toBeNull();
    expect(normalisePagePrefs("overview", prefs)).toEqual({ layout: { hidden: ["overview.topology"] }, widgets: { "overview.events": { v: 1, s: { rows: 6, types: ["deploy", "watchman"] } } } });
  });

  it("states the size caps: 16 KiB a request, 8 KiB a stored page", () => {
    expect(MAX_PREFS_BODY_BYTES).toBe(16 * 1024);
    expect(MAX_PAGE_PREFS_BYTES).toBe(8 * 1024);
  });
});

describe("thresholdTone", () => {
  it("above: amber at or over warn, red at or over bad", () => {
    const t = { warn: 80, bad: 100 };
    expect(thresholdTone(79.9, t, "above")).toBe("ok");
    expect(thresholdTone(80, t, "above")).toBe("warn");
    expect(thresholdTone(99, t, "above")).toBe("warn");
    expect(thresholdTone(100, t, "above")).toBe("bad");
  });
  it("below: amber under warn, red under bad", () => {
    const t = { warn: 99, bad: 90 };
    expect(thresholdTone(99, t, "below")).toBe("ok");
    expect(thresholdTone(98.9, t, "below")).toBe("warn");
    expect(thresholdTone(90, t, "below")).toBe("warn");
    expect(thresholdTone(89.9, t, "below")).toBe("bad");
  });
  it("off thresholds never colour; no data is null, not ok", () => {
    expect(thresholdTone(1e9, { warn: null, bad: null }, "above")).toBe("ok");
    expect(thresholdTone(5, { warn: null, bad: 1 }, "above")).toBe("bad");
    expect(thresholdTone(null, { warn: 1, bad: 2 }, "above")).toBeNull();
    expect(thresholdTone(undefined, { warn: 1, bad: 2 }, "above")).toBeNull();
    expect(thresholdTone(Number.NaN, { warn: 1, bad: 2 }, "below")).toBeNull();
  });
});
