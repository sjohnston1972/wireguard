// views/labs/status.ts
//
// Plain English: whether a lab can run, and what it is doing, kept apart
// (labs redesign spec §6.3). Readiness comes only from the Worker's blockers
// (the checks deployLab makes), never from raw permission flags: no data is
// "checking", a role or Graph blocker is "setup required", any other blocker
// (or one this app does not know) is "unavailable", otherwise "ready" (a
// prerequisite is only a recommendation). The session status comes from the
// live session. Badges and actions look at the session first, then readiness.
// No action here deploys: "Start lab" is a link to the lab's dialog, whose
// Deploy form is the confirmation.

import type { LabBlocker, LabBlockerKind, LabCard, LabOrphan, LabSession } from "@shared/api";
import { stateWord, type Tone } from "./model";

export type LabReadiness = "checking" | "ready" | "setup-required" | "prerequisite-required" | "unavailable";
/** The brief's LabSessionState (named apart from the API's LabSessionState, the session row's state). */
export type LabSessionStatus = "none" | "deploying" | "running" | "destroying" | "failed";

/** Blocker kinds the setup banner and "Complete setup" are about. */
export const SETUP_KINDS: readonly LabBlockerKind[] = ["role", "graph"];

const isSetup = (b: LabBlocker) => SETUP_KINDS.includes(b.kind);

/** A card's blockers; an older Worker without the field: its `unavailable` sentence as an unknown blocker (fail-closed). */
function blockersOf(card: LabCard): LabBlocker[] {
  if (Array.isArray(card.blockers)) return card.blockers;
  return card.unavailable ? [{ kind: "unavailable" as LabBlockerKind, message: card.unavailable }] : [];
}

/** Readiness, first match (spec §6.3): checking, setup-required, unavailable, ready. */
export function labReadiness(card: LabCard | null | undefined, loaded: boolean): LabReadiness {
  if (!loaded || !card) return "checking";
  const blockers = blockersOf(card);
  if (blockers.some(isSetup)) return "setup-required";
  if (blockers.length > 0) return "unavailable";
  return "ready";
}

/** The live session's status; none without one (ended sessions are never live). */
export function labSessionStatus(session: LabSession | null | undefined): LabSessionStatus {
  switch (session?.state) {
    case "deploying":
      return "deploying";
    case "running":
      return "running";
    case "tearing_down":
      return "destroying";
    case "failed":
      return "failed";
    default:
      return "none";
  }
}

export interface LabBadge {
  label: string;
  tone: Tone;
}

/** The first blocker that is not a setup one (an unavailable lab has no setup blocker, so its first). */
const firstBlocker = (card: LabCard | null | undefined): LabBlocker | null => (card ? (blockersOf(card).find((b) => !isSetup(b)) ?? blockersOf(card)[0] ?? null) : null);

const UNAVAILABLE_BADGE: Partial<Record<LabBlockerKind, LabBadge>> = {
  github: { label: "Unavailable", tone: "grey" },
  slots: { label: "At capacity", tone: "amber" },
  max_running: { label: "At capacity", tone: "amber" },
  leftovers: { label: "Clean-up needed", tone: "red" },
  budget: { label: "Budget reached", tone: "red" },
};

/** The status badge (StatusPill: a word and a tone), session first (spec §6.3 table). */
export function statusBadge(readiness: LabReadiness, status: LabSessionStatus, card?: LabCard | null): LabBadge {
  const live = card?.running ?? null;
  switch (status) {
    case "deploying":
      return live ? stateWord(live) : { label: "Deploying", tone: "amber" };
    case "running":
      return live ? stateWord(live) : { label: "Running", tone: "green" };
    case "destroying":
      return live ? stateWord(live) : { label: "Tearing down", tone: "amber" };
    case "failed":
      return { label: "Failed", tone: "red" };
    case "none":
      break;
  }
  switch (readiness) {
    case "checking":
      return { label: "Checking…", tone: "grey" };
    case "ready":
      return { label: "Ready to run", tone: "green" };
    case "setup-required":
      return { label: "Setup required", tone: "amber" };
    case "prerequisite-required":
      return { label: "Prerequisite first", tone: "amber" };
    case "unavailable": {
      const b = firstBlocker(card);
      return (b && UNAVAILABLE_BADGE[b.kind]) ?? { label: "Unavailable", tone: "grey" };
    }
  }
}

/**
 * What a card or the details' button does. select: select this lab (`labId`); open: a link to the
 * lab's dialog (`href` = /labs/:id, add the page's search with labHref); start: the same link, for
 * an idle lab (its Deploy form is the confirmation); setup: a link to /settings/labs; prerequisite:
 * select the lab in `labId`; disabled: no action, `detail` says why. Nothing here deploys.
 */
export interface LabAction {
  kind: "select" | "open" | "start" | "setup" | "prerequisite" | "disabled";
  label: string;
  href?: string;
  labId?: string;
  /** Disabled: why ("Checking…", or the first blocker's sentence). */
  detail?: string;
  variant: "primary" | "secondary";
}

const SESSION_WORDS: Record<Exclude<LabSessionStatus, "none">, string> = {
  deploying: "View progress",
  running: "Open session",
  destroying: "View progress",
  failed: "Review failure",
};

const labPath = (card: LabCard | null | undefined) => (card ? `/labs/${card.id}` : undefined);

/** The card's footer action (spec §6.3): session links first; otherwise selecting the card. */
export function cardAction(readiness: LabReadiness, status: LabSessionStatus, card?: LabCard | null): LabAction {
  if (status !== "none") return { kind: "open", label: SESSION_WORDS[status], href: labPath(card), labId: card?.id, variant: status === "running" ? "primary" : "secondary" };
  switch (readiness) {
    case "checking":
      return { kind: "disabled", label: "Checking…", detail: "Checking…", variant: "secondary" };
    case "setup-required":
      return { kind: "select", label: "Review setup", labId: card?.id, variant: "secondary" };
    case "ready":
      // Filled blue, as in Steven's mockup: the obvious next step for a lab that can start now.
      return { kind: "select", label: "View lab", labId: card?.id, variant: "primary" };
    default:
      return { kind: "select", label: "View lab", labId: card?.id, variant: "secondary" };
  }
}

/** The details' one primary action (spec §6.3). */
export function panelAction(readiness: LabReadiness, status: LabSessionStatus, card?: LabCard | null): LabAction {
  if (status !== "none") return { kind: "open", label: SESSION_WORDS[status], href: labPath(card), labId: card?.id, variant: "primary" };
  switch (readiness) {
    case "checking":
      return { kind: "disabled", label: "Start lab", detail: "Checking…", variant: "primary" };
    case "ready":
      return { kind: "start", label: "Start lab", href: labPath(card), labId: card?.id, variant: "primary" };
    case "setup-required":
      return { kind: "setup", label: "Complete setup", href: "/settings/labs", variant: "primary" };
    case "prerequisite-required":
      return { kind: "prerequisite", label: "View prerequisite", labId: card?.prerequisites[0], variant: "primary" };
    case "unavailable":
      return { kind: "disabled", label: "Start lab", detail: firstBlocker(card)?.message ?? card?.unavailable ?? "This lab can't be deployed now.", variant: "primary" };
  }
}

/** Where a blocker's fix lives (spec §6.3 fixes); null when there is nothing to do but wait. */
export function blockerFix(kind: LabBlockerKind, ctx: { labId?: string; orphans?: LabOrphan[] } = {}): { label: string; href: string } | null {
  switch (kind) {
    case "role":
    case "graph":
      return { label: "Complete setup", href: "/settings/labs" };
    case "github":
      return { label: "Open the setup checklist", href: "/settings/overview" };
    case "budget":
      return { label: "Review the budget", href: "/settings/automation" };
    case "max_running":
      return { label: "Change the limit", href: "/settings/labs" };
    case "leftovers":
      // The leftovers notice (id labs-orphans) has the lab's Clean up button when the sweep listed it.
      return ctx.labId && ctx.orphans?.some((o) => o.labId === ctx.labId) ? { label: "Clean up", href: "#labs-orphans" } : null;
    default:
      return null;
  }
}

/** The cards with a role or Graph blocker: the setup banner's count (always the whole catalogue, never a filtered view). */
export function setupAffected(cards: readonly LabCard[]): LabCard[] {
  return cards.filter((c) => blockersOf(c).some(isSetup));
}
