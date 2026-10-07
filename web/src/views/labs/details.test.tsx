// Labs redesign plan C1: the selected lab's details (spec §8.5 items 1-8).
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LabBlockerKind, LabCard } from "@shared/api";
import panelCss from "./LabDetailsPanel.css?raw";
import launchCss from "./LabLaunchAction.css?raw";
import resourcesCss from "./LabResourceSummary.css?raw";
import prereqCss from "./LabPrerequisites.css?raw";
import { renderDetails } from "./details.harness";
import { resourceSummary } from "./topics";
import { HOUR, at, card, catalogue, detailIdle, labs, run, session } from "./testData";

const ID = "az104-06-blob-security";
const DETAIL = `GET /api/v1/labs/${ID}`;

/** The catalogue with lab 6 replaced by `over`. */
const withLab6 = (over: Partial<LabCard> = {}) => labs({ labs: catalogue().map((c) => (c.id === ID ? card({ ...c, ...over }) : c)) });
const open = (over: Partial<LabCard> = {}, more: { autoCleanup?: boolean; routes?: Record<string, unknown> } = {}) => {
  const data = withLab6(over);
  if (more.autoCleanup !== undefined) data.autoCleanup = more.autoCleanup;
  return renderDetails(data, { url: `/labs?lab=${ID}`, routes: { [DETAIL]: detailIdle({ card: data.labs.find((c) => c.id === ID)! }), ...more.routes } });
};
const panel = () => within(screen.getByRole("complementary", { name: /Blob security/ }));
/** A fact's value by its label (the facts are a dl). */
const fact = (label: string) => {
  const dt = panel().getByText(label, { selector: "dt" });
  return dt.nextElementSibling as HTMLElement;
};

describe("details panel content (spec §8.5)", () => {
  it("a ready lab: number, exams, id, title, badge, objective, what you will learn", () => {
    open();
    const p = panel();
    expect(p.getByText("Lab 6 · AZ-104")).toBeInTheDocument();
    expect(p.getByText(ID)).toHaveClass("lab-details__id");
    expect(p.getByRole("heading", { level: 2, name: "Blob security: SAS, access policies, private endpoint" })).toBeInTheDocument();
    expect(p.getByText("Ready to run")).toBeInTheDocument();
    expect(p.getByRole("heading", { name: "Objective" })).toBeInTheDocument();
    expect(p.getByText("Control who reaches one blob container with keys and SAS tokens, Entra roles and a private endpoint.")).toBeInTheDocument();
    const learn = within(p.getByRole("list", { name: "What you will learn" }));
    expect(learn.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Make a SAS from a stored access policy and revoke it without rotating keys",
      "Grant blob data access to an Entra group and test it with your own sign-in",
      "Resolve the account to a private endpoint address through the tunnel",
    ]);
  });

  it("learning time, deploy time, estimated cost and session are each labelled, never one figure for two", () => {
    open();
    expect(fact("Learning time")).toHaveTextContent("50 min");
    expect(fact("Deploy time")).toHaveTextContent("about 4 min");
    expect(fact("Estimated cost")).toHaveTextContent("£0.0082/hour");
    expect(fact("Estimated cost")).toHaveTextContent("about £0.02 for 2 h");
    expect(fact("Session")).toHaveTextContent("2 h, extendable to 6 h");
    expect(fact("Level")).toHaveTextContent("Associate");
    expect(fact("Type")).toHaveTextContent("Explore");
    expect(fact("Peering")).toHaveTextContent("Optional");
  });

  it("a lab at no list price says so, and never £0.00", () => {
    open({ estGbpH: 0 });
    expect(fact("Estimated cost")).toHaveTextContent("No hourly charge at list price");
    expect(panel().queryByText(/£0\.00/)).toBeNull();
    // Said once: no "no charge at list price for 1 h" line repeating it.
    expect(fact("Estimated cost")).not.toHaveTextContent(/for \d/);
  });

  it("a missing estimate says Estimate unavailable", () => {
    open({ estGbpH: Number.NaN });
    expect(fact("Estimated cost")).toHaveTextContent("Estimate unavailable");
  });

  it("deploy time adds the measured time from the current version's release test", () => {
    const test = { labId: ID, version: 2, at: at(-24 * HOUR), runId: "lab-test-1", result: "pass" as const, clean: true, deploySeconds: 263, destroySeconds: 120, estGbp: 0.01, leftovers: [] };
    const first = open({ version: 2, released: true, lastReleaseTest: test });
    expect(fact("Deploy time")).toHaveTextContent("about 4 min");
    expect(fact("Deploy time").querySelector(".lab-facts__sub")).toHaveTextContent("measured 4 min 23 s");
    expect(fact("Release test")).toHaveTextContent("Passed v2");
    first.unmount();
    // A test of an older version measures nothing about this one.
    open({ version: 3, released: false, lastReleaseTest: test });
    expect(fact("Deploy time")).toHaveTextContent(/^about 4 min$/);
    expect(fact("Deploy time").querySelector(".lab-facts__sub")).toBeNull();
  });

  it("an untested version says Untested vN", () => {
    open({ version: 2, released: false });
    expect(fact("Release test")).toHaveTextContent("Untested v2");
  });

  it("no learning content: the summary is shown and What you will learn is left out", () => {
    open({ learning: null });
    const p = panel();
    expect(p.getByText("A storage account with a private container, a stored access policy and a private endpoint in a small VNet.")).toBeInTheDocument();
    expect(p.queryByRole("heading", { name: "What you will learn" })).toBeNull();
    expect(p.queryByRole("list", { name: "What you will learn" })).toBeNull();
    expect(fact("Learning time")).toHaveTextContent("no data");
  });

  it("resources deployed: a tile per kind with ×N, and every topic chip", () => {
    open();
    const res = within(panel().getByRole("region", { name: "Resources deployed" }));
    const tiles = res.getAllByRole("listitem").filter((li) => li.classList.contains("lab-resources__tile"));
    const lines = resourceSummary(card().resources);
    expect(tiles.map((t) => t.textContent)).toEqual(lines.slice(0, 6).map((l) => l.label));
    expect(res.getByRole("link", { name: `+${lines.length - 6} more: see the diagram` })).toBeInTheDocument();
    expect(tiles[0]!.querySelector("svg use")).toHaveAttribute("href", expect.stringMatching(/^#az-/));
    const topics = within(res.getByRole("list", { name: "Topics" }));
    expect(topics.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Entra ID", "Private Link", "DNS", "Storage", "Virtual networks"]);
  });

  it("6 resource tiles then +N more linking to the diagram", () => {
    open({ resources: { vm: 2, nsg: 1, publicIp: 1, storage: 1, keyVault: 1, bastion: 1, firewall: 1, routeTable: 1, vnet: 2, subnet: 4 } });
    const res = within(panel().getByRole("region", { name: "Resources deployed" }));
    const tiles = res.getAllByRole("listitem").filter((li) => li.classList.contains("lab-resources__tile"));
    expect(tiles).toHaveLength(6);
    expect(tiles.some((t) => /×2/.test(t.textContent ?? ""))).toBe(true);
    const more = res.getByRole("link", { name: "+4 more: see the diagram" });
    expect(more).toHaveAttribute("href", `/labs/${ID}?lab=${ID}&view=diagram`);
  });

  it("resources null says Resource list unavailable", () => {
    open({ resources: null });
    const res = within(panel().getByRole("region", { name: "Resources deployed" }));
    expect(res.getByText("Resource list unavailable")).toBeInTheDocument();
    expect(res.queryByRole("list", { name: "Topics" })).toBeNull();
  });

  it("prerequisites are Recommended first, each a link selecting that lab, and never block", async () => {
    const user = userEvent.setup();
    const { fetchMock } = open();
    const pre = within(panel().getByRole("region", { name: "Prerequisites" }));
    expect(pre.getByText("Recommended first")).toBeInTheDocument();
    const link = pre.getByRole("link", { name: "Lab 5: Storage accounts: redundancy, access tiers, lifecycle" });
    expect(link).toHaveAttribute("href", "/labs?lab=az104-05-storage");
    // A lab with prerequisites is still ready.
    expect(panel().getByText("Ready to run")).toBeInTheDocument();
    await user.click(link);
    expect(screen.getByLabelText("location")).toHaveTextContent("/labs?lab=az104-05-storage");
    expect(screen.getByRole("heading", { level: 2, name: "Storage accounts: redundancy, access tiers, lifecycle" })).toBeInTheDocument();
    expect(fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("no prerequisites says None; one not in the catalogue is named by its id", () => {
    const first = open({ prerequisites: [] });
    expect(within(panel().getByRole("region", { name: "Prerequisites" })).getByText("None")).toBeInTheDocument();
    first.unmount();
    open({ prerequisites: ["az104-99-gone"] });
    const pre = within(panel().getByRole("region", { name: "Prerequisites" }));
    expect(pre.getByText("az104-99-gone (not in the catalogue)")).toBeInTheDocument();
    expect(pre.queryByRole("link")).toBeNull();
  });

  it("history: Not run yet, or how often and when last", () => {
    const first = open({ runs: 0 });
    expect(fact("History")).toHaveTextContent("Not run yet");
    first.unmount();
    open({ runs: 3, lastSession: session({ state: "ended", endedAt: "2026-10-01T10:15:00.000Z" }) });
    expect(fact("History")).toHaveTextContent("Run 3×, last 1 Oct, 11:15");
  });

  it("session and cleanup: when it ends and what is torn down, never a promise of zero cost", () => {
    open();
    const s = within(panel().getByRole("region", { name: "Session and cleanup" }));
    const text = s.getByText(/Ends by itself/).textContent!;
    expect(text).toContain("Ends by itself after 2 h unless you extend it (never past 6 h).");
    expect(text).toContain(`rg-lab-${ID}`);
    expect(text).toContain("Azure can take a day to bill the last hour.");
    expect(screen.getByRole("complementary").textContent ?? "").not.toMatch(/£0(?!\.0)|zero|no cost|guarantee|nothing (?:is )?left/i);
  });

  it("without auto-cleanup the cleanup text says to tear it down yourself", () => {
    open({}, { autoCleanup: false });
    const s = within(panel().getByRole("region", { name: "Session and cleanup" }));
    expect(s.getByText(/Automatic tear-down needs GitHub connected: tear the lab down yourself\./)).toBeInTheDocument();
    expect(s.queryByText(/Ends by itself/)).toBeNull();
    expect(screen.getByRole("region", { name: "Session and cleanup" }).textContent ?? "").not.toMatch(/zero|guarantee/i);
  });

  it("a setup-required lab: Setup required, and each missing permission's sentence", () => {
    const blockers = [
      { kind: "role" as const, message: "Needs the governance role: run Check permissions (Settings → Labs)." },
      { kind: "graph" as const, message: "Needs Graph read access to users and groups (Settings → Labs)." },
    ];
    open({ blockers, unavailable: blockers[0]!.message });
    const p = panel();
    expect(p.getByText("Setup required")).toBeInTheDocument();
    for (const b of blockers) expect(p.getByText(b.message)).toBeInTheDocument();
  });

  it.each<[LabBlockerKind, string]>([
    ["github", "Unavailable"],
    ["slots", "At capacity"],
    ["max_running", "At capacity"],
    ["leftovers", "Clean-up needed"],
    ["budget", "Budget reached"],
  ])("an unavailable lab (%s first): its badge and the blocker's sentence", (kind, badge) => {
    const message = `Blocked by ${kind}.`;
    open({ blockers: [{ kind, message }], unavailable: message });
    expect(panel().getByText(badge)).toBeInTheDocument();
    expect(panel().getByText(message)).toBeInTheDocument();
  });

  it("a running lab: its live badge and when the session ends", () => {
    const s = session({ labId: ID, state: "running", autoDestroyAt: at(90 * 60_000), maxUntil: at(5 * HOUR) });
    open({ running: s });
    const p = panel();
    expect(p.getByText(/^Running/)).toBeInTheDocument();
    expect(fact("Session")).toHaveTextContent(/Ends 14:30/);
  });

  it("a deploying lab: Deploying with its step", () => {
    const s = session({ labId: ID, state: "deploying", readyAt: null, activeRun: run() });
    open({ running: s });
    expect(panel().getByText("Deploying 3/16")).toBeInTheDocument();
  });

  it("nothing selected and no answer yet: a skeleton, never placeholder text", () => {
    renderDetails(labs(), { loaded: false });
    const aside = screen.getByRole("complementary", { name: "Lab details" });
    expect(aside).toHaveAttribute("aria-busy", "true");
    expect(aside.querySelector(".skeleton")).not.toBeNull();
  });

  it("the details CSS uses tokens only (no hex colour)", () => {
    for (const css of [panelCss, launchCss, resourcesCss, prereqCss]) expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
