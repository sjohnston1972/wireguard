// PhoneAzure.tsx
//
// Plain English: on the phone the enabled cloud widgets (Cloud changes and
// Cloud service health) append as cards under the usual ones, in the words
// of the cloud whose data they carry (AWS insights spec 2026-10-15 section 7).

import { useState } from "react";
import { EmptyState, Panel } from "@/components";
import { useWidget } from "@/widgets";
import { cloudLabel } from "../overview/cloud";
import { AzureChangeDrawer, useAzureChangeRows } from "./AzureChanges";
import { EventPill, NotConnected, callerLabel, changeLabel, notConnected } from "./azure";
import { fmtWhen } from "./model";
import { ServiceEventDrawer, useServiceEvents } from "./ServiceHealth";

const SHOWN = 5;

function ChangesCard() {
  const { data, rows, cloud } = useAzureChangeRows();
  const label = cloudLabel(cloud);
  const [open, setOpen] = useState<string | null>(null);
  const selected = rows.find((c) => c.id === open) ?? null;
  return (
    <Panel title="Cloud changes" className="act__phone-card">
      {!data ? (
        <p className="act__muted" aria-busy="true">Loading {label} changes...</p>
      ) : notConnected(data.feed) ? (
        <NotConnected cloud={cloud} />
      ) : rows.length === 0 ? (
        <EmptyState title={`No ${label} changes`} />
      ) : (
        <ul className="act__phone-list">
          {rows.slice(0, SHOWN).map((c) => (
            <li key={c.id}>
              <button type="button" className="act__phone-row" onClick={() => setOpen(c.id)}>
                <span className="act__phone-row-main">
                  <strong>{changeLabel(c)}</strong>
                  <span>{c.resourceName ?? ""}</span>
                  <span className="act__muted">{callerLabel(c, cloud)}, {fmtWhen(c.at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && <AzureChangeDrawer change={selected} cloud={cloud} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function HealthCard() {
  const { data, events, region, cloud } = useServiceEvents();
  const label = cloudLabel(cloud);
  const [open, setOpen] = useState<string | null>(null);
  const selected = events.find((e) => e.trackingId === open) ?? null;
  return (
    <Panel title="Cloud service health" className="act__phone-card act__health-card">
      {!data ? (
        <p className="act__muted" aria-busy="true">Loading {label} service health...</p>
      ) : notConnected(data.feed) ? (
        <NotConnected cloud={cloud} />
      ) : events.length === 0 ? (
        <EmptyState title={`No ${label} issues or maintenance in ${region}`} />
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

/** Spec: on the phone the enabled cloud widgets append as cards under the usual ones. */
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
