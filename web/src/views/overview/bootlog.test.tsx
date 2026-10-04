// bootlog.test.tsx
//
// Plain English: the boot log modal (spec 2026-10-04 section 11). It opens
// from the verdict's Boot log link and from Azure health, shows the
// Worker's redacted serial log, fetches a fresh one on request (one a
// minute), says why there is none, and never shows a URL.
import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BootLogResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { azureSummaryFixture } from "@/test/fixtures";
import { overview, prefsRoutes, routes } from "./testData";

const log = (over: Partial<BootLogResponse> = {}): BootLogResponse => ({ fetchedAt: "2026-10-02T11:58:00.000Z", bytes: 2048, truncated: false, redactions: 1, text: "[    0.000000] Linux version 6.8.0-azure\n[    5.100000] cloud-init: password ‹redacted›", reason: null, ...over });
const stale = (extra: Record<string, unknown> = {}) => routes(overview("running", { derived: { heartbeatStale: true } }), { "GET /api/v1/azure/summary": azureSummaryFixture(), ...extra });

async function openFromVerdict() {
  const user = userEvent.setup();
  const panel = await screen.findByRole("region", { name: "Health summary" });
  await user.click(await within(panel).findByRole("button", { name: "Boot log" }));
  return { user, dialog: await screen.findByRole("dialog", { name: "Boot log" }) };
}

describe("Boot log modal", () => {
  it("opens from the verdict", async () => {
    renderApp("/", { routes: stale({ "GET /api/v1/azure/bootlog": log() }) });
    const { dialog } = await openFromVerdict();
    expect(await within(dialog).findByText(/Linux version 6\.8\.0-azure/)).toBeInTheDocument();
  });

  it("opens from Azure health", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: prefsRoutes(overview("running"), { layout: { hidden: ["overview.notes"], shown: ["overview.azureHealth"] } }, { "GET /api/v1/azure/summary": azureSummaryFixture(), "GET /api/v1/azure/bootlog": log() }) });
    const panel = await screen.findByRole("region", { name: "Azure health" });
    await user.click(await within(panel).findByRole("button", { name: "Boot log" }));
    const dialog = await screen.findByRole("dialog", { name: "Boot log" });
    expect(await within(dialog).findByText(/Linux version/)).toBeInTheDocument();
  });

  it("Fetch now posts and shows the redacted text", async () => {
    const r = renderApp("/", { routes: stale({ "GET /api/v1/azure/bootlog": log({ text: null, fetchedAt: null, bytes: 0, reason: "No boot log fetched yet." }), "POST /api/v1/azure/bootlog": log({ text: "[   9.000000] systemd: secret ‹redacted› fresh line" }) }) });
    const { user, dialog } = await openFromVerdict();
    await user.click(within(dialog).getByRole("button", { name: "Fetch now" }));
    expect(await within(dialog).findByText(/fresh line/)).toBeInTheDocument();
    expect(r.fetchMock!.callsTo("POST", "/api/v1/azure/bootlog")).toHaveLength(1);
  });

  it("429 says try again in a minute", async () => {
    renderApp("/", { routes: stale({ "GET /api/v1/azure/bootlog": log(), "POST /api/v1/azure/bootlog": { status: 429, json: { error: { code: "slow_down", message: "Slow down." } } } }) });
    const { user, dialog } = await openFromVerdict();
    await user.click(within(dialog).getByRole("button", { name: "Fetch now" }));
    expect(await within(dialog).findByText(/Try again in a minute/)).toBeInTheDocument();
  });

  it("boot log modal never renders a URL", async () => {
    const sas = "https://md-abc.blob.core.windows.net/x/serial.log?sv=2024&sig=SECRETSIG";
    renderApp("/", { routes: stale({ "GET /api/v1/azure/bootlog": log({ text: `[ 1.0] fetching ${sas}\n[ 2.0] http://198.51.100.9/metadata ok` }) }) });
    const { dialog } = await openFromVerdict();
    await within(dialog).findByText(/fetching/);
    await waitFor(() => expect(dialog.textContent).not.toMatch(/https?:\/\//));
    expect(document.body.innerHTML).not.toContain("SECRETSIG");
    expect(document.body.innerHTML).not.toContain("blob.core.windows.net");
  });

  it("next-deploy reason shown", async () => {
    renderApp("/", { routes: stale({ "GET /api/v1/azure/bootlog": log({ text: null, fetchedAt: null, bytes: 0, redactions: 0, reason: "Boot diagnostics turn on with the next deploy" }) }) });
    const { dialog } = await openFromVerdict();
    expect(await within(dialog).findByText("Boot diagnostics turn on with the next deploy")).toBeInTheDocument();
  });
});
