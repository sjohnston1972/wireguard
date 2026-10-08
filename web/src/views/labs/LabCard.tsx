// views/labs/LabCard.tsx
//
// Plain English: one lab in the catalogue grid (labs redesign spec §8.4): its
// number and exam, status badge, topic icon, title, objective, up to three
// topic chips, learning time and short cost. The title is the select button,
// stretched over the whole card, so the card is one tab stop and a click
// anywhere selects it; selecting never deploys. Only a card with a live
// session has a footer action: a real link to its dialog (a second tab stop);
// "Checking…" shows while readiness is unknown. Ready, setup and unavailable
// cards have no footer button (it only repeated the card's own click).
// Memoised: a selection change re-renders only the two cards it touches.

import { memo, useId, type MouseEvent } from "react";
import { ArrowRight, Check, Clock, Coins } from "lucide-react";
import { Link } from "react-router-dom";
import { cx } from "@/components";
import type { LabView } from "./contract";
import type { LabsLayout } from "./layout";
import { LabStatusBadge } from "./LabStatusBadge";
import { labHref } from "./model";
import { fmtHourlyPrecise, fmtHourlyShort, fmtMinutes, hourlyAria } from "./money";
import { cardAction } from "./status";
import { FAMILY_ICON, topicChips } from "./topics";
import "./LabCard.css";

/** The card's one-line description: the learning objective, else the summary's first sentence. */
export function cardObjective(view: Pick<LabView, "card">): string {
  const c = view.card;
  if (c.learning?.objective) return c.learning.objective;
  return /^[\s\S]*?[.!?](?=\s|$)/.exec(c.summary.trim())?.[0] ?? c.summary;
}

export interface LabCardProps {
  view: LabView;
  selected: boolean;
  /** Select this lab (stable across renders, so memo holds). */
  onSelect: (id: string) => void;
  /** The page's query without ?lab and ?view (stable across selections), for the session link. */
  search: string;
  layout: LabsLayout;
}

export const LabCard = memo(function LabCard({ view, selected, onSelect, search, layout }: LabCardProps) {
  const c = view.card;
  const action = cardAction(view.readiness, view.status, c);
  const Icon = FAMILY_ICON[view.family ?? "none"];
  const chips = topicChips(view.topics);
  const exams = c.exams?.length ? c.exams : [c.exam];
  const also = exams.filter((e) => e !== c.exam);
  const tip = fmtHourlyPrecise(c.estGbpH) + (c.pricey ? ` · Pricey: ${c.pricey.item}, about ${fmtHourlyPrecise(c.pricey.gbpH)}` : "");
  const selectWords = action.kind === "select" ? action.label : "View lab";
  const costId = useId();
  // Chips and meta sit above the stretched title button (so their tooltips reach the pointer); a click on them still selects.
  const selectFromInfo = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as Element).closest(".lab-card__topics, .lab-card__meta")) onSelect(c.id);
  };
  return (
    <article className={cx("lab-card", selected && "lab-card--selected")} data-lab-card={c.id} onClick={selectFromInfo}>
      <div className="lab-card__eyebrow">
        <span className="lab-card__id">
          Lab {c.number} · {c.exam}
          {also.length > 0 && ` · also ${also.join(", ")}`}
        </span>
        <LabStatusBadge badge={view.badge} className="lab-card__badge" />
      </div>
      <div className="lab-card__iconrow">
        <Icon size={22} aria-hidden="true" className="lab-card__icon" />
        {/* Not colour alone: a check and the word, on the icon's row so the card keeps its height. */}
        {selected && (
          <span className="lab-card__picked">
            <Check size={13} aria-hidden="true" />
            Selected
          </span>
        )}
      </div>
      <h3 className="lab-card__title">
        <button type="button" className="lab-card__select" aria-current={selected ? "true" : undefined} aria-describedby={costId} onClick={() => onSelect(c.id)}>
          {c.title}
          <span className="visually-hidden">, {selectWords}</span>
        </button>
      </h3>
      <p className="lab-card__objective">{cardObjective(view)}</p>
      {chips.shown.length > 0 && (
        <ul className="lab-card__topics" aria-label="Topics">
          {chips.shown.map((t) => (
            <li key={t} className="lab-card__chip" title={t}>
              {t}
            </li>
          ))}
          {chips.more > 0 && (
            <li className="lab-card__chip lab-card__chip--more" aria-label={`${chips.more} more topics`}>
              +{chips.more}
            </li>
          )}
        </ul>
      )}
      <ul className="lab-card__meta">
        {c.learning && (
          <li aria-label={`Learning time ${c.learning.learningMin} minutes`}>
            <Clock size={14} aria-hidden="true" />
            {fmtMinutes(c.learning.learningMin)}
          </li>
        )}
        <li aria-label={`Estimated cost ${hourlyAria(c.estGbpH)}`} title={tip}>
          <Coins size={14} aria-hidden="true" />
          {fmtHourlyShort(c.estGbpH)}
          {/* The tooltip's words without hover (spec §10): the select button's description. */}
          <span id={costId} className="visually-hidden">
            Estimated cost {tip}
          </span>
        </li>
      </ul>
      {action.kind === "open" && (
        <div className="lab-card__footer">
          <Link className={cx("btn", `btn--${action.variant}`, "lab-card__action", "lab-card__action--link")} to={labHref(c.id, search, layout)}>
            {action.label}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      )}
      {action.kind === "disabled" && (
        <div className="lab-card__footer">
          <span className={cx("btn", `btn--${action.variant}`, "lab-card__action", "lab-card__action--disabled")} aria-hidden="true">
            {action.label}
          </span>
        </div>
      )}
    </article>
  );
});
