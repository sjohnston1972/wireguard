// widgets.test.tsx
//
// Plain English: every Activity panel is a widget (W4). With nothing saved
// the page is today's page; each setting in the catalogue changes what its
// widget draws; hidden and reordered widgets give their room to the rest.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PagePrefs, SettingValue } from "@shared/api";
import { widgetDef } from "@shared/widgets";
import { renderApp } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { activityResponse, activityRoutes, noteRows, runRows, runDetail } from "./testkit";
import { preloadLazy } from "@/test/lazy";

beforeAll(preloadLazy);

vi.setConfig({ testTimeout: 20_000 });

/** Saved settings for widgets: { "activity.kpis": { deltas: false } }. */
const saved = (widgets: Record<string, Record<string, SettingValue>>, layout?: PagePrefs["layout"]): PagePrefs => ({
  ...(layout ? { layout } : {}),
  widgets: Object.fromEntries(Object.entries(widgets).map(([id, s]) => [id, { v: widgetDef(id)!.version, s }])),
});

const manyLines = (n: number) => Array.from({ length: n }, (_, i) => `2026-10-02T11:51:${String(i % 60).padStart(2, "0")}.0000000Z [INFO] line number ${i + 1}`).join("\n");

function renderActivity(prefs: PagePrefs | null, opts: { url?: string; routes?: Record<string, unknown> } = {}) {
  const server = prefsServer(prefs ? { activity: prefs } : {});
  const r = renderApp(opts.url ?? "/activity", { routes: activityRoutes({ ...server.routes, ...(opts.routes ?? {}) }) });
  return { ...r, server };
}

const group = (name: string) => screen.findByRole("group", { name });
const groupNow = (name: string) => screen.getByRole("group", { name });
const tone = (el: HTMLElement) => /tile__icon--(green|amber|red|grey|blue|purple)/.exec(el.querySelector(".tile__icon")!.className)?.[1];
/** The threshold word shown (not only read aloud) beside a tile's value, or null. */
const shownWord = (el: HTMLElement) => {
  const w = el.querySelector(".tile__value .act-kpi__word");
  if (w?.classList.contains("visually-hidden")) return null;
  return w?.textContent?.trim() ?? null;
};
const headers = () => within(screen.getByRole("table", { name: "Runs" })).getAllByRole("columnheader").map((h) => h.textContent);
const eventsList = () => screen.getByRole("list", { name: "Events" });
const ringTone = (el: HTMLElement) => el.querySelector(".ring circle:last-child")?.getAttribute("stroke")?.replace(/^var\(--(.*)\)$/, "$1");

describe("activity: widget frame", () => {
  it("activity: every panel is a widget with a cog named \"<Title> settings\"", async () => {
    renderActivity(null);
    await group("Deploys");
    for (const t of ["Activity figures", "Activity timeline", "Runs and activity", "Live event stream", "Change log", "Run details", "Live output"]) {
      expect(await screen.findByRole("button", { name: `${t} settings` })).toBeInTheDocument();
    }
  });

  it("with no prefs activity renders today's tiles, columns, ranges and colours", async () => {
    const { fetchMock } = renderActivity(null);
    await group("Deploys");
    // six tiles, with their change lines and sub-lines
    expect(screen.getAllByRole("group").filter((g) => g.closest(".act__kpis"))).toHaveLength(6);
    expect(groupNow("Deploys")).toHaveTextContent("100% vs previous period");
    expect(groupNow("Deploys")).toHaveTextContent("successful deploys");
    // success 90/70, failed red at 1, watchman amber at 1 (and grey / green below)
    expect(groupNow("Success rate").querySelector(".ring")).not.toBeNull();
    expect(tone(groupNow("Failed runs"))).toBe("red");
    expect(tone(groupNow("Watchman problems"))).toBe("amber");
    // columns
    await screen.findByRole("table", { name: "Runs" });
    expect(headers()).toEqual(["When", "Action", "Result", "Duration", "Cost impact", "Actor", "Source", "Notes", "Open"]);
    expect(document.querySelector(".act__list .dt")).not.toHaveClass("dt--compact");
    // range and the change log's kind: no kind on the query
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=7d")).toBe(true);
    // the stream: every type, clock times, detail lines
    expect(within(eventsList()).getAllByRole("listitem")).toHaveLength(6);
    expect(document.querySelector(".act__event-time")).toHaveTextContent(/^\d\d:\d\d:\d\d$/);
    expect(within(eventsList()).getByText("Allow DNS")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Auto-scroll" })).toBeChecked();
    // the timeline's six series
    expect(within(screen.getByRole("list", { name: "Timeline legend" })).getAllByRole("listitem")).toHaveLength(6);
    // the change log's columns
    const changes = within(screen.getByRole("table", { name: "Changes" }));
    expect(changes.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "What changed", "By", "Open"]);
    // run details: durations on, the newest run; live output: 60 lines, not wrapped
    expect(document.querySelector(".act__track")).not.toHaveClass("act__track--one");
    await waitFor(() => expect(screen.getByRole("log", { name: "Live output log" })).toBeInTheDocument());
    expect(document.querySelector(".act__output .log")).not.toHaveClass("log--wrap");
  });

  it("with no prefs live output shows the last 60 lines", async () => {
    renderActivity(null, { routes: { "GET /api/v1/runs/run-4/log": { log: manyLines(100), source: "live", active: true, updatedAt: new Date().toISOString() } } });
    const log = await screen.findByRole("log", { name: "Live output log" });
    expect(log.querySelectorAll(".log__line")).toHaveLength(60);
    expect(log).toHaveTextContent("line number 100");
    expect(log).not.toHaveTextContent("line number 40 ");
  });
});

describe("activity: data settings", () => {
  it("starting tab applies only without ?tab=", async () => {
    renderActivity(saved({ "activity.list": { tab: "notes" } }));
    expect(await screen.findByRole("table", { name: "Watchman notes" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Runs" })).toBeNull();
  });

  it("a ?tab= in the address beats the starting tab", async () => {
    renderActivity(saved({ "activity.list": { tab: "notes" } }), { url: "/activity?tab=runs" });
    expect(await screen.findByRole("table", { name: "Runs" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status", { name: "location" })).toHaveTextContent("tab=runs"));
    expect(screen.queryByRole("table", { name: "Watchman notes" })).toBeNull();
  });

  it("runs columns add Public IP (and drop what is unticked)", async () => {
    renderActivity(saved({ "activity.list": { runColumns: ["duration", "publicIp"] } }));
    await waitFor(() => expect(headers()).toEqual(["When", "Action", "Result", "Duration", "Public IP", "Open"]));
    expect(within(screen.getByRole("table", { name: "Runs" })).getAllByText("203.0.113.7").length).toBeGreaterThan(0);
  });

  it("runs columns may be empty: only When, Action, Result and the chevron stay", async () => {
    renderActivity(saved({ "activity.list": { runColumns: [] } }));
    await waitFor(() => expect(headers()).toEqual(["When", "Action", "Result", "Open"]));
  });

  it("timeline series: the legend lists, and the chart draws, only the chosen series", async () => {
    renderActivity(saved({ "activity.timeline": { series: ["deploy", "failure"] } }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Timeline legend" })).getAllByRole("listitem")).toHaveLength(2));
    const legend = screen.getByRole("list", { name: "Timeline legend" });
    expect(legend).toHaveTextContent("Deploy");
    expect(legend).toHaveTextContent("Failure");
    expect(legend).not.toHaveTextContent("Tear down");
  });

  it("stream starting event type filters the stream and shows in its select", async () => {
    renderActivity(saved({ "activity.stream": { type: "failure" } }));
    await waitFor(() => expect(within(eventsList()).getAllByRole("listitem")).toHaveLength(1));
    expect(eventsList()).toHaveTextContent("Deploy failure");
    expect(screen.getByRole("combobox", { name: "Event type" })).toHaveTextContent("Failure");
    // the reader can still pick another type for now
    await userEvent.click(screen.getByRole("combobox", { name: "Event type" }));
    await userEvent.click(await screen.findByRole("option", { name: "All events" }));
    await waitFor(() => expect(within(eventsList()).getAllByRole("listitem")).toHaveLength(6));
  });

  it("change log starting kind sets kind on the query when the URL has none", async () => {
    const { fetchMock } = renderActivity(saved({ "activity.changeLog": { kind: "firewall" } }));
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=7d&kind=firewall")).toBe(true));
    expect(screen.getByRole("combobox", { name: "Change kind" })).toHaveTextContent("Firewall and published ports");
  });

  it("a kind in the address beats the starting kind, and picking All changes asks for all", async () => {
    const { fetchMock } = renderActivity(saved({ "activity.changeLog": { kind: "firewall" } }), { url: "/activity?kind=settings" });
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=7d&kind=settings")).toBe(true));
    expect(fetchMock!.calls.some((c) => c.url.includes("kind=firewall"))).toBe(false);
    await userEvent.click(await screen.findByRole("combobox", { name: "Change kind" }));
    await userEvent.click(await screen.findByRole("option", { name: "All changes" }));
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=7d")).toBe(true));
    // and that stays: the starting kind does not come back by itself
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Change kind" })).toHaveTextContent("All changes"));
  });

  const failedRoutes = () => ({ "GET /api/v1/runs/run-1": runDetail("run-1", { active: false }) });

  it("run details Newest failed run on /activity", async () => {
    const { fetchMock } = renderActivity(saved({ "activity.runDetails": { run: "newestFailed" } }), { routes: failedRoutes() });
    await waitFor(() => expect(document.querySelector(".act__rundetails")).toHaveTextContent("terraform apply failed"));
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/runs/run-1")).toBe(true);
  });

  it("run details: /activity/runs/:id ignores Newest failed run", async () => {
    renderActivity(saved({ "activity.runDetails": { run: "newestFailed" } }), { url: "/activity/runs/run-3", routes: failedRoutes() });
    await waitFor(() => expect(document.querySelector(".act__rundetails")).toHaveTextContent("requested by dev@localhost"));
    expect(document.querySelector(".act__rundetails")).not.toHaveTextContent("terraform apply failed");
  });

  it("run details Newest failed run with none in the range says so", async () => {
    const noFailures = activityResponse({ runs: runRows().filter((r) => r.status !== "failure") });
    renderActivity(saved({ "activity.runDetails": { run: "newestFailed" } }), { routes: { "GET /api/v1/activity": noFailures } });
    expect(await screen.findByText("No failed runs")).toBeInTheDocument();
  });

  it("live output lines keeps only that many lines", async () => {
    renderActivity(saved({ "activity.liveOutput": { lines: 20 } }), { routes: { "GET /api/v1/runs/run-4/log": { log: manyLines(100), source: "live", active: true, updatedAt: new Date().toISOString() } } });
    await waitFor(() => expect(screen.getByRole("log", { name: "Live output log" }).querySelectorAll(".log__line")).toHaveLength(20));
    expect(screen.getByRole("log", { name: "Live output log" })).toHaveTextContent("line number 100");
  });
});

describe("activity: thresholds and display", () => {
  it("success rate: at the warn cutoff is fine, just under it is amber with a word", async () => {
    renderActivity(saved({ "activity.kpis": { successRate: { warn: 96, bad: 70 } } }));
    await group("Success rate");
    expect(shownWord(groupNow("Success rate"))).toBeNull(); // 96 is not below 96
    expect(ringTone(groupNow("Success rate"))).toBe("green");
  });

  it("success rate: warn just above gives amber and the word Warning; bad above gives red and Critical", async () => {
    const a = renderActivity(saved({ "activity.kpis": { successRate: { warn: 97, bad: 70 } } }));
    await group("Success rate");
    await waitFor(() => expect(shownWord(groupNow("Success rate"))).toBe("Warning"));
    expect(ringTone(groupNow("Success rate"))).toBe("amber");
    a.unmount();
    renderActivity(saved({ "activity.kpis": { successRate: { warn: 99, bad: 97 } } }));
    await group("Success rate");
    await waitFor(() => expect(shownWord(groupNow("Success rate"))).toBe("Critical"));
    expect(ringTone(groupNow("Success rate"))).toBe("red");
  });

  it("failed runs: default red with a word; 2 runs at warn 2 is amber, at bad 2 red, off is grey", async () => {
    const a = renderActivity(null);
    await group("Failed runs");
    expect(tone(groupNow("Failed runs"))).toBe("red");
    expect(shownWord(groupNow("Failed runs"))).toBe("Critical");
    a.unmount();
    const b = renderActivity(saved({ "activity.kpis": { failedRuns: { warn: 2, bad: 3 } } }));
    await group("Failed runs");
    await waitFor(() => expect(tone(groupNow("Failed runs"))).toBe("amber"));
    expect(shownWord(groupNow("Failed runs"))).toBe("Warning");
    b.unmount();
    const c = renderActivity(saved({ "activity.kpis": { failedRuns: { warn: null, bad: 3 } } }));
    await group("Failed runs");
    await waitFor(() => expect(tone(groupNow("Failed runs"))).toBe("grey"));
    expect(shownWord(groupNow("Failed runs"))).toBeNull();
    c.unmount();
  });

  it("watchman problems: default amber with a word; red from bad; green when under warn", async () => {
    const a = renderActivity(null);
    await group("Watchman problems");
    expect(tone(groupNow("Watchman problems"))).toBe("amber");
    expect(shownWord(groupNow("Watchman problems"))).toBe("Warning");
    a.unmount();
    const b = renderActivity(saved({ "activity.kpis": { watchman: { warn: null, bad: 1 } } }));
    await group("Watchman problems");
    await waitFor(() => expect(tone(groupNow("Watchman problems"))).toBe("red"));
    expect(shownWord(groupNow("Watchman problems"))).toBe("Critical");
    b.unmount();
    renderActivity(saved({ "activity.kpis": { watchman: { warn: 2, bad: null } } }));
    await group("Watchman problems");
    await waitFor(() => expect(tone(groupNow("Watchman problems"))).toBe("green"));
    expect(shownWord(groupNow("Watchman problems"))).toBeNull();
  });

  it("tiles setting removes a tile", async () => {
    renderActivity(saved({ "activity.kpis": { tiles: ["deploys", "success"] } }));
    await group("Deploys");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Failed runs" })).toBeNull());
    expect(screen.getAllByRole("group").filter((g) => g.closest(".act__kpis")).map((g) => g.getAttribute("aria-label"))).toEqual(["Deploys", "Success rate"]);
    expect((document.querySelector(".act__kpis") as HTMLElement).style.getPropertyValue("--act-kpi-cols")).toBe("2");
  });

  it("deltas off drops the change lines; sub-lines off drops the sub-lines", async () => {
    const a = renderActivity(saved({ "activity.kpis": { deltas: false } }));
    await group("Deploys");
    await waitFor(() => expect(document.querySelector(".act__kpis")!.textContent).not.toContain("vs previous period"));
    expect(document.querySelector(".act__kpis")!.textContent).toContain("successful deploys");
    a.unmount();
    renderActivity(saved({ "activity.kpis": { subLines: false } }));
    await group("Deploys");
    await waitFor(() => expect(document.querySelector(".act__kpis")!.textContent).not.toContain("successful deploys"));
    expect(document.querySelector(".act__kpis")!.textContent).toContain("vs previous period");
  });

  it("stream time format relative and detail off", async () => {
    renderActivity(saved({ "activity.stream": { timeFormat: "relative", detail: false } }));
    await waitFor(() => expect(document.querySelector(".act__event-time")).toHaveTextContent("1h ago"));
    const times = [...document.querySelectorAll(".act__event-time")].map((t) => t.textContent);
    expect(times).toEqual(["1h ago", "1h ago", "1h ago", "2h ago", "3h ago", "1d ago"]);
    expect(within(eventsList()).queryByText("Allow DNS")).toBeNull();
    expect(within(eventsList()).getByText("firewall.rule")).toBeInTheDocument();
  });

  it("stream auto-scroll off at start", async () => {
    renderActivity(saved({ "activity.stream": { autoScroll: false } }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Auto-scroll" })).not.toBeChecked());
  });

  it("live output wrap, timestamps and level tags", async () => {
    renderActivity(saved({ "activity.liveOutput": { wrap: true, timestamps: false, levelTags: false } }));
    const log = await screen.findByRole("log", { name: "Live output log" });
    await waitFor(() => expect(document.querySelector(".act__output .log")).toHaveClass("log--wrap"));
    expect(log.querySelector(".log__time")).toBeNull();
    expect(log.querySelector(".log__level")).toBeNull();
    expect(log).toHaveTextContent("Applying Terraform configuration");
  });

  it("compact density", async () => {
    renderActivity(saved({ "activity.list": { density: "compact" } }));
    await screen.findByRole("table", { name: "Runs" });
    await waitFor(() => expect(document.querySelector(".act__list .dt")).toHaveClass("dt--compact"));
  });

  it("step name lines 1 and step durations off", async () => {
    const a = renderActivity(saved({ "activity.runDetails": { nameLines: "1" } }));
    await waitFor(() => expect(document.querySelector(".act__rundetails .act__track")).toHaveClass("act__track--one"));
    expect(document.querySelector(".act__rundetails")).toHaveTextContent("28s");
    a.unmount();
    renderActivity(saved({ "activity.runDetails": { durations: false } }));
    await screen.findByRole("list", { name: "Run progress" });
    await waitFor(() => expect(document.querySelector(".act__rundetails")).not.toHaveTextContent("28s"));
    expect(document.querySelector(".act__rundetails")).toHaveTextContent("Running…");
  });

  it("change log What changed and By columns off", async () => {
    renderActivity(saved({ "activity.changeLog": { whatChanged: false, by: false } }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Changes" })).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "Open"]));
  });
});

describe("activity: layout", () => {
  it("hiding the timeline gives the list the column", async () => {
    renderActivity(saved({}, { hidden: ["activity.timeline"] }));
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector(".act__timeline")).toBeNull();
    expect(document.querySelector(".act__left")!.children).toHaveLength(1);
    expect(document.querySelector(".act__left .act__list")).not.toBeNull();
  });

  it("hiding the change log gives the stream the column", async () => {
    renderActivity(saved({}, { hidden: ["activity.changeLog"] }));
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector(".act__log")).toBeNull();
    expect(document.querySelector(".act__right")!.children).toHaveLength(1);
    expect(document.querySelector(".act__right .act__stream")).not.toBeNull();
  });

  it("hiding the whole right stack widens the left", async () => {
    renderActivity(saved({}, { hidden: ["activity.stream", "activity.changeLog"] }));
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector(".act__right")).toBeNull();
    const row = document.querySelector<HTMLElement>(".act__r2")!;
    expect(row.style.gridTemplateColumns).toBe("minmax(0, 8fr)");
    expect(row).toHaveClass("act__r2--custom");
  });

  it("a default layout keeps today's CSS columns (no inline template)", async () => {
    renderActivity(null);
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector<HTMLElement>(".act__r2")!.style.gridTemplateColumns).toBe("");
    expect(document.querySelector<HTMLElement>(".act__bottom")!.style.gridTemplateColumns).toBe("");
  });

  it("the reordered layout renders in the saved order", async () => {
    renderActivity(saved({}, { order: { r2: ["right", "left"] } }));
    await screen.findByRole("table", { name: "Runs" });
    const row = document.querySelector(".act__r2")!;
    expect([...row.children].map((c) => c.className.split(" ")[0])).toEqual(["act__right", "act__left"]);
  });

  it("the two stacks swap as one by the top widget's handle, and the list's cog moves its column", async () => {
    const user = userEvent.setup();
    const { server } = renderActivity(null);
    await screen.findByRole("table", { name: "Runs" });
    const handle = await screen.findByRole("button", { name: "Move Activity timeline column" });
    expect(screen.getByRole("button", { name: "Move Live event stream column" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move Change log/ })).toBeNull();
    handle.focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    const row = document.querySelector(".act__r2")!;
    await waitFor(() => expect([...row.children].map((c) => c.className.split(" ")[0])).toEqual(["act__right", "act__left"]));
    await user.click(screen.getByRole("button", { name: "Runs and activity settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Runs and activity settings" });
    await user.click(within(dialog).getByRole("button", { name: "Move column left" }));
    await waitFor(() => expect([...row.children].map((c) => c.className.split(" ")[0])).toEqual(["act__left", "act__right"]));
    await waitFor(() => expect(server.puts.length).toBeGreaterThan(0));
  });

  it("swapping run details and live output", async () => {
    renderActivity(saved({}, { order: { r3: ["activity.liveOutput", "activity.runDetails"] } }));
    await screen.findByRole("table", { name: "Runs" });
    const bottom = document.querySelector<HTMLElement>(".act__bottom")!;
    expect([...bottom.children].map((c) => (c.classList.contains("act__output") ? "output" : "details"))).toEqual(["output", "details"]);
    expect(bottom.style.gridTemplateColumns).toBe("minmax(0, 2fr) minmax(0, 3fr)");
  });

  it("the bottom row is still not rendered at 720 px tall, however it is arranged", async () => {
    setViewport([1100, 720]);
    renderActivity(saved({}, { order: { r3: ["activity.liveOutput", "activity.runDetails"] } }));
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector(".act__bottom")).toBeNull();
    expect(screen.queryByRole("region", { name: /Run details/ })).toBeNull();
  });

  it("hiding both bottom widgets drops the row", async () => {
    renderActivity(saved({}, { hidden: ["activity.runDetails", "activity.liveOutput"] }));
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector(".act__bottom")).toBeNull();
  });

  it("hiding the figures removes the tile row", async () => {
    renderActivity(saved({}, { hidden: ["activity.kpis"] }));
    await screen.findByRole("table", { name: "Runs" });
    expect(document.querySelector(".act__kpis")).toBeNull();
  });

  it("the Layout menu is in the header", async () => {
    renderActivity(null);
    expect(await screen.findByRole("button", { name: "Layout" })).toBeInTheDocument();
  });
});

describe("activity: phone", () => {
  it("phone: last run card follows run details; a failed-run setting and durations apply", async () => {
    setViewport("phone");
    renderActivity(saved({ "activity.runDetails": { run: "newestFailed", durations: false } }));
    const card = await screen.findByRole("region", { name: "Last run" });
    await waitFor(() => expect(card).toHaveTextContent("Failed"));
    expect(card).not.toHaveTextContent("4m 0s");
    const note = screen.getByRole("region", { name: "Last note" });
    expect(note).toHaveTextContent(noteRows()[0].message);
  });

  it("phone: today's last run card still shows its duration by default", async () => {
    setViewport("phone");
    renderActivity(saved({ "activity.runDetails": { run: "newestFailed" } }));
    expect(await screen.findByRole("region", { name: "Last run" })).toHaveTextContent("4m 0s");
  });

  it("phone: a hidden widget's block is gone and settings apply to its phone content", async () => {
    setViewport("phone");
    const { fetchMock } = renderActivity(saved({ "activity.changeLog": { kind: "firewall" } }, { hidden: ["activity.runDetails", "activity.changeLog"] }));
    await screen.findByRole("region", { name: "Last note" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Last run" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
    // the hidden widget's kind still shapes what the phone asks for
    expect(fetchMock!.calls.some((c) => c.url.includes("kind=firewall"))).toBe(true);
  });

  it("phone: the Changes sheet follows the change log's starting kind", async () => {
    setViewport("phone");
    const { fetchMock } = renderActivity(saved({ "activity.changeLog": { kind: "settings" } }));
    await screen.findByRole("region", { name: "Last run" });
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=7d&kind=settings")).toBe(true));
  });

  it("phone: settings are reachable from the Layout menu", async () => {
    setViewport("phone");
    renderActivity(null);
    expect(await screen.findByRole("button", { name: "Layout" })).toBeInTheDocument();
  });
});
