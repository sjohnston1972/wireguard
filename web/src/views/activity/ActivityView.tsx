import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ActivityResponse } from "@shared/api";
import { DataAge, ErrorState, IconButton, PageHeader, Select, useIsPhone } from "@/components";
import { useActivity } from "@/api/queries";
import { ActivityList } from "./ActivityList";
import { ChangeLog } from "./ChangeLog";
import { EventStream } from "./EventStream";
import { Kpis } from "./Kpis";
import { RANGES, type Window } from "./model";
import { Timeline } from "./Timeline";
import { useActivityParams } from "./useActivityParams";
import "./activity.css";

/** The last good answer, so a new range keeps the old figures on screen until the new ones arrive. */
function useHeld<T>(data: T | undefined): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  if (data !== undefined) ref.current = data;
  return data ?? ref.current;
}

export function ActivityView({ runId }: { runId?: string }) {
  const p = useActivityParams();
  const q = useActivity({ range: p.range, kind: p.kind, q: p.q, page: p.page > 1 ? p.page : undefined });
  const data: ActivityResponse | undefined = useHeld(q.data);
  const phone = useIsPhone();
  const navigate = useNavigate();
  const location = useLocation();
  void runId;
  void phone;

  // The window picked on the timeline filters the lists; a different range starts without one.
  const [win, setWin] = useState<Window | null>(null);
  useEffect(() => setWin(null), [p.range]);

  const openRun = useCallback(
    (id: string) => navigate({ pathname: `/activity/runs/${encodeURIComponent(id)}`, search: p.search ? `?${p.search}` : "" }, { state: { from: "activity" } }),
    [navigate, p.search],
  );
  const openChange = useCallback((id: number) => p.set({ change: id }), [p]);
  void location;

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
    return (
      <section className="act">
        {header}
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      </section>
    );
  }

  const selectedChange = p.change === null ? null : Number(p.change);
  return (
    <section className="act" aria-busy={q.isFetching && !q.data ? true : undefined}>
      {header}
      <Kpis data={data} />
      {data && (
        <div className="act__main">
          <div className="act__left">
            <Timeline key={p.range} timeline={data.timeline} range={p.range} window={win} onWindow={setWin} />
            <ActivityList data={data} params={p} set={p.set} window={win} selectedRun={runId ?? null} onOpenRun={openRun} onOpenChange={openChange} />
          </div>
          <div className="act__right">
            <EventStream
              events={data.all}
              window={win}
              fetchedAt={q.dataUpdatedAt || null}
              onOpenRun={openRun}
              onOpenChange={openChange}
              hasChange={(id) => data.changes.rows.some((c) => c.id === id)}
            />
            <ChangeLog changes={data.changes} params={p} set={p.set} window={win} selected={selectedChange} onOpen={openChange} />
          </div>
        </div>
      )}
    </section>
  );
}
