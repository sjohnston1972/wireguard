import { Fragment, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Col, ErrorState, Grid, PageHeader, Select, Skeleton, Switch, useIsPhone } from "@/components";
import { useCost } from "@/api/queries";
import { EnvironmentField } from "@/shell/StateChip";
import { LayoutMenu, Widget, WidgetCorner, useRowItems, useStarting, useWidget } from "@/widgets";
import { InsightsPanel, BreakdownPanel, ForecastPanel, PerSessionPanel, SpendPanel, SplitPanel } from "./Panels";
import { CostPhone } from "./Phone";
import { SessionsPanel } from "./Sessions";
import { KpiRow } from "./Tiles";
import { RANGE_OPTIONS, parseRange } from "./model";
import type { CostResponse } from "@shared/api";
import "./cost.css";

const GRID_ROWS = ["r2", "r3", "r4"] as const;

/**
 * Rows 2 to 4 of the desktop page. While every row is as shipped, the rows are
 * `display: contents`, so the panels are the grid's own items and the page is
 * laid out exactly as it always was (including the short window's named areas).
 * Once any row differs (a widget hidden or moved) every row is a real row whose
 * columns come from the widgets' weights, and the generic row layout applies.
 */
function CostGrid({ panels }: { panels: Record<string, ReactNode> }) {
  const views = { r2: useRowItems("cost", "r2"), r3: useRowItems("cost", "r3"), r4: useRowItems("cost", "r4") };
  const generic = !GRID_ROWS.every((r) => views[r].isDefault);
  return (
    <Grid className={generic ? "cost-grid cost-grid--generic" : "cost-grid"} style={generic ? ({ "--cost-rows": GRID_ROWS.filter((r) => views[r].visible).map((r) => `var(--cost-h-${r})`).join(" ") } as CSSProperties) : undefined}>
      {GRID_ROWS.map((r) => {
        const v = views[r];
        if (!v.visible) return null;
        return (
          <div key={r} className={`cost-row cost-row--${r}${generic ? "" : " cost-row--default"}`} style={generic ? { gridTemplateColumns: v.template } : undefined}>
            {v.items.map((i) => (
              <Fragment key={i.key}>{panels[i.key]}</Fragment>
            ))}
          </div>
        );
      })}
    </Grid>
  );
}

function Panels({ cost, compare, updatedAt }: { cost: CostResponse; compare: boolean; updatedAt: number }) {
  return (
    <CostGrid
      panels={{
        "cost.spend": (
          <Col span={5} className="cost-c-spend">
            <Widget id="cost.spend">
              <SpendPanel cost={cost} compare={compare} updatedAt={updatedAt} />
            </Widget>
          </Col>
        ),
        "cost.breakdown": (
          <Col span={4} className="cost-c-break">
            <Widget id="cost.breakdown">
              <BreakdownPanel cost={cost} />
            </Widget>
          </Col>
        ),
        "cost.forecast": (
          <Col span={3} className="cost-c-fc">
            <Widget id="cost.forecast">
              <ForecastPanel cost={cost} />
            </Widget>
          </Col>
        ),
        "cost.split": (
          <Col span={4} className="cost-c-split">
            <Widget id="cost.split">
              <SplitPanel cost={cost} />
            </Widget>
          </Col>
        ),
        "cost.perSession": (
          <Col span={4} className="cost-c-per">
            <Widget id="cost.perSession">
              <PerSessionPanel cost={cost} />
            </Widget>
          </Col>
        ),
        "cost.insights": (
          <Col span={4} className="cost-c-ins">
            <Widget id="cost.insights">
              <InsightsPanel cost={cost} />
            </Widget>
          </Col>
        ),
        "cost.sessions": (
          <Col span={12} className="cost-sessions-col cost-c-sess">
            <Widget id="cost.sessions">
              <SessionsPanel cost={cost} />
            </Widget>
          </Col>
        ),
      }}
    />
  );
}

/** Plan 4 area F: spend, budget, where the money went, and the sessions behind it. */
export function CostPage() {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params.get("range"));
  const spendWidget = useWidget("cost.spend");
  const startPrevious = spendWidget.settings.previous === true;
  const [compare, setCompare] = useStarting(startPrevious);
  const phone = useIsPhone();
  const q = useCost(range);
  const cost = q.data;
  // The switch drives the Spend over time chart only: with that widget hidden it would do nothing.
  const canCompare = !!cost && cost.previous.length > 0 && !spendWidget.hidden;

  const setRange = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("range", v);
    setParams(next);
  };

  const header = (
    <PageHeader
      title="Cost"
      subtitle="Monitor, analyse and control what the WireGuard VM costs on Azure."
      env={<EnvironmentField />}
      right={
        <>
          <Select label="Range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} />
          {canCompare && (
            <span className="cost-compare">
              <span aria-hidden="true">Compare to previous period</span>
              <Switch label="Compare to previous period" checked={compare} onCheckedChange={setCompare} />
            </span>
          )}
          <LayoutMenu page="cost" />
        </>
      }
    />
  );

  if (q.isError && !cost) {
    return (
      <section className="cost">
        {header}
        <ErrorState
          title="Could not load cost"
          message={q.error instanceof Error ? q.error.message : "The cost figures could not be loaded."}
          onRetry={() => void q.refetch()}
        />
      </section>
    );
  }
  if (!cost) {
    return (
      <section className="cost" aria-busy="true">
        {header}
        <Widget id="cost.kpis" headerless>
          <div className="cost-kpis" aria-label="Loading cost">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} variant="tile" />
            ))}
            <WidgetCorner />
          </div>
        </Widget>
        <Skeleton variant="block" height={220} />
      </section>
    );
  }

  return (
    <section className="cost">
      {header}
      {phone ? (
        <CostPhone cost={cost} compare={compare && canCompare} updatedAt={q.dataUpdatedAt} />
      ) : (
        <>
          <Widget id="cost.kpis" headerless>
            <KpiRow cost={cost} />
          </Widget>
          <div className="cost-body">
            <Panels cost={cost} compare={compare && canCompare} updatedAt={q.dataUpdatedAt} />
          </div>
        </>
      )}
    </section>
  );
}
