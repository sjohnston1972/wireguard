import { RefreshCw } from "lucide-react";
import { useRef } from "react";
import type { ActivityResponse } from "@shared/api";
import { DataAge, ErrorState, IconButton, PageHeader, Select } from "@/components";
import { useActivity } from "@/api/queries";
import { ApiError } from "@/api/client";
import { Kpis } from "./Kpis";
import { RANGES } from "./model";
import { useActivityParams } from "./useActivityParams";
import "./activity.css";

/** The last good answer, so a new range keeps the old figures on screen (greyed) until the new ones arrive. */
function useHeld<T>(data: T | undefined): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  if (data !== undefined) ref.current = data;
  return data ?? ref.current;
}

export function ActivityView({ runId }: { runId?: string }) {
  const p = useActivityParams();
  const q = useActivity({ range: p.range, kind: p.kind, q: p.q, page: p.page > 1 ? p.page : undefined });
  const data: ActivityResponse | undefined = useHeld(q.data);
  void runId;

  const header = (
    <PageHeader
      title="Activity"
      subtitle="Monitor deployments, tear-downs and configuration changes across your WireGuard environment."
      right={
        <>
          <Select label="Range" value={p.range} onValueChange={(v) => p.set({ range: v })} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
          <IconButton label="Refresh" onClick={() => void q.refetch()}>
            <RefreshCw size={16} aria-hidden />
          </IconButton>
          <span className="act__live">
            <span className="act__live-dot" aria-hidden />
            Live
            <DataAge at={q.dataUpdatedAt || null} />
          </span>
        </>
      }
    />
  );

  if (!data && q.isError) {
    const message = q.error instanceof ApiError || q.error instanceof Error ? q.error.message : "Something went wrong.";
    return (
      <section className="act">
        {header}
        <ErrorState message={message} onRetry={() => void q.refetch()} />
      </section>
    );
  }

  return (
    <section className="act" aria-busy={q.isFetching && !q.data ? true : undefined}>
      {header}
      <Kpis data={data} />
    </section>
  );
}
