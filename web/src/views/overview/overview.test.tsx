import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { overview, routes } from "./testData";

const ok = { ok: true, message: "Done." };

async function banner() {
  return screen.findByRole("region", { name: "Status" });
}

describe("Overview status banner", () => {
  it("deploying shows step n of m, elapsed and usually about, never a countdown", async () => {
    renderApp("/", { routes: routes(overview("deploying")) });
    const b = await banner();
    expect(within(b).getByText("Deploying")).toBeInTheDocument();
    expect(b).toHaveTextContent("6 of 12 steps completed");
    expect(within(b).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(b).toHaveTextContent("Elapsed time");
    expect(b).toHaveTextContent(/2m (28|29|30)s/);
    expect(b).toHaveTextContent("usually about 4 min");
    expect(b).not.toHaveTextContent(/remaining|left to go|countdown/i);
  });

  it("Cancel is offered only during a GitHub run", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("deploying"), { "POST /api/v1/cancel": ok }) });
    const b = await banner();
    await user.click(within(b).getByRole("button", { name: "Cancel deploy" }));
    const dlg = await screen.findByRole("dialog", { name: "Cancel the deploy?" });
    expect(r.fetchMock!.callsTo("POST", "/api/v1/cancel")).toHaveLength(0);
    await user.click(within(dlg).getByRole("button", { name: "Cancel the run" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/cancel")).toHaveLength(1));
    r.unmount();

    for (const state of ["running", "standby", "resuming", "hibernating", "destroyed", "failed"] as const) {
      const v = renderApp("/", { routes: routes(overview(state)) });
      const b2 = await banner();
      expect(within(b2).queryByRole("button", { name: /^Cancel/ })).toBeNull();
      v.unmount();
    }
  });

  it("destroyed shows the deploy form; an over-budget deploy needs the confirmation", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("destroyed", { budget: { level: "over", pct: 104, total: 10.4 } }), { "POST /api/v1/deploy": ok }) });
    const b = await banner();
    const form = within(b).getByRole("form", { name: "Deploy" });
    expect(within(form).getByRole("group", { name: "For how long?" })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "4h" })).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("group", { name: "Where?" })).toBeInTheDocument();
    expect(form).toHaveTextContent(/104% of the £10\.00 budget/);
    const deploy = within(form).getByRole("button", { name: "Deploy" });
    expect(deploy).toBeDisabled();

    await user.click(within(form).getByRole("button", { name: "2h" }));
    await user.click(within(form).getByRole("button", { name: "US exit" }));
    await user.click(within(form).getByRole("checkbox", { name: "Deploy anyway, over budget" }));
    expect(deploy).toBeEnabled();
    await user.click(deploy);
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")).toHaveLength(1));
    expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")[0].body).toEqual({ hours: 2, profileId: 2, overBudgetOk: true });
  });

  it("destroyed within budget deploys without the over-budget box", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("destroyed"), { "POST /api/v1/deploy": ok }) });
    const form = within(await banner()).getByRole("form", { name: "Deploy" });
    expect(within(form).queryByRole("checkbox")).toBeNull();
    await user.click(within(form).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")).toHaveLength(1));
    expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")[0].body).toEqual({ hours: 4, profileId: 1, overBudgetOk: false });
  });

  it("running shows Extend, Hibernate, Move, Speed test and Tear down; Tear down needs the typed word", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("running"), { "POST /api/v1/destroy": ok }) });
    const b = await banner();
    for (const name of ["Extend", "Hibernate", "Move", "Speed test", "Tear down"]) expect(within(b).getByRole("button", { name })).toBeInTheDocument();

    await user.click(within(b).getByRole("button", { name: "Tear down" }));
    const dlg = await screen.findByRole("dialog", { name: "Tear down" });
    const go = within(dlg).getByRole("button", { name: "Tear down now" });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText("Type destroy to confirm"), "destro");
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText("Type destroy to confirm"), "y");
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/destroy")).toHaveLength(1));
    expect(r.fetchMock!.callsTo("POST", "/api/v1/destroy")[0].body).toEqual({ confirm: "destroy" });
  });

  it("standby offers Resume and Tear down", async () => {
    renderApp("/", { routes: routes(overview("standby")) });
    const b = await banner();
    expect(within(b).getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: "Tear down" })).toBeInTheDocument();
    expect(within(b).queryByRole("button", { name: "Hibernate" })).toBeNull();
  });

  it("failed links to the failed step's log and offers Clean up", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("failed"), { "POST /api/v1/cleanup": ok }) });
    const b = await banner();
    expect(b).toHaveTextContent("Failed at step 7: Apply Terraform configuration");
    expect(b).toHaveTextContent("Terraform apply failed: SkuNotAvailable");
    expect(within(b).getByRole("link", { name: "View log" })).toHaveAttribute("href", "/activity/runs/run-fail");
    await user.click(within(b).getByRole("button", { name: "Clean up" }));
    const dlg = await screen.findByRole("dialog", { name: "Clean up" });
    await user.click(within(dlg).getByRole("button", { name: "Start clean-up" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/cleanup")).toHaveLength(1));
  });

  it("without GitHub the actions are disabled and say why", async () => {
    renderApp("/", { routes: routes(overview("destroyed", { actions: { canDispatch: false } })) });
    const form = within(await banner()).getByRole("form", { name: "Deploy" });
    expect(within(form).getByRole("button", { name: "Deploy" })).toBeDisabled();
    expect(form).toHaveTextContent("GitHub is not connected");
  });
});
