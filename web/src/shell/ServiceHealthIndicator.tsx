// shell/ServiceHealthIndicator.tsx
//
// Plain English: the top bar's Azure Service Health pill, beside the notes
// bell (spec 2026-10-04-azure-insights-design.md, section 10.2). It shows
// only while Azure has an active issue affecting VMs or networking in the
// configured region (useAzureSummary().data.serviceIssues), and never for
// planned maintenance. Amber for an issue, red (and "Serious") when Azure
// rates it Error. Clicking opens each issue's title, services, start, last
// update and summary, with a link to the Activity page's service health widget.

import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, OctagonAlert } from "lucide-react";
import { Link } from "react-router-dom";
import type { ServiceEvent } from "@shared/api";
import { useAzureSummary } from "@/api/queries";
import "./ServiceHealthIndicator.css";

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "02 Oct, 10:22" in the viewer's time zone. */
function when(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${pad(d.getDate())} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : "unknown";
}

const isError = (e: ServiceEvent) => /^error$/i.test(e.level ?? "");

export function ServiceHealthIndicator() {
  const { data } = useAzureSummary();
  const issues = (data?.serviceIssues ?? []).filter((e) => e.type === "ServiceIssue" && e.status === "Active");
  if (!data || issues.length === 0) return null;
  const severe = issues.some(isError);
  const region = data.region.name;
  const word = severe ? "Serious Azure issue" : "Azure issue";
  const Icon = severe ? OctagonAlert : AlertTriangle;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="sh-pill" data-tone={severe ? "red" : "amber"} aria-label={`${word} in ${region}`}>
          <Icon size={15} aria-hidden="true" />
          <span aria-hidden="true">
            {word}
            <span className="sh-pill__region"> in {region}</span>
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="sh-pop" align="end" sideOffset={8} collisionPadding={12} aria-label="Azure service health">
          <ul className="sh-pop__list">
            {issues.map((e) => (
              <li key={e.trackingId}>
                <strong>{e.title}</strong>
                <dl>
                  <dt>Services</dt>
                  <dd>{e.services.join(", ") || "not listed"}</dd>
                  <dt>Started</dt>
                  <dd>{when(e.startsAt)}</dd>
                  <dt>Last update</dt>
                  <dd>{when(e.updatedAt)}</dd>
                </dl>
                {e.summary && <p>{e.summary}</p>}
              </li>
            ))}
          </ul>
          <Link to="/activity?widget=serviceHealth" className="sh-pop__link">
            Azure service health on Activity
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
