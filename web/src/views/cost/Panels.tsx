import { useState } from "react";
import type { CostResponse } from "@shared/api";
import { BarChart, DataAge, Donut, EmptyState, Panel, SegmentedControl, type DonutSegment, type Tone } from "@/components";
import { cumulativeSeries, dayLabel, gbp, pctText, spendSeries, startedLabel, TYPE_LABEL } from "./model";

const COLOURS: Tone[] = ["blue", "purple", "green", "amber"];
const TYPE_COLOUR: Record<keyof typeof TYPE_LABEL, Tone> = { compute: "blue", network: "purple", disk: "green", other: "amber" };

const money = (v: number) => gbp(v).replace(/(\.\d\d)0$/, "$1");

/** Row 2, left: daily actuals, the budget pace, the projection and (optionally) the previous period. */
export function SpendPanel({ cost, compare, updatedAt, height }: { cost: CostResponse; compare: boolean; updatedAt: number; height?: number }) {
  const s = spendSeries(cost);
  const showPrev = compare && s.previous.some((v) => v !== null);
  return (
    <Panel title="Spend over time" className="cost-panel" bodyClassName="cost-panel__body">
      <BarChart
        title="Daily spend"
        bars={s.bars}
        forecast={s.forecast}
        previous={showPrev ? s.previous : undefined}
        budget={s.budgetPerDay}
        format={money}
        height={height ?? 140}
        className="cost-chart"
      />
      <ul className="cost-legend" aria-label="Chart key">
        <li><span className="cost-key cost-key--bar" />Actual spend</li>
        {showPrev && <li><span className="cost-key cost-key--prev" />Previous period</li>}
        {s.forecast.length > 0 && <li><span className="cost-key cost-key--fc" />Forecast</li>}
        {s.budgetPerDay !== undefined && <li><span className="cost-key cost-key--budget" />Budget pace ({gbp(s.budgetPerDay)} a day)</li>}
      </ul>
      <p className="cost-note">
        GBP · UTC days · Azure figures lag up to {cost.meta.azureLagHours} h <DataAge at={updatedAt} />
      </p>
    </Panel>
  );
}

/** Row 2, middle: where the money went, by type (Azure's split) or, failing that, by region (the sessions' estimate). */
export function BreakdownPanel({ cost }: { cost: CostResponse }) {
  const b = cost.breakdown;
  let segments: DonutSegment[] = [];
  let caption: string | null = null;
  let centreLabel = "Total";
  if (b && b.basis === "azure") {
    segments = b.byType.map((t) => ({ label: TYPE_LABEL[t.type], value: t.gbp, color: TYPE_COLOUR[t.type], display: gbp(t.gbp) }));
    caption = `Azure actual${b.asOfDay ? `, as of ${dayLabel(b.asOfDay)}` : ""}`;
  } else if (b) {
    segments = b.byRegion.map((r, i) => ({ label: r.name, value: r.gbp, color: COLOURS[i % COLOURS.length]!, display: gbp(r.gbp) }));
    caption = "Estimate by region: session length at the hourly rate. Azure's split is not in yet.";
    centreLabel = "Estimate";
  }
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <Panel title="Spend breakdown" className="cost-panel" bodyClassName="cost-panel__body cost-breakdown">
      <Donut title="Spend breakdown" segments={segments} centre={total > 0 ? { value: gbp(total), label: centreLabel } : undefined} size={132} stroke={15} />
      {caption && total > 0 && <p className="cost-note">{caption}</p>}
    </Panel>
  );
}

/** Row 2, right: the forecast against the budget, with the month's running total. */
export function ForecastPanel({ cost, height }: { cost: CostResponse; height?: number }) {
  const { projection, budget } = cost;
  const series = cumulativeSeries(cost);
  const onTrack = projection && budget.budget > 0 ? projection.gbp <= budget.budget : null;
  return (
    <Panel
      title="Forecast vs budget"
      className="cost-panel"
      bodyClassName="cost-panel__body"
      status={onTrack === null ? undefined : <span className={onTrack ? "cost-pill cost-pill--good" : "cost-pill cost-pill--bad"}>{onTrack ? "On track" : "Over budget"}</span>}
    >
      <dl className="cost-pair">
        <div>
          <dt>Forecast</dt>
          <dd>{projection ? gbp(projection.gbp) : <span className="cost-none">no data</span>}</dd>
        </div>
        <div>
          <dt>Monthly budget</dt>
          <dd>{budget.budget > 0 ? gbp(budget.budget) : <span className="cost-none">no data</span>}</dd>
        </div>
      </dl>
      {series ? (
        <BarChart title="Month so far against budget" bars={series.bars} forecast={series.forecast} budget={budget.budget > 0 ? budget.budget : undefined} format={money} height={height ?? 96} className="cost-chart" />
      ) : (
        <p className="cost-note">{cost.range === "month" ? "No days from Azure yet." : "Choose This month to see the running total."}</p>
      )}
    </Panel>
  );
}

/** Row 3, left: spend by region or by resource type, as bars. */
export function SplitPanel({ cost }: { cost: CostResponse }) {
  const [by, setBy] = useState<"region" | "type">("region");
  const b = cost.breakdown;
  const rows =
    !b ? [] : by === "region" ? b.byRegion.map((r) => ({ key: r.location, name: r.name, gbp: r.gbp, pct: r.pct })) : b.byType.map((t) => ({ key: t.type, name: TYPE_LABEL[t.type], gbp: t.gbp, pct: t.pct }));
  return (
    <Panel
      title={by === "region" ? "Spend by region" : "Spend by resource type"}
      className="cost-panel"
      actions={
        <SegmentedControl
          aria-label="Split spend by"
          value={by}
          onChange={(v) => setBy(v as "region" | "type")}
          items={[
            { value: "region", label: "Region" },
            { value: "type", label: "Resource type" },
          ]}
        />
      }
    >
      {rows.length === 0 ? (
        <p className="cost-none cost-none--block">{b && by === "type" ? "no data: Azure's split by type is not in yet (the estimate is by region only)" : "no data"}</p>
      ) : (
        <ul className="cost-split">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="cost-split__name">{r.name}</span>
              <span className="cost-split__track" aria-hidden>
                <span className="cost-split__fill" style={{ width: `${Math.max(2, r.pct)}%` }} />
              </span>
              <span className="cost-split__gbp">{gbp(r.gbp)}</span>
              <span className="cost-split__pct">{pctText(r.pct)}</span>
            </li>
          ))}
        </ul>
      )}
      {b?.basis === "estimate" && rows.length > 0 && <p className="cost-note">Estimate from session length; Azure's actuals are not in yet.</p>}
    </Panel>
  );
}

/** Row 3, middle: what a session costs, on average and at most, with a bar per session. */
export function PerSessionPanel({ cost, height }: { cost: CostResponse; height?: number }) {
  const rows = [...cost.sessions].reverse();
  const costs = rows.map((r) => r.estimatedGbp);
  const total = costs.reduce((a, b) => a + b, 0);
  const top = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.estimatedGbp > a.estimatedGbp ? r : a), null);
  return (
    <Panel title="Cost per session" className="cost-panel" bodyClassName="cost-panel__body">
      <dl className="cost-pair cost-pair--3">
        <div>
          <dt>Average per session</dt>
          <dd>{rows.length ? gbp(total / rows.length) : <span className="cost-none">no data</span>}</dd>
        </div>
        <div>
          <dt>Most expensive</dt>
          <dd>{top ? gbp(top.estimatedGbp) : <span className="cost-none">no data</span>}</dd>
          {top && <dd className="cost-pair__sub">{startedLabel(top.started)}</dd>}
        </div>
        <div>
          <dt>Total sessions</dt>
          <dd>{rows.length ? rows.length : <span className="cost-none">no data</span>}</dd>
        </div>
      </dl>
      <BarChart title="Cost of each session" bars={rows.map((r) => ({ label: dayLabel(r.started.slice(0, 10)), value: r.estimatedGbp }))} format={money} height={height ?? 84} className="cost-chart" />
    </Panel>
  );
}

/** Row 3, right: the facts the data backs up (the API's insights, nothing invented). */
export function InsightsPanel({ cost }: { cost: CostResponse }) {
  return (
    <Panel title="Insights" className="cost-panel" bodyClassName="cost-panel__body">
      {cost.insights.length === 0 ? (
        <EmptyState title="Nothing to point out" description="Insights appear here when the figures show something, such as a budget at 80% or a VM left on Standby." />
      ) : (
        <ul className="cost-insights">
          {cost.insights.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
