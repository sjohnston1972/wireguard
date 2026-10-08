// No demo banner (demo mode spec §8.1, amended 2026-10-08 by Steven: "remove the
// demo banner when in demo mode"). Demo mode is turned off in Settings → Demo
// mode; actions stay off (the client guard and the Worker's 409s are unchanged).
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { demoStatusFixture } from "@/test/fixtures";
import { currentSource } from "@/api/client";

const WORDS = "Demo data — nothing here is real. Actions are off.";
const on = () => demoStatusFixture({ on: true, refreshedAt: "2026-10-02T11:00:00.000Z" });

describe("demo mode has no banner", () => {
  for (const path of ["/", "/clients", "/firewall", "/cost", "/labs", "/settings/overview"]) {
    it(`no banner and no Turn off strip on ${path} while demo mode is on`, async () => {
      const { fetchMock } = renderApp(path, { routes: { "GET /api/v1/demo": on() } });
      await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/demo").length).toBeGreaterThan(0));
      // Let the shell settle on the demo answer before looking.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(WORDS)).toBeNull();
      expect(screen.queryByRole("status", { name: "Demo mode" })).toBeNull();
    });
  }

  it("the way out is Settings → Demo mode: the switch PUTs { on: false } and the real data comes back", async () => {
    const user = userEvent.setup();
    let isOn = true;
    const { fetchMock } = renderApp("/settings/demo", {
      routes: {
        "GET /api/v1/demo": () => demoStatusFixture({ on: isOn }),
        "PUT /api/v1/demo": () => {
          isOn = false;
          return { ...demoStatusFixture({ on: false }), message: "Demo mode is off. Showing your real data." };
        },
      },
    });
    const s = await screen.findByRole("region", { name: "Demo mode" });
    const sw = await within(s).findByRole("switch", { name: "Show demo data" });
    expect(sw).toBeChecked();
    await user.click(sw);
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/demo")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/demo")[0]!.body).toEqual({ on: false });
    await waitFor(() => expect(currentSource()).toBe("real"));
  });
});
