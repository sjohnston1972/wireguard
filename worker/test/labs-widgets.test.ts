// labs-widgets.test.ts
//
// Plain English: the two lab widgets in the registry (plan ruling 5): both
// off by default, each in its home row suggesting the widget it replaces, the
// Cost page's row 3 capped at three, the simulator's zone picker offering the
// Labs zone, and, with nothing saved, every page drawn exactly as before.

import { describe, expect, it } from "vitest";
import { LAYOUTS, PAGE_IDS, isVisible, rowCapacity, widgetDef, widgetHome, normalisePagePrefs, validatePagePrefs, type LayoutItem, type PageId } from "../../shared/widgets";

/** The widgets each page draws with nothing saved, as they were before labs. */
const BEFORE: Record<PageId, string[]> = {
  overview: ["overview.status", "overview.topology", "overview.keyMetrics", "overview.run", "overview.traffic", "overview.events", "overview.speedTest", "overview.health", "overview.costImpact", "overview.notes"],
  clients: ["clients.kpis", "clients.table", "clients.talkers", "clients.statusDonut", "clients.sessionTraffic"],
  firewall: ["firewall.kpis", "firewall.rules", "firewall.zones", "firewall.simulator", "firewall.drops", "firewall.ports", "firewall.capture"],
  activity: ["activity.kpis", "activity.timeline", "activity.list", "activity.stream", "activity.changeLog", "activity.runDetails", "activity.liveOutput"],
  cost: ["cost.kpis", "cost.spend", "cost.breakdown", "cost.forecast", "cost.split", "cost.perSession", "cost.insights", "cost.sessions"],
};

function shownWithNoPrefs(page: PageId): string[] {
  const rows = LAYOUTS[page].rows;
  const expand = (items: LayoutItem[]): string[] =>
    items.flatMap((it) => ("widget" in it ? [it.widget] : it.widgets.flatMap((m) => (rows.some((r) => r.id === m) ? expand(rows.find((r) => r.id === m)!.items) : [m]))));
  return rows
    .filter((r) => !r.in)
    .flatMap((r) => expand(r.items))
    .filter((id) => isVisible({}, widgetDef(id)!));
}

describe("lab widgets", () => {
  it("runningLabs and cost.labs are defaultOff in their homes with their replaces", () => {
    const running = widgetDef("overview.runningLabs")!;
    expect(running).toMatchObject({ page: "overview", defaultOff: true, replaces: "overview.costImpact", icon: "FlaskConical" });
    expect(running.description).not.toBe("");
    expect(widgetHome("overview.runningLabs")).toMatchObject({ row: "r4" });
    const r4 = LAYOUTS.overview.rows.find((r) => r.id === "r4")!;
    expect(r4.items.find((i) => "widget" in i && i.widget === "overview.runningLabs")).toEqual({ widget: "overview.runningLabs", weight: 32 });
    const labs = widgetDef("cost.labs")!;
    expect(labs).toMatchObject({ page: "cost", defaultOff: true, replaces: "cost.insights", icon: "FlaskConical" });
    expect(labs.description).not.toBe("");
    expect(widgetHome("cost.labs")).toMatchObject({ row: "r3" });
  });

  it("cost r3 max is 3", () => {
    expect(LAYOUTS.cost.rows.find((r) => r.id === "r3")!.max).toBe(3);
    // Turning cost.labs on in a full row means replacing one, cost.insights first.
    const cap = rowCapacity("cost", "r3", {}, "cost.labs");
    expect(cap.max).toBe(3);
    expect(cap.full).toBe(true);
    expect(cap.suggestion).toBe("cost.insights");
    // Overview r4 is already full at 3: runningLabs suggests Cost impact.
    expect(rowCapacity("overview", "r4", {}, "overview.runningLabs").suggestion).toBe("overview.costImpact");
  });

  it("with no prefs no layout changes", () => {
    for (const page of PAGE_IDS) expect(shownWithNoPrefs(page), page).toEqual(BEFORE[page]);
  });

  it("turning a lab widget on is a valid preference, and normalises to itself", () => {
    const overview = { layout: { shown: ["overview.runningLabs"], hidden: ["overview.costImpact"] } };
    expect(validatePagePrefs("overview", overview)).toBeNull();
    expect(normalisePagePrefs("overview", overview)).toEqual(overview);
    const cost = { layout: { shown: ["cost.labs"], hidden: ["cost.insights"] } };
    expect(validatePagePrefs("cost", cost)).toBeNull();
  });

  it("simulator offers labs", () => {
    for (const key of ["from", "to"]) {
      const spec = widgetDef("firewall.simulator")!.settings.find((s) => s.key === key)!;
      expect(spec.kind).toBe("enum");
      const values = (spec as { options: { value: string; label: string }[] }).options.map((o) => o.value);
      expect(values).toContain("labs");
      expect(values.indexOf("labs")).toBe(values.indexOf("internet") - 1);
    }
  });
});
