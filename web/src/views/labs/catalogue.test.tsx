// Plan L3.1: the catalogue and its filters.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderApp } from "@/test/render";
import { labCoverageFixture } from "@/test/fixtures";
import { card, catalogue as catalogueCards, detailIdle, labs } from "./testData";
import { readFilters } from "./model";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const HERE = dirname(fileURLToPath(import.meta.url));
const routes = (over: Record<string, unknown> = {}) => ({ "GET /api/v1/labs": labs(), "GET /api/v1/labs/coverage": labCoverageFixture(), ...over });
const catalogue = async () => within(await screen.findByRole("region", { name: "Catalogue" }));
const cardOf = (c: ReturnType<typeof within>, title: string | RegExp) => within(c.getByRole("link", { name: title }).closest("article")!);

describe("the catalogue", () => {
  it("cards grouped AZ-104 then AZ-305 by number", async () => {
    renderApp("/labs", { routes: routes() });
    const c = await catalogue();
    await c.findByRole("heading", { name: "AZ-104" });
    const headings = c.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["AZ-104", "AZ-305"]);
    const titles = c.getAllByRole("link").map((a) => a.textContent);
    expect(titles).toEqual([
      "Users, groups and a custom role",
      "Storage accounts: redundancy, access tiers, lifecycle",
      "Blob security: SAS, access policies, private endpoint",
      "Azure Files: SMB share mounted on a VM",
      "Landing zone: management groups and policy",
    ]);
    // Each lab opens its modal at /labs/:id.
    expect(c.getByRole("link", { name: "Azure Files: SMB share mounted on a VM" })).toHaveAttribute("href", "/labs/az104-07-file-share");
  });

  it("a card shows title, two-line summary, level, £/h, deploy time, session, pricey marker with the resource on hover, run before, Ran 2× and Untested v2", async () => {
    renderApp("/labs", { routes: routes() });
    const c = await catalogue();
    await c.findByRole("link", { name: /Blob security/ });
    const six = cardOf(c, /Blob security/);
    expect(six.getByText(/A storage account with a private container/)).toHaveClass("labs-card__summary");
    expect(six.getByText("Associate")).toBeInTheDocument();
    expect(six.getByText("£0.0082/h")).toBeInTheDocument();
    expect(six.getByText("4 min to deploy")).toBeInTheDocument();
    expect(six.getByText("2 h session")).toBeInTheDocument();
    expect(six.getByText("Run before: Lab 5")).toBeInTheDocument();
    expect(six.getByText("Ran 2×")).toBeInTheDocument();
    expect(six.getByText("Untested v2")).toBeInTheDocument();
    expect(six.getByLabelText("Cost £: pennies an hour")).toHaveTextContent("£");

    const seven = cardOf(c, /Azure Files/);
    const marker = seven.getByLabelText(/^Cost £££/);
    expect(marker).toHaveAccessibleName("Cost £££: pricey, Azure Firewall about £0.95/h");
    // On hover (or keyboard focus) the resource shows beside the marker.
    expect(marker).toHaveAttribute("tabindex", "0");
    const tip = seven.getByRole("tooltip", { hidden: true });
    expect(tip).toHaveTextContent("Pricey: Azure Firewall, about £0.95/h");
    expect(seven.getByText("Break-fix")).toBeInTheDocument();
    expect(seven.getByText("35 min to deploy")).toBeInTheDocument();
    expect(seven.queryByText(/Untested/)).toBeNull();
    expect(seven.queryByText(/Ran/)).toBeNull();
    // The summary is clamped to two lines.
    const css = readFileSync(join(HERE, "labs.css"), "utf8");
    expect(css).toMatch(/\.labs-card__summary\s*\{[^}]*-webkit-line-clamp:\s*2/);
  });

  it("filters exam, skill area, level, type and not run yet", async () => {
    const user = userEvent.setup();
    renderApp("/labs", { routes: routes() });
    const c = await catalogue();
    await c.findByRole("link", { name: /Blob security/ });
    const filters = within(screen.getByRole("region", { name: "Filters" }));
    const count = () => c.getAllByRole("link").length;
    expect(count()).toBe(5);

    await user.click(filters.getByRole("radio", { name: "AZ-305" }));
    expect(c.getAllByRole("link").map((a) => a.textContent)).toEqual(["Landing zone: management groups and policy"]);
    await user.click(filters.getByRole("radio", { name: "All" }));
    expect(count()).toBe(5);

    await user.click(filters.getByRole("button", { name: "Foundation" }));
    expect(c.getAllByRole("link").map((a) => a.textContent)).toEqual(["Users, groups and a custom role", "Storage accounts: redundancy, access tiers, lifecycle"]);
    await user.click(filters.getByRole("button", { name: "Foundation" }));

    await user.click(filters.getByRole("button", { name: "Break-fix" }));
    expect(c.getAllByRole("link").map((a) => a.textContent)).toEqual(["Azure Files: SMB share mounted on a VM"]);
    await user.click(filters.getByRole("button", { name: "Break-fix" }));

    // Skill areas by name (from coverage), else by key.
    await user.click(filters.getByRole("combobox", { name: "Skill area" }));
    await user.click(await screen.findByRole("option", { name: "Implement and manage storage" }));
    expect(c.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Storage accounts: redundancy, access tiers, lifecycle",
      "Blob security: SAS, access policies, private endpoint",
      "Azure Files: SMB share mounted on a VM",
    ]);

    await user.click(filters.getByRole("switch", { name: "Not run yet" }));
    expect(c.getAllByRole("link").map((a) => a.textContent)).toEqual(["Storage accounts: redundancy, access tiers, lifecycle", "Azure Files: SMB share mounted on a VM"]);
    // The filters live in the address, so a reload or the back button keeps them.
    expect(screen.getByLabelText("location")).toHaveTextContent("area=az104.storage");
  });

  it("says so when no lab matches, and offers to clear the filters", async () => {
    const user = userEvent.setup();
    renderApp("/labs?exam=AZ-305&type=break-fix", { routes: routes() });
    const c = await catalogue();
    expect(await c.findByText("No lab matches these filters")).toBeInTheDocument();
    await user.click(c.getByRole("button", { name: "Clear filters" }));
    expect(c.getAllByRole("link")).toHaveLength(5);
  });

  it("an empty catalogue says so", async () => {
    renderApp("/labs");
    const c = await catalogue();
    expect(await c.findByText("No labs in the catalogue yet")).toBeInTheDocument();
  });

  it("an unavailable lab says why on its card", async () => {
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": labs({ labs: [card({ unavailable: "Needs the permissions check (Settings → Labs)." })] }) }) });
    const c = await catalogue();
    expect(await c.findByText("Needs the permissions check (Settings → Labs).")).toBeInTheDocument();
  });

  it("the catalogue scrolls inside its panel at 1100×600", () => {
    const css = readFileSync(join(HERE, "labs.css"), "utf8");
    const desktop = css.match(/@media \(min-width: 1100px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    // The page fills #main and never grows past it; the catalogue's list is the scroller.
    expect(desktop).toMatch(/\.labs\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/);
    expect(desktop).toMatch(/\.labs-catalogue__scroll\s*\{[^}]*overflow:\s*auto/);
    expect(desktop).toMatch(/\.labs-filters__scroll\s*\{[^}]*overflow:\s*auto/);
  });
});

// AZ-700 plan Z0.2 (ruling 39): a lab may belong to more than one exam.
describe("labs in more than one exam", () => {
  /** The five test labs plus lab 14 (AZ-104, tagged AZ-700) and lab 31 (AZ-700). */
  const multi = () =>
    labs({
      labs: [
        ...catalogueCards(),
        card({ id: "az104-14-peering-udr", number: 14, title: "VNet peering and UDRs", exam: "AZ-104", exams: ["AZ-104", "AZ-700"], skillAreas: ["az104.networking", "az700.core"], prerequisites: [], released: true }),
        card({ id: "az700-31-ip-nat-outbound", number: 31, title: "Public IP prefixes, NAT Gateway and outbound rules", exam: "AZ-700", exams: ["AZ-700"], skillAreas: ["az700.core"], prerequisites: [], released: true }),
      ],
    });

  it('with no exam filter a tagged lab appears once, under its primary exam, with an "Also AZ-700" chip', async () => {
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": multi() }) });
    const c = await catalogue();
    await c.findByRole("heading", { name: "AZ-700" });
    expect(c.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["AZ-104", "AZ-305", "AZ-700"]);
    expect(c.getAllByRole("link", { name: "VNet peering and UDRs" })).toHaveLength(1);
    const az104 = within(c.getByRole("region", { name: "AZ-104" }));
    expect(az104.getByRole("link", { name: "VNet peering and UDRs" })).toBeInTheDocument();
    expect(cardOf(c, "VNet peering and UDRs").getByText("Also AZ-700")).toBeInTheDocument();
    // A lab in one exam has no chip.
    expect(cardOf(c, "Public IP prefixes, NAT Gateway and outbound rules").queryByText(/^Also /)).toBeNull();
    expect(cardOf(c, /Blob security/).queryByText(/^Also /)).toBeNull();
    expect(within(c.getByRole("region", { name: "AZ-700" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Public IP prefixes, NAT Gateway and outbound rules"]);
  });

  it("the AZ-700 filter shows tagged and AZ-700 labs together by number", async () => {
    const user = userEvent.setup();
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": multi() }) });
    const c = await catalogue();
    await c.findByRole("link", { name: "VNet peering and UDRs" });
    const filters = within(screen.getByRole("region", { name: "Filters" }));
    await user.click(filters.getByRole("radio", { name: "AZ-700" }));
    expect(c.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["AZ-700"]);
    expect(c.getAllByRole("link").map((a) => a.textContent)).toEqual(["VNet peering and UDRs", "Public IP prefixes, NAT Gateway and outbound rules"]);
    // Filtered to one exam, the chip names the other exams the lab belongs to.
    expect(cardOf(c, "VNet peering and UDRs").getByText("Also AZ-104")).toBeInTheDocument();
    // The skill areas offered are those of the labs shown.
    await user.click(filters.getByRole("combobox", { name: "Skill area" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toContain("az700.core");
    expect(options).toContain("az104.networking");
    expect(options).not.toContain("Implement and manage storage");
  });

  it("readFilters accepts AZ-700", () => {
    expect(readFilters(new URLSearchParams("exam=AZ-700")).exam).toBe("AZ-700");
    expect(readFilters(new URLSearchParams("exam=AZ-305")).exam).toBe("AZ-305");
    expect(readFilters(new URLSearchParams("exam=AZ-900")).exam).toBeNull();
  });

  it("the modal subtitle lists every exam", async () => {
    const tagged = card({ id: "az104-14-peering-udr", number: 14, title: "VNet peering and UDRs", exam: "AZ-104", exams: ["AZ-104", "AZ-700"], level: "associate", type: "explore", version: 3 });
    renderApp("/labs/az104-14-peering-udr", { routes: routes({ "GET /api/v1/labs": multi(), "GET /api/v1/labs/az104-14-peering-udr": detailIdle({ card: tagged }) }) });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Lab 14 · AZ-104, AZ-700 · Associate · Explore · v3")).toBeInTheDocument();
  });

  it("the page says the labs cover AZ-104, AZ-305 and AZ-700", async () => {
    renderApp("/labs", { routes: routes() });
    expect(await screen.findByText(/AZ-104, AZ-305 and AZ-700/)).toBeInTheDocument();
  });
});
