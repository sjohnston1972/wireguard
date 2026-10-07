// views/labs/contract.ts
//
// Plain English: what the catalogue page (area B) and the details (area C)
// share (labs redesign plan E8). Each card's derived view (readiness, session
// status, badge, topics, icon family and search text) is computed once per
// GET /labs answer, in lab number order (ruling 13), so filtering is a linear
// pass and a memoised card re-renders only when its own view changes. The
// details containers all take DetailsProps.

import { useMemo } from "react";
import type { LabCard, LabsResponse } from "@shared/api";
import type { LabsLayout } from "./layout";
import { searchText } from "./model";
import { labReadiness, labSessionStatus, statusBadge, type LabBadge, type LabReadiness, type LabSessionStatus } from "./status";
import { labFamily, labTopics, type TopicFamily } from "./topics";

export interface LabView {
  card: LabCard;
  readiness: LabReadiness;
  status: LabSessionStatus;
  badge: LabBadge;
  /** Every topic, in TOPICS order (cards show 3 and "+N": topicChips). */
  topics: string[];
  /** The card icon's family (FAMILY_ICON); null: no topic (the flask). */
  family: TopicFamily | null;
  /** searchText(card): what the toolbar's search matches. */
  search: string;
}

/** One card's view. `loaded`: the labs query has data (else everything is "checking"). */
export function labView(card: LabCard, loaded: boolean): LabView {
  const readiness = labReadiness(card, loaded);
  const status = labSessionStatus(card.running);
  return { card, readiness, status, badge: statusBadge(readiness, status, card), topics: labTopics(card.resources), family: labFamily(card.resources), search: searchText(card) };
}

/** Every card's view, by lab number (then id). */
export function labViews(cards: readonly LabCard[], loaded: boolean): LabView[] {
  return [...cards].sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => labView(c, loaded));
}

/**
 * The views of a labs query's answer, computed once per answer (useMemo on `q.data`), and by id.
 * `loaded` is false until the first answer (then views is []).
 */
export function useLabViews(q: { data?: LabsResponse }): { views: LabView[]; byId: Map<string, LabView>; loaded: boolean } {
  const data = q.data;
  return useMemo(() => {
    const views = data ? labViews(data.labs, true) : [];
    return { views, byId: new Map(views.map((v) => [v.card.id, v])), loaded: !!data };
  }, [data]);
}

/** What every details container (wide panel, tablet drawer, phone view) takes. */
export interface DetailsProps {
  /** The selected lab's view; null when nothing is selected or the catalogue has not answered. */
  view: LabView | null;
  /** The whole GET /labs answer (permissions, orphans, autoCleanup, other labs' titles for prerequisites). */
  data: LabsResponse | undefined;
  layout: LabsLayout;
  /** Select another lab (a prerequisite's link): the page writes ?lab. */
  onSelect(id: string): void;
}
