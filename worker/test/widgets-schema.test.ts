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
  PREFS_SCHEMA,
  isVisible,
  rowCapacity,
  widgetHome,
  homeMembers,
  type PageId,
  type Registry,
  type WidgetDef,
} from "../../shared/widgets";
import type { PagePrefs } from "../../shared/api";
import { readdirSync, readFileSync } from "node:fs";
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
  it("has 43 widgets: Overview 13, Clients 5, Firewall 8, Activity 9, Cost 8; four pinned", () => {
    expect(WIDGETS).toHaveLength(43);
    const count = (p: PageId) => WIDGETS.filter((w) => w.page === p).length;
    expect(PAGE_IDS.map(count)).toEqual([13, 5, 8, 9, 8]);
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
    const dir = new URL("../../scripts/shots-prefs/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const all = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Record<string, PagePrefs>;
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

  it("lays out each page's rows with today's weights (the insights widgets after them, each row and stack capped at its old count)", () => {
    const shape = (p: PageId) =>
      LAYOUTS[p].rows.map((r) => ({
        id: r.id,
        ...(r.in ? { in: r.in } : {}),
        ...(r.max ? { max: r.max } : {}),
        items: r.items.map((i) => ("widget" in i ? `${i.widget}:${i.weight}` : `${i.stack}[${i.widgets.join(",")}]:${i.weight}${i.max ? ` max ${i.max}` : ""}`)),
      }));
    expect(shape("overview")).toEqual([
      { id: "r1", items: ["overview.status:1"] },
      { id: "r2", items: ["overview.topology:1", "overview.keyMetrics:1"] },
      { id: "r3", max: 3, items: ["overview.run:41", "overview.traffic:45", "side[overview.events,overview.speedTest]:32", "overview.vmPerformance:45"] },
      { id: "r4", max: 3, items: ["overview.health:54", "overview.costImpact:32", "overview.notes:32", "overview.azureHealth:32", "overview.vitals:32"] },
    ]);
    expect(shape("clients")).toEqual([
      { id: "r1", items: ["clients.kpis:1"] },
      { id: "r2", items: ["clients.table:1"] },
      { id: "r3", items: ["clients.talkers:1", "clients.statusDonut:1", "clients.sessionTraffic:1"] },
    ]);
    expect(shape("firewall")).toEqual([
      { id: "r1", items: ["firewall.kpis:1"] },
      { id: "r2", items: ["left[firewall.rules,bottom]:9", "right[firewall.drops,firewall.ports,firewall.capture,firewall.publicIp]:3 max 3"] },
      { id: "bottom", in: "left", items: ["firewall.zones:1", "firewall.simulator:1"] },
    ]);
    expect(shape("activity")).toEqual([
      { id: "r1", items: ["activity.kpis:1"] },
      { id: "r2", items: ["left[activity.timeline,activity.list]:8", "right[activity.stream,activity.changeLog,activity.azureChanges]:4 max 2"] },
      { id: "r3", max: 2, items: ["activity.runDetails:3", "activity.liveOutput:2", "activity.serviceHealth:2"] },
    ]);
    expect(shape("cost")).toEqual([
      { id: "r1", items: ["cost.kpis:1"] },
      { id: "r2", items: ["cost.spend:5", "cost.breakdown:4", "cost.forecast:3"] },
      { id: "r3", items: ["cost.split:4", "cost.perSession:4", "cost.insights:4"] },
      { id: "r4", items: ["cost.sessions:1"] },
    ]);
    expect(rowItemKeys("overview", "r3")).toEqual(["overview.run", "overview.traffic", "side", "overview.vmPerformance"]);
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
      layout: { order: { r3: ["overview.traffic", "overview.run", "side", "overview.vmPerformance"] }, hidden: ["overview.notes"] },
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
      description: "A test-only version 2",
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
    expect(normalisePagePrefs("overview", { layout: { order: { r3: ["side", "overview.run"] } } })).toEqual({ layout: { order: { r3: ["side", "overview.traffic", "overview.run", "overview.vmPerformance"] } } });
    // Run missing (declared first) goes back first; the result is the default order, so nothing is kept.
    expect(normalisePagePrefs("overview", { layout: { order: { r3: ["overview.traffic", "side"] } } })).toEqual({});
    expect(normalisePagePrefs("overview", { layout: { order: { r4: ["overview.notes", "overview.health"] } } })).toEqual({ layout: { order: { r4: ["overview.notes", "overview.costImpact", "overview.health", "overview.azureHealth", "overview.vitals"] } } });
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
      layout: { order: { r3: ["side", "overview.traffic", "overview.run", "overview.vmPerformance"], r2: ["overview.keyMetrics", "overview.topology"] }, hidden: ["overview.speedTest", "overview.events"] },
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
    ["an order that is not a permutation of its row", "overview", { layout: { order: { r3: ["overview.run", "overview.traffic"] } } }, "layout.order.r3", /each of overview\.run, overview\.traffic, side, overview\.vmPerformance once/],
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

// ── Azure insights (spec 2026-10-04-azure-insights-design.md, sections 9 and 10.1) ──

const NEW_WIDGETS = ["overview.vmPerformance", "overview.azureHealth", "overview.vitals", "firewall.publicIp", "activity.azureChanges", "activity.serviceHealth"];

/** Each row's and stack's item count before this project: what `max` defaults to. */
const BEFORE: Record<PageId, Record<string, number>> = {
  overview: { r1: 1, r2: 2, r3: 3, side: 2, r4: 3 },
  clients: { r1: 1, r2: 1, r3: 3 },
  firewall: { r1: 1, r2: 2, left: 2, right: 3, bottom: 2 },
  activity: { r1: 1, r2: 2, left: 2, right: 2, r3: 2 },
  cost: { r1: 1, r2: 3, r3: 3, r4: 1 },
};

describe("widget library schema (insights spec 9.1)", () => {
  it("every widget has a one-line description", () => {
    for (const w of WIDGETS) {
      expect(typeof w.description, w.id).toBe("string");
      expect(w.description.length, w.id).toBeGreaterThanOrEqual(10);
      expect(w.description.length, w.id).toBeLessThanOrEqual(90);
      expect(w.description, w.id).not.toMatch(/[\n\r]|\.$/);
    }
  });

  it("the six new widgets are defaultOff and declared in their home row or stack after the existing items", () => {
    expect(WIDGETS.filter((w) => w.defaultOff).map((w) => w.id).sort()).toEqual([...NEW_WIDGETS].sort());
    const homes: Record<string, [PageId, string, number]> = {
      "overview.vmPerformance": ["overview", "r3", 3],
      "overview.azureHealth": ["overview", "r4", 3],
      "overview.vitals": ["overview", "r4", 4],
      "firewall.publicIp": ["firewall", "right", 3],
      "activity.azureChanges": ["activity", "right", 2],
      "activity.serviceHealth": ["activity", "r3", 2],
    };
    for (const [id, [page, home, index]] of Object.entries(homes)) {
      const h = widgetHome(id)!;
      expect(h, id).toEqual({ page, row: h.row, stack: home === h.row ? null : home, home });
      expect(homeMembers(page, home).indexOf(id), id).toBe(index);
      expect(index, id).toBeGreaterThanOrEqual(BEFORE[page][home]!);
      expect(widgetDef(id)!.pinned, id).toBeFalsy();
      expect(widgetDef(id)!.icon, id).toMatch(/^[A-Z][A-Za-z0-9]+$/);
    }
    expect(widgetHome("overview.nope")).toBeNull();
  });

  it("every icon named is a lucide-react icon", async () => {
    const lucide = (await import("lucide-react")) as Record<string, unknown>;
    for (const w of WIDGETS.filter((x) => x.icon)) expect(lucide[w.icon!], `${w.id} ${w.icon}`).toBeDefined();
  });

  it("every row's max defaults to its item count before this project", () => {
    for (const p of PAGE_IDS) {
      const homes = LAYOUTS[p].rows.flatMap((r) => [r.id, ...r.items.flatMap((i) => ("stack" in i ? [i.stack] : []))]);
      expect([...homes].sort(), p).toEqual(Object.keys(BEFORE[p]).sort());
      for (const h of homes) expect(rowCapacity(p, h, {}).max, `${p} ${h}`).toBe(BEFORE[p][h]);
    }
  });

  it("with no prefs every new widget is off and no layout changes", () => {
    for (const id of NEW_WIDGETS) expect(isVisible({}, widgetDef(id)!), id).toBe(false);
    for (const w of WIDGETS.filter((x) => !x.defaultOff)) expect(isVisible({}, w), w.id).toBe(true);
    // Every row and stack shows exactly what it showed before, so each is full.
    for (const p of PAGE_IDS)
      for (const [home, n] of Object.entries(BEFORE[p])) {
        const c = rowCapacity(p, home, {});
        expect(c.visible, `${p} ${home}`).toBe(n);
        expect(c.full, `${p} ${home}`).toBe(true);
      }
    expect(normalisePagePrefs("overview", {})).toEqual({});
  });

  it("a stored page from before this project normalises to the same visibility with every new widget off", () => {
    // Real saved shapes: hidden and reordered items, as the widgets project stored them.
    const stored: Record<PageId, { layout: { hidden: string[]; order: Record<string, string[]> }; widgets?: unknown }> = {
      overview: { layout: { order: { r3: ["side", "overview.traffic", "overview.run"], r4: ["overview.notes", "overview.costImpact", "overview.health"] }, hidden: ["overview.speedTest", "overview.topology"] }, widgets: { "overview.events": { v: 1, s: { rows: 7 } } } },
      clients: { layout: { order: { r3: ["clients.statusDonut", "clients.sessionTraffic", "clients.talkers"] }, hidden: ["clients.kpis"] } },
      firewall: { layout: { order: { r2: ["right", "left"], bottom: ["firewall.simulator", "firewall.zones"] }, hidden: ["firewall.capture"] } },
      activity: { layout: { order: { r2: ["right", "left"], r3: ["activity.liveOutput", "activity.runDetails"] }, hidden: ["activity.timeline", "activity.stream"] } },
      cost: { layout: { order: { r2: ["cost.forecast", "cost.breakdown", "cost.spend"] }, hidden: ["cost.insights"] } },
    };
    for (const p of PAGE_IDS) {
      const raw = stored[p];
      const n = normalisePagePrefs(p, raw);
      for (const w of pageWidgets(p)) expect(isVisible(n, w), `${p} ${w.id}`).toBe(w.defaultOff ? false : !raw.layout.hidden.includes(w.id) || !!w.pinned);
      expect(n.layout?.shown, p).toBeUndefined();
      expect(n.layout?.hidden, p).toEqual(pageWidgets(p).filter((w) => raw.layout.hidden.includes(w.id)).map((w) => w.id));
      // The old order comes back with only the new widgets added, at their declared (last) places.
      for (const [row, keys] of Object.entries(raw.layout.order)) {
        const back = n.layout!.order![row]!;
        expect(back.slice(0, keys.length), `${p} ${row}`).toEqual(keys);
        expect(back.slice(keys.length).every((k) => NEW_WIDGETS.includes(k)), `${p} ${row}`).toBe(true);
      }
      // What the old dashboard saved, normalised, is a valid save for this one.
      expect(validatePagePrefs(p, n), p).toBeNull();
    }
  });

  it("shown may name only default-off widgets and hidden may not name one", () => {
    expect(validatePagePrefs("overview", { layout: { shown: ["overview.vmPerformance"], hidden: ["overview.traffic"] } })).toBeNull();
    const cases: [PageId, unknown, string, RegExp][] = [
      ["overview", { layout: { shown: ["overview.traffic"] } }, "layout.shown", /Network traffic is on by default/],
      ["overview", { layout: { shown: ["overview.nope"] } }, "layout.shown", /No widget overview\.nope on the Overview page/],
      ["overview", { layout: { shown: ["firewall.publicIp"] } }, "layout.shown", /No widget firewall\.publicIp on the Overview page/],
      ["overview", { layout: { shown: ["overview.vitals", "overview.vitals"] } }, "layout.shown", /twice/],
      ["overview", { layout: { shown: "overview.vitals" } }, "layout.shown", /list/],
      ["overview", { layout: { hidden: ["overview.vitals"] } }, "layout.hidden", /System vitals is off by default/],
    ];
    for (const [page, body, field, message] of cases) {
      const p = validatePagePrefs(page, body);
      expect(p, JSON.stringify(body)).toMatchObject({ field });
      expect(p!.message, JSON.stringify(body)).toMatch(message);
    }
    // The lenient reader drops the same things.
    expect(normalisePagePrefs("overview", { layout: { shown: ["overview.traffic", "overview.nope", "overview.vitals", "overview.vitals", 3], hidden: ["overview.vitals", "overview.costImpact"] } })).toEqual({
      layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] },
    });
  });

  it("validate refuses a row over max with field layout.shown", () => {
    expect(validatePagePrefs("overview", { layout: { shown: ["overview.vmPerformance"] } })).toEqual({ field: "layout.shown", message: "Overview row 3 is full. Turn a widget off first." });
    expect(validatePagePrefs("firewall", { layout: { shown: ["firewall.publicIp"] } })).toEqual({ field: "layout.shown", message: "The Firewall right column is full. Turn a widget off first." });
    expect(validatePagePrefs("overview", { layout: { shown: ["overview.azureHealth", "overview.vitals"], hidden: ["overview.notes"] } })).toMatchObject({ field: "layout.shown" });
    expect(validatePagePrefs("overview", { layout: { shown: ["overview.azureHealth", "overview.vitals"], hidden: ["overview.notes", "overview.costImpact"] } })).toBeNull();
    expect(validatePagePrefs("activity", { layout: { shown: ["activity.azureChanges", "activity.serviceHealth"], hidden: ["activity.changeLog", "activity.liveOutput"] } })).toBeNull();
    // A stack counts as one item of its row while any member shows.
    expect(validatePagePrefs("overview", { layout: { shown: ["overview.vmPerformance"], hidden: ["overview.events"] } })).toMatchObject({ field: "layout.shown" });
    expect(validatePagePrefs("overview", { layout: { shown: ["overview.vmPerformance"], hidden: ["overview.events", "overview.speedTest"] } })).toBeNull();
  });

  it("normalise drops the newest shown entries from an over-full row", () => {
    expect(normalisePagePrefs("overview", { layout: { shown: ["overview.vitals", "overview.azureHealth"], hidden: ["overview.notes"] } })).toEqual({ layout: { hidden: ["overview.notes"], shown: ["overview.vitals"] } });
    expect(normalisePagePrefs("overview", { layout: { shown: ["overview.vmPerformance"] } })).toEqual({});
    // Rows are repaired one by one: a shown widget in a row with room stays.
    expect(normalisePagePrefs("overview", { layout: { shown: ["overview.vmPerformance", "overview.vitals"], hidden: ["overview.costImpact"] } })).toEqual({ layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } });
  });

  it("rowCapacity lists visible non-pinned candidates and the suggestion", () => {
    expect(rowCapacity("overview", "r3", {}, "overview.vmPerformance")).toEqual({
      page: "overview",
      home: "r3",
      kind: "row",
      max: 3,
      visible: 3,
      full: true,
      // The side stack shows two widgets: hiding one of them frees no place, so neither is offered.
      candidates: ["overview.run", "overview.traffic"],
      suggestion: "overview.traffic",
    });
    // A stack with one widget left offers that widget.
    expect(rowCapacity("overview", "r3", { layout: { hidden: ["overview.events"] } }).candidates).toEqual(["overview.run", "overview.traffic", "overview.speedTest"]);
    // A stack home lists the stack's members; pinned and hidden ones are never offered.
    expect(rowCapacity("firewall", "right", {}, "firewall.publicIp")).toMatchObject({ kind: "stack", max: 3, visible: 3, full: true, candidates: ["firewall.drops", "firewall.ports", "firewall.capture"], suggestion: "firewall.capture" });
    expect(rowCapacity("activity", "right", { layout: { hidden: ["activity.changeLog"] } }, "activity.azureChanges")).toMatchObject({ visible: 1, full: false, candidates: ["activity.stream"], suggestion: "activity.stream" });
    expect(rowCapacity("firewall", "r2", {}).candidates).toEqual([]);
    // The suggestion, when it is not a candidate and nothing else points anywhere, is the row's last candidate; none without a widget.
    expect(rowCapacity("overview", "r4", { layout: { hidden: ["overview.notes"] } }, "overview.azureHealth")).toMatchObject({ full: false, suggestion: "overview.costImpact" });
    expect(rowCapacity("overview", "r4", {}, "overview.vitals").suggestion).toBe("overview.costImpact");
    expect(rowCapacity("overview", "r4", {}).suggestion).toBeNull();
    expect(() => rowCapacity("overview", "nope", {})).toThrow(/No row or stack nope on the Overview page/);
  });

  it("without a preset suggestion Replace offers the widget that took its place, else the newest turned on, else the row's last, never its first", () => {
    // Turning Watchman notes back on after Azure health replaced it: swap them back.
    expect(rowCapacity("overview", "r4", { layout: { hidden: ["overview.notes"], shown: ["overview.azureHealth"] } }, "overview.notes")).toMatchObject({
      full: true,
      candidates: ["overview.health", "overview.costImpact", "overview.azureHealth"],
      suggestion: "overview.azureHealth",
    });
    // Health summary back on, where nothing replaced it: the most recently turned-on widget (Azure health, after System vitals).
    expect(rowCapacity("overview", "r4", { layout: { hidden: ["overview.health", "overview.costImpact"], shown: ["overview.vitals", "overview.azureHealth"] } }, "overview.health")).toMatchObject({
      full: true,
      candidates: ["overview.notes", "overview.azureHealth", "overview.vitals"],
      suggestion: "overview.azureHealth",
    });
    // The person's order does not change which one was turned on last.
    const order = { r4: ["overview.vitals", "overview.azureHealth", "overview.notes", "overview.health", "overview.costImpact"] };
    expect(rowCapacity("overview", "r4", { layout: { order, hidden: ["overview.health", "overview.costImpact"], shown: ["overview.azureHealth", "overview.vitals"] } }, "overview.health").suggestion).toBe("overview.vitals");
    // A preset still wins.
    expect(rowCapacity("overview", "r4", { layout: { hidden: ["overview.notes"], shown: ["overview.azureHealth"] } }, "overview.vitals").suggestion).toBe("overview.costImpact");
  });

  // Spec 10.1, one row per new widget: suggested Replace, title, description, settings keys (section, kind) and defaults, threshold defaults.
  const S = (section: string, kind: string, def: unknown) => ({ section, kind, default: def });
  const catalogue: Record<string, { replaces: string; title: string; description: string; settings: Record<string, ReturnType<typeof S>> }> = {
    "overview.vmPerformance": {
      replaces: "overview.traffic",
      title: "VM performance",
      description: "CPU, memory, network and disk as Azure measures them",
      settings: {
        range: S("data", "enum", "24h"),
        charts: S("data", "multi", ["cpu", "credits", "network"]),
        azureNames: S("display", "boolean", true),
        peaks: S("display", "boolean", false),
        cpu: S("thresholds", "threshold", { warn: 80, bad: 95 }),
        credits: S("thresholds", "threshold", { warn: 30, bad: 10 }),
        memory: S("thresholds", "threshold", { warn: 85, bad: 95 }),
        diskIops: S("thresholds", "threshold", { warn: 80, bad: 95 }),
      },
    },
    "overview.azureHealth": {
      replaces: "overview.notes",
      title: "Azure health",
      description: "What Azure says about the VM: health, power, agent, maintenance",
      settings: {
        annotations: S("data", "number", 3),
        maintenance: S("data", "boolean", true),
        serviceIssues: S("data", "boolean", true),
        feedAges: S("display", "boolean", true),
        azureTerms: S("display", "boolean", true),
      },
    },
    "overview.vitals": {
      replaces: "overview.costImpact",
      title: "System vitals",
      description: "Memory, disk, load, steal, connections, updates and internet from the VM",
      settings: {
        rows: S("data", "multi", ["memory", "disk", "load", "steal", "conntrack", "uptime", "updates", "internet"]),
        bars: S("display", "boolean", true),
        memory: S("thresholds", "threshold", { warn: 85, bad: 95 }),
        disk: S("thresholds", "threshold", { warn: 80, bad: 90 }),
        load: S("thresholds", "threshold", { warn: 1, bad: 2 }),
        steal: S("thresholds", "threshold", { warn: 10, bad: 25 }),
        conntrack: S("thresholds", "threshold", { warn: 70, bad: 90 }),
        latency: S("thresholds", "threshold", { warn: 100, bad: 250 }),
        loss: S("thresholds", "threshold", { warn: 2, bad: 10 }),
        securityUpdates: S("thresholds", "threshold", { warn: 1, bad: null }),
      },
    },
    "firewall.publicIp": {
      replaces: "firewall.capture",
      title: "Public IP and DDoS",
      description: "Packets at Azure's edge and DDoS mitigation on the public IP",
      settings: {
        range: S("data", "enum", "24h"),
        series: S("data", "multi", ["packets", "dropped"]),
        azureNames: S("display", "boolean", true),
        availability: S("thresholds", "threshold", { warn: 99.9, bad: 99 }),
        dropped: S("thresholds", "threshold", { warn: null, bad: null }),
      },
    },
    "activity.azureChanges": {
      replaces: "activity.changeLog",
      title: "Azure change log",
      description: "Who changed what in Azure, including the portal",
      settings: {
        range: S("data", "enum", "7d"),
        who: S("data", "enum", "all"),
        types: S("data", "multi", ["vm", "nsg", "pip", "nic", "disk", "vnet", "rg", "other"]),
        status: S("display", "boolean", true),
        caller: S("display", "boolean", true),
        failedOnly: S("display", "boolean", false),
      },
    },
    "activity.serviceHealth": {
      replaces: "activity.liveOutput",
      title: "Azure service health",
      description: "Azure issues and planned maintenance in your region",
      settings: {
        range: S("data", "enum", "30d"),
        types: S("data", "multi", ["issue", "maintenance"]),
        summaries: S("display", "boolean", true),
      },
    },
  };

  it("catalogue rows match spec 10.1", () => {
    for (const [id, want] of Object.entries(catalogue)) {
      const d = widgetDef(id)!;
      expect(d, id).toBeDefined();
      expect({ title: d.title, description: d.description, replaces: d.replaces, version: d.version, defaultOff: d.defaultOff }, id).toEqual({ title: want.title, description: want.description, replaces: want.replaces, version: 1, defaultOff: true });
      expect(Object.fromEntries(d.settings.map((s) => [s.key, { section: s.section, kind: s.kind, default: s.default }])), id).toEqual(want.settings);
    }
    // The choices and ranges the spec names.
    const spec = (id: string, key: string) => widgetDef(id)!.settings.find((s) => s.key === key)!;
    const values = (id: string, key: string) => (spec(id, key) as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values("overview.vmPerformance", "range")).toEqual(["1h", "24h", "7d", "30d"]);
    expect(values("overview.vmPerformance", "charts")).toEqual(["cpu", "credits", "memory", "network", "disk", "diskQuota"]);
    expect(values("overview.vitals", "rows")).toEqual(["memory", "disk", "load", "steal", "conntrack", "uptime", "updates", "internet"]);
    expect(values("firewall.publicIp", "range")).toEqual(["1h", "24h", "7d"]);
    expect(values("firewall.publicIp", "series")).toEqual(["packets", "bytes", "syn", "dropped"]);
    expect(values("activity.azureChanges", "range")).toEqual(["24h", "7d", "30d", "90d"]);
    expect(values("activity.azureChanges", "who")).toEqual(["all", "others", "wgadmin"]);
    expect(values("activity.serviceHealth", "range")).toEqual(["7d", "30d", "90d"]);
    expect(spec("overview.azureHealth", "annotations")).toMatchObject({ min: 0, max: 5, step: 1 });
    expect(spec("overview.vitals", "load")).toMatchObject({ direction: "above", min: 0, max: 16, step: 0.1 });
    expect(spec("overview.vitals", "latency")).toMatchObject({ direction: "above", min: 1, max: 1000, unit: "ms" });
    expect(spec("overview.vitals", "securityUpdates")).toMatchObject({ direction: "above", min: 0, max: 500 });
    expect(spec("overview.vmPerformance", "credits")).toMatchObject({ direction: "below", min: 0, max: 2000 });
    expect(spec("overview.vmPerformance", "cpu")).toMatchObject({ direction: "above", min: 0, max: 100, unit: "%" });
    expect(spec("firewall.publicIp", "availability")).toMatchObject({ direction: "below", min: 0, max: 100, step: 0.1 });
    expect(spec("firewall.publicIp", "dropped")).toMatchObject({ direction: "above", min: 1, max: 1e9 });
    for (const [id, w] of Object.entries(catalogue)) for (const k of Object.keys(w.settings)) if (spec(id, k).kind === "multi") expect((spec(id, k) as { minSelected: number }).minSelected, `${id}.${k}`).toBe(1);
  });

  it("overview.health verdict defaults to true and activity.changeLog azure to false, both still version 1", () => {
    expect(widgetDef("overview.health")).toMatchObject({ version: 1 });
    expect(widgetDef("overview.health")!.settings.find((s) => s.key === "verdict")).toMatchObject({ kind: "boolean", section: "display", label: "Verdict line", default: true });
    expect(widgetDef("activity.changeLog")).toMatchObject({ version: 1 });
    expect(widgetDef("activity.changeLog")!.settings.find((s) => s.key === "azure")).toMatchObject({ kind: "boolean", section: "data", label: "Include Azure changes", default: false });
    // A page saved before keeps its other settings.
    expect(normalisePagePrefs("overview", { widgets: { "overview.health": { v: 1, s: { ages: false } } } })).toEqual({ widgets: { "overview.health": { v: 1, s: { ages: false } } } });
  });

  it("states the prefs schema number the app sends: 2", () => {
    expect(PREFS_SCHEMA).toBe(2);
  });
});
