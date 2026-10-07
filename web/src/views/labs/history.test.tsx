// Plan L3.5: Your labs (/labs/history): the sessions table and the coverage map.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabSessionsResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { labCoverageFixture } from "@/test/fixtures";
import { labs, session } from "./testData";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const HERE = dirname(fileURLToPath(import.meta.url));

const sessions = (): LabSessionsResponse => ({
  sessions: [
    session(), // lab 6, running now
    session({
      id: "ls-20261001090000-a5r1",
      labId: "az104-05-storage",
      title: "Storage accounts: redundancy, access tiers, lifecycle",
      state: "ended",
      requestedAt: "2026-10-01T09:00:00.000Z",
      readyAt: "2026-10-01T09:04:00.000Z",
      endedAt: "2026-10-01T10:30:00.000Z",
      costGbp: 0.0123,
      costBasis: "actual",
      endReason: "timer",
      note: "Lifecycle rules take a day to run.",
      outputs: null,
    }),
    session({
      id: "ls-20260930140000-a6r1",
      state: "ended_dirty",
      requestedAt: "2026-09-30T14:00:00.000Z",
      endedAt: "2026-09-30T14:20:00.000Z",
      costGbp: 0.0021,
      costBasis: "estimate",
      endReason: "manual",
      leftovers: ["rg-lab-az104-06-blob-security"],
    }),
  ],
});
const routes = () => ({ "GET /api/v1/labs": labs({ running: [session()] }), "GET /api/v1/labs/sessions": sessions(), "GET /api/v1/labs/coverage": labCoverageFixture() });

describe("Your labs", () => {
  it("sessions table: date, lab, duration, estimate or actual, end reason, note", async () => {
    renderApp("/labs/history", { routes: routes() });
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    const table = within(await screen.findByRole("table", { name: "Sessions" }));
    expect(table.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Date", "Lab", "Duration", "Cost", "Ended", "Note"]);
    await table.findByText("Lifecycle rules take a day to run.");
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const ended = within(rows[1]!);
    expect(ended.getByText("1 Oct, 10:00")).toBeInTheDocument();
    expect(ended.getByText("Storage accounts: redundancy, access tiers, lifecycle")).toBeInTheDocument();
    expect(ended.getByText("1 h 30 min")).toBeInTheDocument();
    expect(ended.getByText("£0.012")).toBeInTheDocument();
    expect(ended.getByText("actual")).toBeInTheDocument();
    expect(ended.getByText("Timer")).toBeInTheDocument();
    const live = within(rows[0]!);
    expect(live.getByText("Running")).toBeInTheDocument();
    expect(live.getByText("estimate")).toBeInTheDocument();
    const dirty = within(rows[2]!);
    expect(dirty.getByText("You tore it down, leftovers")).toBeInTheDocument();
    expect(dirty.getByText("20 min")).toBeInTheDocument();
    // A lab opens its modal over this page.
    expect(ended.getByRole("link", { name: "Storage accounts: redundancy, access tiers, lifecycle" })).toHaveAttribute("href", "/labs/az104-05-storage");
  });

  it("no sessions yet says so", async () => {
    renderApp("/labs/history");
    expect(await screen.findByText("No lab sessions yet")).toBeInTheDocument();
  });

  it("coverage rows per skill area with run over available and a filled box per run lab", async () => {
    renderApp("/labs/history", { routes: routes() });
    const map = within(await screen.findByRole("region", { name: "Coverage" }));
    expect(await map.findByRole("heading", { name: "AZ-104" })).toBeInTheDocument();
    const row = within(map.getByRole("listitem", { name: /Implement and manage storage/ }));
    expect(row.getByText("1 of 2")).toBeInTheDocument();
    const boxes = row.getAllByRole("img");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["Lab 5, Storage accounts: redundancy, access tiers, lifecycle: not run yet", "Lab 6, Blob security: SAS, access policies, private endpoint: run"]);
    expect(boxes.map((b) => b.classList.contains("labs-box--run"))).toEqual([false, true]);
  });

  it("the Catalogue link goes back to the catalogue", async () => {
    const user = userEvent.setup();
    renderApp("/labs/history", { routes: routes() });
    const nav = within(await screen.findByRole("navigation", { name: "Labs pages" }));
    expect(nav.getByRole("link", { name: "Your labs" })).toHaveAttribute("aria-current", "page");
    await user.click(nav.getByRole("link", { name: "Catalogue" }));
    expect(await screen.findByRole("list", { name: "Labs" })).toBeInTheDocument();
  });

  it("/labs/history fits 1100×600", () => {
    const css = readFileSync(join(HERE, "labs.css"), "utf8");
    const desktop = css.match(/@media \(min-width: 1100px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(desktop).toMatch(/\.labs-history\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0/);
    expect(desktop).toMatch(/\.labs-sessions__scroll\s*\{[^}]*overflow:\s*auto/);
    expect(desktop).toMatch(/\.labs-coverage__scroll\s*\{[^}]*overflow:\s*auto/);
  });
});

