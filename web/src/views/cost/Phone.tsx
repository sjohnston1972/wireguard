import { useState, type CSSProperties } from "react";
import type { CostResponse } from "@shared/api";
import { Button, Sheet } from "@/components";
import { Widget, useWidget } from "@/widgets";
import { BreakdownPanel, InsightsPanel, SpendPanel } from "./Panels";
import { SessionsPanel } from "./Sessions";
import { KpiRow } from "./Tiles";

type Open = "chart" | "sessions" | "breakdown" | null;

/** Spec §9: the totals and the budget bar, with the chart, breakdown and sessions one tap away in sheets. A hidden widget loses its button. */
export function CostPhone({ cost, compare, updatedAt }: { cost: CostResponse; compare: boolean; updatedAt: number }) {
  const [open, setOpen] = useState<Open>(null);
  const close = (o: boolean) => !o && setOpen(null);
  const spend = !useWidget("cost.spend").hidden;
  const breakdown = !useWidget("cost.breakdown").hidden;
  const sessions = !useWidget("cost.sessions").hidden;
  const buttons = [spend, breakdown, sessions].filter(Boolean).length;
  return (
    <>
      <Widget id="cost.kpis" headerless>
        <KpiRow cost={cost} />
      </Widget>
      {buttons > 0 && (
        <div className="cost-phone__buttons" style={buttons === 3 ? undefined : ({ gridTemplateColumns: `repeat(${buttons}, 1fr)` } as CSSProperties)}>
          {spend && <Button onClick={() => setOpen("chart")}>Spend over time</Button>}
          {breakdown && <Button onClick={() => setOpen("breakdown")}>Breakdown</Button>}
          {sessions && <Button onClick={() => setOpen("sessions")}>Sessions</Button>}
        </div>
      )}
      <Widget id="cost.insights">
        <InsightsPanel cost={cost} />
      </Widget>
      <Sheet open={open === "chart"} onOpenChange={close} title="Spend over time">
        <SpendPanel cost={cost} compare={compare} updatedAt={updatedAt} height={180} />
      </Sheet>
      <Sheet open={open === "breakdown"} onOpenChange={close} title="Breakdown">
        <BreakdownPanel cost={cost} />
      </Sheet>
      <Sheet open={open === "sessions"} onOpenChange={close} title="Sessions">
        <SessionsPanel cost={cost} bare />
      </Sheet>
    </>
  );
}
