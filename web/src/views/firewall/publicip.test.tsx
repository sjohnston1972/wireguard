// publicip.test.tsx
//
// Plain English: the Firewall's Public IP and DDoS widget (spec 2026-10-04
// section 10.1): off until turned on, then in the right-hand column (or its
// tabs when narrow, or a card on the phone). Range and series choose what
// is fetched and shown; availability and dropped packets colour with a
// word; Azure's metric names are in small print; every state says what is
// going on.
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { AzureMetricsResponse, AzureSummaryResponse, FirewallResponse, PagePrefs, SettingValue } from "@shared/api";
import { renderApp } from "@/test/render";
import { azureSummaryFixture, feedFixture, prefsServer } from "@/test/fixtures";
import { FEEDS } from "@shared/azureMetrics";
import { setViewport } from "@/test/viewport";
import { firewallData } from "./testData";
import { preloadLazy } from "@/test/lazy";

beforeAll(preloadLazy);

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const ON: PagePrefs = { layout: { hidden: ["firewall.capture"], shown: ["firewall.publicIp"] } };
const withSettings = (s: Record<string, SettingValue>): PagePrefs => ({ ...ON, widgets: { "firewall.publicIp": { v: 1, s } } });

function pipMetrics(range: AzureMetricsResponse["range"] = "24h", last: Record<string, number | null> = {}): AzureMetricsResponse {
  const cols = ["ddos_max", "pkts_in_ddos", "pkts_drop_ddos", "bytes_in_ddos", "bytes_drop_ddos", "packets", "bytes", "syn", "vip_avail"];
  const points = Array.from({ length: 6 }, (_, i) => {
    const p: Record<string, number | string | null> = { t: new Date(NOW_MS - (6 - i) * 300_000).toISOString() };
    for (const c of cols) p[c] = c === "ddos_max" || c.includes("drop") ? 0 : c === "vip_avail" ? 100 : 1000 + i;
    return i === 5 ? { ...p, ...last } : p;
  });
  return { resource: "pip", range, step: 300, columns: ["t", ...cols], points };
}

function renderFw(prefs: PagePrefs = ON, opts: { data?: FirewallResponse; summary?: AzureSummaryResponse; metrics?: AzureMetricsResponse | null } = {}) {
  const server = prefsServer({ firewall: prefs });
  return renderApp("/firewall", {
    routes: {
      ...server.routes,
      "GET /api/v1/firewall": opts.data ?? firewallData(),
      "GET /api/v1/azure/summary": opts.summary ?? azureSummaryFixture(),
      "GET /api/v1/azure/metrics": ({ url }: { url: string }) => opts.metrics ?? pipMetrics((new URL(url, "http://x").searchParams.get("range") ?? "24h") as "24h"),
    },
  });
}
const panel = () => screen.findByRole("region", { name: "Public IP and DDoS" }, { timeout: 15_000 });
const names = (p: HTMLElement) => within(p).getAllByText(/./, { selector: ".ov-az__name" }).map((e) => e.textContent);
const row = (p: HTMLElement, name: string) => within(p).getByText(name, { selector: ".ov-az__name" }).closest("li") as HTMLElement;

describe("Firewall: Public IP and DDoS", () => {
  it("with no prefs firewall renders exactly as before", async () => {
    setViewport(1600);
    renderFw({});
    expect(await screen.findByRole("region", { name: "Packet capture" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recent drops" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Public IP and DDoS" })).toBeNull();
  });

  it("turned on, it takes the capture's place in the right-hand column", async () => {
    setViewport(1600);
    renderFw();
    const p = await panel();
    expect(p.closest(".fw__right")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Packet capture" })).toBeNull();
  });

  it("range fetches that range", async () => {
    setViewport(1600);
    const r = renderFw(withSettings({ range: "7d" }));
    await panel();
    await waitFor(() => expect(r.fetchMock!.calls.some((c) => c.url.includes("/api/v1/azure/metrics?resource=pip&range=7d"))).toBe(true), { timeout: 10_000 });
  });

  it("series: packets and dropped by default, or the chosen ones", async () => {
    setViewport(1600);
    renderFw();
    let p = await panel();
    await within(p).findByText("Packets");
    expect(names(p)).toEqual(["Data path availability", "Packets", "Dropped by DDoS mitigation"]);
    cleanup();
    renderFw(withSettings({ series: ["bytes", "syn"] }));
    p = await panel();
    await within(p).findByText("Bytes");
    expect(names(p)).toEqual(["Data path availability", "Bytes", "SYN packets"]);
  });

  it("availability threshold colours with a word", async () => {
    setViewport(1600);
    renderFw(ON, { metrics: pipMetrics("24h", { vip_avail: 98.5 }) });
    const p = await panel();
    await within(p).findByText("98.5%");
    expect(within(row(p, "Data path availability")).getByText("Very low")).toBeInTheDocument();
  });

  it("dropped threshold is off by default and colours once set", async () => {
    setViewport(1600);
    renderFw(ON, { metrics: pipMetrics("24h", { pkts_drop_ddos: 2 }) });
    let p = await panel();
    await within(p).findByText("600 per 5 min");
    expect(within(row(p, "Dropped by DDoS mitigation")).queryByText(/High/)).toBeNull();
    cleanup();
    renderFw(withSettings({ dropped: { warn: 100, bad: null } }), { metrics: pipMetrics("24h", { pkts_drop_ddos: 2 }) });
    p = await panel();
    await within(p).findByText("600 per 5 min");
    expect(within(row(p, "Dropped by DDoS mitigation")).getByText("High")).toBeInTheDocument();
  });

  it("under attack says so in words", async () => {
    setViewport(1600);
    renderFw(ON, { metrics: pipMetrics("24h", { ddos_max: 1 }) });
    const p = await panel();
    expect(await within(p).findByText("Under DDoS attack")).toBeInTheDocument();
  });

  it("Azure names in small print, and off", async () => {
    setViewport(1600);
    renderFw();
    let p = await panel();
    expect(await within(p).findByText("VipAvailability")).toBeInTheDocument();
    cleanup();
    renderFw(withSettings({ azureNames: false }));
    p = await panel();
    await within(p).findByText("Packets");
    expect(within(p).queryByText("VipAvailability")).toBeNull();
  });

  it("states: not configured, waiting, nothing running, error", async () => {
    setViewport(1600);
    renderFw(ON, { summary: azureSummaryFixture({ configured: false }) });
    expect(await within(await panel()).findByText("Azure isn't connected. Add the service principal secrets to the Worker.")).toBeInTheDocument();
    cleanup();

    const empty = { ...pipMetrics(), points: [] };
    renderFw(ON, { summary: azureSummaryFixture({ feeds: FEEDS.map((f) => feedFixture(f.id, { status: "idle", lastOkAt: null })) }), metrics: empty });
    expect(await within(await panel()).findByText("Waiting for the first reading from Azure.")).toBeInTheDocument();
    cleanup();

    renderFw(ON, { data: firewallData({ running: false }), metrics: empty });
    expect(await within(await panel()).findByText("Nothing running.")).toBeInTheDocument();
    cleanup();

    renderFw(ON, { summary: azureSummaryFixture({ feeds: FEEDS.map((f) => feedFixture(f.id, f.id === "pipMetrics" ? { status: "error", error: "Azure answered 429: too many requests" } : {})) }) });
    const p = await panel();
    expect(await within(p).findByText("Packets")).toBeInTheDocument();
    expect(within(p).getByText(/Azure answered 429: too many requests/)).toBeInTheDocument();
  });

  it("narrow tabs include publicIp only when shown", async () => {
    setViewport(1200);
    renderFw({});
    let tabs = await screen.findByRole("tablist", { name: /drops/i });
    expect(within(tabs).queryByRole("tab", { name: /Public IP/ })).toBeNull();
    cleanup();
    renderFw();
    tabs = await screen.findByRole("tablist", { name: "Drops, published ports and public IP" });
    expect(within(tabs).getByRole("tab", { name: /Public IP/ })).toBeInTheDocument();
    expect(within(tabs).queryByRole("tab", { name: /Capture/ })).toBeNull();
  });

  it("phone: an enabled Azure widget appears as a card after the existing blocks", async () => {
    setViewport("phone");
    renderFw();
    const p = await panel();
    const more = document.querySelector(".fw-ph__more")!;
    expect(more.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
