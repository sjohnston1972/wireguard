// azure.test.tsx
//
// Plain English: the Activity page's Azure parts (insights spec 10.1): the
// Azure change log widget, the Change log's "Include Azure changes" opt-in,
// and the Azure service health widget. All are off until turned on; with
// nothing saved the page is today's page.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PagePrefs } from "@shared/api";
import { widgetDef } from "@shared/widgets";
import { renderApp } from "@/test/render";
import { azureSummaryFixture, prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { activityRoutes } from "./testkit";
import { azChangesResponse, azRoutes, healthEvents, healthResponse, issue, turnedOn } from "./azureKit";

vi.setConfig({ testTimeout: 20_000 });

function renderActivity(prefs: PagePrefs | null, routes: Record<string, unknown> = {}, url = "/activity") {
  const server = prefsServer(prefs ? { activity: prefs } : {});
  const r = renderApp(url, { routes: activityRoutes({ ...server.routes, ...azRoutes(), ...routes }) });
  return { ...r, server };
}

const AZ_LOG = ["activity.azureChanges", "activity.changeLog"] as const;
const AZ_HEALTH = ["activity.serviceHealth", "activity.liveOutput"] as const;
const changes = () => within(screen.getByRole("table", { name: "Azure changes" }));
const bodyRows = (t: ReturnType<typeof changes>) => t.getAllByRole("row").slice(1);

describe("activity: Azure widgets are off by default", () => {
  it("with no prefs activity renders exactly as before", async () => {
    const { fetchMock } = renderActivity(null);
    await screen.findByRole("table", { name: "Runs" });
    expect(screen.getByRole("table", { name: "Changes" })).toBeInTheDocument();
    expect(screen.queryByText("Azure change log")).toBeNull();
    expect(screen.queryByText("Azure service health")).toBeNull();
    expect(fetchMock!.calls.some((c) => /azure\/(changes|service-health)/.test(c.url))).toBe(false);
    const changesTable = within(screen.getByRole("table", { name: "Changes" }));
    expect(changesTable.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "What changed", "By", "Open"]);
    expect(screen.queryByText("Azure")).toBeNull();
  });
});

describe("activity: Azure change log widget", () => {
  it("shows Azure's changes in a table, newest first, named in plain words", async () => {
    renderActivity(turnedOn(...AZ_LOG));
    const t = await screen.findByRole("table", { name: "Azure changes" });
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "What", "Status", "Caller", "Open"]);
    const rows = bodyRows(changes());
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Changed network security group");
    expect(rows[0]).toHaveTextContent("wg-nsg");
    expect(rows[1]).toHaveTextContent("Started virtual machine");
    expect(rows[3]).toHaveTextContent("Deleted public IP");
    // the Change log it would replace is hidden in this fixture, so the stack has room
    expect(screen.queryByRole("table", { name: "Changes" })).toBeNull();
  });

  it("range, who and types filter the query and rows", async () => {
    const { fetchMock } = renderActivity(turnedOn(...AZ_LOG, { range: "30d", who: "others", types: ["nsg", "disk"] }));
    await screen.findByRole("table", { name: "Azure changes" });
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/azure/changes?range=30d&who=others")).toBe(true);
    const rows = bodyRows(changes());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("wg-nsg");
    expect(rows[1]).toHaveTextContent("wg-disk");
  });

  it("failed only", async () => {
    renderActivity(turnedOn(...AZ_LOG, { failedOnly: true }));
    await screen.findByRole("table", { name: "Azure changes" });
    const rows = bodyRows(changes());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("wg-disk");
    expect(rows[0]).toHaveTextContent("Failed");
  });

  it("status and caller columns", async () => {
    renderActivity(turnedOn(...AZ_LOG, { status: false, caller: false }));
    await screen.findByRole("table", { name: "Azure changes" });
    expect(changes().getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "What", "Open"]);
    expect(screen.queryByText("Succeeded")).toBeNull();
  });

  it("wg-admin rows are labelled wg-admin and portal changes show the person", async () => {
    renderActivity(turnedOn(...AZ_LOG));
    await screen.findByRole("table", { name: "Azure changes" });
    const rows = bodyRows(changes());
    expect(rows[0]).toHaveTextContent("someone@example.net");
    expect(rows[1]).toHaveTextContent("wg-admin");
    expect(rows[3]).toHaveTextContent("Azure");
    // words with colour: the status is a word in a pill
    expect(within(rows[0]).getByText("Succeeded")).toBeInTheDocument();
  });

  it("a row opens its details in the modal", async () => {
    renderActivity(turnedOn(...AZ_LOG));
    await screen.findByRole("table", { name: "Azure changes" });
    await userEvent.click(bodyRows(changes())[0]);
    const dialog = await screen.findByRole("dialog", { name: /Changed network security group/ });
    expect(dialog).toHaveTextContent("someone@example.net");
    expect(dialog).toHaveTextContent("Microsoft.Network/networkSecurityGroups/securityRules/write");
  });

  it("states: loading, error, not connected, empty and a stale or failing feed", async () => {
    // not connected
    const nc = azChangesResponse({ rows: [], feed: { id: "activity", title: "Activity log", status: "not_configured", lastOkAt: null, error: null, cadenceMin: 5 } });
    const a = renderActivity(turnedOn(...AZ_LOG), { "GET /api/v1/azure/changes": nc });
    expect(await screen.findByText("Azure isn't connected")).toBeInTheDocument();
    a.unmount();
    // empty
    const b = renderActivity(turnedOn(...AZ_LOG), { "GET /api/v1/azure/changes": azChangesResponse({ rows: [] }) });
    expect(await screen.findByText("No Azure changes")).toBeInTheDocument();
    b.unmount();
    // feed failing: the last rows stay, with the reason in words
    const failing = azChangesResponse({ feed: { id: "activity", title: "Activity log", status: "error", lastOkAt: null, error: "Azure refused the request", cadenceMin: 5 } });
    const c = renderActivity(turnedOn(...AZ_LOG), { "GET /api/v1/azure/changes": failing });
    expect(await screen.findByText(/Azure refused the request/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Azure changes" })).toBeInTheDocument();
    c.unmount();
    // request error
    renderActivity(turnedOn(...AZ_LOG), { "GET /api/v1/azure/changes": () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }) });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("activity: Change log opt-in", () => {
  it("off by default leaves the change log unchanged", async () => {
    const { fetchMock } = renderActivity(null);
    const t = await screen.findByRole("table", { name: "Changes" });
    expect(within(t).getAllByRole("row")).toHaveLength(3);
    expect(fetchMock!.calls.some((c) => /azure\/(changes|service-health)/.test(c.url))).toBe(false);
  });

  it("Include Azure changes merges Azure rows tagged Azure in time order", async () => {
    const { fetchMock } = renderActivity({ widgets: { "activity.changeLog": { v: widgetDef("activity.changeLog")!.version, s: { azure: true } } } });
    const t = await screen.findByRole("table", { name: "Changes" });
    await waitFor(() => expect(within(t).getAllByRole("row")).toHaveLength(1 + 2 + 4));
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/azure/changes?range=7d&who=all")).toBe(true);
    const rows = within(t).getAllByRole("row").slice(1);
    expect(rows.map((r) => (/wg-nsg|wg-vm|firewall.rule|settings\.autoDestroy|wg-disk|wg-ip/.exec(r.textContent ?? "") ?? [""])[0])).toEqual(["wg-nsg", "wg-vm", "firewall.rule", "settings.autoDestroy", "wg-disk", "wg-ip"]);
    expect(within(rows[0]).getByText("Azure")).toBeInTheDocument();
    expect(within(rows[2]).queryByText("Azure")).toBeNull();
    // an Azure row opens the Azure details, a dashboard row the usual drawer
    await userEvent.click(rows[0]);
    expect(await screen.findByRole("dialog", { name: /Changed network security group/ })).toBeInTheDocument();
  });
});

describe("activity: Azure service health widget", () => {
  const rows = () => within(screen.getByRole("list", { name: "Azure service events" })).getAllByRole("listitem");

  it("active first, then resolved, each with a word for its state", async () => {
    renderActivity(turnedOn(...AZ_HEALTH));
    await screen.findByRole("list", { name: "Azure service events" });
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toHaveTextContent("Active issue");
    expect(rows()[0]).toHaveTextContent("Virtual Machines: connectivity problems");
    expect(rows()[1]).toHaveTextContent("Resolved");
    expect(rows()[2]).toHaveTextContent("Maintenance done");
  });

  it("an error-level issue reads Severe issue", async () => {
    renderActivity(turnedOn(...AZ_HEALTH), { "GET /api/v1/azure/service-health": healthResponse([issue({ level: "Error" })]) });
    await screen.findByRole("list", { name: "Azure service events" });
    expect(rows()[0]).toHaveTextContent("Severe issue");
  });

  it("range and types", async () => {
    const { fetchMock } = renderActivity(turnedOn(...AZ_HEALTH, { range: "90d", types: ["issue"] }));
    await screen.findByRole("list", { name: "Azure service events" });
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/azure/service-health?range=90d")).toBe(true);
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText("Planned: host update")).toBeNull();
  });

  it("summaries toggle", async () => {
    const on = renderActivity(turnedOn(...AZ_HEALTH));
    expect(await screen.findByText("Some VMs in UK South may fail to start.")).toBeInTheDocument();
    on.unmount();
    renderActivity(turnedOn(...AZ_HEALTH, { summaries: false }));
    await screen.findByRole("list", { name: "Azure service events" });
    expect(screen.queryByText("Some VMs in UK South may fail to start.")).toBeNull();
  });

  it("region named in plain words", async () => {
    renderActivity(turnedOn(...AZ_HEALTH), { "GET /api/v1/azure/service-health": healthResponse([]) });
    expect(await screen.findByText(/No Azure issues or maintenance in UK South/)).toBeInTheDocument();
  });

  it("an event opens its details in the modal", async () => {
    renderActivity(turnedOn(...AZ_HEALTH));
    await screen.findByRole("list", { name: "Azure service events" });
    await userEvent.click(within(rows()[0]).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "Virtual Machines: connectivity problems" });
    expect(dialog).toHaveTextContent("TRK-1");
    expect(dialog).toHaveTextContent("Some VMs in UK South may fail to start.");
  });

  it("states: not connected and a failing feed", async () => {
    const nc = healthResponse([], { feed: { id: "serviceHealth", title: "Service Health", status: "not_configured", lastOkAt: null, error: null, cadenceMin: 15 } });
    const a = renderActivity(turnedOn(...AZ_HEALTH), { "GET /api/v1/azure/service-health": nc });
    expect(await screen.findByText("Azure isn't connected")).toBeInTheDocument();
    a.unmount();
    const bad = healthResponse(healthEvents(), { feed: { id: "serviceHealth", title: "Service Health", status: "error", lastOkAt: null, error: "Sign-in to Azure failed", cadenceMin: 15 } });
    renderActivity(turnedOn(...AZ_HEALTH), { "GET /api/v1/azure/service-health": bad });
    expect(await screen.findByText(/Sign-in to Azure failed/)).toBeInTheDocument();
  });
});

describe("activity: Azure widgets on the phone", () => {
  it("phone: enabled widgets append as cards", async () => {
    setViewport("phone");
    const prefs: PagePrefs = { layout: { shown: ["activity.azureChanges", "activity.serviceHealth"], hidden: ["activity.changeLog", "activity.liveOutput"] } };
    renderActivity(prefs);
    const log = await screen.findByRole("region", { name: "Azure change log" });
    expect(await within(log).findByText("wg-nsg")).toBeInTheDocument();
    const health = await screen.findByRole("region", { name: "Azure service health" });
    expect(await within(health).findByText("Virtual Machines: connectivity problems")).toBeInTheDocument();
    await userEvent.click(within(health).getByRole("button", { name: /Virtual Machines: connectivity problems/ }));
    expect(await screen.findByRole("dialog", { name: "Virtual Machines: connectivity problems" })).toBeInTheDocument();
  });

  it("phone: nothing is added while the widgets are off", async () => {
    setViewport("phone");
    const { fetchMock } = renderActivity(null);
    await screen.findByRole("region", { name: "Last run" });
    expect(screen.queryByRole("region", { name: "Azure change log" })).toBeNull();
    expect(fetchMock!.calls.some((c) => /azure\/(changes|service-health)/.test(c.url))).toBe(false);
  });
});

describe("activity: the Service Health pill's link (/activity?widget=serviceHealth)", () => {
  const PILL_LINK = "/activity?widget=serviceHealth";
  const withIssue = { "GET /api/v1/azure/summary": azureSummaryFixture({ serviceIssues: [issue()] }) };

  it("with the widget on, it scrolls to and focuses the Azure service health widget", async () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    onTestFinished(() => scrolled.mockRestore());
    renderActivity(turnedOn(...AZ_HEALTH), withIssue, PILL_LINK);
    const panel = await screen.findByRole("region", { name: "Azure service health" });
    await waitFor(() => expect(panel).toHaveFocus());
    expect(scrolled).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Handled once: the address loses the parameter.
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/activity$/));
  });

  it("with the widget off, it opens the active issue's details", async () => {
    renderActivity(null, withIssue, PILL_LINK);
    const dialog = await screen.findByRole("dialog", { name: "Virtual Machines: connectivity problems" });
    expect(dialog).toHaveTextContent("Some VMs in UK South may fail to start.");
    expect(dialog).toHaveTextContent("UK South");
    expect(screen.queryByRole("region", { name: "Azure service health" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/activity$/));
  });

  it("without the parameter nothing opens, even during an issue", async () => {
    renderActivity(null, withIssue);
    await screen.findByRole("table", { name: "Runs" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
