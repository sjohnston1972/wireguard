import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Col, ErrorState, Grid, PageHeader, Select, Skeleton, Switch, useIsPhone } from "@/components";
import { useCost } from "@/api/queries";
import { EnvironmentField } from "@/shell/StateChip";
import { InsightsPanel, BreakdownPanel, ForecastPanel, PerSessionPanel, SpendPanel, SplitPanel } from "./Panels";
import { CostPhone } from "./Phone";
import { SessionsPanel } from "./Sessions";
import { KpiRow } from "./Tiles";
import { RANGE_OPTIONS, parseRange } from "./model";
import "./cost.css";

/** Plan 4 area F: spend, budget, where the money went, and the sessions behind it. */
export function CostPage() {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params.get("range"));
  const [compare, setCompare] = useState(false);
  const phone = useIsPhone();
  const q = useCost(range);
  const cost = q.data;
  const canCompare = !!cost && cost.previous.length > 0;

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
        <div className="cost-kpis" aria-label="Loading cost">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} variant="tile" />
          ))}
        </div>
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
          <KpiRow cost={cost} />
          <div className="cost-body">
            <Grid className="cost-grid">
              <Col span={5} className="cost-c-spend">
                <SpendPanel cost={cost} compare={compare && canCompare} updatedAt={q.dataUpdatedAt} />
              </Col>
              <Col span={4} className="cost-c-break">
                <BreakdownPanel cost={cost} />
              </Col>
              <Col span={3} className="cost-c-fc">
                <ForecastPanel cost={cost} />
              </Col>
              <Col span={4} className="cost-c-split">
                <SplitPanel cost={cost} />
              </Col>
              <Col span={4} className="cost-c-per">
                <PerSessionPanel cost={cost} />
              </Col>
              <Col span={4} className="cost-c-ins">
                <InsightsPanel cost={cost} />
              </Col>
              <Col span={12} className="cost-sessions-col cost-c-sess">
                <SessionsPanel cost={cost} />
              </Col>
            </Grid>
          </div>
        </>
      )}
    </section>
  );
}
