// Labs redesign plan C2: the details' one primary action (spec §6.3) and the secondary links.
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LabBlockerKind, LabCard, LabSession } from "@shared/api";
import { renderWithProviders } from "@/test/render";
import { labView } from "./contract";
import { renderDetails } from "./details.harness";
import { LabLaunchAction } from "./LabLaunchAction";
import { card, catalogue, detailIdle, labs, run, session } from "./testData";

const ID = "az104-06-blob-security";
const DETAIL = `GET /api/v1/labs/${ID}`;
const DEPLOY = `POST /api/v1/labs/${ID}/deploy`;

const withLab6 = (over: Partial<LabCard> = {}, more: Parameters<typeof labs>[0] = {}) => labs({ labs: catalogue().map((c) => (c.id === ID ? card({ ...c, ...over }) : c)), ...more });
const open = (over: Partial<LabCard> = {}, opts: { url?: string; layout?: "wide" | "tablet" | "phone"; more?: Parameters<typeof labs>[0] } = {}) => {
  const data = withLab6(over, opts.more);
  return renderDetails(data, { layout: opts.layout, url: opts.url ?? `/labs?lab=${ID}`, routes: { [DETAIL]: detailIdle({ card: data.labs.find((c) => c.id === ID)! }), [DEPLOY]: { ok: true, message: "Deploying." } } });
};
const launch = () => within(screen.getByRole("group", { name: "Launch" }));
const live = (state: LabSession["state"]): LabSession => session({ labId: ID, state, activeRun: state === "deploying" ? run() : null });

describe("the details' primary action, row by row (spec §6.3)", () => {
  it.each<[LabSession["state"], string]>([
    ["deploying", "View progress"],
    ["running", "Open session"],
    ["tearing_down", "View progress"],
    ["failed", "Review failure"],
  ])("a %s session: %s, a link to its dialog", (state, label) => {
    open({ running: live(state) });
    const a = launch().getByRole("link", { name: label });
    expect(a).toHaveAttribute("href", `/labs/${ID}?lab=${ID}`);
    expect(a).toHaveClass("btn--primary");
  });

  it("ready: Start lab, a link to the dialog (its Deploy form is the confirmation)", () => {
    open();
    const a = launch().getByRole("link", { name: "Start lab" });
    expect(a).toHaveAttribute("href", `/labs/${ID}?lab=${ID}`);
    expect(a).toHaveClass("btn--primary");
  });

  it("checking: Start lab disabled, saying Checking…", () => {
    renderWithProviders(<LabLaunchAction view={labView(card(), false)} data={undefined} layout="wide" onSelect={() => {}} />, { url: "/labs" });
    const b = screen.getByRole("button", { name: "Start lab" });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription("Checking…");
  });

  it("setup-required: each blocker's sentence and Complete setup to /settings/labs", () => {
    const blockers = [
      { kind: "role" as const, message: "Needs the governance role: run Check permissions (Settings → Labs)." },
      { kind: "graph" as const, message: "Needs Graph read access to users and groups (Settings → Labs)." },
    ];
    open({ blockers });
    const l = launch();
    expect(l.getByRole("link", { name: "Complete setup" })).toHaveAttribute("href", "/settings/labs");
    const reasons = within(l.getByRole("list", { name: "Why this lab can't start" }));
    expect(reasons.getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent)).toEqual(blockers.map((b) => b.message));
    // The primary action already is the fix: the sentences do not repeat it.
    expect(l.getAllByRole("link", { name: "Complete setup" })).toHaveLength(1);
  });

  it("prerequisite-required: View prerequisite selects it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const view = { ...labView(card(), true), readiness: "prerequisite-required" as const };
    renderWithProviders(<LabLaunchAction view={view} data={withLab6()} layout="wide" onSelect={onSelect} />, { url: "/labs" });
    await user.click(screen.getByRole("button", { name: "View prerequisite" }));
    expect(onSelect).toHaveBeenCalledWith("az104-05-storage");
  });

  it.each<[LabBlockerKind, string | null, string | null]>([
    ["github", "Open the setup checklist", "/settings/overview"],
    ["budget", "Review the budget", "/settings/automation"],
    ["max_running", "Change the limit", "/settings/labs"],
    ["slots", null, null],
  ])("unavailable (%s): Start lab disabled with the sentence and its fix", (kind, label, href) => {
    const message = `Blocked by ${kind}.`;
    open({ blockers: [{ kind, message }], unavailable: message });
    const l = launch();
    const b = l.getByRole("button", { name: "Start lab" });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription(message);
    const item = within(l.getByRole("list", { name: "Why this lab can't start" })).getByRole("listitem");
    expect(item).toHaveTextContent(message);
    if (label) expect(within(item).getByRole("link", { name: label })).toHaveAttribute("href", href);
    else expect(within(item).queryByRole("link")).toBeNull();
  });

  it("leftovers: Clean up goes to the leftovers notice only when the sweep listed this lab", async () => {
    const user = userEvent.setup();
    const message = "Leftovers of an earlier session are still in Azure.";
    const first = open({ blockers: [{ kind: "leftovers", message }] });
    expect(within(launch().getByRole("list", { name: "Why this lab can't start" })).queryByRole("link")).toBeNull();
    first.unmount();

    open({ blockers: [{ kind: "leftovers", message }] }, { more: { orphans: [{ labId: ID, names: ["rg-lab-az104-06-blob-security"], since: "2026-10-02T10:00:00.000Z" }] } });
    // The page's leftovers notice (B renders it with this id).
    const notice = document.createElement("section");
    notice.id = "labs-orphans";
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", `Clean up ${ID}`);
    notice.appendChild(btn);
    document.body.appendChild(notice);
    const link = launch().getByRole("link", { name: "Clean up" });
    expect(link).toHaveAttribute("href", "#labs-orphans");
    await user.click(link);
    expect(btn).toHaveFocus();
    notice.remove();
  });

  it("Lab guide and Diagram open the dialog's Readme and Diagram tabs, keeping filters", () => {
    open({}, { url: `/labs?exam=AZ-104&lab=${ID}` });
    const l = launch();
    expect(l.getByRole("link", { name: "Start lab" })).toHaveAttribute("href", `/labs/${ID}?exam=AZ-104&lab=${ID}`);
    expect(l.getByRole("link", { name: "Lab guide" })).toHaveAttribute("href", `/labs/${ID}?exam=AZ-104&lab=${ID}`);
    expect(l.getByRole("link", { name: "Diagram" })).toHaveAttribute("href", `/labs/${ID}?exam=AZ-104&lab=${ID}&view=diagram`);
  });

  it("on the tablet the links drop ?lab (closing the dialog returns to the catalogue)", () => {
    open({}, { layout: "tablet", url: `/labs?exam=AZ-104&lab=${ID}` });
    const d = within(screen.getByRole("dialog"));
    expect(d.getByRole("link", { name: "Start lab" })).toHaveAttribute("href", `/labs/${ID}?exam=AZ-104`);
    expect(d.getByRole("link", { name: "Diagram" })).toHaveAttribute("href", `/labs/${ID}?exam=AZ-104&view=diagram`);
  });

  it("Start lab navigates to /labs/:id; Start lab, Lab guide and Diagram never post deploy", async () => {
    const user = userEvent.setup();
    for (const name of ["Start lab", "Lab guide", "Diagram"]) {
      const r = open();
      await user.click(launch().getByRole("link", { name }));
      expect(screen.getByLabelText("location")).toHaveTextContent(new RegExp(`^/labs/${ID}\\?lab=${ID}`));
      expect(r.fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      r.unmount();
    }
  });
});
