import { useMemo, useState } from "react";
import type { ActivityResponse } from "@shared/api";
import type { ActivityRange } from "../../../../worker/src/activity";
import { Button, Panel, StackedBars, type StackBucket, type StackSeries } from "@/components";
import { useWidget } from "@/widgets";
import { bucketLabel, EVENT_TYPES, windowLabel, windowOf, type Window } from "./model";
import { useMedia } from "@/lib/useMedia";

const ALL_SERIES: StackSeries[] = EVENT_TYPES.map((e) => ({ key: e.value, label: e.label, color: e.tone }));

export interface TimelineProps {
  timeline: ActivityResponse["timeline"];
  range: ActivityRange;
  window: Window | null;
  onWindow: (w: Window | null) => void;
}

/** Events per bucket by type; dragging over buckets picks a window that filters the lists below. */
export function Timeline({ timeline, range, window: win, onWindow }: TimelineProps) {
  // The chart keeps its own selection; a new key clears it when Reset is pressed.
  const [generation, setGeneration] = useState(0);
  const short = useMedia("(max-height: 720px)");
  const { settings } = useWidget("activity.timeline");
  const chosen = new Set(settings.series as string[]);
  const series = ALL_SERIES.filter((s) => chosen.has(s.key));
  const legend = settings.legend as boolean;
  const buckets: StackBucket[] = useMemo(() => timeline.map((b) => ({ label: bucketLabel(b.start, range), values: b.counts })), [timeline, range]);

  return (
    <Panel
      title="Activity timeline"
      className="act__timeline"
      actions={
        <>
          {legend && (
            <ul className="act__legend" aria-label="Timeline legend">
              {EVENT_TYPES.filter((e) => chosen.has(e.value)).map((e) => (
                <li key={e.value}>
                  <span className={`act__swatch act__swatch--${e.tone}`} aria-hidden />
                  {e.label}
                </li>
              ))}
            </ul>
          )}
          {win && <span className="act__window">{windowLabel(win)}</span>}
          <Button
            size="sm"
            disabled={!win}
            onClick={() => {
              onWindow(null);
              setGeneration((g) => g + 1);
            }}
          >
            Reset
          </Button>
        </>
      }
    >
      <StackedBars
        key={generation}
        title="Activity timeline"
        series={series}
        buckets={buckets}
        height={short ? 72 : 104}
        onBrush={(r) => onWindow(windowOf(timeline, range, r))}
      />
    </Panel>
  );
}
