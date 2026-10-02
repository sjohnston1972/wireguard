import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { activityResponse, activityRoutes, changeRows } from "./testkit";

const runsTable = () => screen.findByRole("table", { name: "Runs" });
const stream = () => screen.getByRole("region", { name: "Live event stream" });
const location = () => screen.getByRole("status", { name: "location" });

// The whole page renders in each test, and the machine is shared: give slow ones room.
vi.setConfig({ testTimeout: 20_000 });

/** Drag over the last two of the 28 buckets (the last 12 hours of the 7 days). The chart is 700 units wide with a 30 unit margin. */
async function brushLastTwo() {
  const plot = await screen.findByRole("application", { name: /Activity timeline/ });
  plot.getBoundingClientRect = () => ({ left: 0, width: 700, top: 0, height: 128, right: 700, bottom: 128, x: 0, y: 0, toJSON() {} }) as DOMRect;
  fireEvent.pointerDown(plot, { clientX: 660, pointerId: 1 });
  fireEvent.pointerMove(plot, { clientX: 690, pointerId: 1 });
  fireEvent.pointerUp(plot, { clientX: 690, pointerId: 1 });
}

describe("Activity timeline and tabs", () => {
  it("brushing a window filters the table and the stream, Reset clears", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    const table = await runsTable();
    expect(within(table).getByText("terraform apply failed")).toBeInTheDocument();
    expect(within(stream()).getByText("Deploy failure")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    await brushLastTwo();
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();

    // The failed run is from the day before: outside the window, in the table and in the stream.
    expect(within(table).queryByText("terraform apply failed")).toBeNull();
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3);
    expect(within(stream()).queryByText("Deploy failure")).toBeNull();
    expect(within(stream()).getByText("Torn down")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(within(table).getByText("terraform apply failed")).toBeInTheDocument();
    expect(within(stream()).getByText("Deploy failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  it("the timeline legend names every type", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    const legend = await screen.findByRole("list", { name: "Timeline legend" });
    for (const w of ["Deploy", "Tear down", "Failure", "Config", "Firewall", "Watchman"]) expect(within(legend).getByText(w)).toBeInTheDocument();
  });

  it("tabs switch rows and keep range in the URL", async () => {
    renderApp("/activity?range=30d", { routes: activityRoutes() });
    await runsTable();
    // The mockup's "Firewall events" tab is a filter on Config changes, not a fifth tab.
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Runs", "All activity", "Config changes", "Watchman notes"]);

    await userEvent.click(screen.getByRole("tab", { name: "Config changes" }));
    const changes = await screen.findByRole("table", { name: "Config changes" });
    expect(within(changes).getByText("firewall.rule")).toBeInTheDocument();
    expect(location()).toHaveTextContent("range=30d");
    expect(location()).toHaveTextContent("tab=changes");

    await userEvent.click(screen.getByRole("tab", { name: "Watchman notes" }));
    const notes = await screen.findByRole("table", { name: "Watchman notes" });
    expect(within(notes).getByText("Firewall rules differ from the VM")).toBeInTheDocument();
    expect(within(notes).getByText("drift")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "All activity" }));
    const all = await screen.findByRole("table", { name: "All activity" });
    expect(within(all).getByText("Torn down")).toBeInTheDocument();
    expect(location()).toHaveTextContent("range=30d");

    await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(await runsTable()).toBeInTheDocument();
  });

  it("opens on the tab in the address", async () => {
    renderApp("/activity?tab=notes", { routes: activityRoutes() });
    expect(await screen.findByRole("table", { name: "Watchman notes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Watchman notes" })).toHaveAttribute("aria-selected", "true");
  });

  it("Firewall events is a filter on config changes", async () => {
    const { fetchMock } = renderApp("/activity?tab=changes", { routes: activityRoutes() });
    await screen.findByRole("table", { name: "Config changes" });
    const chip = screen.getByRole("button", { name: "Firewall events" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(chip);
    await waitFor(() => expect(location()).toHaveTextContent("kind=firewall"));
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url.includes("kind=firewall"))).toBe(true));
    expect(screen.getByRole("button", { name: "Firewall events" })).toHaveAttribute("aria-pressed", "true");
  });

  it("changes page forward when more is true", async () => {
    const page = (url: string) => (/page=2/.test(url) ? 2 : 1);
    const { fetchMock } = renderApp("/activity?tab=changes", {
      routes: activityRoutes({
        "GET /api/v1/activity": ({ url }: { url: string }) =>
          page(url) === 1
            ? activityResponse({ changes: { rows: changeRows(), more: true, page: 1, kind: "", q: "" } })
            : activityResponse({
                changes: { rows: [{ id: 5, at: "2026-10-01T09:00:00.000Z", user: "dev@localhost", action: "client.created", target: "198.51.100.4", before_json: null, after_json: null, lines: [] }], more: false, page: 2, kind: "", q: "" },
              }),
      }),
    });
    const nav = await screen.findByRole("navigation", { name: "Config changes pages" });
    expect(within(nav).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await userEvent.click(within(nav).getByRole("button", { name: "Next page" }));

    await waitFor(() => expect(location()).toHaveTextContent("page=2"));
    const table = await screen.findByRole("table", { name: "Config changes" });
    expect(await within(table).findByText("client.created")).toBeInTheDocument();
    expect(fetchMock!.calls.some((c) => /\/activity\?.*page=2/.test(c.url))).toBe(true);
    const nav2 = screen.getByRole("navigation", { name: "Config changes pages" });
    expect(within(nav2).getByRole("button", { name: "Next page" })).toBeDisabled();

    await userEvent.click(within(nav2).getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(location()).not.toHaveTextContent("page=2"));
  });

  it("search narrows the runs table without asking the API", async () => {
    const { fetchMock } = renderApp("/activity", { routes: activityRoutes() });
    const table = await runsTable();
    const before = fetchMock!.calls.length;
    await userEvent.type(screen.getByRole("searchbox", { name: "Search this list" }), "watchman");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("terraform apply failed")).toBeInTheDocument();
    expect(fetchMock!.calls.length).toBe(before);
  });

  it("the change log filters by kind through the API", async () => {
    const { fetchMock } = renderApp("/activity", { routes: activityRoutes() });
    const log = await screen.findByRole("region", { name: "Change log" });
    await userEvent.click(within(log).getByRole("combobox", { name: "Change kind" }));
    await userEvent.click(await screen.findByRole("option", { name: "Clients" }));
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url.includes("kind=client"))).toBe(true));
    expect(location()).toHaveTextContent("kind=client");
  });

  it("the runs table shows each column the spec names", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    const table = await runsTable();
    for (const h of ["When", "Action", "Result", "Duration", "Cost impact", "Actor", "Source", "Notes"]) expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    // Newest first; a running run has no duration or cost, a deploy's cost is marked as an estimate.
    expect(rows[1]).toHaveTextContent("Deploy");
    expect(rows[1]).toHaveTextContent("Running");
    expect(rows[3]).toHaveTextContent("est. £0.010");
    expect(rows[3]).toHaveTextContent("2m 18s");
    expect(rows[2]).toHaveTextContent("auto-destroy");
    expect(rows[4]).toHaveTextContent("Failed");
    expect(rows[4]).toHaveTextContent("watchman");
  });
});
