// Plan L3.3: the lab modal while the lab is not running.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import type { LabDetail } from "@shared/api";
import { renderApp, renderWithProviders } from "@/test/render";
import { expectCentredModal } from "@/test/dialogs";
import { setViewport } from "@/test/viewport";
import { LabModal } from "./LabModal";
import { card, detailIdle, detailRunning, labs, session } from "./testData";
import { PLANNED_URL, layoutServer, nodeOn, plannedGraph } from "./topology/places.fixtures";

// The diagram's lazy chunk, counted as it loads (lab topology plan T2.3).
const { chunkLoads } = vi.hoisted(() => ({ chunkLoads: { n: 0 } }));
vi.mock("@/views/labs/topology", async (importOriginal) => {
  chunkLoads.n++;
  return await importOriginal();
});

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const ID = "az104-06-blob-security";
const PATH = `/api/v1/labs/${ID}`;
const open = (detail: LabDetail, more: Record<string, unknown> = {}) =>
  renderApp(`/labs/${ID}`, { routes: { "GET /api/v1/labs": labs(), [`GET ${PATH}`]: detail, [`POST ${PATH}/deploy`]: { ok: true, message: "Deploying." }, ...more } });
const dialog = async () => within(await screen.findByRole("dialog", { name: /Blob security/ }));

describe("the lab modal, not running", () => {
  it("/labs/:id opens the modal", async () => {
    const user = userEvent.setup();
    open(detailIdle());
    const el = await screen.findByRole("dialog", { name: /Blob security/ });
    expectCentredModal(el, "lg");
    expect(within(el).getByText(/Lab 6 · AZ-104 · Associate · Explore · v1/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/labs$/);
  });

  it("a card opens its lab", async () => {
    // Labs redesign: a card's title selects it; its session link (and the details' Start lab) opens the dialog.
    const user = userEvent.setup();
    const live = labs({ labs: labs().labs.map((c) => (c.id === ID ? { ...c, running: session() } : c)) });
    renderApp("/labs", { routes: { "GET /api/v1/labs": live, [`GET ${PATH}`]: detailIdle() } });
    await user.click(await screen.findByRole("link", { name: "Open session" }));
    expect(await screen.findByRole("dialog", { name: /Blob security/ })).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs/${ID}`);
  });

  it("an unknown lab says so on the page, with no empty modal over it", async () => {
    const user = userEvent.setup();
    renderApp("/labs/az104-99-nothing", { routes: { "GET /api/v1/labs": labs() } });
    const notice = within(await screen.findByRole("alert"));
    expect(notice.getByText(/Could not open az104-99-nothing: No such lab\./)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The page stays usable behind it.
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    await user.click(notice.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/labs$/);
  });

  it("readme blocks render without HTML injection", async () => {
    const readme: LabDetail["readme"] = [
      { t: "h", level: 2, text: "What it deploys" },
      { t: "p", inlines: [{ t: "text", text: '<img src=x onerror="alert(1)"> and ' }, { t: "b", text: "<b>bold</b>" }, { t: "text", text: " in " }, { t: "code", text: "rg-lab-<id>" }] },
      { t: "code", lang: "text", text: "vnet-lab ── peering ── vnet-wg\n<script>alert(1)</script>" },
      { t: "ul", items: [[{ t: "a", text: "SAS overview", href: "https://learn.microsoft.com/azure/storage/common/storage-sas-overview" }], [{ t: "a", text: "bad", href: "javascript:alert(1)" }]] },
      { t: "details", summary: "What was broken", blocks: [{ t: "p", inlines: [{ t: "text", text: "The NSG denied 445." }] }] },
    ];
    open(detailIdle({ readme }));
    const d = await dialog();
    const doc = d.getByRole("article", { name: "Readme" });
    expect(within(doc).getByRole("heading", { name: "What it deploys" })).toBeInTheDocument();
    expect(doc.querySelector("img, script")).toBeNull();
    expect(doc).toHaveTextContent('<img src=x onerror="alert(1)"> and <b>bold</b> in rg-lab-<id>');
    expect(doc.querySelector("strong")).toHaveTextContent("<b>bold</b>");
    expect(doc.querySelector("p code")).toHaveTextContent("rg-lab-<id>");
    expect(doc.querySelector("pre")).toHaveTextContent("<script>alert(1)</script>");
    const link = within(doc).getByRole("link", { name: /SAS overview/ });
    expect(link).toHaveAttribute("href", "https://learn.microsoft.com/azure/storage/common/storage-sas-overview");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // Only https links are links; anything else is plain text.
    expect(within(doc).queryByRole("link", { name: "bad" })).toBeNull();
    expect(doc).toHaveTextContent("bad");
    const details = doc.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("What was broken").tagName).toBe("SUMMARY");
  });

  it("cost items, per hour and per session for the chosen hours", async () => {
    const user = userEvent.setup();
    open(detailIdle());
    const d = await dialog();
    const cost = within(d.getByRole("table", { name: "Cost" }));
    const rows = cost.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Storage account, LRS hot, a few MB"),
      expect.stringContaining("Private endpoint"),
      expect.stringContaining("Private DNS zone"),
    ]);
    expect(within(rows[1]!).getByText("£0.0076/h")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Azure price, 3 h old")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Estimate")).toBeInTheDocument();
    expect(d.getByText("£0.0082 an hour")).toBeInTheDocument();
    expect(d.getByText("£0.016 for 2 h")).toBeInTheDocument();
    await user.click(d.getByRole("combobox", { name: "Session length" }));
    await user.click(await screen.findByRole("option", { name: "4 hours" }));
    expect(d.getByText("£0.033 for 4 h")).toBeInTheDocument();
  });

  it("session defaults to session_h and stops at max_h", async () => {
    const user = userEvent.setup();
    const { fetchMock } = open(detailIdle());
    const d = await dialog();
    const hours = d.getByRole("combobox", { name: "Session length" });
    expect(hours).toHaveTextContent("2 hours");
    await user.click(hours);
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["1 hour", "2 hours", "3 hours", "4 hours", "5 hours", "6 hours"]);
    await user.click(screen.getByRole("option", { name: "6 hours" }));
    await user.click(d.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)[0]!.body).toEqual({ hours: 6, peer: true, region: "uksouth" });
  });

  it("peer tick optional, forced for required, hidden for off, and says will peer later when the gateway is down", async () => {
    const user = userEvent.setup();
    const { fetchMock, unmount } = open(detailIdle());
    let d = await dialog();
    const tick = d.getByRole("switch", { name: "Peer to gateway" });
    expect(tick).toBeChecked();
    expect(tick).toBeEnabled();
    await user.click(tick);
    await user.click(d.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)[0]?.body).toMatchObject({ peer: false }));
    unmount();

    const required = open(detailIdle({ card: card({ peering: "required" }), connectivity: { peering: "required", dns_link: true, subnets_used: 1 }, defaults: { region: "uksouth", peer: true, hours: 2 } }));
    d = await dialog();
    expect(d.getByRole("switch", { name: "Peer to gateway" })).toBeChecked();
    expect(d.getByRole("switch", { name: "Peer to gateway" })).toBeDisabled();
    expect(d.getByText("This lab needs peering.")).toBeInTheDocument();
    required.unmount();

    const off = open(detailIdle({ card: card({ peering: "off" }), connectivity: { peering: "off", dns_link: false, subnets_used: 0 }, defaults: { region: "uksouth", peer: false, hours: 2 } }));
    d = await dialog();
    expect(d.queryByRole("switch", { name: "Peer to gateway" })).toBeNull();
    off.unmount();

    open(detailIdle({ gatewayUp: false }));
    d = await dialog();
    expect(d.getByText("The gateway is not running: it will peer when the gateway is next running.")).toBeInTheDocument();
  });

  it("region defaults to Settings", async () => {
    const user = userEvent.setup();
    const { fetchMock } = open(detailIdle({ defaults: { region: "westeurope", peer: true, hours: 2 } }));
    const d = await dialog();
    const region = d.getByRole("textbox", { name: "Region" });
    expect(region).toHaveValue("westeurope");
    await user.clear(region);
    await user.type(region, "ukwest");
    await user.click(d.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)[0]?.body).toEqual({ hours: 2, peer: true, region: "ukwest" }));
  });

  it("each warning shown; Deploy anyway sends the override", async () => {
    const user = userEvent.setup();
    const warnings: LabDetail["warnings"] = [
      { kind: "budget", message: "This session would take the month to £31.20 of £30.00.", overridable: true },
      { kind: "capacity", message: "Standard_B1s may not be available in uksouth.", overridable: true },
      { kind: "pricey", message: "Pricey: Azure Firewall, about £0.95/h.", overridable: false },
      { kind: "slow", message: "Takes about 35 minutes to deploy and 20 to tear down.", overridable: false },
    ];
    const { fetchMock } = open(detailIdle({ warnings }));
    const d = await dialog();
    const list = within(d.getByRole("list", { name: "Warnings" }));
    expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "BudgetThis session would take the month to £31.20 of £30.00.",
      "CapacityStandard_B1s may not be available in uksouth.",
      "PriceyPricey: Azure Firewall, about £0.95/h.",
      "SlowTakes about 35 minutes to deploy and 20 to tear down.",
    ]);
    expect(d.queryByRole("button", { name: "Deploy" })).toBeNull();
    await user.click(d.getByRole("button", { name: "Deploy anyway" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)[0]?.body).toEqual({ hours: 2, peer: true, region: "uksouth", overBudgetOk: true, capacityOk: true }));
  });

  it("information warnings alone keep the plain Deploy", async () => {
    open(detailIdle({ warnings: [{ kind: "slow", message: "Takes about 35 minutes to deploy and 20 to tear down.", overridable: false }] }));
    const d = await dialog();
    expect(d.getByRole("button", { name: "Deploy" })).toBeEnabled();
  });

  it("a budget warning with no override (month already over budget) disables Deploy and offers no Deploy anyway", async () => {
    open(detailIdle({ warnings: [{ kind: "budget", message: "This month is already at £10.10 of £10.00, and the budget guard removes labs at 100%. Raise the budget in Settings to deploy.", overridable: false }] }));
    const d = await dialog();
    expect(d.queryByRole("button", { name: "Deploy anyway" })).toBeNull();
    expect(d.getByRole("button", { name: "Deploy" })).toBeDisabled();
  });

  it("unavailable disables Deploy with the reason", async () => {
    open(detailIdle({ warnings: [{ kind: "unavailable", message: "3 of 3 labs are running (Settings → Labs).", overridable: false }] }));
    const d = await dialog();
    expect(d.getByRole("button", { name: "Deploy" })).toBeDisabled();
    expect(d.getAllByText("3 of 3 labs are running (Settings → Labs).").length).toBeGreaterThan(0);
  });

  it("the card's unavailable reason also disables Deploy", async () => {
    open(detailIdle({ card: card({ unavailable: "Needs the permissions check (Settings → Labs)." }) }));
    const d = await dialog();
    expect(d.getByRole("button", { name: "Deploy" })).toBeDisabled();
    expect(d.getByText("Needs the permissions check (Settings → Labs).")).toBeInTheDocument();
  });
});

// ── Lab topology plan T2.3: the Diagram tab beside the readme ────────────

describe("the Diagram tab, lab not running", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      localStorage.clear();
    } catch {
      /* nothing to clear */
    }
  });
  const withDiagram = (more: Record<string, unknown> = {}) => ({ [`GET ${PLANNED_URL}`]: plannedGraph(), ...layoutServer().routes, ...more });
  const openAt = (url: string, more: Record<string, unknown> = {}) => renderApp(url, { routes: { "GET /api/v1/labs": labs(), [`GET ${PATH}`]: detailIdle(), ...withDiagram(more) } });

  it("the diagram chunk loads only when the Diagram tab first opens", async () => {
    const user = userEvent.setup();
    expect(chunkLoads.n).toBe(0);
    openAt(`/labs/${ID}`);
    const d = await dialog();
    expect(d.getByRole("article", { name: "Readme" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(chunkLoads.n).toBe(0);
    await user.click(d.getByRole("tab", { name: "Diagram" }));
    expect(await d.findByRole("region", { name: "Lab diagram" })).toBeInTheDocument();
    expect(chunkLoads.n).toBe(1);
  });

  it("the idle panel shows Readme and Diagram tabs", async () => {
    openAt(`/labs/${ID}`);
    const d = await dialog();
    const tabs = within(d.getByRole("tablist", { name: "Readme and diagram" }));
    expect(tabs.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Readme", "Diagram"]);
    expect(tabs.getByRole("tab", { name: "Readme" })).toHaveAttribute("aria-selected", "true");
    expect(d.getByRole("article", { name: "Readme" })).toBeInTheDocument();
    // The cost and Deploy column is where it was.
    expect(d.getByRole("heading", { name: "Deploy" })).toBeInTheDocument();
  });

  it("?view=diagram opens Diagram and switching tabs updates the URL without a new history entry", async () => {
    const user = userEvent.setup();
    const r = openAt(`/labs/${ID}?view=diagram`);
    const d = await dialog();
    expect(d.getByRole("tab", { name: "Diagram" })).toHaveAttribute("aria-selected", "true");
    const tree = await d.findByRole("region", { name: "Lab diagram" });
    expect(nodeOn(tree, /Storage account l06…blob/)).toBeInTheDocument();
    expect(d.getByText("Example addresses (slot 31); each session gets its own /18.")).toBeInTheDocument();
    expect(d.queryByRole("article", { name: "Readme" })).toBeNull();
    await user.click(d.getByRole("tab", { name: "Readme" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(new RegExp(`^/labs/${ID}$`));
    expect(r.router.state.historyAction).toBe("REPLACE");
    expect(d.getByRole("article", { name: "Readme" })).toBeInTheDocument();
    await user.click(d.getByRole("tab", { name: "Diagram" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs/${ID}?view=diagram`);
    expect(r.router.state.historyAction).toBe("REPLACE");
  });

  it("the Live/Planned toggle appears only while a session is live (not here)", async () => {
    openAt(`/labs/${ID}?view=diagram`);
    const d = await dialog();
    expect(await d.findByRole("region", { name: "Lab diagram" })).toBeInTheDocument();
    expect(d.queryByRole("radiogroup", { name: "Diagram source" })).toBeNull();
    // The other controls are there.
    expect(d.getByRole("searchbox", { name: "Search the diagram" })).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Reset layout" })).toBeInTheDocument();
    expect(d.getByRole("link", { name: "Full screen" })).toHaveAttribute("href", `/labs/${ID}/diagram?view=diagram`);
  });

  it("the dependency toggle and Diagram/List choice are remembered on this device", async () => {
    const user = userEvent.setup();
    const first = openAt(`/labs/${ID}?view=diagram`);
    let d = await dialog();
    await d.findByRole("region", { name: "Lab diagram" });
    const deps = d.getByRole("switch", { name: "Show dependencies" });
    expect(deps).toBeChecked();
    expect(d.getByRole("radio", { name: "Diagram" })).toBeChecked();
    await user.click(deps);
    await user.click(d.getByRole("radio", { name: "List" }));
    expect(JSON.parse(localStorage.getItem("wg.topology.v1")!)).toEqual({ showDependencies: false, view: "list" });
    first.unmount();
    openAt(`/labs/${ID}?view=diagram`);
    d = await dialog();
    // List was chosen, so the List view's tree is drawn, not the diagram.
    await d.findByRole("tree", { name: /diagram/i });
    expect(d.queryByRole("region", { name: "Lab diagram" })).toBeNull();
    expect(d.getByRole("switch", { name: "Show dependencies" })).not.toBeChecked();
    expect(d.getByRole("radio", { name: "List" })).toBeChecked();
  });

  it("a broken localStorage only forgets the choice", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const user = userEvent.setup();
    openAt(`/labs/${ID}?view=diagram`);
    const d = await dialog();
    await d.findByRole("region", { name: "Lab diagram" });
    await user.click(d.getByRole("radio", { name: "List" }));
    expect(d.getByRole("radio", { name: "List" })).toBeChecked();
  });

  it("the planned file failing to load says so with Try again", async () => {
    const user = userEvent.setup();
    let fail = true;
    openAt(`/labs/${ID}?view=diagram`, { [`GET ${PLANNED_URL}`]: () => (fail ? { status: 503, json: {} } : plannedGraph()) });
    const d = await dialog();
    const alert = await d.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the diagram: The planned diagram did not load (503).");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await d.findByRole("region", { name: "Lab diagram" })).toBeInTheDocument();
  });
});

// ── Labs redesign plan C4: the launch flow in the dialog (spec §13) ─────

describe("the launch flow", () => {
  const busy = (message: string, status = 409, code = "unavailable") => ({ status, json: { error: { code, message } } });

  it("two synchronous Deploy clicks send one POST", async () => {
    const { fetchMock } = open(detailIdle());
    const d = await dialog();
    const deploy = d.getByRole("button", { name: "Deploy" });
    fireEvent.click(deploy);
    fireEvent.click(deploy);
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(1);
  });

  it("after success the button stays disabled with Starting the deploy… until the session appears", async () => {
    let up = false;
    const { fetchMock, client } = open(detailIdle(), { [`GET ${PATH}`]: () => (up ? detailRunning() : detailIdle()) });
    const d = await dialog();
    await userEvent.setup().click(d.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(1));
    expect(await d.findByText("Starting the deploy…")).toBeInTheDocument();
    // The refetch after success still has no session: Deploy stays off.
    await waitFor(() => expect(fetchMock!.calls.filter((c) => c.method === "GET" && c.url === PATH).length).toBeGreaterThan(1));
    expect(d.getByRole("button", { name: "Deploy" })).toBeDisabled();
    fireEvent.click(d.getByRole("button", { name: "Deploy" }));
    expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(1);
    // The session appears: the dialog shows its progress.
    up = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["labs"] });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull());
    expect(screen.getByRole("dialog", { name: /Blob security/ })).toBeInTheDocument();
  });

  it("a 409 shows an inline alert with the server sentence and the fix link", async () => {
    const message = "3 labs are already running (the limit in Settings → Labs).";
    let refused = false;
    const { fetchMock } = open(detailIdle(), {
      [`GET ${PATH}`]: () => (refused ? detailIdle({ card: card({ runs: 2, blockers: [{ kind: "max_running", message }], unavailable: message }) }) : detailIdle()),
      [`POST ${PATH}/deploy`]: () => {
        refused = true;
        return busy(message);
      },
    });
    const d = await dialog();
    await userEvent.setup().click(d.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(1));
    const alert = await d.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(await within(alert).findByRole("link", { name: "Change the limit" })).toHaveAttribute("href", "/settings/labs");
    // The refreshed card says why: Deploy is off.
    await waitFor(() => expect(d.getByRole("button", { name: "Deploy" })).toBeDisabled());
  });

  it("a 409 for a lock held by another run says so with no fix link, and Deploy can be tried again", async () => {
    const message = "Another run of Blob security is in progress (lab-deploy-1). Wait for it to finish.";
    const { fetchMock } = open(detailIdle(), { [`POST ${PATH}/deploy`]: busy(message, 409, "conflict") });
    const d = await dialog();
    const user = userEvent.setup();
    await user.click(d.getByRole("button", { name: "Deploy" }));
    const alert = await d.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(within(alert).queryByRole("link")).toBeNull();
    await waitFor(() => expect(d.getByRole("button", { name: "Deploy" })).toBeEnabled());
    await user.click(d.getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)).toHaveLength(2));
  });

  it("a 422 confirm_required shows the warnings with Deploy anyway", async () => {
    const warning = { kind: "budget" as const, message: "This session would take the month to £31.20 of £30.00.", overridable: true };
    let asked = false;
    const { fetchMock } = open(detailIdle(), {
      [`GET ${PATH}`]: () => (asked ? detailIdle({ warnings: [warning] }) : detailIdle()),
      [`POST ${PATH}/deploy`]: ({ body }: { body: Record<string, unknown> }) => {
        if (body.overBudgetOk) return { ok: true, message: "Deploying." };
        asked = true;
        return busy(`${warning.message} Choose "Deploy anyway" to go ahead.`, 422, "confirm_required");
      },
    });
    const d = await dialog();
    const user = userEvent.setup();
    await user.click(d.getByRole("button", { name: "Deploy" }));
    expect(await d.findByRole("alert")).toHaveTextContent('Choose "Deploy anyway" to go ahead.');
    const anyway = await d.findByRole("button", { name: "Deploy anyway" });
    expect(within(d.getByRole("list", { name: "Warnings" })).getByText(warning.message)).toBeInTheDocument();
    await user.click(anyway);
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/deploy`)[1]?.body).toMatchObject({ overBudgetOk: true }));
  });

  it.each(["tablet", "phone"] as const)("on the %s closing the dialog focuses the lab's card", async (size) => {
    setViewport(size);
    const user = userEvent.setup();
    function AtLab() {
      const { pathname } = useLocation();
      return pathname.startsWith("/labs/") ? <LabModal id={ID} /> : null;
    }
    renderWithProviders(
      <>
        <article data-lab-card={ID}>
          <h3>
            <button type="button">Blob security</button>
          </h3>
        </article>
        <AtLab />
      </>,
      { url: `/labs/${ID}`, routes: { "GET /api/v1/labs": labs(), [`GET ${PATH}`]: detailIdle() } },
    );
    await screen.findByRole("dialog", { name: /Blob security/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Blob security" })).toHaveFocus();
  });
});
