import type { LabCard as Card } from "@shared/api";
import { EmptyState, Panel } from "@/components";
import { LabCard } from "./LabCard";
import { NO_FILTERS, alsoExams, anyFilter, applyFilters, groupByExam } from "./model";
import { useFilters } from "./Filters";

/**
 * The catalogue (spec §10): AZ-104, AZ-305 then AZ-700, by number; the list scrolls inside the
 * panel. A lab in more than one exam (ruling 39) appears once, under its primary exam, unless an
 * exam is filtered to: then every lab of that exam, tagged ones included.
 */
export function Catalogue({ cards, bare = false }: { cards: Card[]; bare?: boolean }) {
  const [f, setF] = useFilters();
  const shown = applyFilters(cards, f);
  const groups = groupByExam(shown, f.exam);
  const body = (
    <div className="labs-catalogue__scroll">
      {cards.length === 0 ? (
        <EmptyState title="No labs in the catalogue yet" description="Labs arrive with a Worker deploy that includes them." />
      ) : groups.length === 0 ? (
        <EmptyState title="No lab matches these filters" action={anyFilter(f) ? { label: "Clear filters", onClick: () => setF(NO_FILTERS) } : undefined} />
      ) : (
        groups.map((g) => (
          <section key={g.exam} className="labs-exam" aria-labelledby={`labs-exam-${g.exam}`}>
            <h3 className="labs-exam__title" id={`labs-exam-${g.exam}`}>
              {g.exam}
            </h3>
            <div className="labs-grid">
              {g.cards.map((c) => (
                <LabCard key={c.id} card={c} also={alsoExams(c, g.exam)} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
  if (bare) return body;
  return (
    <Panel
      title="Catalogue"
      className="labs-catalogue"
      bodyClassName="labs-catalogue__body"
      widgetChrome={false}
      status={
        cards.length > 0 && (
          <span className="labs-muted">
            {shown.length === cards.length ? `${cards.length} labs` : `${shown.length} of ${cards.length} labs`}
          </span>
        )
      }
    >
      {body}
    </Panel>
  );
}
