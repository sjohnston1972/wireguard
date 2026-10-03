import "./testSetup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { STEP_NAMES, overview, routes } from "./testData";

const groupedLog = STEP_NAMES.slice(0, 7)
  .map((name, i) => [`##[group]${name}`, `output of step ${i + 1}`, ...(i === 6 ? ["##[warning]slow disk", "##[error]something broke"] : []), "##[endgroup]"].join("\n"))
  .join("\n");

describe("Overview during a run", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clicking a step scrolls the log to its group", async () => {
    const user = userEvent.setup();
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.textContent ?? "");
    });
    renderApp("/", { routes: routes(overview("deploying"), { "GET /api/v1/runs/run-dep/log": { log: groupedLog } }) });
    const log = await screen.findByRole("log", { name: "Deployment log" });
    await within(log).findByText(/output of step 2/);
    const pipeline = screen.getByRole("region", { name: "Deployment pipeline" });
    scrolled.length = 0;
    await user.click(within(pipeline).getByRole("button", { name: /^Parse deployment configuration/ }));
    expect(scrolled.some((t) => t.includes("Parse deployment configuration"))).toBe(true);
    expect(scrolled.some((t) => t.includes("Check out code"))).toBe(false);
  });

  it("the log colours errors and warnings and shows GitHub's groups", async () => {
    renderApp("/", { routes: routes(overview("deploying"), { "GET /api/v1/runs/run-dep/log": { log: groupedLog } }) });
    const log = await screen.findByRole("log", { name: "Deployment log" });
    expect(await within(log).findByText("something broke")).toBeInTheDocument();
    expect(log).toHaveTextContent("ERROR");
    expect(log).toHaveTextContent("WARN");
    expect(log).not.toHaveTextContent("##[");
  });

  it("says Streaming while the run's live log comes in", async () => {
    renderApp("/", { routes: routes(overview("deploying"), { "GET /api/v1/runs/run-dep/log": { log: groupedLog, source: "live", active: true, updatedAt: new Date(Date.now() - 5_000).toISOString() } }) });
    const panel = await screen.findByRole("region", { name: "Live logs" });
    const log = within(panel).getByRole("log", { name: "Deployment log" });
    expect(await within(log).findByText(/output of step 2/)).toBeInTheDocument();
    expect(panel).toHaveTextContent("Streaming");
    expect(panel).not.toHaveTextContent("Stalled");
    expect(panel).not.toHaveTextContent("Waiting for the first lines");
  });

  it("says Stalled (amber), not Streaming, when the run is going but nothing new has arrived for over 30 s", async () => {
    renderApp("/", { routes: routes(overview("deploying"), { "GET /api/v1/runs/run-dep/log": { log: groupedLog, source: "live", active: true, updatedAt: new Date(Date.now() - 45_000).toISOString() } }) });
    const panel = await screen.findByRole("region", { name: "Live logs" });
    expect(await within(panel).findByText(/output of step 2/)).toBeInTheDocument();
    const label = within(panel).getByText("Stalled");
    expect(label.closest(".ov-stream")).toHaveClass("ov-stream--stalled");
    expect(panel).not.toHaveTextContent("Streaming");
  });

  it("before the first lines arrive, the live log says it is waiting instead of showing an error", async () => {
    renderApp("/", { routes: routes(overview("deploying", { snapshot: { log_tail: null } }), { "GET /api/v1/runs/run-dep/log": { log: "", source: "live", active: true, updatedAt: null } }) });
    const panel = await screen.findByRole("region", { name: "Live logs" });
    expect(await within(panel).findByText("Waiting for the first lines from GitHub Actions…")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Streaming");
  });

  it("once the run has finished the full GitHub log is shown, and it no longer says Streaming", async () => {
    renderApp("/", { routes: routes(overview("deploying"), { "GET /api/v1/runs/run-dep/log": { log: groupedLog, source: "github", active: false, updatedAt: null } }) });
    const panel = await screen.findByRole("region", { name: "Live logs" });
    expect(await within(panel).findByText(/output of step 2/)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("Streaming");
    expect(panel).toHaveTextContent("Finished");
  });

  it("without a GitHub log the snapshot's log tail is shown", async () => {
    renderApp("/", { routes: routes(overview("deploying"), { "GET /api/v1/runs/run-dep/log": { status: 404, json: { error: { code: "no_log", message: "This run has no GitHub log." } } } }) });
    const log = await screen.findByRole("log", { name: "Deployment log" });
    expect(await within(log).findByText("azurerm_public_ip.wg: Creating...")).toBeInTheDocument();
  });

  it("step filter chips filter the list", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: routes(overview("deploying")) });
    const pipeline = await screen.findByRole("region", { name: "Deployment pipeline" });
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(12);
    const chips = screen.getByRole("tablist", { name: "Show steps" });
    await user.click(within(chips).getByRole("tab", { name: "Completed (6)" }));
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(6);
    await user.click(within(chips).getByRole("tab", { name: "In progress (1)" }));
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(1);
    expect(pipeline).toHaveTextContent("Apply Terraform configuration");
    await user.click(within(chips).getByRole("tab", { name: "Pending (5)" }));
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(5);
    await user.click(within(chips).getByRole("tab", { name: "All (12)" }));
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(12);
  });

  it("the log polls every 5 s while running and stops after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let o = overview("deploying");
    const r = renderApp("/", { routes: { ...routes(o), "GET /api/v1/overview": () => o } });
    await screen.findByRole("log", { name: "Deployment log" });
    const logs = () => r.fetchMock!.callsTo("GET", "/api/v1/runs/run-dep/log").length;
    await waitFor(() => expect(logs()).toBe(1));
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    expect(logs()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(logs()).toBe(3);

    o = overview("running", { snapshot: { run_id: "run-dep" } });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await screen.findByRole("region", { name: "Last run" });
    const n = logs();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(logs()).toBe(n);
  });

  it("with no run, the last run's steps link to its log", async () => {
    renderApp("/", { routes: routes(overview("running")) });
    const last = await screen.findByRole("region", { name: "Last run" });
    expect(within(last).getAllByRole("listitem")).toHaveLength(12);
    expect(within(last).getByRole("link", { name: "View log" })).toHaveAttribute("href", "/activity/runs/run-ok");
    expect(screen.queryByRole("log", { name: "Deployment log" })).toBeNull();
    expect(screen.getByRole("region", { name: "Network traffic" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Speed test" })).toBeInTheDocument();
  });
});
