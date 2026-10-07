// Labs redesign plan B5: the catalogue grid and its cards (spec §8.4; Review Focus 3, 6 and 8).
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabCard, LabsResponse } from "@shared/api";
import { renderWithProviders } from "@/test/render";
import { card, labs, run, session } from "./testData";
import { labView, useLabViews } from "./contract";
import { LabCard as LabCardView } from "./LabCard";
import type { LabsLayout } from "./layout";
import { LabCatalogueGrid } from "./LabCatalogueGrid";

vi.setConfig({ testTimeout: 20_000 });

// Every card render draws its badge once, so counting badge renders counts card renders (Review Focus 8).
const badgeRenders = vi.hoisted(() => [] as string[]);
vi.mock("./LabStatusBadge", () => ({
  LabStatusBadge: ({ badge }: { badge: { label: string; tone: string } }) => {
    badgeRenders.push(badge.label);
    return <span className={`pill pill--${badge.tone}`}>{badge.label}</span>;
  },
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "LabCard.css"), "utf8") + readFileSync(join(HERE, "LabCatalogueGrid.css"), "utf8");

function Harness({ data, layout = "wide", initial = null, search = "" }: { data: LabsResponse | null; layout?: LabsLayout; initial?: string | null; search?: string }) {
  const { views } = useLabViews({ data: data ?? undefined });
  const [sel, setSel] = useState<string | null>(initial);
  return (
    <>
      <LabCatalogueGrid views={data ? views : null} selectedId={sel} onSelect={setSel} search={search} layout={layout} />
      <aside className="labs-details" aria-label="Lab details" />
    </>
  );
}

const DEPLOY = (id: string) => `POST /api/v1/labs/${id}/deploy`;
const setup = (data: LabsResponse | null = labs(), opts: { layout?: LabsLayout; initial?: string | null; search?: string } = {}) =>
  renderWithProviders(<Harness data={data} {...opts} />, { url: "/labs", routes: { [DEPLOY("az104-06-blob-security")]: { ok: true } } });

const grid = () => within(screen.getByRole("list", { name: "Labs" }));
const cardOf = (title: RegExp) => within(screen.getByRole("button", { name: title }).closest("article")!);
const article = () => screen.getByRole("button", { name: /^Blob security/ }).closest("article")!;
const one = (over: Partial<LabCard>) => labs({ labs: [card({ prerequisites: [], ...over })] });

describe("a card", () => {
  it("a card shows Lab n · exam, badge, icon, title, objective, at most 3 topic chips plus +N, learning time and short cost", () => {
    setup(one({ exams: ["AZ-104", "AZ-700"], estGbpH: 0.0082 }));
    const c = cardOf(/^Blob security/);
    expect(c.getByText("Lab 6 · AZ-104 · also AZ-700")).toBeInTheDocument();
    expect(c.getByText("Ready to run")).toHaveClass("pill--green");
    expect(c.getByRole("heading", { level: 3, name: /Blob security: SAS, access policies, private endpoint/ })).toBeInTheDocument();
    expect(c.getByText("Control who reaches one blob container with keys and SAS tokens, Entra roles and a private endpoint.")).toBeInTheDocument();
    // Topics in TOPICS order: Entra ID, Private Link, DNS, Storage, Virtual networks: 3 and "+2".
    const topics = within(c.getByRole("list", { name: "Topics" }));
    expect(topics.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Entra ID", "Private Link", "DNS", "+2"]);
    expect(topics.getByLabelText("2 more topics")).toBeInTheDocument();
    expect(c.getByLabelText("Learning time 50 minutes")).toHaveTextContent("50 min");
    const cost = c.getByLabelText("Estimated cost under 1p an hour");
    expect(cost).toHaveTextContent("< £0.01/hour");
    expect(cost).toHaveAttribute("title", "£0.0082/hour");
    expect(c.queryByText(/£0\.00\//)).toBeNull();
    // The topic icon is decorative.
    expect(article().querySelector(".lab-card__icon")).toHaveAttribute("aria-hidden", "true");
  });

  it("a pricey lab's cost tooltip names the resource", () => {
    setup(one({ estGbpH: 1.1, pricey: { item: "Azure Firewall", gbpH: 0.95 } }));
    const cost = cardOf(/^Blob security/).getByLabelText("Estimated cost £1.10 an hour");
    expect(cost).toHaveTextContent("£1.10/hour");
    expect(cost).toHaveAttribute("title", "£1.10/hour · Pricey: Azure Firewall, about £0.95/hour");
  });

  it("the precise cost and the pricey resource reach the keyboard: the card's one tab stop is described by them", async () => {
    setup(one({ estGbpH: 1.1, pricey: { item: "Azure Firewall", gbpH: 0.95 } }), { layout: "tablet" });
    const btn = screen.getByRole("button", { name: /^Blob security/ });
    await userEvent.setup().tab();
    expect(btn).toHaveFocus();
    expect(btn).toHaveAccessibleDescription("Estimated cost £1.10/hour · Pricey: Azure Firewall, about £0.95/hour");
  });

  it("chips and meta sit above the stretched select button (their tooltips reach the pointer), and a click on them still selects", async () => {
    // The title button's ::after covers the card; positioned chips and meta with a z-index are drawn above it.
    expect(css).toMatch(/\.lab-card__meta li\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1/);
    expect(css).toMatch(/\.lab-card__chip\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1/);
    const user = userEvent.setup();
    setup(labs());
    await user.click(cardOf(/^Blob security/).getByText("Entra ID"));
    expect(screen.getByRole("button", { name: /^Blob security/ })).toHaveAttribute("aria-current", "true");
    await user.click(cardOf(/^Azure Files/).getByLabelText(/^Estimated cost/));
    expect(screen.getByRole("button", { name: /^Azure Files/ })).toHaveAttribute("aria-current", "true");
  });

  it("a card without learning shows the summary's first sentence and no learning time", () => {
    setup(one({ learning: null, summary: "Two storage accounts, LRS hot and GRS cool. Then a lifecycle policy moves blobs." }));
    const c = cardOf(/^Blob security/);
    expect(c.getByText("Two storage accounts, LRS hot and GRS cool.")).toBeInTheDocument();
    expect(c.queryByText(/lifecycle policy/)).toBeNull();
    expect(c.queryByLabelText(/Learning time/)).toBeNull();
  });

  it("a lab with no resources has no chips and the flask icon", () => {
    setup(one({ resources: null }));
    const c = cardOf(/^Blob security/);
    expect(c.queryByRole("list", { name: "Topics" })).toBeNull();
    expect(article().querySelector(".lucide-flask-conical")).not.toBeNull();
  });

  it("no card repeats a permission paragraph", () => {
    const msg = "Needs the governance role: run Check permissions in Settings → Labs.";
    setup(one({ blockers: [{ kind: "role", message: msg }], unavailable: msg }));
    const c = cardOf(/^Blob security/);
    expect(c.getByText("Setup required")).toBeInTheDocument();
    expect(screen.queryByText(msg)).toBeNull();
  });
});

describe("each state's card action and label", () => {
  const live = (state: "deploying" | "running" | "tearing_down" | "failed") =>
    session({ state, activeRun: state === "deploying" ? run() : state === "tearing_down" ? run({ action: "destroy", step: { done: 4, of: 11, name: "Unpeer" } }) : null });
  const rows: [string, Partial<LabCard>, string, string, "link" | "twin"][] = [
    ["ready", {}, "Ready to run", "View lab", "twin"],
    ["setup required", { blockers: [{ kind: "graph", message: "Needs Graph." }] }, "Setup required", "Review setup", "twin"],
    ["at capacity", { blockers: [{ kind: "max_running", message: "3 of 3 labs are running." }] }, "At capacity", "View lab", "twin"],
    ["clean-up needed", { blockers: [{ kind: "leftovers", message: "Leftovers first." }] }, "Clean-up needed", "View lab", "twin"],
    ["budget reached", { blockers: [{ kind: "budget", message: "Budget used." }] }, "Budget reached", "View lab", "twin"],
    ["github", { blockers: [{ kind: "github", message: "No GitHub." }] }, "Unavailable", "View lab", "twin"],
    ["deploying", { running: live("deploying") }, "Deploying 3/16", "View progress", "link"],
    ["running", { running: live("running") }, "Running", "Open session", "link"],
    ["tearing down", { running: live("tearing_down") }, "Tearing down 4/11", "View progress", "link"],
    ["failed", { running: live("failed") }, "Failed", "Review failure", "link"],
  ];
  it.each(rows)("%s: badge %s, action %s", (_name, over, badge, action, kind) => {
    setup(one(over), { layout: "tablet" });
    const c = cardOf(/^Blob security/);
    expect(c.getByText(badge)).toBeInTheDocument();
    const footer = article().querySelector(".lab-card__footer")!;
    expect(footer).toHaveTextContent(action);
    if (kind === "link") {
      // A session card's action is a real link to the lab's dialog (a second tab stop).
      expect(within(footer as HTMLElement).getByRole("link", { name: action })).toHaveAttribute("href", "/labs/az104-06-blob-security");
    } else {
      // The visual twin of the select button: hidden from assistive tech, never a tab stop.
      expect(within(footer as HTMLElement).queryByRole("button")).toBeNull();
      expect(within(footer as HTMLElement).queryByRole("link")).toBeNull();
      expect(footer.firstElementChild).toHaveAttribute("aria-hidden", "true");
    }
    // The select button carries the action's words.
    expect(c.getByRole("button", { name: `Blob security: SAS, access policies, private endpoint, ${kind === "twin" ? action : "View lab"}` })).toBeInTheDocument();
  });

  it("a session card's action is a link to /labs/:id that keeps the filters (and ?lab on wide)", () => {
    setup(one({ running: session() }), { search: "?exam=AZ-104" });
    expect(cardOf(/^Blob security/).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/labs/az104-06-blob-security?exam=AZ-104&lab=az104-06-blob-security");
  });
});

describe("selecting", () => {
  it("the selected card has aria-current and the live region names it", async () => {
    const user = userEvent.setup();
    setup(labs(), { initial: "az104-05-storage" });
    const five = screen.getByRole("button", { name: /^Storage accounts/ });
    expect(five).toHaveAttribute("aria-current", "true");
    expect(five.closest("article")).toHaveClass("lab-card--selected");
    expect(within(five.closest("article")!).getByText("Selected")).toHaveClass("visually-hidden");
    await user.click(screen.getByRole("button", { name: /^Blob security/ }));
    expect(screen.getByRole("button", { name: /^Blob security/ })).toHaveAttribute("aria-current", "true");
    expect(five).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Showing Lab 6, Blob security: SAS, access policies, private endpoint")).toHaveAttribute("aria-live", "polite");
  });

  it("clicking a card, View lab or Review setup never posts deploy", async () => {
    const user = userEvent.setup();
    const data = labs({ labs: [...labs().labs.filter((c) => c.number !== 1), card({ id: "az104-01-identity", number: 1, title: "Users, groups and a custom role", prerequisites: [], blockers: [{ kind: "role", message: "Needs the role." }] })] });
    const { fetchMock } = setup(data);
    const six = screen.getByRole("button", { name: /^Blob security/ });
    await user.click(six);
    await user.click(six.closest("article")!.querySelector(".lab-card__footer > *")!);
    await user.click(six.closest("article")!.querySelector(".lab-card__objective")!);
    await user.click(screen.getByRole("button", { name: /^Users, groups and a custom role, Review setup/ }));
    expect(fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Users, groups/ })).toHaveAttribute("aria-current", "true");
  });

  it("Enter and Space on a card select only", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(labs());
    const six = screen.getByRole("button", { name: /^Blob security/ });
    six.focus();
    await user.keyboard("{Enter}");
    expect(six).toHaveAttribute("aria-current", "true");
    const five = screen.getByRole("button", { name: /^Storage accounts/ });
    five.focus();
    await user.keyboard(" ");
    expect(five).toHaveAttribute("aria-current", "true");
    // Focus stays on the card.
    expect(five).toHaveFocus();
    expect(fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("list", { name: "Labs" })).toBeInTheDocument();
  });

  it("selecting another lab re-renders two cards", async () => {
    const user = userEvent.setup();
    setup(labs(), { initial: "az104-05-storage" });
    badgeRenders.length = 0;
    await user.click(screen.getByRole("button", { name: /^Blob security/ }));
    expect(badgeRenders).toHaveLength(2);
  });

  it("the skip link moves focus to the panel", async () => {
    const user = userEvent.setup();
    setup(labs());
    const skip = screen.getByRole("link", { name: "Skip to lab details" });
    await user.click(skip);
    expect(screen.getByRole("complementary", { name: "Lab details" })).toHaveFocus();
  });

  it("no skip link off the wide layout (the details are a drawer or a view)", () => {
    setup(labs(), { layout: "tablet" });
    expect(screen.queryByRole("link", { name: "Skip to lab details" })).toBeNull();
  });
});

describe("the grid", () => {
  it("cards in lab number order, one flat list with no exam headings", () => {
    setup(labs());
    const items = [...screen.getByRole("list", { name: "Labs" }).children] as HTMLElement[];
    const titles = items.map((li) => within(li).getByRole("heading", { level: 3 }).textContent);
    expect(titles.map((t) => t!.replace(/, View lab$/, "").split(":")[0])).toEqual(["Users, groups and a custom role", "Storage accounts", "Blob security", "Azure Files", "Landing zone"]);
    expect(screen.queryByRole("heading", { level: 3, name: "AZ-104" })).toBeNull();
    for (const li of items) expect(li.querySelector("article[data-lab-card]")).not.toBeNull();
  });

  it("loading shows skeleton cards, as tall as real ones, and no number", () => {
    setup(null);
    const list = screen.getByRole("list", { name: "Labs" });
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(list.querySelectorAll(".lab-card--skeleton")).toHaveLength(6);
    expect(list.textContent).toBe("");
    // A skeleton card is a .lab-card, so it has the same min-height.
    expect(css).toMatch(/\.lab-card\s*\{[^}]*min-height:\s*var\(--lab-card-min\)/);
  });

  it("selected state uses an inset shadow, not a thicker border", () => {
    const sel = css.match(/\.lab-card--selected\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(sel).toMatch(/border-color:\s*var\(--blue-bright\)/);
    expect(sel).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--blue-bright\)/);
    expect(sel).not.toMatch(/border(-width)?:\s*\d/);
  });

  it("cards in a row share a height and footers align", () => {
    expect(css).toMatch(/\.lab-grid\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/\.lab-grid > li\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.lab-card\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.lab-card__footer\s*\{[^}]*margin-top:\s*auto;[^}]*padding-top:\s*16px/);
  });

  it("topic chips wrap like words and never run past the card: a very long one ends in an ellipsis, its full word in a tooltip", () => {
    expect(css).toMatch(/\.lab-card__topics\s*\{[^}]*flex-wrap:\s*wrap/);
    const chip = css.match(/\.lab-card__chip\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(chip).toMatch(/max-width:\s*100%/);
    expect(chip).toMatch(/overflow:\s*hidden/);
    expect(chip).toMatch(/text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.lab-card__chip--more\s*\{[^}]*flex:\s*none/);
    renderWithProviders(<LabCardView view={labView(card({ resources: { managedIdentity: 1, keyVault: 1, vm: 1, vnet: 1 } }), true)} selected={false} onSelect={() => {}} search="" layout="wide" />);
    const chips = within(screen.getByRole("list", { name: "Topics" })).getAllByRole("listitem");
    expect(chips.slice(0, 3).map((c) => c.getAttribute("title"))).toEqual(["Managed identities", "Key Vault", "Virtual machines"]);
  });

  it("columns follow the grid's own width: 3 at 872 px, 2 at 576 px, else 1", () => {
    expect(css).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container[^{]*\(min-width:\s*576px\)\s*\{\s*\.lab-grid\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@container[^{]*\(min-width:\s*872px\)\s*\{\s*\.lab-grid\s*\{\s*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  });

  it("reduced motion: no card hover transition", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.lab-card[^{]*\{[^}]*transition:\s*none/);
  });

});
