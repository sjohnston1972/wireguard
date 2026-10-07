// views/labs/model.ts
//
// Plain English: the Labs tab's words and sums. Money (labs cost pennies, so
// small amounts keep more places), time left, the catalogue's filters (kept in
// the address), grouping by exam, the state and peering words, and which
// Extend choices fit before a lab's hard stop.

import { useEffect, useState } from "react";
import type { LabCard, LabPeering, LabSession, LabSessionState } from "@shared/api";
import { LAB_EXAMS, type LabExam, type LabLevel, type LabType } from "@shared/labs";
import { useLabs } from "@/api/queries";
import type { LabsLayout } from "./layout";
import type { LabReadiness, LabSessionStatus } from "./status";
import { labTopics } from "./topics";

// ── Money ────────────────────────────────────────────────────────────────

/** £ with as many places as a small figure needs: £0.0082, £0.042, £0.42, £1.20. */
export function fmtGbp(v: number): string {
  const a = Math.abs(v);
  const places = a === 0 || a >= 0.1 ? 2 : a >= 0.01 ? 3 : 4;
  return `${v < 0 ? "-" : ""}£${a.toFixed(places)}`;
}

/** "£0.0082/h". */
export const fmtRate = (gbpH: number): string => `${fmtGbp(gbpH)}/h`;

// ── Time ─────────────────────────────────────────────────────────────────

/** "1 h 15 min", "40 min", "2 h", "under a minute". */
export function fmtSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "17:52" in UK time. */
export const fmtClock = (iso: string): string => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/** "2 Oct, 11:15" in UK time. */
export const fmtWhen = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/**
 * The time now by the server's clock: GET /labs says what time it was when
 * it answered, so "time left" never depends on this device's clock being
 * right. Ticks every 15 s.
 */
export function useLabClock(): number {
  const q = useLabs();
  const skew = q.data ? Date.parse(q.data.now) - q.dataUpdatedAt : 0;
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return tick + (Number.isFinite(skew) ? skew : 0);
}

/** When the session ends by itself: its timer, else its hard stop. */
export const endsAt = (s: LabSession): string => s.autoDestroyAt ?? s.maxUntil;

/** "1 h 15 min left", or "Ending" once the time is up. */
export function timeLeft(s: LabSession, now: number): string {
  const ms = Date.parse(endsAt(s)) - now;
  return ms <= 0 ? "Ending" : `${fmtSpan(ms)} left`;
}

// ── Extend (spec §7.4: never past max_until) ─────────────────────────────

export type ExtendChoice = { hours: 1 | 2; label: string } | { toMax: true; label: string };

/**
 * What Extend offers: 1 h and 2 h when they fit before the hard stop (Extend
 * adds to the current timer), and "to max" whenever the timer is short of it.
 * Under an hour from max, "to max" is the only one. [] when the timer is
 * already at max or the session is not running.
 */
export function extendChoices(s: LabSession, now: number): ExtendChoice[] {
  if (s.state !== "running") return [];
  const max = Date.parse(s.maxUntil);
  const base = Math.max(now, Date.parse(s.autoDestroyAt ?? s.maxUntil));
  if (base >= max - 60_000) return [];
  const out: ExtendChoice[] = [];
  if (max - now >= 3_600_000) {
    if (base + 3_600_000 <= max) out.push({ hours: 1, label: "1 hour" });
    if (base + 7_200_000 <= max) out.push({ hours: 2, label: "2 hours" });
  }
  out.push({ toMax: true, label: `To max (until ${fmtClock(s.maxUntil)})` });
  return out;
}

// ── Words ────────────────────────────────────────────────────────────────

export const LEVEL_WORD: Record<LabLevel, string> = { foundation: "Foundation", associate: "Associate", expert: "Expert" };
export const TYPE_WORD: Record<LabType, string> = { explore: "Explore", "break-fix": "Break-fix" };
export const EXAMS: readonly LabExam[] = LAB_EXAMS;

export type Tone = "green" | "amber" | "red" | "blue" | "grey";

/** A session's state as a word and a colour: "Deploying 3/16", "Running", "Tearing down", "Failed". */
export function stateWord(s: LabSession): { label: string; tone: Tone } {
  const step = s.activeRun?.step;
  const progress = step ? ` ${step.done}/${step.of}` : "";
  const words: Record<LabSessionState, { label: string; tone: Tone }> = {
    deploying: { label: `Deploying${progress}`, tone: "amber" },
    running: { label: s.activeRun ? `Running, ${s.activeRun.action}${progress}` : "Running", tone: "green" },
    failed: { label: "Failed", tone: "red" },
    tearing_down: { label: `Tearing down${progress}`, tone: "amber" },
    ended: { label: "Ended", tone: "grey" },
    ended_dirty: { label: "Ended with leftovers", tone: "red" },
  };
  return words[s.state];
}

/** The peering as a word: "Peered", "Peer waiting", "Not peered", "Disconnected". */
export function peeringWord(p: LabPeering): { label: string; tone: Tone } {
  switch (p) {
    case "on":
      return { label: "Peered", tone: "green" };
    case "waiting":
      return { label: "Peer waiting", tone: "amber" };
    case "disconnected":
      return { label: "Disconnected", tone: "red" };
    default:
      return { label: "Not peered", tone: "grey" };
  }
}

/** The NN of az104-NN-slug, else null. */
export function labNumber(id: string): number | null {
  const m = /^az\d{3}-(\d{2})-/.exec(id);
  return m ? Number(m[1]) : null;
}

/** "Run before: Lab 5" (or the id when it has no number). */
export function runBefore(prereqs: string[]): string | null {
  if (prereqs.length === 0) return null;
  return `Run before: ${prereqs.map((p) => (labNumber(p) !== null ? `Lab ${labNumber(p)}` : p)).join(", ")}`;
}

/** The cost marker's accessible words, with the pricey resource when there is one. */
export function markerLabel(c: Pick<LabCard, "marker" | "pricey">): string {
  if (c.pricey) return `Cost ${c.marker}: pricey, ${c.pricey.item} about ${fmtRate(c.pricey.gbpH)}`;
  const words = { "£": "pennies an hour", "££": "up to about 50p an hour", "£££": "about £1 an hour or more, or a slow deploy" } as const;
  return `Cost ${c.marker}: ${words[c.marker]}`;
}

// ── Catalogue filters (labs redesign spec §8.3; kept in the address:
//    ?q=&exam=&area=&level=&type=&notrun=1&ready=1, every write a replace) ──

export interface Filters {
  /** Search text as typed (applyFilters trims it). */
  q: string;
  exam: LabExam | null;
  area: string | null;
  /** Single (ruling 12); an old ?level=a,b keeps its first valid value. */
  level: LabLevel | null;
  type: LabType[];
  notRun: boolean;
  /** "Ready to run only": readiness ready and no live session. */
  ready: boolean;
}

const LEVELS: LabLevel[] = ["foundation", "associate", "expert"];
const TYPES: LabType[] = ["explore", "break-fix"];
const list = <T extends string>(raw: string | null, allowed: T[]): T[] => (raw ?? "").split(",").filter((v): v is T => (allowed as string[]).includes(v));

export function readFilters(p: URLSearchParams): Filters {
  const exam = p.get("exam");
  return {
    q: p.get("q") ?? "",
    exam: (EXAMS as readonly string[]).includes(exam ?? "") ? (exam as LabExam) : null,
    area: p.get("area") || null,
    level: list(p.get("level"), LEVELS)[0] ?? null,
    type: list(p.get("type"), TYPES),
    notRun: p.get("notrun") === "1",
    ready: p.get("ready") === "1",
  };
}

/** The address with these filters (other parameters, such as lab and view, kept). */
export function writeFilters(p: URLSearchParams, f: Filters): URLSearchParams {
  const next = new URLSearchParams(p);
  const set = (k: string, v: string | null) => (v ? next.set(k, v) : next.delete(k));
  set("q", f.q.trim() || null);
  set("exam", f.exam);
  set("area", f.area);
  set("level", f.level);
  set("type", f.type.join(","));
  set("notrun", f.notRun ? "1" : null);
  set("ready", f.ready ? "1" : null);
  return next;
}

export const NO_FILTERS: Filters = { q: "", exam: null, area: null, level: null, type: [], notRun: false, ready: false };
export const anyFilter = (f: Filters): boolean => !!(f.q.trim() || f.exam || f.area || f.level || f.type.length || f.notRun || f.ready);

/** What a card is found by (spec §8.3): title, id, "lab N", summary, objective and topic words, lower case. */
export function searchText(card: LabCard): string {
  return [card.title, card.id, `lab ${card.number}`, card.summary, card.learning?.objective ?? "", ...labTopics(card.resources)].join("\n").toLowerCase();
}

/** The parts of a LabView (contract.ts) the filters read. */
export interface FilterableView {
  card: LabCard;
  readiness: LabReadiness;
  status: LabSessionStatus;
  /** searchText(card). */
  search: string;
}

/** Does the search text match? "lab 6" (or "lab6") is that lab only, never lab 60; anything else is a substring. */
function matches(v: FilterableView, q: string): boolean {
  const n = /^lab\s*(\d{1,2})$/.exec(q);
  if (n) return v.card.number === Number(n[1]);
  return v.search.includes(q);
}

/** The views every filter keeps (all combined), in the order given (lab number order from useLabViews). */
export function applyFilters<V extends FilterableView>(views: readonly V[], f: Filters): V[] {
  const q = f.q.trim().toLowerCase();
  return views.filter(
    (v) =>
      // A lab belongs to every exam in its exams (ruling 39), not only its primary one.
      (!f.exam || examsOf(v.card).includes(f.exam)) &&
      (!f.area || v.card.skillAreas.includes(f.area)) &&
      (!f.level || v.card.level === f.level) &&
      (f.type.length === 0 || f.type.includes(v.card.type)) &&
      (!f.notRun || v.card.runs === 0) &&
      (!f.ready || (v.readiness === "ready" && v.status === "none")) &&
      (!q || matches(v, q)),
  );
}

// ── Selection (spec §9: ?lab=<id> is a selection, never a dialog) ─────────

/** ?lab, or null. */
export const readSelection = (p: URLSearchParams): string | null => p.get("lab") || null;

/** The address with `id` selected (null: none), other parameters kept. */
export function withSelection(p: URLSearchParams, id: string | null): URLSearchParams {
  const next = new URLSearchParams(p);
  if (id) next.set("lab", id);
  else next.delete("lab");
  return next;
}

/**
 * Which lab the details show, and whether ?lab must go (one replace; it only ever removes, so it
 * cannot loop). Wide: ?lab when visible, else the first visible lab (implicit, never written);
 * a known lab the filters hide is dropped. Tablet and phone: only ?lab (the drawer and the view
 * show it whatever the filters hide), never an implicit one. An unknown ?lab is dropped at every
 * layout (with one toast), but only once the catalogue is known (`knownIds` non-empty).
 */
export function selectedLab(visibleIds: readonly string[], urlLab: string | null, layout: LabsLayout, knownIds: readonly string[]): { shown: string | null; drop: boolean } {
  const loaded = knownIds.length > 0;
  const known = !!urlLab && knownIds.includes(urlLab);
  if (layout === "wide") {
    if (urlLab && visibleIds.includes(urlLab)) return { shown: urlLab, drop: false };
    if (urlLab && !loaded) return { shown: urlLab, drop: false };
    return { shown: visibleIds[0] ?? null, drop: !!urlLab };
  }
  if (!urlLab) return { shown: null, drop: false };
  if (!loaded || known) return { shown: urlLab, drop: false };
  return { shown: null, drop: true };
}

/**
 * The link that opens a lab's dialog (/labs/:id) from the catalogue, keeping its filters. Wide: with
 * ?lab=<id> (the dialog's lab is the selection, so closing it leaves that lab selected); tablet and
 * phone: without ?lab (closing returns to the catalogue, focus on the lab's card). `view` "diagram"
 * opens the Diagram tab.
 */
export function labHref(id: string, search: string, layout: LabsLayout, view?: "diagram"): string {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (layout === "wide") p.set("lab", id);
  else p.delete("lab");
  if (view) p.set("view", view);
  else p.delete("view");
  const q = p.toString();
  return `/labs/${id}${q ? `?${q}` : ""}`;
}

/** A card's exams, the primary first (an older Worker sends no exams: then its one exam). */
const examsOf = (c: Pick<LabCard, "exam" | "exams">): LabExam[] => (c.exams?.length ? c.exams : [c.exam]);

/**
 * The catalogue's groups. With no exam filter: one group per exam (AZ-104, AZ-305, AZ-700), each
 * lab once, under its primary exam. With an exam filter: one group, every lab that belongs to that
 * exam (a tagged lab too). Each by lab number; exams with no lab are left out.
 */
export function groupByExam(cards: LabCard[], exam: LabExam | null = null): { exam: LabExam; cards: LabCard[] }[] {
  const byNumber = (xs: LabCard[]) => [...xs].sort((a, b) => a.number - b.number);
  if (exam) {
    const mine = byNumber(cards.filter((c) => examsOf(c).includes(exam)));
    return mine.length ? [{ exam, cards: mine }] : [];
  }
  return EXAMS.map((e) => ({ exam: e, cards: byNumber(cards.filter((c) => c.exam === e)) })).filter((g) => g.cards.length > 0);
}

/** The other exams a card belongs to, beside the group it is shown in (its primary exam, or the exam filtered to): the "Also …" chip. */
export function alsoExams(card: Pick<LabCard, "exam" | "exams">, shownUnder: LabExam | null = null): LabExam[] {
  const under = shownUnder ?? card.exam;
  return examsOf(card).filter((e) => e !== under);
}

/** "AZ-104, AZ-700": every exam a lab belongs to, the primary first (the modal's subtitle). */
export const examsWord = (card: Pick<LabCard, "exam" | "exams">): string => examsOf(card).join(", ");
