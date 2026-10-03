import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ActivityResponse } from "@shared/api";
import { DataAge, ErrorState, IconButton, PageHeader, Select, Skeleton, useIsPhone } from "@/components";
import { useActivity } from "@/api/queries";
import { ActivityList } from "./ActivityList";
import { ChangeLog } from "./ChangeLog";
import { ChangeDrawer, RunDrawer } from "./Drawers";
import { EventStream } from "./EventStream";
import { Kpis } from "./Kpis";
import { RANGES, type Window } from "./model";
import { PhoneActivity } from "./PhoneActivity";
import { LiveOutput, RunDetails } from "./RunPanels";
import { Timeline } from "./Timeline";
import { useActivityParams } from "./useActivityParams";
import { useMedia } from "@/lib/useMedia";
import { LayoutMenu, Widget, WidgetRow, WidgetStack, useRowItems, useWidget } from "@/widgets";
import type { Tab } from "./model";
import "./activity.css";

/** The last good answer, so a new range keeps the old figures on screen until the new ones arrive. */
function useHeld<T>(data: T | undefined): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  if (data !== undefined) ref.current = data;
  return data ?? ref.current;
}

/** The Activity page; with `runId` (the /activity/runs/:id route) that run's drawer is open over it. */
export function ActivityView({ runId }: { runId?: string }) {
  const list = useWidget("activity.list");
  const changeLog = useWidget("activity.changeLog");
  const runDetails = useWidget("activity.runDetails");
  const p = useActivityParams({ tab: list.settings.tab as Tab, kind: changeLog.settings.kind as string });
  const r2 = useRowItems("activity", "r2");
  const q = useActivity({ range: p.range, kind: p.kind, q: p.q, page: p.page > 1 ? p.page : undefined });
  const data: ActivityResponse | undefined = useHeld(q.data);
  const phone = useIsPhone();
  // A short desktop window (the 1100 x 600 boundary): the runs table gets the bottom row's height; the run drawer shows the same steps and log.
  const short = useMedia("(min-width: 1100px) and (max-height: 720px)");
  const navigate = useNavigate();
  const location = useLocation();

  // The window picked on the timeline filters the lists; a different range starts without one.
  const [win, setWin] = useState<Window | null>(null);
  useEffect(() => setWin(null), [p.range]);

  const openRun = useCallback(
    (id: string) => navigate({ pathname: `/activity/runs/${encodeURIComponent(id)}`, search: p.search ? `?${p.search}` : "" }, { state: { from: "activity" } }),
    [navigate, p.search],
  );
  const openChange = useCallback((id: number) => p.set({ change: id }), [p]);
  const closeChange = useCallback(() => p.set({ change: null }), [p]);
  /** Back to the page the run opened from; from a link, to the Activity page with the same range. */
  const closeRun = useCallback(() => {
    if ((location.state as { from?: string } | null)?.from === "activity") navigate(-1);
    else navigate({ pathname: "/activity", search: p.search ? `?${p.search}` : "" }, { replace: true });
  }, [location.state, navigate, p.search]);

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
          <LayoutMenu page="activity" />
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
  const changeRow = selectedChange === null || !data ? null : (data.changes.rows.find((c) => c.id === selectedChange) ?? null);
  // The run shown below: the one open in the drawer, else the newest (or the newest failed one, if Run details is set to that).
  const failedOnly = !runId && runDetails.settings.run === "newestFailed";
  const shownRun = runId ?? (failedOnly ? data?.runs.find((r) => r.status === "failure")?.id : data?.runs[0]?.id) ?? null;

  return (
    <section className="act" aria-busy={q.isFetching && !q.data ? true : undefined}>
      {header}
      {phone ? (
        data ? (
          <PhoneActivity data={data} onOpenRun={openRun} onOpenChange={openChange} />
        ) : (
          <div aria-busy="true" className="act__skel">
            <Skeleton variant="block" height={96} />
            <Skeleton variant="block" height={96} />
          </div>
        )
      ) : (
        <>
          <Widget id="activity.kpis" headerless>
            <Kpis data={data} />
          </Widget>
          {data && (
            <div className="act__main">
              <WidgetRow page="activity" row="r2" className={r2.isDefault ? "act__r2" : "act__r2 act__r2--custom"}>
                {{
                  left: (
                    <WidgetStack page="activity" stack="left" className="act__left">
                      {{
                        "activity.timeline": (
                          <Widget id="activity.timeline">
                            <Timeline key={p.range} timeline={data.timeline} range={p.range} window={win} onWindow={setWin} />
                          </Widget>
                        ),
                        "activity.list": (
                          <Widget id="activity.list" headerless>
                            <ActivityList data={data} params={p} set={p.set} window={win} selectedRun={runId ?? null} onOpenRun={openRun} onOpenChange={openChange} />
                          </Widget>
                        ),
                      }}
                    </WidgetStack>
                  ),
                  right: (
                    <WidgetStack page="activity" stack="right" className="act__right">
                      {{
                        "activity.stream": (
                          <Widget id="activity.stream">
                            <EventStream
                              events={data.all}
                              window={win}
                              fetchedAt={q.dataUpdatedAt || null}
                              now={Date.parse(data.now)}
                              onOpenRun={openRun}
                              onOpenChange={openChange}
                              hasChange={(id) => data.changes.rows.some((c) => c.id === id)}
                            />
                          </Widget>
                        ),
                        "activity.changeLog": (
                          <Widget id="activity.changeLog">
                            <ChangeLog changes={data.changes} params={p} set={p.set} window={win} selected={selectedChange} onOpen={openChange} />
                          </Widget>
                        ),
                      }}
                    </WidgetStack>
                  ),
                }}
              </WidgetRow>
              {!short && (
                <WidgetRow page="activity" row="r3" className="act__bottom">
                  {{
                    "activity.runDetails": (
                      <Widget id="activity.runDetails">
                        <RunDetails id={shownRun} {...(failedOnly ? { emptyTitle: "No failed runs", emptyHint: "A failed deploy or tear-down shows its steps here." } : {})} />
                      </Widget>
                    ),
                    "activity.liveOutput": (
                      <Widget id="activity.liveOutput">
                        <LiveOutput id={shownRun} search={p.search} />
                      </Widget>
                    ),
                  }}
                </WidgetRow>
              )}
            </div>
          )}
        </>
      )}
      {runId && <RunDrawer id={runId} onClose={closeRun} />}
      {data && selectedChange !== null && !runId && <ChangeDrawer change={changeRow} onClose={closeChange} />}
    </section>
  );
}
