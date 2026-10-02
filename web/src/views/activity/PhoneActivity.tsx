import { useState, type ReactNode } from "react";
import { Bell, ChevronRight, ListChecks, Rocket } from "lucide-react";
import type { ActivityResponse } from "@shared/api";
import { Button, EmptyState, Panel, Sheet, StatusPill } from "@/components";
import { actionWord, fmtDuration, fmtWhen, noteKind, resultPill } from "./model";

type List = "runs" | "notes" | "changes";

export interface PhoneActivityProps {
  data: ActivityResponse;
  onOpenRun: (id: string) => void;
  onOpenChange: (id: number) => void;
}

function Row({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const inner = (
    <>
      <span className="act__phone-row-main">{children}</span>
      {onClick && <ChevronRight size={16} aria-hidden className="act__chev" />}
    </>
  );
  return <li>{onClick ? <button type="button" className="act__phone-row" onClick={onClick}>{inner}</button> : <div className="act__phone-row">{inner}</div>}</li>;
}

/** Spec §9: the last run and the last note, and a button for each list (which opens in a sheet). */
export function PhoneActivity({ data, onOpenRun, onOpenChange }: PhoneActivityProps) {
  const [list, setList] = useState<List | null>(null);
  const run = data.runs[0];
  const note = data.notes[0];
  const pick = (fn: () => void) => () => {
    setList(null);
    fn();
  };

  return (
    <div className="act__phone">
      <Panel title="Last run" className="act__phone-card">
        {run ? (
          <button type="button" className="act__phone-card-btn" onClick={() => onOpenRun(run.id)}>
            <Rocket size={20} aria-hidden />
            <span className="act__phone-card-text">
              <strong>{actionWord(run.action)}</strong>
              <span className="act__muted">
                {fmtWhen(run.requested_at)}
                {fmtDuration(run.durationSeconds) ? `, ${fmtDuration(run.durationSeconds)}` : ""}
              </span>
            </span>
            <StatusPill {...resultPill(run.status)} />
          </button>
        ) : (
          <EmptyState title="No runs yet" description="A deploy or tear-down shows up here." />
        )}
      </Panel>
      <Panel title="Last note" className="act__phone-card">
        {note ? (
          <div className="act__phone-card-btn">
            <Bell size={20} aria-hidden />
            <span className="act__phone-card-text">
              <strong>{noteKind(note.kind)}</strong>
              <span>{note.message}</span>
              <span className="act__muted">{fmtWhen(note.at)}</span>
            </span>
          </div>
        ) : (
          <EmptyState title="No notes yet" description="The watchman writes a note when something looks wrong." />
        )}
      </Panel>
      <div className="act__phone-buttons">
        <Button size="lg" icon={<ListChecks size={18} />} onClick={() => setList("runs")}>
          Runs
        </Button>
        <Button size="lg" onClick={() => setList("notes")}>
          Notes
        </Button>
        <Button size="lg" onClick={() => setList("changes")}>
          Changes
        </Button>
      </div>

      {list === "runs" && (
        <Sheet open onOpenChange={(o) => !o && setList(null)} title="Runs">
          {data.runs.length === 0 ? (
            <EmptyState title="No runs in this range" />
          ) : (
            <ul className="act__phone-list">
              {data.runs.map((r) => (
                <Row key={r.id} onClick={pick(() => onOpenRun(r.id))}>
                  <strong>{actionWord(r.action)}</strong>
                  <StatusPill {...resultPill(r.status)} />
                  <span className="act__muted">{fmtWhen(r.requested_at)}</span>
                </Row>
              ))}
            </ul>
          )}
        </Sheet>
      )}
      {list === "notes" && (
        <Sheet open onOpenChange={(o) => !o && setList(null)} title="Watchman notes">
          {data.notes.length === 0 ? (
            <EmptyState title="No notes in this range" />
          ) : (
            <ul className="act__phone-list">
              {data.notes.map((n) => (
                <Row key={n.id}>
                  <strong>{noteKind(n.kind)}</strong>
                  <span>{n.message}</span>
                  <span className="act__muted">{fmtWhen(n.at)}</span>
                </Row>
              ))}
            </ul>
          )}
        </Sheet>
      )}
      {list === "changes" && (
        <Sheet open onOpenChange={(o) => !o && setList(null)} title="Config changes">
          {data.changes.rows.length === 0 ? (
            <EmptyState title="No changes in this range" />
          ) : (
            <ul className="act__phone-list">
              {data.changes.rows.map((c) => (
                <Row key={c.id} onClick={pick(() => onOpenChange(c.id))}>
                  <code className="act__code">{c.action}</code>
                  <span>{c.lines.join(", ") || c.target || "—"}</span>
                  <span className="act__muted">{fmtWhen(c.at)}</span>
                </Row>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </div>
  );
}
