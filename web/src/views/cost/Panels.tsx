import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { CostResponse } from "@shared/api";
import { thresholdTone, type Threshold } from "@shared/widgets";
import { BarChart, DataAge, Donut, EmptyState, Panel, SegmentedControl, type DonutSegment, type Tone } from "@/components";
import { useStarting, useWidget } from "@/widgets";
import { cumulativeSeries, dayLabel, forecastLevel, gbp, pctText, spendSeries, startedLabel, TYPE_LABEL } from "./model";
import { FillHeight } from "./FillHeight";

const COLOURS: Tone[] = ["blue", "purple", "green", "amber"];
const TYPE_COLOUR: Record<keyof typeof TYPE_LABEL, Tone> = { compute: "blue", network: "purple", disk: "green", other: "amber" };

const money = (v: number) => gbp(v).replace(/(\.\d\d)0$/, "$1");

/** Row 2, left: daily actuals, the budget pace, the projection and (optionally) the previous period. */
export function SpendPanel({ cost, compare, updatedAt, height }: { cost: CostResponse; compare: boolean; updatedAt: number; height?: number }) {
  const { settings } = useWidget("cost.spend");
  const s = spendSeries(cost);
  const showPrev = compare && s.previous.some((v) => v !== null);
  const forecast = settings.forecast === true ? s.forecast : [];
  const budgetPerDay = settings.budgetLine === true ? s.budgetPerDay : undefined;
  return (
    <Panel title="Spend over time" className="cost-panel" bodyClassName="cost-panel__body">
      <FillHeight fallback={height ?? 140} min={70}>
        {(h) => (
          <BarChart
            title="Daily spend"
            bars={s.bars}
            forecast={forecast}
            previous={showPrev ? s.previous : undefined}
            budget={budgetPerDay}
            format={money}
            height={h}
            className="cost-chart"
          />
        )}
      </FillHeight>
      {settings.legend === true && (
        <ul className="cost-legend" aria-label="Chart key">
          <li><span className="cost-key cost-key--bar" />Actual spend</li>
          {showPrev && <li><span className="cost-key cost-key--prev" />Previous period</li>}
          {forecast.length > 0 && <li><span className="cost-key cost-key--fc" />Forecast</li>}
          {budgetPerDay !== undefined && <li><span className="cost-key cost-key--budget" />Budget pace ({gbp(budgetPerDay)} a day)</li>}
        </ul>
      )}
      {settings.note === true && (
        <p className="cost-note">
          GBP · UTC days · Azure figures lag up to {cost.meta.azureLagHours} h <DataAge at={updatedAt} />
        </p>
      )}
    </Panel>
  );
}

/** Row 2, middle: where the money went, by type (Azure's split) or, failing that (or when asked), by region (the sessions' estimate). */
export function BreakdownPanel({ cost }: { cost: CostResponse }) {
  const { settings } = useWidget("cost.breakdown");
  const withPct = settings.percentages === true;
  const b = cost.breakdown;
  const share = (p: number) => (withPct ? ` (${pctText(p)})` : "");
  let segments: DonutSegment[] = [];
  let caption: string | null = null;
  let centreLabel = "Total";
  if (b && b.basis === "azure" && settings.groupBy !== "region") {
    segments = b.byType.map((t) => ({ label: TYPE_LABEL[t.type], value: t.gbp, color: TYPE_COLOUR[t.type], display: `${gbp(t.gbp)}${share(t.pct)}` }));
    caption = `Azure actual${b.asOfDay ? `, as of ${dayLabel(b.asOfDay)}` : ""}`;
  } else if (b) {
    segments = b.byRegion.map((r, i) => ({ label: r.name, value: r.gbp, color: COLOURS[i % COLOURS.length]!, display: `${gbp(r.gbp)}${share(r.pct)}` }));
    caption = "Estimate by region: session length at the hourly rate. Azure's split is not in yet.";
    centreLabel = "Estimate";
  }
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <Panel title="Spend breakdown" className="cost-panel" bodyClassName="cost-panel__body cost-breakdown">
      <FillHeight fallback={132} min={72}>
        {(h) => (
          <Donut title="Spend breakdown" segments={segments} centre={total > 0 ? { value: gbp(total), label: centreLabel } : undefined} size={h < 140 ? Math.min(h, 104) : 132} stroke={h < 140 ? 11 : 15} />
        )}
      </FillHeight>
      {caption && total > 0 && <p className="cost-note">{caption}</p>}
    </Panel>
  );
}

/** Row 2, right: the forecast against the budget, with the month's running total. */
export function ForecastPanel({ cost, height }: { cost: CostResponse; height?: number }) {
  const { settings } = useWidget("cost.forecast");
  const { projection, budget } = cost;
  const series = cumulativeSeries(cost);
  const level = forecastLevel(projection?.gbp, budget.budget, settings.forecast as Threshold);
  const pill = level === "bad" ? { cls: "bad", text: "Over budget" } : level === "warn" ? { cls: "warn", text: "Near budget" } : level === "ok" ? { cls: "good", text: "On track" } : null;
  return (
    <Panel
      title="Forecast vs budget"
      className="cost-panel"
      bodyClassName="cost-panel__body"
      status={pill ? <span className={`cost-pill cost-pill--${pill.cls}`}>{pill.text}</span> : undefined}
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
      {settings.chart !== true ? null : series ? (
        <FillHeight fallback={height ?? 96} min={56}>
          {(h) => <BarChart title="Month so far against budget" bars={series.bars} forecast={series.forecast} budget={budget.budget > 0 ? budget.budget : undefined} format={money} height={h} className="cost-chart" />}
        </FillHeight>
      ) : (
        <p className="cost-note">{cost.range === "month" ? "No days from Azure yet." : "Choose This month to see the running total."}</p>
      )}
    </Panel>
  );
}

/** Row 3, left: spend by region or by resource type, as bars. */
export function SplitPanel({ cost }: { cost: CostResponse }) {
  const { settings } = useWidget("cost.split");
  const [by, setBy] = useStarting<"region" | "type">(settings.view === "resource" ? "type" : "region");
  const b = cost.breakdown;
  let rows = !b ? [] : by === "region" ? b.byRegion.map((r) => ({ key: r.location, name: r.name, gbp: r.gbp, pct: r.pct })) : b.byType.map((t) => ({ key: t.type, name: TYPE_LABEL[t.type], gbp: t.gbp, pct: t.pct }));
  if (settings.order === "largest") rows = [...rows].sort((x, y) => y.gbp - x.gbp);
  const tracks = settings.tracks === true;
  const percent = settings.percent === true;
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
        <ul className={`cost-split${tracks ? "" : " cost-split--no-tracks"}${percent ? "" : " cost-split--no-pct"}`}>
          {rows.map((r) => (
            <li key={r.key}>
              <span className="cost-split__name">{r.name}</span>
              {tracks && (
                <span className="cost-split__track" aria-hidden>
                  <span className="cost-split__fill" style={{ width: `${Math.max(2, r.pct)}%` }} />
                </span>
              )}
              <span className="cost-split__gbp">{gbp(r.gbp)}</span>
              {percent && <span className="cost-split__pct">{pctText(r.pct)}</span>}
            </li>
          ))}
        </ul>
      )}
      {b?.basis === "estimate" && rows.length > 0 && <p className="cost-note">Estimate from session length; Azure's actuals are not in yet.</p>}
    </Panel>
  );
}

/**
 * Colours the bars of the BarChart inside it by tone (the chart has no per-bar
 * colour of its own). The rects of its svg are exactly its bars, in order.
 */
function BarTones({ tones, children }: { tones: Array<"warn" | "bad" | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll("svg rect").forEach((r, i) => {
      const t = tones[i];
      r.setAttribute("fill", t === "bad" ? "var(--red)" : t === "warn" ? "var(--amber)" : "var(--blue)");
    });
  });
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
}

/** Row 3, middle: what a session costs, on average and at most, with a bar per session. */
export function PerSessionPanel({ cost, height }: { cost: CostResponse; height?: number }) {
  const { settings } = useWidget("cost.perSession");
  const limit = settings.shown === "all" ? 0 : Number(settings.shown);
  const thr = settings.session as Threshold;
  const rows = [...cost.sessions].reverse();
  const costs = rows.map((r) => r.estimatedGbp);
  const total = costs.reduce((a, b) => a + b, 0);
  const top = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.estimatedGbp > a.estimatedGbp ? r : a), null);
  // The chart shows the latest sessions (rows run oldest to newest).
  const bars = limit > 0 ? rows.slice(-limit) : rows;
  const coloured = thr.warn !== null || thr.bad !== null;
  const tones = bars.map((r) => {
    const t = thresholdTone(r.estimatedGbp, thr, "above");
    return t === "warn" || t === "bad" ? t : null;
  });
  const warnCount = tones.filter((t) => t === "warn").length;
  const badCount = tones.filter((t) => t === "bad").length;
  const count = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;
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
      <FillHeight fallback={height ?? 96} min={56}>
        {(h) => {
          const c = <BarChart title="Cost of each session" bars={bars.map((r) => ({ label: dayLabel(r.started.slice(0, 10)), value: r.estimatedGbp }))} format={money} height={h} className="cost-chart" />;
          return coloured ? <BarTones tones={tones}>{c}</BarTones> : c;
        }}
      </FillHeight>
      {coloured && (warnCount > 0 || badCount > 0) && (
        <p className="cost-flag cost-flag--sessions">
          {warnCount > 0 && thr.warn !== null && <span className="cost-flag__warn">Amber: {count(warnCount)} over {money(thr.warn)}</span>}
          {badCount > 0 && thr.bad !== null && <span className="cost-flag__bad">Red: {count(badCount)} over {money(thr.bad)}</span>}
        </p>
      )}
    </Panel>
  );
}

/** Row 3, right: the facts the data backs up (the API's insights, nothing invented). */
export function InsightsPanel({ cost }: { cost: CostResponse }) {
  return (
    <Panel title="Insights" className="cost-panel" bodyClassName="cost-panel__body cost-insights-body">
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
