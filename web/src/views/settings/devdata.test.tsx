// Settings → Dev data (demo mode spec §8.4): the dev server's seed stories,
// present only when GET /demo offers them (devSeed non-null), never on the live site.
import "./slow";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { demoStatusFixture } from "@/test/fixtures";
import { routesFor } from "./testkit";

const SCENARIOS = ["empty", "destroyed", "deploying", "running", "failed", "standby", "busy-month", "insights", "labs", "labs-setup", "everything"];
const dev = () => ({ ...routesFor(), "GET /api/v1/demo": demoStatusFixture({ devSeed: { scenarios: SCENARIOS } }) });

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Command palette" });
}

describe("Settings → Dev data, live site (devSeed null)", () => {
  it("has no tab, and its address falls back to the overview", async () => {
    renderApp("/settings/dev-data", { routes: routesFor() });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByRole("tab", { name: "Dev data" })).toBeNull();
    expect(screen.getByLabelText("location")).toHaveTextContent("/settings/overview");
  });

  it("has no phone row", async () => {
    setViewport("phone");
    renderApp("/settings", { routes: routesFor() });
    const list = await screen.findByRole("list", { name: "Settings sections" });
    await waitFor(() => expect(within(list).getByRole("button", { name: /Demo mode/ })).toBeInTheDocument());
    expect(within(list).queryByRole("button", { name: /Dev data/ })).toBeNull();
  });

  it("has no palette entry", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: routesFor() });
    const dialog = await openPalette(user);
    expect(within(dialog).getByRole("option", { name: "Settings: Demo mode" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: "Settings: Dev data" })).toBeNull();
  });
});

describe("Settings → Dev data, dev server", () => {
  it("lists the eleven stories, each with a description and Seed", async () => {
    renderApp("/settings/dev-data", { routes: dev() });
    const s = await screen.findByRole("region", { name: "Dev data" });
    expect(within(s).getByText("Wipes this PC's local database and loads a story. Dev server only.")).toBeInTheDocument();
    const rows = await within(s).findAllByRole("listitem");
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.querySelector(".set-seed__name")?.textContent)).toEqual(SCENARIOS);
    for (const r of rows) {
      expect(r.querySelector(".set-seed__desc")?.textContent?.length).toBeGreaterThan(10);
      expect(within(r).getByRole("button", { name: /^Seed / })).toBeEnabled();
    }
    expect(screen.getByRole("tab", { name: "Dev data" })).toHaveAttribute("aria-selected", "true");
  });

  it("Seed asks first, then posts, toasts the counts and reads everything again", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/dev-data", {
      routes: { ...dev(), "POST /__dev/seed": { ok: true, scenario: "running", now: "2026-10-02T12:00:00.000Z", counts: { peers: 8, runs: 14 } } },
    });
    const s = await screen.findByRole("region", { name: "Dev data" });
    await user.click(await within(s).findByRole("button", { name: "Seed running" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace the local data with running?" });
    expect(fetchMock!.callsTo("POST", "/__dev/seed")).toHaveLength(0);
    const overviewReads = fetchMock!.callsTo("GET", "/api/v1/settings").length;
    await user.click(within(dialog).getByRole("button", { name: "Seed running" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/__dev/seed")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/__dev/seed")[0]!.url).toBe("/__dev/seed?scenario=running");
    expect(await screen.findByText("Seeded running: peers 8, runs 14")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/settings").length).toBeGreaterThan(overviewReads));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Replace the local data/ })).toBeNull());
  });

  it("a 404 says the seeder only exists on the local dev server", async () => {
    const user = userEvent.setup();
    renderApp("/settings/dev-data", { routes: { ...dev(), "POST /__dev/seed": { status: 404, text: "404 Not Found", contentType: "text/plain" } } });
    const s = await screen.findByRole("region", { name: "Dev data" });
    await user.click(await within(s).findByRole("button", { name: "Seed empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace the local data with empty?" });
    await user.click(within(dialog).getByRole("button", { name: "Seed empty" }));
    expect(await screen.findByText("The seeder only exists on the local dev server.")).toBeInTheDocument();
  });

  it("is a phone row and a palette entry", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: dev() });
    const dialog = await openPalette(user);
    expect(await within(dialog).findByRole("option", { name: "Settings: Dev data" })).toBeInTheDocument();
  });

  it("on the phone: a row with its blurb", async () => {
    setViewport("phone");
    renderApp("/settings", { routes: dev() });
    const list = await screen.findByRole("list", { name: "Settings sections" });
    const row = await within(list).findByRole("button", { name: /Dev data/ });
    expect(row).toHaveTextContent("Load a seed story (dev server only)");
  });
});
