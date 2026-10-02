import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChartColumn, ChevronRight, Coins, Gauge, Info, ShieldCheck } from "lucide-react";
import type { CostResponse } from "@shared/api";
import { MetricTile, type Tone } from "@/components";
import { changeVsPrevious, dayLabel, gbp, hasActuals } from "./model";

/** A small "i" button whose text shows on hover or focus and closes on Escape. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className="cost-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      <button type="button" className="cost-tip__btn" aria-label={label} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <Info size={14} aria-hidden />
      </button>
      {open && (
        <span role="tooltip" id={id} className="cost-tip__bubble">
          {children}
        </span>
      )}
    </span>
  );
}

const Named = ({ name, children }: { name: string; children: ReactNode }) => (
  <div role="group" aria-label={name} className="cost-tile">
    {children}
  </div>
);

const budgetTone = (level: CostResponse["budget"]["level"]): Tone => (level === "over" ? "red" : level === "warn" ? "amber" : "green");

/** Row 1: this session, month to date, the month's projection, the budget and the cost guard. */
export function KpiRow({ cost }: { cost: CostResponse }) {
  const { session, budget, projection } = cost;
  const known = hasActuals(cost);
  // Spent is Azure's actuals plus the running VM's estimate; with neither it is unknown, not £0.
  const spentKnown = known || session.running;
  const change = cost.range === "month" ? changeVsPrevious(cost) : null;
  const guard = budget.level === "none" ? null : budget.level === "over" ? "Over budget" : budget.level === "warn" ? "Nearly there" : "Healthy";
  return (
    <div className="cost-kpis">
      <Named name="This session">
        <MetricTile
          iconStyle="circle"
          tone="amber"
          icon={<Coins />}
          label="This session"
          value={session.estimateGbp === null ? null : gbp(session.estimateGbp)}
          sub={session.running ? `Estimate, running since ${session.since?.slice(11, 16)} UTC` : "Nothing is running"}
          action={<span className={session.running ? "cost-state cost-state--on" : "cost-state"}>{session.running ? "Running" : "Idle"}</span>}
        />
      </Named>
      <Named name="Month to date (actual)">
        <MetricTile
          iconStyle="circle"
          tone="blue"
          icon={<CalendarDays />}
          label="Month to date (actual)"
          value={known ? gbp(cost.monthToDate) : null}
          delta={known && change !== null ? { text: `${Math.abs(Math.round(change))}%`, direction: change < 0 ? "down" : "up", good: change <= 0 } : undefined}
          sub={cost.meta.asOfDay ? `Azure actual, as of ${dayLabel(cost.meta.asOfDay)} (UTC)` : "Azure has not listed a day yet"}
        />
      </Named>
      <Named name="Estimated this month">
        <MetricTile
          iconStyle="circle"
          tone="blue"
          icon={<ChartColumn />}
          label="Estimated this month"
          value={projection ? gbp(projection.gbp) : null}
          sub={
            projection ? (
              <span className="cost-sub">
                Based on current usage
                <InfoTip label="How this is estimated">{projection.basis}</InfoTip>
              </span>
            ) : (
              "Needs a day from Azure first"
            )
          }
        />
      </Named>
      <Named name="Monthly budget">
        <MetricTile
          iconStyle="circle"
          tone={budgetTone(budget.level)}
          icon={<Gauge />}
          label="Monthly budget"
          value={budget.budget > 0 ? gbp(budget.budget) : null}
          progress={budget.budget > 0 && spentKnown ? { value: budget.pct, tone: budgetTone(budget.level), showValue: true } : undefined}
          sub={
            budget.budget > 0 ? (
              <span className="cost-figs">
                <span>
                  <span className="cost-figs__k">Spent</span> <strong>{spentKnown ? gbp(budget.total) : "no data"}</strong>
                </span>
                {projection && (
                  <span>
                    <span className="cost-figs__k">Projected</span> <strong>{gbp(projection.gbp)}</strong>
                  </span>
                )}
              </span>
            ) : (
              "No budget set"
            )
          }
        />
      </Named>
      <Named name="Cost guard">
        <MetricTile
          iconStyle="circle"
          tone={budgetTone(budget.level)}
          icon={<ShieldCheck />}
          label="Cost guard"
          value={guard}
          valueTone
          sub={budget.level === "none" ? "Set a monthly budget to turn it on" : budget.alerted ? `Alert sent at ${budget.alerted}% of budget` : "No budget alerts"}
          action={
            <Link to="/settings/automation" className="cost-tile__go" aria-label="Cost guard settings">
              <ChevronRight size={18} aria-hidden />
            </Link>
          }
        />
      </Named>
    </div>
  );
}
