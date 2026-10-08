// The demo banner (demo mode spec §8.1): on every page while demo mode is on,
// with the exact words and a Turn off that works even when the rest fails.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { demoStatusFixture } from "@/test/fixtures";
import { currentSource } from "@/api/client";

const WORDS = "Demo data — nothing here is real. Actions are off.";
const on = () => demoStatusFixture({ on: true, refreshedAt: "2026-10-02T11:00:00.000Z" });

describe("DemoBanner", () => {
  it("is not shown while demo mode is off", async () => {
    const { fetchMock } = renderApp("/");
    await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/demo").length).toBeGreaterThan(0));
    await waitFor(() => expect(currentSource()).toBe("real"));
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  for (const path of ["/", "/clients", "/labs", "/settings/overview"]) {
    it(`shows the exact words on ${path} while demo mode is on, as a status`, async () => {
      renderApp(path, { routes: { "GET /api/v1/demo": on() } });
      const banner = await screen.findByRole("status", { name: "Demo mode" });
      expect(banner).toHaveTextContent(WORDS);
      expect(within(banner).getByRole("button", { name: "Turn off" })).toBeEnabled();
    });
  }

  it("Turn off PUTs { on: false }; the banner goes and the real data comes back", async () => {
    const user = userEvent.setup();
    let isOn = true;
    const { fetchMock } = renderApp("/", {
      routes: {
        "GET /api/v1/demo": () => demoStatusFixture({ on: isOn }),
        "PUT /api/v1/demo": () => {
          isOn = false;
          return { ...demoStatusFixture({ on: false }), message: "Demo mode is off. Showing your real data." };
        },
      },
    });
    const banner = await screen.findByRole("status", { name: "Demo mode" });
    await user.click(within(banner).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/demo")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/demo")[0]!.body).toEqual({ on: false });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Demo mode" })).toBeNull());
    expect(await screen.findByText("Demo mode is off. Showing your real data.")).toBeInTheDocument();
    expect(currentSource()).toBe("real");
  });

  it("Turn off still works when /settings and the overview fail", async () => {
    const user = userEvent.setup();
    const broken = { status: 503, json: { error: { code: "demo_unavailable", message: "Demo data could not be read. Turn demo mode off or refresh it in Settings." } } };
    const { fetchMock } = renderApp("/settings/overview", {
      routes: {
        "GET /api/v1/demo": on(),
        "GET /api/v1/settings": broken,
        "GET /api/v1/overview": broken,
        "GET /api/v1/session": broken,
        "PUT /api/v1/demo": { ...demoStatusFixture({ on: false }), message: "Demo mode is off. Showing your real data." },
      },
    });
    const banner = await screen.findByRole("status", { name: "Demo mode" });
    await user.click(within(banner).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/demo")).toHaveLength(1));
  });

  it("a failed Turn off says why", async () => {
    const user = userEvent.setup();
    renderApp("/", {
      routes: {
        "GET /api/v1/demo": on(),
        "PUT /api/v1/demo": { status: 503, json: { error: { code: "demo_unknown", message: "Could not check demo mode. Try again." } } },
      },
    });
    const banner = await screen.findByRole("status", { name: "Demo mode" });
    await user.click(within(banner).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("Could not check demo mode. Try again.")).toBeInTheDocument();
  });
});
