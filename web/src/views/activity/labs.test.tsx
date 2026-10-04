// labs.test.tsx
//
// Plain English: lab runs in Activity (Labs spec section 10). A lab run keeps
// a gateway action (apply or destroy) but shows the lab's title and its own
// action, opens the same run drawer, and the Labs chip narrows the list to
// lab runs. Watchman lab notes use the kinds that already exist.
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { activityResponse, activityRoutes, runDetail, runRows } from "./testkit";

vi.setConfig({ testTimeout: 30_000 });

const LAB_ID = "lab-deploy-20261002111500-b6d1";
const labRun = (): ReturnType<typeof runRows>[number] => ({
  id: LAB_ID,
  action: "apply",
  status: "success",
  requested_at: "2026-10-02T11:15:00.000Z",
  requested_by: "dev@localhost",
  started_at: "2026-10-02T11:15:05.000Z",
  finished_at: "2026-10-02T11:19:05.000Z",
  github_run_url: "https://github.example/runs/9",
  public_ip: null,
  reason: null,
  error: null,
  durationSeconds: 240,
  sessionCostGbp: null,
  source: "dashboard",
  lab: { id: "az104-06-blob-security", title: "Blob security", action: "deploy" },
});
const routes = () => {
  const run = labRun();
  return activityRoutes({
    "GET /api/v1/activity": activityResponse({ runs: [run, ...runRows()] }),
    [`GET /api/v1/runs/${LAB_ID}`]: runDetail("run-2", { run, active: false }),
    [`GET /api/v1/runs/${LAB_ID}/log`]: { log: "", source: "github", active: false, updatedAt: null },
  });
};
const runsTable = async () => screen.findByRole("table", { name: "Runs" });

describe("Activity: lab runs", () => {
  it("lab runs show the lab title and open the run drawer", async () => {
    const user = userEvent.setup();
    renderApp("/activity", { routes: routes() });
    const table = await runsTable();
    const row = within(table).getByRole("row", { name: /Deploy lab/ });
    expect(row).toHaveTextContent("Blob security");
    // The gateway runs beside it still read Deploy and Tear down.
    expect(table).toHaveTextContent("Tear down");
    await user.click(row);
    const drawer = await screen.findByRole("dialog");
    expect(drawer).toHaveTextContent("Deploy lab run");
    expect(drawer).toHaveTextContent("Blob security");
  });

  it("the Labs chip filters to lab runs", async () => {
    const user = userEvent.setup();
    renderApp("/activity", { routes: routes() });
    const table = await runsTable();
    const before = within(table).getAllByRole("row").length;
    const chip = screen.getByRole("button", { name: "Labs" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2)); // header + the one lab run
    expect(within(table).getAllByRole("row").length).toBeLessThan(before);
    await user.click(chip);
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(before));
  });

  it("without any lab run the Labs chip is not offered", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    await runsTable();
    expect(screen.queryByRole("button", { name: "Labs" })).toBeNull();
  });

  it("watchman lab notes use existing kinds", async () => {
    const user = userEvent.setup();
    renderApp("/activity?tab=notes", {
      routes: activityRoutes({
        "GET /api/v1/activity": activityResponse({
          notes: [{ id: 21, at: "2026-10-02T11:00:00.000Z", kind: "cost_guard", message: "Lab Blob security ran past its time and was torn down", run_id: null, acknowledged: 0 }],
        }),
      }),
    });
    const table = await screen.findByRole("table", { name: "Watchman notes" });
    expect(table).toHaveTextContent("Lab Blob security ran past its time");
    await user.click(screen.getByRole("combobox", { name: "Filter" }));
    expect(await screen.findAllByRole("option")).toHaveLength(2); // All notes + the one kind that exists: no lab-only kind
  });
});
