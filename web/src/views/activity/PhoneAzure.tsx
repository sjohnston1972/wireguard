import { useState } from "react";
import { EmptyState, Panel } from "@/components";
import { useWidget } from "@/widgets";
import { AzureChangeDrawer, useAzureChangeRows } from "./AzureChanges";
import { EventPill, NotConnected, callerLabel, changeLabel, notConnected } from "./azure";
import { fmtWhen } from "./model";
import { ServiceEventDrawer, useServiceEvents } from "./ServiceHealth";

const SHOWN = 5;

function ChangesCard() {
  const { data, rows } = useAzureChangeRows();
  const [open, setOpen] = useState<string | null>(null);
  const selected = rows.find((c) => c.id === open) ?? null;
  return (
    <Panel title="Azure change log" className="act__phone-card">
      {!data ? (
        <p className="act__muted" aria-busy="true">Loading Azure changes...</p>
      ) : notConnected(data.feed) ? (
        <NotConnected />
      ) : rows.length === 0 ? (
        <EmptyState title="No Azure changes" />
      ) : (
        <ul className="act__phone-list">
          {rows.slice(0, SHOWN).map((c) => (
            <li key={c.id}>
              <button type="button" className="act__phone-row" onClick={() => setOpen(c.id)}>
                <span className="act__phone-row-main">
                  <strong>{changeLabel(c)}</strong>
                  <span>{c.resourceName ?? ""}</span>
                  <span className="act__muted">{callerLabel(c)}, {fmtWhen(c.at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && <AzureChangeDrawer change={selected} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function HealthCard() {
  const { data, events, region } = useServiceEvents();
  const [open, setOpen] = useState<string | null>(null);
  const selected = events.find((e) => e.trackingId === open) ?? null;
  return (
    <Panel title="Azure service health" className="act__phone-card">
      {!data ? (
        <p className="act__muted" aria-busy="true">Loading Azure service health...</p>
      ) : notConnected(data.feed) ? (
        <NotConnected />
      ) : events.length === 0 ? (
        <EmptyState title={`No Azure issues or maintenance in ${region}`} />
      ) : (
        <ul className="act__phone-list">
          {events.slice(0, SHOWN).map((e) => (
            <li key={e.trackingId}>
              <button type="button" className="act__phone-row" aria-label={e.title} onClick={() => setOpen(e.trackingId)}>
                <span className="act__phone-row-main">
                  <EventPill e={e} />
                  <strong>{e.title}</strong>
                  <span className="act__muted">{e.startsAt ? fmtWhen(e.startsAt) : ""}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && <ServiceEventDrawer event={selected} region={region} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

/** Spec: on the phone the enabled Azure widgets append as cards under the usual ones. */
export function PhoneAzure() {
  const changes = useWidget("activity.azureChanges");
  const health = useWidget("activity.serviceHealth");
  if (changes.hidden && health.hidden) return null;
  return (
    <div className="act__phone">
      {!changes.hidden && <ChangesCard />}
      {!health.hidden && <HealthCard />}
    </div>
  );
}
