// Demo mode, the visibly disabled actions (spec ruling 18, §8.5): while demo mode
// is on, the primary actions are disabled with the tooltip "Actions are off in
// demo mode"; with it off they work as before. Everything else is stopped by
// the client guard (web/src/api/demo-client.test.tsx).
import "./overview/testSetup";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { demoStatusFixture } from "@/test/fixtures";
import { DEMO_ACTIONS_OFF } from "@/api/demo";
import { overview, routes } from "./overview/testData";
import { clientRoutes } from "./clients/testData";
import { draftData, firewallData } from "./firewall/testData";
import { detailIdle, labs } from "./labs/testData";
import { routesFor } from "./settings/testkit";

const DEMO = { "GET /api/v1/demo": demoStatusFixture({ on: true, refreshedAt: "2026-10-02T11:00:00.000Z" }) };

function expectOff(button: HTMLElement) {
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", DEMO_ACTIONS_OFF);
}

const status = () => screen.findByRole("region", { name: "Status" });
let lastFetch: ReturnType<typeof renderApp>["fetchMock"] = null;
const renderDemo = (...args: Parameters<typeof renderApp>) => {
  const r = renderApp(...args);
  lastFetch = r.fetchMock;
  return r;
};
/** Waits until GET /demo has answered, so buttons are judged with demo mode known (no banner to wait for since 2026-10-08). */
const demoShown = async () => {
  await waitFor(() => expect(lastFetch!.callsTo("GET", "/api/v1/demo").length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 20));
};

describe("Overview action bar", () => {
  it("running: Extend, Hibernate, Move, Speed test and Tear down are off in demo", async () => {
    renderDemo("/", { routes: { ...routes(overview("running")), ...DEMO } });
    await demoShown();
    const b = await status();
    for (const name of ["Extend", "Hibernate", "Move", "Speed test", "Tear down"]) await waitFor(() => expectOff(within(b).getByRole("button", { name })));
  });

  it("running with demo off: Extend works as before", async () => {
    renderDemo("/", { routes: routes(overview("running")) });
    const b = await status();
    expect(within(b).getByRole("button", { name: "Extend" })).toBeEnabled();
    expect(within(b).getByRole("button", { name: "Extend" })).not.toHaveAttribute("title", DEMO_ACTIONS_OFF);
  });

  it("standby: Resume and Tear down are off", async () => {
    renderDemo("/", { routes: { ...routes(overview("standby")), ...DEMO } });
    await demoShown();
    const b = await status();
    for (const name of ["Resume", "Tear down"]) await waitFor(() => expectOff(within(b).getByRole("button", { name })));
  });

  it("failed: Clean up and Deploy again are off", async () => {
    renderDemo("/", { routes: { ...routes(overview("failed")), ...DEMO } });
    await demoShown();
    const b = await status();
    for (const name of ["Clean up", "Deploy again"]) await waitFor(() => expectOff(within(b).getByRole("button", { name })));
  });

  it("deploying: Cancel deploy is off", async () => {
    renderDemo("/", { routes: { ...routes(overview("deploying")), ...DEMO } });
    await demoShown();
    const b = await status();
    await waitFor(() => expectOff(within(b).getByRole("button", { name: "Cancel deploy" })));
  });

  it("destroyed: the deploy form's Deploy is off and says why", async () => {
    renderDemo("/", { routes: { ...routes(overview("destroyed")), ...DEMO } });
    await demoShown();
    const form = within(await status()).getByRole("form", { name: "Deploy" });
    await waitFor(() => expectOff(within(form).getByRole("button", { name: "Deploy" })));
    expect(within(form).getByRole("note")).toHaveTextContent(DEMO_ACTIONS_OFF);
  });

  it("on the phone: the main action and the small action buttons are off; the sheets still open", async () => {
    setViewport("phone");
    renderDemo("/", { routes: { ...routes(overview("running")), ...DEMO } });
    await demoShown();
    const page = await screen.findByRole("region", { name: "Environment status" });
    for (const name of ["Extend", "Hibernate", "Tear down", "Speed", "Move"]) await waitFor(() => expectOff(within(page).getByRole("button", { name })));
    expect(within(page).getByRole("button", { name: "Details" })).toBeEnabled();
  });
});

describe("the lab dialog's Deploy", () => {
  it("is off in demo, with the reason shown", async () => {
    const ID = "az104-06-blob-security";
    await import("@/views/labs");
    renderDemo(`/labs/${ID}`, { routes: { "GET /api/v1/labs": labs(), [`GET /api/v1/labs/${ID}`]: detailIdle(), ...DEMO } });
    await demoShown();
    const d = within(await screen.findByRole("dialog", { name: /Blob security/ }));
    await waitFor(() => expectOff(d.getByRole("button", { name: "Deploy" })));
    expect(d.getByText(DEMO_ACTIONS_OFF)).toBeInTheDocument();
  }, 30_000);
});

describe("Clients' Add client", () => {
  it("is off in demo", async () => {
    renderDemo("/clients", { routes: { ...clientRoutes(), ...DEMO } });
    await demoShown();
    await waitFor(() => expectOff(screen.getAllByRole("button", { name: "Add client" })[0]!));
  });

  it("works with demo off", async () => {
    renderDemo("/clients", { routes: clientRoutes() });
    expect((await screen.findAllByRole("button", { name: "Add client" }))[0]).toBeEnabled();
  });
});

describe("Firewall's Apply draft", () => {
  it("is off in demo", async () => {
    renderDemo("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ draft: draftData() }), ...DEMO } });
    await demoShown();
    const bar = await screen.findByRole("region", { name: "Unpublished changes" });
    fireEvent.click(within(bar).getByRole("button", { name: "Review & apply" }));
    const dialog = await screen.findByRole("dialog", { name: /review/i });
    await waitFor(() => expectOff(within(dialog).getByRole("button", { name: /^Apply / })));
  });
});

describe("a Settings section's Save", () => {
  it("is off in demo", async () => {
    const user = userEvent.setup();
    renderDemo("/settings/automation", { routes: { ...routesFor(), ...DEMO } });
    await demoShown();
    const idle = await screen.findByLabelText(/Idle limit/);
    await user.clear(idle);
    await user.type(idle, "15");
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expectOff(within(bar).getByRole("button", { name: "Save" }));
    expect(within(bar).getByRole("button", { name: "Discard" })).toBeEnabled();
  });
});
