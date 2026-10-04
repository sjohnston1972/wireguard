// insights.test.tsx
//
// Plain English: the Overview's three Azure insights widgets (spec
// 2026-10-04 section 10.1): VM performance, Azure health and System
// vitals. All are off until turned on; each setting changes what shows;
// thresholds colour with a word; every state says what is going on, and
// "no data" is never drawn as 0.
import "./testSetup";
import { beforeAll, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { AzureMetricsResponse, AzureSummaryResponse, PagePrefs, SettingValue } from "@shared/api";
import { renderApp } from "@/test/render";
import { azureSummaryFixture, feedFixture, vitalsFixture } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { FEEDS } from "@shared/azureMetrics";
import { NOW_MS, merge, overview, prefsRoutes, routes, saved, type State } from "./testData";
import { preloadLazy } from "@/test/lazy";

beforeAll(preloadLazy);

const iso = (ms: number) => new Date(ms).toISOString();
const ON: PagePrefs = { layout: { hidden: ["overview.traffic", "overview.costImpact", "overview.notes"], shown: ["overview.vmPerformance", "overview.azureHealth", "overview.vitals"] } };
const set = (id: string, s: Record<string, SettingValue>) => saved(`overview.${id}`, s);
const withOn = (...ps: PagePrefs[]): PagePrefs => ({ ...merge(...ps), layout: ON.layout });

/** VM metric points: 12 five-minute slots, the last one's figures as given. */
function vmMetrics(range: AzureMetricsResponse["range"] = "24h", last: Record<string, number | null> = {}): AzureMetricsResponse {
  const cols = ["cpu_avg", "cpu_max", "mem_free_min", "net_in", "net_out", "disk_read", "disk_write", "disk_rops", "disk_wops", "credits_min", "credits_used", "avail_avg", "os_iops_max", "os_bw_max"];
  const points = Array.from({ length: 12 }, (_, i) => {
    const p: Record<string, number | string | null> = { t: iso(NOW_MS - (12 - i) * 300_000) };
    for (const c of cols) p[c] = c === "cpu_max" ? 10 + i * 3 : c === "credits_min" ? 120 - i : c === "mem_free_min" ? 400_000_000 : c.startsWith("net") || c.startsWith("disk_r") || c.startsWith("disk_w") ? 1500 + i : 5 + i;
    return i === 11 ? { ...p, ...last } : p;
  });
  return { resource: "vm", range, step: 300, columns: ["t", ...cols], points };
}

function show(o = overview("running"), prefs: PagePrefs = ON, summary: AzureSummaryResponse | null = azureSummaryFixture(), extra: Record<string, unknown> = {}) {
  return renderApp("/", { routes: prefsRoutes(o, prefs, { ...(summary ? { "GET /api/v1/azure/summary": summary } : {}), "GET /api/v1/azure/metrics": ({ url }: { url: string }) => vmMetrics((new URL(url, "http://x").searchParams.get("range") ?? "24h") as "24h"), ...extra }) });
}
const region = (name: string) => screen.findByRole("region", { name });
/** The row of a widget's list named `name`. */
const row = (panel: HTMLElement, name: string) => within(panel).getByText(name, { selector: ".ov-az__name" }).closest("li") as HTMLElement;

describe("with no prefs", () => {
  it("with no prefs overview renders exactly as before", async () => {
    show(overview("running"), {});
    await region("Health summary");
    for (const name of ["VM performance", "Azure health", "System vitals"]) expect(screen.queryByRole("region", { name })).toBeNull();
    for (const name of ["Network traffic", "Cost impact", "Watchman notes"]) expect(screen.getByRole("region", { name })).toBeInTheDocument();
  });
});

describe("VM performance", () => {
  it("range fetches that range", async () => {
    const r = show(overview("running"), withOn(set("vmPerformance", { range: "7d" })));
    await region("VM performance");
    await waitFor(() => expect(r.fetchMock!.calls.some((c) => c.url.includes("/api/v1/azure/metrics?resource=vm&range=7d"))).toBe(true));
  });

  it("charts setting: the default three, or the chosen ones", async () => {
    show();
    const p = await region("VM performance");
    await within(p).findByText("CPU used");
    expect(within(p).getAllByText(/./, { selector: ".ov-az__name" }).map((e) => e.textContent)).toEqual(["CPU used", "Credits left", "Data in / out"]);
  });

  it("charts setting: memory, disk and disk quota", async () => {
    show(overview("running"), withOn(set("vmPerformance", { charts: ["memory", "disk", "diskQuota"] })));
    const p = await region("VM performance");
    await within(p).findByText("Memory free");
    expect(within(p).getAllByText(/./, { selector: ".ov-az__name" }).map((e) => e.textContent)).toEqual(["Memory free", "Disk read / written", "Disk IOPS used"]);
  });

  it("thresholds colour with a word", async () => {
    show(overview("running"), ON, azureSummaryFixture(), { "GET /api/v1/azure/metrics": vmMetrics("24h", { cpu_avg: 96, credits_min: 20 }) });
    const p = await region("VM performance");
    await within(p).findByText("96%");
    const cpu = row(p, "CPU used");
    expect(within(cpu).getByText("Very high")).toBeInTheDocument();
    expect(cpu.querySelector(".ov-az__value--red")).not.toBeNull();
    expect(within(row(p, "Credits left")).getByText("Low")).toBeInTheDocument();
  });

  it("thresholds follow the widget's settings", async () => {
    show(overview("running"), withOn(set("vmPerformance", { cpu: { warn: 5, bad: null } })), azureSummaryFixture(), { "GET /api/v1/azure/metrics": vmMetrics("24h", { cpu_avg: 6 }) });
    const p = await region("VM performance");
    await within(p).findByText("6%");
    expect(within(row(p, "CPU used")).getByText("High")).toBeInTheDocument();
  });

  it("Azure metric names in small print", async () => {
    show();
    const p = await region("VM performance");
    expect(await within(p).findByText("Percentage CPU")).toBeInTheDocument();
  });

  it("Azure metric names off", async () => {
    show(overview("running"), withOn(set("vmPerformance", { azureNames: false })));
    const p = await region("VM performance");
    await within(p).findByText("CPU used");
    expect(within(p).queryByText("Percentage CPU")).toBeNull();
  });

  it("peaks", async () => {
    show(overview("running"), withOn(set("vmPerformance", { peaks: true })));
    const p = await region("VM performance");
    // cpu_max climbs 10, 13, ... 43 over the range.
    expect(await within(p).findByText("peak 43%")).toBeInTheDocument();
  });
});

describe("Azure health", () => {
  const annotated = () =>
    azureSummaryFixture({
      health: { ...azureSummaryFixture().health!, annotations: [1, 2, 3, 4].map((i) => ({ at: iso(NOW_MS - i * 3_600_000), title: `Host repair ${i}` })) },
      maintenance: [{ id: "ev-1", type: "Reboot", status: "Scheduled", notBefore: iso(NOW_MS + 3 * 3_600_000), source: "Platform", description: null, durationS: 900 }],
      serviceIssues: [{ trackingId: "TRK-1", type: "ServiceIssue", status: "Active", level: "Warning", title: "Virtual Machines - UK South - connectivity", summary: null, services: ["Virtual Machines"], startsAt: iso(NOW_MS - 1_800_000), endsAt: null, updatedAt: iso(NOW_MS) }],
    });

  it("health, power, agent, annotations shown", async () => {
    show(overview("running"), ON, annotated());
    const p = await region("Azure health");
    expect(await within(p).findByText("Available")).toBeInTheDocument();
    expect(within(p).getByText("VM running")).toBeInTheDocument();
    expect(within(p).getByText("Ready · 2.11.1.12")).toBeInTheDocument();
    expect(within(p).getAllByText(/^Host repair/)).toHaveLength(3);
  });

  it("annotations shown follows the setting", async () => {
    show(overview("running"), withOn(set("azureHealth", { annotations: 1 })), annotated());
    const p = await region("Azure health");
    await within(p).findByText("Available");
    expect(within(p).getAllByText(/^Host repair/)).toHaveLength(1);
  });

  it("maintenance and service issues toggles", async () => {
    const r = show(overview("running"), ON, annotated());
    let p = await region("Azure health");
    expect(await within(p).findByText(/Reboot/)).toBeInTheDocument();
    expect(within(p).getByText("Virtual Machines - UK South - connectivity")).toBeInTheDocument();
    r.unmount();
    show(overview("running"), withOn(set("azureHealth", { maintenance: false, serviceIssues: false })), annotated());
    p = await region("Azure health");
    await within(p).findByText("Available");
    expect(within(p).queryByText(/Reboot/)).toBeNull();
    expect(within(p).queryByText("Virtual Machines - UK South - connectivity")).toBeNull();
  });

  it("feed ages", async () => {
    const r = show();
    let p = await region("Azure health");
    expect(await within(p).findByText(/Azure health · 2 m ago/)).toBeInTheDocument();
    r.unmount();
    show(overview("running"), withOn(set("azureHealth", { feedAges: false })));
    p = await region("Azure health");
    await within(p).findByText("Available");
    expect(within(p).queryByText(/Azure health · /)).toBeNull();
  });

  it("Azure terms off gives plain words", async () => {
    show(overview("running"), withOn(set("azureHealth", { azureTerms: false })));
    const p = await region("Azure health");
    expect(await within(p).findByText("Healthy")).toBeInTheDocument();
    expect(within(p).queryByText("Available")).toBeNull();
    expect(within(p).getByText("Running")).toBeInTheDocument();
  });
});

describe("System vitals", () => {
  it("rows setting", async () => {
    show(overview("running"), withOn(set("vitals", { rows: ["memory", "internet"] })));
    const p = await region("System vitals");
    await within(p).findByText("Memory");
    expect(within(p).getAllByText(/./, { selector: ".ov-az__name" }).map((e) => e.textContent)).toEqual(["Memory", "Internet"]);
  });

  it("every row by default", async () => {
    show();
    const p = await region("System vitals");
    await within(p).findByText("Memory");
    expect(within(p).getAllByText(/./, { selector: ".ov-az__name" }).map((e) => e.textContent)).toEqual(["Memory", "Disk", "Load", "CPU steal", "Connections", "Uptime", "Updates", "Internet"]);
  });

  it("each threshold", async () => {
    const v = vitalsFixture({
      memUsedPct: 86,
      diskUsedPct: 91,
      load1: 1.2,
      ncpu: 1,
      stealPct: 26,
      conntrack: { count: 75, max: 100 },
      updates: { pending: 4, security: 1, at: iso(NOW_MS) },
      net: { at: iso(NOW_MS), method: "icmp", targets: [{ ip: "1.1.1.1", rttMs: 260, lossPct: 3 }, { ip: "8.8.8.8", rttMs: 20, lossPct: 0 }] },
    });
    show(overview("running"), ON, azureSummaryFixture({ vitals: v }));
    const p = await region("System vitals");
    await within(p).findByText("Memory");
    const word = (name: string) => within(row(p, name)).getAllByText(/High|Very high/).map((e) => e.textContent);
    expect(word("Memory")).toEqual(["High"]);
    expect(word("Disk")).toEqual(["Very high"]);
    expect(word("Load")).toEqual(["High"]);
    expect(word("CPU steal")).toEqual(["Very high"]);
    expect(word("Connections")).toEqual(["High"]);
    expect(word("Updates")).toEqual(["High"]);
    // Internet: latency very high and loss high; the worse word shows.
    expect(word("Internet")).toEqual(["Very high"]);
    expect(within(row(p, "Uptime")).queryByText(/High/)).toBeNull();
  });

  it("bars off", async () => {
    const r = show();
    let p = await region("System vitals");
    await within(p).findByText("Memory");
    expect(within(p).getAllByRole("progressbar").length).toBeGreaterThan(0);
    r.unmount();
    show(overview("running"), withOn(set("vitals", { bars: false })));
    p = await region("System vitals");
    await within(p).findByText("Memory");
    expect(within(p).queryAllByRole("progressbar")).toHaveLength(0);
  });
});

describe("states", () => {
  const notConnected = azureSummaryFixture({ configured: false });
  const feeds = (id: string, over: Parameters<typeof feedFixture>[1]) => FEEDS.map((f) => feedFixture(f.id, f.id === id ? over : {}));

  it("not configured: the Azure widgets say so; vitals still come from the heartbeat", async () => {
    show(overview("running"), ON, { ...notConnected, vitals: vitalsFixture(), agent: "current" });
    for (const name of ["VM performance", "Azure health"]) expect(await within(await region(name)).findByText("Azure isn't connected. Add the service principal secrets to the Worker.")).toBeInTheDocument();
    expect(await within(await region("System vitals")).findByText("Memory")).toBeInTheDocument();
  });

  it("waiting: no first reading yet", async () => {
    show(overview("running"), ON, azureSummaryFixture({ feeds: FEEDS.map((f) => feedFixture(f.id, { status: "idle", lastOkAt: null })), health: null, vitals: null }), { "GET /api/v1/azure/metrics": { ...vmMetrics(), points: [] } });
    expect(await within(await region("VM performance")).findByText("Waiting for the first reading from Azure.")).toBeInTheDocument();
    expect(await within(await region("Azure health")).findByText("Waiting for the first reading from Azure.")).toBeInTheDocument();
    expect(await within(await region("System vitals")).findByText("Waiting for the first heartbeat with vitals.")).toBeInTheDocument();
  });

  it("stale: the last values with the age in amber and a word", async () => {
    show(overview("running"), ON, azureSummaryFixture({ feeds: feeds("health", { lastOkAt: iso(NOW_MS - 3 * 3_600_000) }) }));
    const p = await region("Azure health");
    expect(await within(p).findByText("Available")).toBeInTheDocument();
    const foot = within(p).getByText(/Azure health · 3 h ago/);
    expect(foot.textContent).toMatch(/stale/);
    expect(foot.closest(".ov-az__foot--amber")).not.toBeNull();
  });

  it("needs the next deploy: an old agent, and boot diagnostics off", async () => {
    show(overview("running"), ON, azureSummaryFixture({ agent: "needsDeploy", vitals: null, health: { ...azureSummaryFixture().health!, bootDiagnostics: false } }));
    expect(await within(await region("System vitals")).findByText("Needs the next deploy: this VM's agent is older than these figures.")).toBeInTheDocument();
    expect(await within(await region("Azure health")).findByText("Boot log turns on with the next deploy")).toBeInTheDocument();
  });

  it("nothing running", async () => {
    show(overview("destroyed" as State), ON, azureSummaryFixture({ health: null, vitals: null, agent: "none" }), { "GET /api/v1/azure/metrics": { ...vmMetrics(), points: [] } });
    for (const name of ["VM performance", "Azure health", "System vitals"]) expect(await within(await region(name)).findByText("Nothing running.")).toBeInTheDocument();
  });

  it("error: the last error in plain words next to the last good values", async () => {
    show(overview("running"), ON, azureSummaryFixture({ feeds: feeds("vmMetrics", { status: "error", error: "Azure answered 503: try again later" }) }));
    const p = await region("VM performance");
    expect(await within(p).findByText("CPU used")).toBeInTheDocument();
    expect(within(p).getByText(/Azure answered 503: try again later/)).toBeInTheDocument();
  });
});

describe("phone", () => {
  it("phone: an enabled Azure widget appears as a card after the existing blocks", async () => {
    setViewport("phone");
    show(overview("running"), { layout: { hidden: ["overview.notes"], shown: ["overview.azureHealth"] } });
    const card = await region("Azure health");
    const phone = screen.getByRole("region", { name: "Environment status" });
    expect(phone.contains(card)).toBe(true);
    // After the buttons, the last block of the composition.
    const small = phone.querySelector(".ov-phone__small")!;
    expect(small.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("region", { name: "VM performance" })).toBeNull();
  });
});
