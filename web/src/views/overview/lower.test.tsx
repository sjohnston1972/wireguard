import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { NOW_MS, cost, overview, routes, session } from "./testData";

const iso = (ms: number) => new Date(ms).toISOString();
const notes = [
  { id: 11, at: iso(NOW_MS - 600_000), kind: "watchman", message: "Heartbeat late for 3 minutes", run_id: null, acknowledged: 0 },
  { id: 12, at: iso(NOW_MS - 300_000), kind: "watchman", message: "Self-test failed: tunnel DNS", run_id: null, acknowledged: 0 },
];

describe("Overview lower row", () => {
  it("acknowledging notes calls notes/ack and hides them", async () => {
    const user = userEvent.setup();
    let acked = false;
    const r = renderApp("/", {
      routes: routes(overview("running"), {
        "GET /api/v1/session": () => session(acked ? [] : notes),
        "POST /api/v1/notes/ack": () => {
          acked = true;
          return { ok: true, message: "ok" };
        },
      }),
    });
    const panel = await screen.findByRole("region", { name: "Watchman notes" });
    expect(await within(panel).findByText("Self-test failed: tunnel DNS")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Heartbeat late for 3 minutes");
    await user.click(within(panel).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/notes/ack")).toHaveLength(1));
    await waitFor(() => expect(within(panel).queryByText("Self-test failed: tunnel DNS")).toBeNull());
    expect(panel).toHaveTextContent("No unread notes");
  });

  it("?action=deploy opens the deploy form and runs nothing", async () => {
    const user = userEvent.setup();
    const r = renderApp("/?action=deploy", { routes: routes(overview("destroyed")) });
    const dlg = await screen.findByRole("dialog", { name: "Deploy" });
    expect(within(dlg).getByRole("form", { name: "Deploy" })).toBeInTheDocument();
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/$/);
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("?action=deploy&profile=<id> (Settings' Use) pre-selects that profile and drops both parameters on close", async () => {
    const user = userEvent.setup();
    const r = renderApp("/?action=deploy&profile=2", { routes: routes(overview("destroyed")) });
    const dlg = await screen.findByRole("dialog", { name: "Deploy" });
    expect(within(dlg).getByRole("button", { name: "US exit" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dlg).getByRole("button", { name: "UK" })).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/$/);
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("?action=deploy&profile=<unknown id> keeps the usual choice", async () => {
    renderApp("/?action=deploy&profile=99", { routes: routes(overview("destroyed")) });
    const dlg = await screen.findByRole("dialog", { name: "Deploy" });
    expect(within(dlg).getByRole("button", { name: "UK" })).toHaveAttribute("aria-pressed", "true");
  });

  it("?action=destroy opens the typed confirmation and runs nothing", async () => {
    const r = renderApp("/?action=destroy", { routes: routes(overview("running")) });
    const dlg = await screen.findByRole("dialog", { name: "Tear down" });
    expect(within(dlg).getByRole("button", { name: "Tear down now" })).toBeDisabled();
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("?action= that the state does not allow opens nothing and says why", async () => {
    const r = renderApp("/?action=deploy", { routes: routes(overview("running")) });
    expect(await screen.findByText("Deploy is not available while the VM is Running.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("health summary lists each check with its age", async () => {
    renderApp("/", { routes: routes(overview("running")) });
    const h = await screen.findByRole("region", { name: "Health summary" });
    expect(h).toHaveTextContent("All systems healthy");
    for (const name of ["VM reachable", "WireGuard service", "DNS resolving", "Tunnel connectivity", "Self-test"]) expect(within(h).getByRole("listitem", { name: new RegExp(`^${name}: OK`) })).toBeInTheDocument();
    expect(within(h).getByRole("listitem", { name: /^VM reachable/ })).toHaveTextContent("3 s ago");
    expect(within(h).getByRole("listitem", { name: /^Self-test/ })).toHaveTextContent("1 h ago");
  });

  it("health summary says no data when nothing runs", async () => {
    renderApp("/", { routes: routes(overview("destroyed")) });
    const h = await screen.findByRole("region", { name: "Health summary" });
    expect(h).not.toHaveTextContent("healthy");
    expect(within(h).getByRole("listitem", { name: /^VM reachable: no data/ })).toBeInTheDocument();
  });

  it("cost impact shows the session estimate against a typical session and links to Cost", async () => {
    const sessions = [0.05, 0.03, 0.04].map((g, i) => ({ runId: `r${i}`, started: iso(NOW_MS - (i + 1) * 86_400_000), ended: iso(NOW_MS - (i + 1) * 86_000_000), durationSeconds: 3600, region: "uksouth", vmSize: "Standard_B1s", estimatedGbp: g, perHourGbp: 0.01, stillRunning: false }));
    renderApp("/", { routes: routes(overview("running"), { "GET /api/v1/cost": cost({ session: { running: true, since: iso(NOW_MS - 7_200_000), estimateGbp: 0.02 }, sessions }) }) });
    const c = await screen.findByRole("region", { name: "Cost impact" });
    expect(await within(c).findByText("£0.02")).toBeInTheDocument();
    expect(c).toHaveTextContent("~£0.04");
    expect(c).toHaveTextContent("typical session");
    expect(within(c).getByRole("link", { name: /View cost details/ })).toHaveAttribute("href", "/cost");
  });

  it("recent events show the latest from activity with a link to all", async () => {
    renderApp("/", { routes: routes(overview("running")) });
    const ev = await screen.findByRole("region", { name: "Recent events" });
    expect(await within(ev).findByText("Deployed")).toBeInTheDocument();
    expect(ev).toHaveTextContent("Client added");
    expect(within(ev).getByRole("link", { name: /View all/ })).toHaveAttribute("href", "/activity");
  });
});
