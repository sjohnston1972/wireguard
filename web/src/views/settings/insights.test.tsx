// insights.test.tsx
//
// Plain English: Settings → Deployment says whether Azure can give the next
// deploy its VM (a warning only when the check fails, else a quiet line),
// shows where the hourly price comes from, and lets you choose Azure's list
// price or the fixed rates (spec 2026-10-04 sections 2.7 and 10.2).
import "./slow";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapacityCheck, PriceInfo } from "@shared/api";
import { renderApp } from "@/test/render";
import { routesFor, settingsFixture } from "./testkit";

const HOUR = 3_600_000;
const price = (over: Partial<PriceInfo> = {}): PriceInfo => ({
  region: "uksouth",
  size: "Standard_B1s",
  vmGbpPerHour: 0.0093,
  diskGbpPerHour: 0.0027,
  ipGbpPerHour: 0.0037,
  totalGbpPerHour: 0.0157,
  standbyGbpPerHour: 0.0064,
  fetchedAt: "2026-10-04T05:00:00.000Z",
  stale: false,
  source: "azure",
  reason: null,
  ...over,
});
const cap = (over: Partial<CapacityCheck> = {}): CapacityCheck => ({
  region: "uksouth",
  size: "Standard_B1s",
  available: true,
  reason: null,
  vcpusNeeded: 1,
  family: { name: "standardBSFamily", used: 1, limit: 10 },
  total: { used: 1, limit: 10 },
  ok: true,
  message: null,
  fetchedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  ...over,
});
const open = (settings = settingsFixture({ price: price(), rateSource: "azure" }), extra: Record<string, unknown> = {}) =>
  renderApp("/settings/deployment", { routes: { ...routesFor(settings), "GET /api/v1/azure/capacity": cap(), ...extra } });

describe("Settings → Deployment: capacity and price", () => {
  it("Settings → Deployment shows the capacity line and the price line", async () => {
    open();
    expect(await screen.findByText("Available · vCPU quota 1 of 10 used · checked 2 h ago")).toBeInTheDocument();
    expect(screen.getByText("Azure list price, UK South: VM £0.0093 + disk £0.0027 + IP £0.0037 = £0.0157/h (4 Oct)")).toBeInTheDocument();
  });

  it("a failing check shows the warning under region and size", async () => {
    const message = "Standard_B1s isn't offered to this subscription in UK South (NotAvailableForSubscription).";
    open(undefined, { "GET /api/v1/azure/capacity": cap({ available: false, reason: "NotAvailableForSubscription", ok: false, message }) });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/^Available ·/)).toBeNull();
  });

  it("an unknown check shows nothing", async () => {
    open(undefined, { "GET /api/v1/azure/capacity": cap({ available: null, ok: null, family: null, total: null, fetchedAt: null }) });
    await screen.findByText(/Azure list price/);
    expect(screen.queryByText(/vCPU quota|isn't offered/)).toBeNull();
  });

  it("rate_source control saves", async () => {
    const user = userEvent.setup();
    const r = open(undefined, { "PUT /api/v1/settings": { ok: true, message: "Saved." } });
    const control = await screen.findByRole("radiogroup", { name: "Cost estimates use" });
    expect(control).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Fixed rates" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("PUT", "/api/v1/settings")).toHaveLength(1));
    expect(r.fetchMock!.callsTo("PUT", "/api/v1/settings")[0]!.body).toEqual({ rate_source: "fixed" });
  });

  it("stale or missing price explains the fixed fallback", async () => {
    const stale = "The newest Azure price for UK South is over 7 days old, so the fixed rates apply.";
    const r = open(settingsFixture({ rateSource: "azure", price: price({ source: "fixed", stale: true, totalGbpPerHour: 0.0144, standbyGbpPerHour: 0.002, reason: stale }) }));
    expect(await screen.findByText(stale)).toBeInTheDocument();
    expect(screen.getByText(/Fixed rates: £0.0144\/h while running, £0.0020\/h in standby/)).toBeInTheDocument();
    r.unmount();

    const missing = "Azure prices aren't collected yet, so the fixed rates apply.";
    open(settingsFixture({ rateSource: "azure", price: price({ source: "fixed", vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, fetchedAt: null, totalGbpPerHour: 0.0144, standbyGbpPerHour: 0.002, reason: missing }) }));
    expect(await screen.findByText(missing)).toBeInTheDocument();
  });
});
