// status.test.ts
//
// Plain English: labs redesign spec §6.3, row by row. A lab's readiness (from
// the Worker's blockers only) and its session status are kept apart; the
// badge and the actions look at the session first, then readiness. Nothing
// unknown is ever "Ready".

import { describe, expect, it } from "vitest";
import type { LabBlocker, LabCard } from "@shared/api";
import { card, run, session } from "./testData";
import { SETUP_KINDS, blockerFix, cardAction, labReadiness, labSessionStatus, panelAction, setupAffected, statusBadge, type LabReadiness, type LabSessionStatus } from "./status";

const B = {
  github: { kind: "github", message: "GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup." },
  role: { kind: "role", message: "Needs the labs governance role: do the one-time setup, then Settings → Labs → Check permissions." },
  graph: { kind: "graph", message: "Needs the Microsoft Graph permissions for lab users and groups: do the one-time setup, then Settings → Labs → Check permissions." },
  slots: { kind: "slots", message: "All 32 address slots are in use. A slot is freed when a lab is clean in Azure again." },
  max_running: { kind: "max_running", message: "3 labs are already running (the limit in Settings → Labs)." },
  leftovers: { kind: "leftovers", message: "Blob security still has leftovers in Azure from an earlier session. Clean them up from the Labs tab first." },
  budget: { kind: "budget", message: "This month is already at £10.50 of £10.00, and the budget guard removes labs at 100%. Raise the budget in Settings to deploy." },
} satisfies Record<string, LabBlocker>;

const withBlockers = (...blockers: LabBlocker[]): LabCard => card({ blockers });
const ID = "az104-06-blob-security";

describe("labReadiness (spec §6.3, first match)", () => {
  it("no data is checking, never ready", () => {
    expect(labReadiness(undefined, false)).toBe("checking");
    expect(labReadiness(undefined, true)).toBe("checking");
    expect(labReadiness(card(), false)).toBe("checking");
  });

  it("a role or graph blocker is setup-required", () => {
    expect(labReadiness(withBlockers(B.role), true)).toBe("setup-required");
    expect(labReadiness(withBlockers(B.graph), true)).toBe("setup-required");
  });

  it("setup kinds win over other kinds", () => {
    expect(labReadiness(withBlockers(B.github, B.role, B.slots), true)).toBe("setup-required");
    expect(labReadiness(withBlockers(B.slots, B.graph), true)).toBe("setup-required");
    expect(SETUP_KINDS).toEqual(["role", "graph"]);
  });

  it("any other blocker is unavailable", () => {
    for (const b of [B.github, B.slots, B.max_running, B.leftovers, B.budget]) expect(labReadiness(withBlockers(b), true), b.kind).toBe("unavailable");
  });

  it("an unknown blocker kind is unavailable", () => {
    expect(labReadiness(withBlockers({ kind: "quota" as LabBlocker["kind"], message: "No quota." }), true)).toBe("unavailable");
  });

  it("a lab with prerequisites and no blockers is ready", () => {
    expect(labReadiness(card({ prerequisites: ["az104-05-storage"], blockers: [] }), true)).toBe("ready");
  });

  it("an older Worker's card without blockers falls back to unavailable when it says so", () => {
    const old = { ...card(), blockers: undefined } as unknown as LabCard;
    expect(labReadiness(old, true)).toBe("ready");
    expect(labReadiness({ ...old, unavailable: "Something." }, true)).toBe("unavailable");
  });
});

describe("labSessionStatus (spec §6.3)", () => {
  it("maps the live session's state, and an ended one to none", () => {
    expect(labSessionStatus(null)).toBe("none");
    expect(labSessionStatus(undefined)).toBe("none");
    expect(labSessionStatus(session({ state: "deploying" }))).toBe("deploying");
    expect(labSessionStatus(session({ state: "running" }))).toBe("running");
    expect(labSessionStatus(session({ state: "tearing_down" }))).toBe("destroying");
    expect(labSessionStatus(session({ state: "failed" }))).toBe("failed");
    expect(labSessionStatus(session({ state: "ended" }))).toBe("none");
    expect(labSessionStatus(session({ state: "ended_dirty" }))).toBe("none");
  });
});

/** The table's rows: session or readiness, the card the row is about, then badge, card action and panel action. */
interface Row {
  name: string;
  readiness: LabReadiness;
  status: LabSessionStatus;
  card: LabCard;
  badge: { label: string; tone: string };
  cardAction: { kind: string; label: string; href?: string };
  panelAction: { kind: string; label: string; href?: string; labId?: string; detail?: string; variant?: string };
}

const deploying = session({ state: "deploying", activeRun: run() });
const ROWS: Row[] = [
  {
    name: "deploying",
    readiness: "ready",
    status: "deploying",
    card: card({ running: deploying }),
    badge: { label: "Deploying 3/16", tone: "amber" },
    cardAction: { kind: "open", label: "View progress", href: `/labs/${ID}` },
    panelAction: { kind: "open", label: "View progress", href: `/labs/${ID}` },
  },
  {
    name: "running",
    readiness: "ready",
    status: "running",
    card: card({ running: session() }),
    badge: { label: "Running", tone: "green" },
    cardAction: { kind: "open", label: "Open session", href: `/labs/${ID}` },
    panelAction: { kind: "open", label: "Open session", href: `/labs/${ID}` },
  },
  {
    name: "destroying",
    readiness: "ready",
    status: "destroying",
    card: card({ running: session({ state: "tearing_down" }) }),
    badge: { label: "Tearing down", tone: "amber" },
    cardAction: { kind: "open", label: "View progress", href: `/labs/${ID}` },
    panelAction: { kind: "open", label: "View progress", href: `/labs/${ID}` },
  },
  {
    name: "failed",
    readiness: "ready",
    status: "failed",
    card: card({ running: session({ state: "failed" }) }),
    badge: { label: "Failed", tone: "red" },
    cardAction: { kind: "open", label: "Review failure", href: `/labs/${ID}` },
    panelAction: { kind: "open", label: "Review failure", href: `/labs/${ID}` },
  },
  {
    name: "none + checking",
    readiness: "checking",
    status: "none",
    card: card(),
    badge: { label: "Checking…", tone: "grey" },
    cardAction: { kind: "disabled", label: "Checking…" },
    panelAction: { kind: "disabled", label: "Start lab", detail: "Checking…" },
  },
  {
    name: "none + ready",
    readiness: "ready",
    status: "none",
    card: card(),
    badge: { label: "Ready to run", tone: "green" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "start", label: "Start lab", href: `/labs/${ID}`, variant: "primary" },
  },
  {
    name: "none + setup-required",
    readiness: "setup-required",
    status: "none",
    card: withBlockers(B.role, B.graph),
    badge: { label: "Setup required", tone: "amber" },
    cardAction: { kind: "select", label: "Review setup" },
    panelAction: { kind: "setup", label: "Complete setup", href: "/settings/labs", variant: "primary" },
  },
  {
    name: "none + prerequisite-required",
    readiness: "prerequisite-required",
    status: "none",
    card: card({ prerequisites: ["az104-05-storage"] }),
    badge: { label: "Prerequisite first", tone: "amber" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "prerequisite", label: "View prerequisite", labId: "az104-05-storage" },
  },
  {
    name: "none + unavailable (github)",
    readiness: "unavailable",
    status: "none",
    card: withBlockers(B.github),
    badge: { label: "Unavailable", tone: "grey" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "disabled", label: "Start lab", detail: B.github.message },
  },
  {
    name: "none + unavailable (slots)",
    readiness: "unavailable",
    status: "none",
    card: withBlockers(B.slots),
    badge: { label: "At capacity", tone: "amber" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "disabled", label: "Start lab", detail: B.slots.message },
  },
  {
    name: "none + unavailable (max_running)",
    readiness: "unavailable",
    status: "none",
    card: withBlockers(B.max_running),
    badge: { label: "At capacity", tone: "amber" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "disabled", label: "Start lab", detail: B.max_running.message },
  },
  {
    name: "none + unavailable (leftovers)",
    readiness: "unavailable",
    status: "none",
    card: withBlockers(B.leftovers),
    badge: { label: "Clean-up needed", tone: "red" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "disabled", label: "Start lab", detail: B.leftovers.message },
  },
  {
    name: "none + unavailable (budget)",
    readiness: "unavailable",
    status: "none",
    card: withBlockers(B.budget),
    badge: { label: "Budget reached", tone: "red" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "disabled", label: "Start lab", detail: B.budget.message },
  },
  {
    name: "none + unavailable (an unknown kind)",
    readiness: "unavailable",
    status: "none",
    card: withBlockers({ kind: "quota" as LabBlocker["kind"], message: "No quota left." }),
    badge: { label: "Unavailable", tone: "grey" },
    cardAction: { kind: "select", label: "View lab" },
    panelAction: { kind: "disabled", label: "Start lab", detail: "No quota left." },
  },
];

describe("badge and actions (spec §6.3 table)", () => {
  for (const r of ROWS) {
    it(`${r.name}: badge, card action and panel action`, () => {
      expect(statusBadge(r.readiness, r.status, r.card)).toEqual(r.badge);
      expect(cardAction(r.readiness, r.status, r.card)).toMatchObject(r.cardAction);
      expect(panelAction(r.readiness, r.status, r.card)).toMatchObject(r.panelAction);
    });
  }

  it("the session decides before readiness: a running lab with a blocker is still Running", () => {
    const c = card({ running: session(), blockers: [B.max_running] });
    expect(statusBadge(labReadiness(c, true), labSessionStatus(c.running), c)).toEqual({ label: "Running", tone: "green" });
    expect(cardAction("unavailable", "running", c)).toMatchObject({ kind: "open", label: "Open session" });
  });

  it("the card's footer is filled blue (primary) for a lab ready to start and a running session, as in Steven's mockup; outlined otherwise", () => {
    expect(cardAction("ready", "none", card()).variant).toBe("primary");
    expect(cardAction("ready", "running", card({ running: session() })).variant).toBe("primary");
    expect(cardAction("setup-required", "none", card({ blockers: [B.role] })).variant).toBe("secondary");
    expect(cardAction("unavailable", "none", card({ blockers: [B.slots] })).variant).toBe("secondary");
    expect(cardAction("ready", "deploying", card({ running: deploying })).variant).toBe("secondary");
    expect(cardAction("checking", "none", card()).variant).toBe("secondary");
  });

  it("a running lab doing something else says so (stateWord)", () => {
    const c = card({ running: session({ state: "running", activeRun: run({ action: "peer", step: { done: 2, of: 7, name: null } }) }) });
    expect(statusBadge("ready", "running", c)).toEqual({ label: "Running, peer 2/7", tone: "green" });
  });

  it("no card action or panel action ever deploys: only select, open, start (a link to the dialog), setup, prerequisite or disabled", () => {
    for (const r of ROWS) {
      for (const a of [cardAction(r.readiness, r.status, r.card), panelAction(r.readiness, r.status, r.card)]) {
        expect(["select", "open", "start", "setup", "prerequisite", "disabled"]).toContain(a.kind);
        if (a.href) expect(a.href).toMatch(/^\/(labs\/[a-z0-9-]+|settings\/[a-z]+)$/);
      }
    }
  });
});

describe("blockerFix (spec §6.3 fixes)", () => {
  it("each blocker kind's fix, or none", () => {
    expect(blockerFix("role")).toEqual({ label: "Complete setup", href: "/settings/labs" });
    expect(blockerFix("graph")).toEqual({ label: "Complete setup", href: "/settings/labs" });
    expect(blockerFix("github")).toEqual({ label: "Open the setup checklist", href: "/settings/overview" });
    expect(blockerFix("budget")).toEqual({ label: "Review the budget", href: "/settings/automation" });
    expect(blockerFix("max_running")).toEqual({ label: "Change the limit", href: "/settings/labs" });
    expect(blockerFix("slots")).toBeNull();
    expect(blockerFix("quota" as LabBlocker["kind"])).toBeNull();
  });

  it("leftovers: Clean up points at the leftovers notice when the lab is listed there, else none", () => {
    const orphans = [{ labId: ID, names: [`rg-lab-${ID}`], since: "2026-10-02T11:00:00.000Z" }];
    expect(blockerFix("leftovers", { labId: ID, orphans })).toEqual({ label: "Clean up", href: "#labs-orphans" });
    expect(blockerFix("leftovers", { labId: "az104-05-storage", orphans })).toBeNull();
    expect(blockerFix("leftovers")).toBeNull();
  });
});

describe("setupAffected (spec §8.2)", () => {
  it("counts every card with a role or graph blocker, and only those", () => {
    const cards = [withBlockers(B.role), card({ id: "a", blockers: [B.github] }), card({ id: "b", blockers: [B.github, B.graph] }), card({ id: "c" }), card({ id: "d", blockers: [B.budget] })];
    expect(setupAffected(cards).map((c) => c.id)).toEqual([ID, "b"]);
    expect(setupAffected([])).toEqual([]);
  });
});
