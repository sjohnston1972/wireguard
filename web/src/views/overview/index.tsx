import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Settings } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { ErrorState, IconButton, PageHeader, Skeleton, useIsPhone, useToast } from "@/components";
import { useOverview } from "@/api/queries";
import { EnvironmentField } from "@/shell/StateChip";
import { ACTION_WORD, ActionDialog, PALETTE_ACTIONS, actionAllowed, type ActionName } from "./actions";
import { StatusBanner } from "./Banner";
import { useServerNow } from "./hooks";
import { KeyMetrics } from "./KeyMetrics";
import { Topology } from "./Topology";
import { LastRun, RunPanels } from "./Run";
import { RecentEvents, SpeedTests, Traffic } from "./Side";
import { CostImpact, HealthSummary, WatchmanNotes } from "./Lower";
import { PhoneOverview } from "./Phone";
import { STATE_WORD, inGithubRun, regionCountry, regionFull } from "./model";
import "./Overview.css";

const SUBTITLE = "Deploy and monitor your WireGuard environment on Azure.";

/** A read-only header field: caption over a boxed value (Region, VM size). */
function ReadField({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="ov-read" role="group" aria-label={caption}>
      <span className="ov-read__caption" aria-hidden>
        {caption}
      </span>
      <span className="ov-read__value">{children}</span>
    </div>
  );
}

function Header({ o }: { o: OverviewResponse | null }) {
  const navigate = useNavigate();
  const region = o ? o.snapshot.region ?? o.config.region : null;
  const size = o ? o.snapshot.vm_size ?? o.config.vmSize : null;
  const country = regionCountry(region);
  return (
    <PageHeader
      title="Overview"
      subtitle={SUBTITLE}
      env={<EnvironmentField />}
      right={
        <>
          <ReadField caption="Region">
            {country && (
              <span className="ov-flag" aria-hidden>
                {country}
              </span>
            )}
            {region ? regionFull(region) : "no data"}
          </ReadField>
          <ReadField caption="VM size">{size || "no data"}</ReadField>
          <IconButton label="Deployment settings" className="ov-gear" onClick={() => navigate("/settings/deployment")}>
            <Settings size={18} aria-hidden />
          </IconButton>
        </>
      }
    />
  );
}

/** Loading: the page's shape in grey, so nothing jumps when the data lands. */
function OverviewSkeleton() {
  return (
    <div className="ov-skeleton" aria-busy="true" aria-label="Loading the overview">
      <Skeleton variant="block" height={96} />
      <div className="ov-skeleton__row">
        <Skeleton variant="block" height={180} />
        <Skeleton variant="block" height={180} />
      </div>
      <div className="ov-skeleton__row ov-skeleton__row--3">
        <Skeleton variant="block" height={220} />
        <Skeleton variant="block" height={220} />
        <Skeleton variant="block" height={220} />
      </div>
    </div>
  );
}

/** ?action=<name> opens that reviewed form once (never runs anything) and is removed when the form closes. */
function usePaletteAction(o: OverviewResponse | null, open: (a: ActionName, profileId: number | null) => void) {
  const [params, setParams] = useSearchParams();
  const asked = params.get("action") as ActionName | null;
  const handled = useRef<string | null>(null);
  const { toast } = useToast();
  const ready = !!o;
  useEffect(() => {
    // Handled once per appearance of the parameter: a new ?action= (or the same one again later) opens again.
    if (!asked) {
      handled.current = null;
      return;
    }
    if (!o || handled.current === asked) return;
    handled.current = asked;
    // Settings' profile "Use" adds &profile=<id>: the deploy form starts on that profile.
    const profile = Number(params.get("profile"));
    if (PALETTE_ACTIONS.includes(asked) && actionAllowed(asked, o)) open(asked, Number.isInteger(profile) && profile > 0 ? profile : null);
    // Not possible in this state: say so; no form opens, so the address is left as it is.
    else if (PALETTE_ACTIONS.includes(asked)) toast({ tone: "info", title: `${ACTION_WORD[asked]} is not available while the VM is ${STATE_WORD[o.snapshot.state]}.` });
    // `o` is read only when the parameter first appears (or the data first arrives).
  }, [asked, ready, open, toast]);
  return useCallback(() => {
    if (!params.has("action") && !params.has("profile")) return;
    const next = new URLSearchParams(params);
    next.delete("action");
    next.delete("profile");
    setParams(next, { replace: true });
  }, [params, setParams]);
}

export function OverviewPage() {
  const q = useOverview();
  const o = q.data ?? null;
  const phone = useIsPhone();
  const [action, setAction] = useState<ActionName | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const openFromPalette = useCallback((a: ActionName, p: number | null) => {
    setAction(a);
    setProfileId(p);
  }, []);
  const clearParam = usePaletteAction(o, openFromPalette);
  const close = useCallback(() => {
    setAction(null);
    setProfileId(null);
    clearParam();
  }, [clearParam]);

  let body: React.ReactNode;
  if (!o && q.isError) body = <ErrorState title="Could not load the overview" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (!o) body = <OverviewSkeleton />;
  else body = phone ? <Phone o={o} receivedAt={q.dataUpdatedAt} onAction={setAction} /> : <Desktop o={o} receivedAt={q.dataUpdatedAt} onAction={setAction} />;

  return (
    <div className="ov">
      <Header o={o} />
      {body}
      {o && <ActionDialog name={action} o={o} onClose={close} profileId={profileId} />}
    </div>
  );
}

function Phone({ o, receivedAt, onAction }: { o: OverviewResponse; receivedAt: number; onAction: (a: ActionName) => void }) {
  const now = useServerNow(o.now, receivedAt, 10_000);
  return <PhoneOverview o={o} now={now} onAction={onAction} />;
}

function Desktop({ o, receivedAt, onAction }: { o: OverviewResponse; receivedAt: number; onAction: (a: ActionName) => void }) {
  const now = useServerNow(o.now, receivedAt, 10_000);
  return (
    <>
      <StatusBanner o={o} now={now} receivedAt={receivedAt} onAction={onAction} />
      <div className="ov-rows">
        <div className="ov-row ov-row--2">
          <Topology o={o} now={now} />
          <KeyMetrics o={o} now={now} />
        </div>
        {inGithubRun(o.snapshot.state) ? (
          <div className="ov-row ov-row--3">
            <RunPanels o={o} />
            <div className="ov-side">
              <RecentEvents />
              <Traffic o={o} now={now} />
            </div>
          </div>
        ) : (
          <div className="ov-row ov-row--3">
            <LastRun o={o} onAction={onAction} />
            <Traffic o={o} now={now} />
            <div className="ov-side">
              <RecentEvents />
              <SpeedTests o={o} now={now} onAction={onAction} />
            </div>
          </div>
        )}
        <div className="ov-row ov-row--4">
          <HealthSummary o={o} now={now} />
          <CostImpact o={o} />
          <WatchmanNotes />
        </div>
      </div>
    </>
  );
}
