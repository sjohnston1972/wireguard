// views/cost/LabsPanel.tsx
//
// Plain English: the Cost page's Labs panel (widget cost.labs, off until
// turned on): this month's spend per lab, Azure's actual (which arrives a day
// late) plus an estimate for what it has not caught up with. Loaded only when
// drawn, see lazyLabs.tsx.

import { Link } from "react-router-dom";
import type { CostResponse, LabCostRow } from "@shared/api";
import { EmptyState, Panel } from "@/components";
import { useWidget } from "@/widgets";
import { gbp } from "./model";

const num = (r: LabCostRow) => r.labId;

export function LabsPanel({ cost }: { cost: CostResponse }) {
  const { settings: st } = useWidget("cost.labs");
  const est = st.estimates as boolean;
  // Without running estimates a lab is worth what Azure has billed so far.
  const total = (r: LabCostRow) => (est ? r.totalGbp : r.actualGbp ?? 0);
  const rows = [...cost.labs].sort(st.order === "lab" ? (a, b) => num(a).localeCompare(num(b)) : (a, b) => total(b) - total(a) || num(a).localeCompare(num(b)));
  return (
    <Panel title="Labs" className="cost-panel" bodyClassName="cost-panel__body cost-insights-body">
      {rows.length === 0 ? (
        <EmptyState title="No lab spend this month" description="Lab sessions and what Azure bills for them show here." />
      ) : (
        <ul className="cost-labs">
          {rows.map((r) => (
            <li key={r.labId} className="cost-labs__row" aria-label={r.title}>
              <span className="cost-labs__name">
                <Link to={`/labs/${r.labId}`}>{r.title}</Link>
                <span className="cost-labs__detail">
                  {r.actualGbp === null ? "no actual yet" : `actual ${gbp(r.actualGbp)}`}
                  {est && r.estimateGbp !== null && ` · estimate ${gbp(r.estimateGbp)}`}
                  {r.running && " · running now"}
                </span>
              </span>
              <span className="cost-labs__total">{r.actualGbp === null && !est ? "no data" : gbp(total(r))}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
