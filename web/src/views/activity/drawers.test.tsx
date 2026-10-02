import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { activityRoutes } from "./testkit";

vi.setConfig({ testTimeout: 20_000 });

/** The path and query (the probe is hidden from the accessibility tree while a modal drawer is open). */
const location = () => document.querySelector<HTMLElement>('output[aria-label="location"]')!;
const logCalls = (m: { calls: { url: string }[] } | null, id: string) => m!.calls.filter((c) => c.url === `/api/v1/runs/${id}/log`).length;
/** The refetchInterval a mounted query asks for (false = it does not poll). */
const intervalOf = (client: ReturnType<typeof renderApp>["client"], key: unknown[]) => {
  const query = client.getQueryCache().find({ queryKey: key });
  const every = query?.observers[0]?.options.refetchInterval;
  return typeof every === "function" ? every(query!) : every;
};

describe("Run drawer", () => {
  it("opening a run loads its log once and polls only while active", async () => {
    const done = renderApp("/activity", { routes: activityRoutes() });
    const table = await screen.findByRole("table", { name: "Runs" });
    await userEvent.click(within(table).getByText("est. £0.010")); // run-2, finished

    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Applying Terraform configuration...")).toBeInTheDocument();
    expect(location()).toHaveTextContent("/activity/runs/run-2");
    // The drawer and the page's own log panel share one request.
    expect(logCalls(done.fetchMock, "run-2")).toBe(1);
    expect(intervalOf(done.client, ["runs", "run-2", "log"])).toBe(false);
    expect(intervalOf(done.client, ["runs", "run-2"])).toBe(false);
    done.unmount();

    // The run in progress refreshes every 5 s, its steps and its log.
    const live = renderApp("/activity/runs/run-4", { routes: activityRoutes() });
    const drawer2 = await screen.findByRole("dialog");
    expect(await within(drawer2).findByText("Applying Terraform configuration...")).toBeInTheDocument();
    // (Not "once": on a slow machine the 5 s poll can already have fired.)
    expect(logCalls(live.fetchMock, "run-4")).toBeGreaterThanOrEqual(1);
    expect(intervalOf(live.client, ["runs", "run-4", "log"])).toBe(5000);
    expect(intervalOf(live.client, ["runs", "run-4"])).toBe(5000);
  });

  it("lists the saved steps with durations and the log with its levels", async () => {
    renderApp("/activity/runs/run-4", { routes: activityRoutes() });
    const drawer = await screen.findByRole("dialog");
    const steps = await within(drawer).findByRole("list", { name: "Run steps" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Init"),
      expect.stringContaining("Plan"),
      expect.stringContaining("Apply"),
      expect.stringContaining("Health check"),
    ]);
    expect(steps).toHaveTextContent("1m 0s");
    expect(steps).toHaveTextContent("28s");
    expect(steps).toHaveTextContent("Running");
    const log = await within(drawer).findByRole("log", { name: "Run log" });
    expect(within(log).getByText("[WARN]".replace(/\[|\]/g, ""))).toBeInTheDocument();
    expect(within(log).getByText("ERROR")).toBeInTheDocument();
    expect(within(log).getByText("quota check failed for 203.0.113.9")).toBeInTheDocument();
    // The run's facts.
    expect(drawer).toHaveTextContent("dev@localhost");
    expect(within(drawer).getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.example/runs/4");
  });

  it("a failed run shows its error and a run with no GitHub log says so without asking", async () => {
    const { fetchMock } = renderApp("/activity/runs/run-1", { routes: activityRoutes() });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("terraform apply failed")).toBeInTheDocument();
    expect(within(drawer).getByText(/no GitHub log/i)).toBeInTheDocument();
    expect(logCalls(fetchMock, "run-1")).toBe(0);
  });

  it("shows the API's message when the log cannot be fetched", async () => {
    renderApp("/activity/runs/run-2", {
      routes: activityRoutes({ "GET /api/v1/runs/run-2/log": { status: 503, json: { error: { code: "not_configured", message: "GitHub is not set up, so there is no log to fetch." } } } }),
    });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("GitHub is not set up, so there is no log to fetch.")).toBeInTheDocument();
  });

  it("an unknown run says so", async () => {
    renderApp("/activity/runs/nope", { routes: activityRoutes({ "GET /api/v1/runs/nope": { status: 404, json: { error: { code: "not_found", message: "No such run." } } } }) });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("No such run.")).toBeInTheDocument();
  });

  it("Back closes the run drawer", async () => {
    renderApp("/activity?range=30d", { routes: activityRoutes() });
    const table = await screen.findByRole("table", { name: "Runs" });
    await userEvent.click(within(table).getByText("est. £0.010"));
    const drawer = await screen.findByRole("dialog");
    expect(location()).toHaveTextContent("/activity/runs/run-2?range=30d");

    await userEvent.click(within(drawer).getByRole("button", { name: "Back to activity" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location()).toHaveTextContent(/^\/activity\?range=30d$/);
  });

  it("Close on a drawer opened from a link goes to the activity page, keeping the range", async () => {
    renderApp("/activity/runs/run-2?range=24h", { routes: activityRoutes() });
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location()).toHaveTextContent(/^\/activity\?range=24h$/);
  });
});

describe("Run details and live output", () => {
  it("show the latest run's steps and log tail, and link to the full log", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    const details = await screen.findByRole("region", { name: "Run details" });
    expect(await within(details).findByText("Health check")).toBeInTheDocument();
    expect(within(details).getByText("Running")).toBeInTheDocument();
    const out = screen.getByRole("region", { name: "Live output" });
    expect(await within(out).findByText("azurerm_public_ip.wg: Creating...")).toBeInTheDocument();
    expect(within(out).getByRole("link", { name: /Open in logs/ })).toHaveAttribute("href", "/activity/runs/run-4");
  });

  it("show the opened run instead of the latest", async () => {
    renderApp("/activity/runs/run-2", { routes: activityRoutes() });
    // The drawer is modal, so the page behind it is hidden from the accessibility tree.
    const details = await screen.findByRole("region", { name: "Run details", hidden: true });
    expect(await within(details).findByText("Success")).toBeInTheDocument();
  });

  it("with no runs say there is nothing to show", async () => {
    const { emptyActivity } = await import("./testkit");
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": emptyActivity() }) });
    const details = await screen.findByRole("region", { name: "Run details" });
    expect(within(details).getByText("No runs yet")).toBeInTheDocument();
  });
});

describe("Change drawer", () => {
  it("a change opens with its before and after diff", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    const log = await screen.findByRole("region", { name: "Change log" });
    await userEvent.click(within(log).getByText("firewall.rule"));

    const drawer = await screen.findByRole("dialog");
    expect(location()).toHaveTextContent("change=31");
    expect(within(drawer).getByRole("heading", { name: "firewall.rule" })).toBeInTheDocument();
    expect(drawer).toHaveTextContent("dev@localhost");
    expect(drawer).toHaveTextContent("Allow DNS");
    const diff = within(drawer).getByRole("list", { name: "Changes" });
    const lines = within(diff).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining("removedenabled: 1"), expect.stringContaining("addedenabled: 0"), expect.stringContaining("port: 53")]));

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location()).not.toHaveTextContent("change=");
  });

  it("opens on the change in the address", async () => {
    renderApp("/activity?change=30", { routes: activityRoutes() });
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "settings.autoDestroy" })).toBeInTheDocument();
    // Nothing before, so the only lines are additions.
    expect(within(within(drawer).getByRole("list", { name: "Changes" })).getByText("minutes: 30")).toBeInTheDocument();
  });

  it("a change that is not on the loaded page says so", async () => {
    renderApp("/activity?change=999", { routes: activityRoutes() });
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(/not on this page/i)).toBeInTheDocument();
  });
});
