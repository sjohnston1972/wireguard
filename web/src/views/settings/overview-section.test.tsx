import "./slow";
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { routesFor, runningOverview, settingsFixture } from "./testkit";

const loc = () => screen.getByLabelText("location");
const T0 = "2026-10-02T11:00:00.000Z";
const T1 = "2026-10-02T12:00:30.000Z";

describe("Settings overview section", () => {
  it("health check is disabled unless running, then waits for a newer self-test and shows its result", async () => {
    const user = userEvent.setup();

    // Not running: the button is off, and says why.
    const standby = renderApp("/settings", { routes: routesFor(settingsFixture(), runningOverview({ state: "standby" })) });
    const off = await screen.findByRole("button", { name: "Run health check" });
    expect(off).toBeDisabled();
    expect(screen.getByText("Needs a running VM.")).toBeInTheDocument();
    standby.unmount();

    // Running: ask, wait, then the result.
    let ov = runningOverview({ selftestAt: T0 });
    const { client, fetchMock } = renderApp("/settings", { routes: { ...routesFor(settingsFixture(), ov), "GET /api/v1/overview": () => ov, "POST /api/v1/health-check": { ok: true, message: "Health check requested." } } });
    const btn = await screen.findByRole("button", { name: "Run health check" });
    await waitFor(() => expect(btn).toBeEnabled());
    expect(screen.getByText("Last self-test passed")).toBeInTheDocument();

    await user.click(btn);
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/health-check")).toHaveLength(1));
    expect(await screen.findByText(/Waiting for the VM/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run health check" })).toBeDisabled();

    // The VM has not answered yet: still the old result, so still waiting. Then a newer one arrives.
    ov = runningOverview({ selftestAt: T1 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["overview"] });
    });
    expect(await screen.findByText("Health check passed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run health check" })).toBeEnabled();
  });

  it("a failed health check names what failed", async () => {
    const user = userEvent.setup();
    let ov = runningOverview({ selftestAt: T0 });
    const { client } = renderApp("/settings", { routes: { ...routesFor(), "GET /api/v1/overview": () => ov, "POST /api/v1/health-check": { ok: true, message: "ok" } } });
    await user.click(await screen.findByRole("button", { name: "Run health check" }));
    ov = runningOverview({ selftestAt: T1 });
    (ov.derived as { selftestFailures: string[] }).selftestFailures = ["tunnel DNS"];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["overview"] });
    });
    expect(await screen.findByText("Health check failed: tunnel DNS")).toBeInTheDocument();
  });

  it("a 409 from health check shows its message", async () => {
    const user = userEvent.setup();
    renderApp("/settings", {
      routes: { ...routesFor(settingsFixture(), runningOverview({ selftestAt: T0 })), "POST /api/v1/health-check": { status: 409, json: { error: { code: "conflict", message: "A health check is already running." } } } },
    });
    await user.click(await screen.findByRole("button", { name: "Run health check" }));
    expect(await screen.findByText("A health check is already running.")).toBeInTheDocument();
    // Nothing was asked for, so we are not pretending to wait.
    expect(screen.queryByText(/Waiting for the VM/)).toBeNull();
  });

  it("deployment actions navigate with ?action= and run nothing", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings", { routes: routesFor() });
    await user.click(await screen.findByRole("button", { name: /Deploy \/ Rebuild/ }));
    expect(loc()).toHaveTextContent("/?action=deploy");
    expect(fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("tear down goes to the reviewed form too, and is off when nothing is deployed", async () => {
    const user = userEvent.setup();
    const { fetchMock, unmount } = renderApp("/settings", { routes: routesFor() });
    await user.click(await screen.findByRole("button", { name: "Tear down" }));
    expect(loc()).toHaveTextContent("/?action=destroy");
    expect(fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
    unmount();

    renderApp("/settings", { routes: routesFor(settingsFixture(), runningOverview({ state: "destroyed" })) });
    expect(await screen.findByRole("button", { name: "Tear down" })).toBeDisabled();
  });

  it("each card leads to its section, and gaps are named", async () => {
    const user = userEvent.setup();
    renderApp("/settings", { routes: routesFor() });
    const checklist = await screen.findByRole("list", { name: "Setup checklist" });
    expect(within(checklist).getByText("Missing: CLOUDFLARE_ZONE_ID")).toBeInTheDocument();
    expect(within(checklist).getByText("Phone alerts (optional)")).toBeInTheDocument();
    const backup = screen.getByRole("region", { name: "Backup and recovery" });
    await user.click(within(backup).getByRole("button", { name: "Open" }));
    expect(loc()).toHaveTextContent("/settings/backup");
  });
});
