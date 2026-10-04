import { Link, useLocation } from "react-router-dom";
import type { LabCard as Card } from "@shared/api";
import { LEVEL_WORD, TYPE_WORD, fmtRate, markerLabel, runBefore, stateWord } from "./model";

/** The £, ££ or £££ marker; with a pricey resource, that resource shows on hover or keyboard focus. */
export function CostMarker({ card }: { card: Pick<Card, "marker" | "pricey" | "id"> }) {
  const tipId = `labs-tip-${card.id}`;
  return (
    <span className="labs-marker-wrap">
      <span className={`labs-marker labs-marker--${card.marker.length}`} role="img" aria-label={markerLabel(card)} tabIndex={card.pricey ? 0 : undefined} aria-describedby={card.pricey ? tipId : undefined}>
        {card.marker}
      </span>
      {card.pricey && (
        <span className="labs-marker__tip" role="tooltip" id={tipId}>
          Pricey: {card.pricey.item}, about {fmtRate(card.pricey.gbpH)}
        </span>
      )}
    </span>
  );
}

/** One lab in the catalogue (spec §10). The title is the link to its modal; the whole card is the click target. */
export function LabCard({ card }: { card: Card }) {
  const { search } = useLocation();
  const live = card.running ? stateWord(card.running) : null;
  const before = runBefore(card.prerequisites);
  return (
    <article className={live ? "labs-card labs-card--live" : "labs-card"}>
      <div className="labs-card__top">
        <span className="labs-card__num">Lab {card.number}</span>
        <CostMarker card={card} />
        {live && <span className={`labs-word labs-word--${live.tone}`}>{live.label}</span>}
      </div>
      <h4 className="labs-card__title">
        <Link className="labs-card__link" to={{ pathname: `/labs/${encodeURIComponent(card.id)}`, search }}>
          {card.title}
        </Link>
      </h4>
      <p className="labs-card__summary">{card.summary}</p>
      <ul className="labs-card__facts" aria-label="Facts">
        <li>{LEVEL_WORD[card.level]}</li>
        <li>{TYPE_WORD[card.type]}</li>
        <li className="labs-card__rate">{fmtRate(card.estGbpH)}</li>
        <li>{card.timing.deployMin} min to deploy</li>
        <li>{card.timing.sessionH} h session</li>
      </ul>
      {(before || card.runs > 0 || !card.released) && (
        <ul className="labs-card__badges" aria-label="Badges">
          {before && <li className="labs-badge">{before}</li>}
          {card.runs > 0 && <li className="labs-badge">Ran {card.runs}×</li>}
          {!card.released && <li className="labs-badge labs-badge--amber">Untested v{card.version}</li>}
        </ul>
      )}
      {card.unavailable && <p className="labs-card__unavailable">{card.unavailable}</p>}
    </article>
  );
}
