// Settings → Demo mode (demo mode spec §8.3): the switch, Refresh demo data,
// when it was last refreshed, the server's refusals inline, and a section that
// works even when /settings (or every demo read) fails.
import "./slow";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { demoStatusFixture } from "@/test/fixtures";
import { routesFor } from "./testkit";

const INTRO =
  "Demo mode shows a made-up environment instead of yours: clients, runs, costs, labs and Azure data are all invented. Only you see it; it changes nothing for anyone else. While it is on, actions are off: nothing can deploy, change or delete anything. Your real setup keeps running as normal, and its phone alerts still arrive.";
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const london = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** The section, once GET /demo has answered (its switch is there). */
async function section() {
  const s = await screen.findByRole("region", { name: "Demo mode" });
  await within(s).findByRole("switch", { name: "Show demo data" });
  return s;
}

describe("Settings → Demo mode", () => {
  it("explains demo mode; off, never refreshed, Refresh available", async () => {
    renderApp("/settings/demo", { routes: routesFor() });
    const s = await section();
    expect(within(s).getByText(INTRO)).toBeInTheDocument();
    const sw = within(s).getByRole("switch", { name: "Show demo data" });
    expect(sw).not.toBeChecked();
    expect(within(s).getByText("Last refreshed: Never")).toBeInTheDocument();
    expect(within(s).getByRole("button", { name: "Refresh demo data" })).toBeEnabled();
  });

  it("switching on PUTs { on: true }, says Preparing demo data… meanwhile, then shows on and the banner", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let on = false;
    const { fetchMock } = renderApp("/settings/demo", {
      routes: {
        ...routesFor(),
        "GET /api/v1/demo": () => demoStatusFixture({ on, refreshedAt: on ? iso(Date.now()) : null }),
        "PUT /api/v1/demo": async () => {
          await gate;
          on = true;
          return { ...demoStatusFixture({ on: true, refreshedAt: iso(Date.now()) }), message: "Demo mode is on." };
        },
      },
    });
    const s = await section();
    await user.click(within(s).getByRole("switch", { name: "Show demo data" }));
    expect(await within(s).findByText("Preparing demo data…")).toBeInTheDocument();
    expect(within(s).getByRole("switch", { name: "Show demo data" })).toBeDisabled();
    expect(fetchMock!.callsTo("PUT", "/api/v1/demo")[0]!.body).toEqual({ on: true });
    release();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Demo mode" })).getByRole("switch", { name: "Show demo data" })).toBeChecked());
    expect(await screen.findByRole("status", { name: "Demo mode" })).toBeInTheDocument();
  });

  it("switching off PUTs { on: false }", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/demo", {
      routes: {
        ...routesFor(),
        "GET /api/v1/demo": demoStatusFixture({ on: true, refreshedAt: iso(Date.now() - HOUR) }),
        "PUT /api/v1/demo": { ...demoStatusFixture({ on: false }), message: "Demo mode is off. Showing your real data." },
      },
    });
    const s = await section();
    await waitFor(() => expect(within(s).getByRole("switch", { name: "Show demo data" })).toBeChecked());
    await user.click(within(s).getByRole("switch", { name: "Show demo data" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/demo")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/demo")[0]!.body).toEqual({ on: false });
  });

  it("a refused switch shows the server's words inline and stays off", async () => {
    const user = userEvent.setup();
    const words = "Demo data has used today's refresh allowance. Try again at 00:00 tomorrow.";
    renderApp("/settings/demo", { routes: { ...routesFor(), "PUT /api/v1/demo": { status: 409, json: { error: { code: "demo_busy", message: words } } } } });
    const s = await section();
    await user.click(within(s).getByRole("switch", { name: "Show demo data" }));
    expect(await within(s).findByRole("alert")).toHaveTextContent(words);
    expect(within(s).getByRole("switch", { name: "Show demo data" })).not.toBeChecked();
  });

  it("Last refreshed says how long ago", async () => {
    renderApp("/settings/demo", { routes: { ...routesFor(), "GET /api/v1/demo": demoStatusFixture({ refreshedAt: iso(Date.now() - 2 * HOUR - 60_000) }) } });
    const s = await section();
    expect(await within(s).findByText("Last refreshed: 2 h ago")).toBeInTheDocument();
  });

  it("Refresh is disabled with the reason until nextRefreshAt", async () => {
    const next = Date.now() + 7 * 60_000;
    renderApp("/settings/demo", { routes: { ...routesFor(), "GET /api/v1/demo": demoStatusFixture({ refreshedAt: iso(Date.now() - 3 * 60_000), nextRefreshAt: iso(next) }) } });
    const s = await section();
    const reason = `Demo data can be refreshed again at ${london(next)}.`;
    expect(await within(s).findByText(reason)).toBeInTheDocument();
    const btn = within(s).getByRole("button", { name: "Refresh demo data" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", reason);
  });

  it("Refresh POSTs /demo/refresh; a demo_busy refusal is shown inline with its time", async () => {
    const user = userEvent.setup();
    const words = "Demo data was refreshed less than 10 minutes ago. Try again at 14:32.";
    const { fetchMock } = renderApp("/settings/demo", {
      routes: { ...routesFor(), "POST /api/v1/demo/refresh": { status: 409, json: { error: { code: "demo_busy", message: words } } } },
    });
    const s = await section();
    await user.click(within(s).getByRole("button", { name: "Refresh demo data" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/demo/refresh")).toHaveLength(1));
    expect(await within(s).findByRole("alert")).toHaveTextContent(words);
  });

  it("Refresh success toasts and shows the new time", async () => {
    const user = userEvent.setup();
    let refreshedAt: string | null = null;
    renderApp("/settings/demo", {
      routes: {
        ...routesFor(),
        "GET /api/v1/demo": () => demoStatusFixture({ refreshedAt }),
        "POST /api/v1/demo/refresh": () => {
          refreshedAt = iso(Date.now());
          return { ...demoStatusFixture({ refreshedAt }), message: "Demo data refreshed." };
        },
      },
    });
    const s = await section();
    await user.click(within(s).getByRole("button", { name: "Refresh demo data" }));
    expect(await screen.findByText("Demo data refreshed.")).toBeInTheDocument();
    expect(await within(s).findByText("Last refreshed: 0 s ago")).toBeInTheDocument();
  });

  it("renders at /settings/demo while /settings fails", async () => {
    renderApp("/settings/demo", {
      routes: { ...routesFor(), "GET /api/v1/settings": { status: 503, json: { error: { code: "demo_unavailable", message: "Demo data could not be read." } } } },
    });
    const s = await section();
    expect(within(s).getByRole("switch", { name: "Show demo data" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Demo mode" })).toHaveAttribute("aria-selected", "true");
  });

  it("is the ninth section: a tab on the desktop", async () => {
    renderApp("/settings/overview", { routes: routesFor() });
    await screen.findByRole("tab", { name: "Overview" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Deployment", "Automation", "Security", "Backup & Recovery", "Mobile", "Labs", "Maintenance", "Demo mode"]);
  });

  it("on the phone: a row with its blurb, opening a sheet even while /settings fails", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/settings", { routes: routesFor() });
    const list = await screen.findByRole("list", { name: "Settings sections" });
    const row = within(list).getByRole("button", { name: /Demo mode/ });
    expect(row).toHaveTextContent("Show made-up data for demos");
    await user.click(row);
    const sheet = await screen.findByRole("dialog", { name: "Demo mode" });
    expect(within(sheet).getByRole("switch", { name: "Show demo data" })).toBeInTheDocument();
  });

  it("on the phone at /settings/demo while /settings fails, the sheet still opens", async () => {
    setViewport("phone");
    renderApp("/settings/demo", { routes: { ...routesFor(), "GET /api/v1/settings": { status: 500, json: { error: { code: "x", message: "Broken." } } } } });
    const sheet = await screen.findByRole("dialog", { name: "Demo mode" });
    expect(await within(sheet).findByRole("switch", { name: "Show demo data" })).toBeInTheDocument();
  });
});
