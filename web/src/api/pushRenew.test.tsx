// A phone that renewed its alert subscription while demo mode was on: the
// service worker's POST /push/subscribe was refused (demo mode writes nothing
// real), so sw.js kept the renewal in a "push-renew" notification. The app
// hands it to the dashboard once the data is real again, never before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { demoStatusFixture } from "@/test/fixtures";
import { PUSH_RENEW_TAG } from "./pushRenew";

const RENEW = { subscribe: { endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" }, label: "Android phone (renewed)" }, old: "https://push.example/old" };

let note: { data: unknown; close: ReturnType<typeof vi.fn> };
let asked: unknown[];

beforeEach(() => {
  note = { data: { url: "/settings/demo", actions: [], renew: RENEW }, close: vi.fn() };
  asked = [];
  const reg = {
    getNotifications: async (filter: unknown) => {
      asked.push(filter);
      return note.close.mock.calls.length ? [] : [note];
    },
  };
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => reg } });
});
afterEach(() => {
  delete (window.navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("a push renewal refused in demo mode", () => {
  it("is handed over (subscribe the new, drop the old) once demo mode is turned off, and its notification closed", async () => {
    const user = userEvent.setup();
    let isOn = true;
    const { fetchMock } = renderApp("/settings/demo", {
      routes: {
        "GET /api/v1/demo": () => demoStatusFixture({ on: isOn }),
        "PUT /api/v1/demo": () => {
          isOn = false;
          return { ...demoStatusFixture({ on: false }), message: "Demo mode is off. Showing your real data." };
        },
        "POST /api/v1/push/subscribe": { ok: true },
        "POST /api/v1/push/unsubscribe": { ok: true },
      },
    });
    // No banner since 2026-10-08: demo mode is turned off in Settings → Demo mode.
    const section = await screen.findByRole("region", { name: "Demo mode" });
    const sw = await within(section).findByRole("switch", { name: "Show demo data" });
    await waitFor(() => expect(sw).toBeChecked());
    expect(fetchMock!.callsTo("POST", "/api/v1/push/")).toEqual([]);
    expect(note.close).not.toHaveBeenCalled();

    await user.click(sw);
    await waitFor(() => expect(note.close).toHaveBeenCalled());
    expect(fetchMock!.callsTo("POST", "/api/v1/push/subscribe").map((c) => c.body)).toEqual([RENEW.subscribe]);
    expect(fetchMock!.callsTo("POST", "/api/v1/push/unsubscribe").map((c) => c.body)).toEqual([{ endpoint: RENEW.old }]);
    expect(asked).toContainEqual({ tag: PUSH_RENEW_TAG });
  });

  it("a refused hand-over keeps the notification for next time", async () => {
    const { fetchMock } = renderApp("/", {
      routes: {
        "POST /api/v1/push/subscribe": { status: 503, json: { error: { code: "x", message: "Down." } } },
      },
    });
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/push/subscribe")).toHaveLength(1));
    expect(note.close).not.toHaveBeenCalled();
  });
});
