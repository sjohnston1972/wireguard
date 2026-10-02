import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import type { ActivityResponse } from "@shared/api";
import { DataAge, EmptyState, Panel, Select, Switch } from "@/components";
import { EVENT_TYPES, fmtClock, inWindow, type EventRow, type Window } from "./model";
import { Fill, TypeTag } from "./parts";

const ALL = "all";
const OPTIONS = [{ value: ALL, label: "All events" }, ...EVENT_TYPES.map((e) => ({ value: e.value as string, label: e.label }))];

export interface EventStreamProps {
  events: ActivityResponse["all"];
  window: Window | null;
  /** When the list was fetched (epoch ms). It is polled every 30 s, not streamed, and says so. */
  fetchedAt: number | null;
  onOpenRun: (id: string) => void;
  onOpenChange: (id: number) => void;
  /** Whether a change event can open (its entry is on the loaded page of the change log). */
  hasChange: (id: number) => boolean;
}

/** Runs, notes and changes as one list, newest first. */
export function EventStream({ events, window: win, fetchedAt, onOpenRun, onOpenChange, hasChange }: EventStreamProps) {
  const [kind, setKind] = useState(ALL);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement | null>(null);
  const shown = events.filter((e) => inWindow(e.at, win) && (kind === ALL || e.type === kind));

  // Newest is on top: following means staying at the top as new events arrive.
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = 0;
  }, [shown.length, shown[0]?.at, follow]);

  const open = (e: EventRow) => {
    if (e.ref.kind === "run") onOpenRun(String(e.ref.id));
    else if (e.ref.kind === "change" && hasChange(Number(e.ref.id))) onOpenChange(Number(e.ref.id));
  };
  const opens = (e: EventRow) => e.ref.kind === "run" || (e.ref.kind === "change" && hasChange(Number(e.ref.id)));

  return (
    <Panel
      title="Live event stream"
      className="act__stream"
      flush
      status={<DataAge at={fetchedAt} />}
      actions={
        <>
          <Select label="Event type" value={kind} onValueChange={setKind} options={OPTIONS} />
          <label className="act__follow">
            Auto-scroll
            <Switch label="Auto-scroll" checked={follow} onCheckedChange={setFollow} />
          </label>
        </>
      }
    >
      <Fill className="act__fill--scroll">
        <div ref={box} className="act__scroll">
          {shown.length === 0 ? (
            <EmptyState icon={<Activity size={20} />} title="No events" description={win || kind !== ALL ? "Nothing in this window or filter. Reset the timeline or pick All events." : "Nothing has happened in this range."} />
          ) : (
            <ul className="act__events" aria-label="Events">
              {shown.map((e) => (
                <li key={`${e.ref.kind}-${e.ref.id}-${e.at}`} className="act__event">
                  <span className="act__event-time">{fmtClock(e.at)}</span>
                  <TypeTag type={e.type} />
                  {opens(e) ? (
                    <button type="button" className="act__event-text act__event-open" onClick={() => open(e)}>
                      <strong>{e.title}</strong>
                      {e.detail && <span>{e.detail}</span>}
                    </button>
                  ) : (
                    <span className="act__event-text">
                      <strong>{e.title}</strong>
                      {e.detail && <span>{e.detail}</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Fill>
    </Panel>
  );
}
