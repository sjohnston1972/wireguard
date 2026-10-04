// labs.test.tsx
//
// Plain English: Settings -> Labs (Labs spec section 10): how many labs may run
// at once, the default peering tick, the permission check with a tick or a
// cross and a word for the role, users and groups, slots in use, and the
// release tests with a Test button per lab that confirms first.
import "./slow";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LabCard, LabsResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { labDetailFixture, labsFixture } from "@/test/fixtures";
import { routesFor, settingsFixture } from "./testkit";

const base = labDetailFixture().card;
const card = (over: Partial<LabCard>): LabCard => ({ ...base, running: null, ...over });
const passed = { labId: "az104-05-storage", version: 1, at: "2026-10-01T10:00:00.000Z", runId: "lab-test-1", result: "pass" as const, clean: true, deploySeconds: 200, destroySeconds: 150, estGbp: 0.02, leftovers: [] };
const labs = (over: Partial<LabsResponse> = {}): LabsResponse =>
  labsFixture({
    labs: [
      card({ id: "az104-05-storage", number: 5, title: "Storage tiers", released: true, lastReleaseTest: passed }),
      card({ id: "az104-06-blob-security", number: 6, title: "Blob security", released: false, lastReleaseTest: null }),
      card({ id: "az104-07-files", number: 7, title: "Files", released: false, lastReleaseTest: { ...passed, labId: "az104-07-files", result: "fail", clean: false, leftovers: ["rg-lab-az104-07-files"] } }),
    ],
    slots: { used: 2, total: 32 },
    ...over,
  });
const routes = (extra: Record<string, unknown> = {}, l = labs(), settings = settingsFixture()) => ({ ...routesFor(settings), "GET /api/v1/labs": l, ...extra });
const withValues = () => {
  const s = settingsFixture();
  (s.values as unknown as Record<string, unknown>).labsMaxRunning = 3;
  (s.values as unknown as Record<string, unknown>).labsDefaultPeering = true;
  return s;
};

describe("Settings: Labs", () => {
  it("max running and default peering save", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/labs", { routes: routes({ "PUT /api/v1/settings": { ok: true, message: "Settings saved." } }, labs(), withValues()) });
    const max = await screen.findByLabelText(/Labs running at once/);
    expect(max).toHaveValue("3");
    expect(screen.getByRole("switch", { name: /Peer labs to the gateway/ })).toBeChecked();
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    await user.clear(max);
    await user.type(max, "4");
    await user.click(screen.getByRole("switch", { name: /Peer labs to the gateway/ }));
    await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/settings")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/settings")[0]!.body).toEqual({ labs_max_running: "4", labs_default_peering: false });
  });

  it("Check permissions ticks role, users and groups", async () => {
    const user = userEvent.setup();
    let checked = false;
    const ok = { checkedAt: "2026-10-02T11:00:00.000Z", role: true, users: true, groups: false, message: "Graph cannot read groups: grant Group.ReadWrite.All." };
    const { fetchMock } = renderApp("/settings/labs", {
      routes: routes({
        "GET /api/v1/labs": () => labs({ permissions: checked ? ok : { checkedAt: null, role: null, users: null, groups: null, message: null } }),
        "POST /api/v1/labs/permissions/check": () => {
          checked = true;
          return { ok: true, message: "Checked.", permissions: ok };
        },
      }),
    });
    const panel = await screen.findByRole("region", { name: "Permissions" });
    expect(within(panel).getAllByText("not checked yet")).toHaveLength(3);
    await user.click(within(panel).getByRole("button", { name: "Check permissions" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/labs/permissions/check")).toHaveLength(1));
    const role = await within(panel).findByRole("listitem", { name: "Governance role" });
    expect(role).toHaveTextContent("OK");
    expect(within(panel).getByRole("listitem", { name: "Read and write users" })).toHaveTextContent("OK");
    expect(within(panel).getByRole("listitem", { name: "Read and write groups" })).toHaveTextContent("Failed");
    expect(panel).toHaveTextContent("Graph cannot read groups");
  });

  it("slots in use", async () => {
    renderApp("/settings/labs", { routes: routes() });
    const slots = await screen.findByRole("group", { name: "Slots in use" });
    await waitFor(() => expect(slots).toHaveTextContent("2 of 32"));
  });

  it("release tests list with a Test button per lab that confirms first", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/labs", { routes: routes({ "POST /api/v1/labs/az104-06-blob-security/test": { ok: true, message: "Release test started." } }) });
    const list = await screen.findByRole("list", { name: "Release tests" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Passed");
    expect(rows[0]).toHaveTextContent("clean");
    expect(rows[1]).toHaveTextContent("Not tested");
    expect(rows[2]).toHaveTextContent("Failed");
    expect(rows[2]).toHaveTextContent("left behind: rg-lab-az104-07-files");
    await user.click(within(rows[1]).getByRole("button", { name: "Test Blob security" }));
    const dlg = await screen.findByRole("dialog", { name: "Run a release test?" });
    expect(dlg).toHaveTextContent("real Azure");
    expect(fetchMock!.callsTo("POST", "/api/v1/labs/")).toHaveLength(0);
    await user.click(within(dlg).getByRole("button", { name: "Run the test" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/test")).toHaveLength(1));
  });

  it("a test already running disables its Test button", async () => {
    const running = labDetailFixture().card.running!;
    renderApp("/settings/labs", { routes: routes({}, labs({ labs: [card({ id: "az104-06-blob-security", title: "Blob security", running })] })) });
    const list = await screen.findByRole("list", { name: "Release tests" });
    expect(within(list).getByRole("button", { name: "Test Blob security" })).toBeDisabled();
    expect(list).toHaveTextContent("running now");
  });
});
