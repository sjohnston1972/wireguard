import { useState } from "react";
import type { CostResponse } from "@shared/api";
import { Button, Sheet } from "@/components";
import { BreakdownPanel, InsightsPanel, SpendPanel } from "./Panels";
import { SessionsPanel } from "./Sessions";
import { KpiRow } from "./Tiles";

type Open = "chart" | "sessions" | "breakdown" | null;

/** Spec §9: the totals and the budget bar, with the chart, breakdown and sessions one tap away in sheets. */
export function CostPhone({ cost, compare, updatedAt }: { cost: CostResponse; compare: boolean; updatedAt: number }) {
  const [open, setOpen] = useState<Open>(null);
  const close = (o: boolean) => !o && setOpen(null);
  return (
    <>
      <KpiRow cost={cost} />
      <div className="cost-phone__buttons">
        <Button onClick={() => setOpen("chart")}>Spend over time</Button>
        <Button onClick={() => setOpen("breakdown")}>Breakdown</Button>
        <Button onClick={() => setOpen("sessions")}>Sessions</Button>
      </div>
      <InsightsPanel cost={cost} />
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
