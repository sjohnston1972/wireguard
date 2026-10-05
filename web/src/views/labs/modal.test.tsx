// Plan L3.3: the lab modal while the lab is not running.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LabDetail } from "@shared/api";
import { renderApp } from "@/test/render";
import { expectCentredModal } from "@/test/dialogs";
import { card, detailIdle, labs } from "./testData";

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
    const user = userEvent.setup();
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs(), [`GET ${PATH}`]: detailIdle() } });
    await user.click(await screen.findByRole("link", { name: /Blob security/ }));
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
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();
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
