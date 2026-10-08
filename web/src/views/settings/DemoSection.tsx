// views/settings/DemoSection.tsx
//
// Plain English: Settings → Demo mode (demo mode spec §8.3). One switch shows a
// made-up environment instead of the real one; Refresh demo data re-seeds it
// (in the Worker, at most every 10 minutes and within a daily allowance). It
// needs only GET /demo, never /settings, so it still works when every other
// answer fails.

import { useEffect, useState } from "react";
import { Button, ErrorState, Panel, Switch } from "@/components";
import { formatAge } from "@/components/data/DataAge";
import { useDemo, useRefreshDemo, useSetDemo } from "@/api/demo";
import "./DemoSection.css";

export const DEMO_INTRO =
  "Demo mode shows a made-up environment instead of yours: clients, runs, costs, labs and Azure data are all invented. Only you see it; it changes nothing for anyone else. While it is on, actions are off: nothing can deploy, change or delete anything. Your real setup keeps running as normal, and its phone alerts still arrive.";

/** 14:32, London time (the Worker's busy messages use the same clock). */
function londonClock(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Re-render every `ms` so "2 m ago" and the Refresh button's wait stay true. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function DemoSection() {
  const demo = useDemo();
  const set = useSetDemo();
  const refresh = useRefreshDemo();
  const clock = useNow(15_000);
  const d = demo.data;

  if (!d) {
    return (
      <div className="set-stack">
        <Panel title="Demo mode">
          <div className="set-demo">
            <p className="set-demo__intro">{DEMO_INTRO}</p>
            {demo.isError ? <ErrorState title="Could not check demo mode" message={demo.error.message} onRetry={() => void demo.refetch()} /> : <p className="set-note">Checking demo mode…</p>}
          </div>
        </Panel>
      </div>
    );
  }

  // Date.now() as well as the ticking clock: a fresh answer is judged at once.
  const now = Math.max(clock, Date.now());
  const turningOn = set.isPending && set.variables === true;
  const checked = set.isPending ? set.variables === true : d.on;
  const words = set.isPending ? (turningOn ? "Preparing demo data…" : "Turning off…") : d.on ? "On: you are seeing demo data." : "Off: you are seeing your real data.";
  const nextAt = d.nextRefreshAt ? Date.parse(d.nextRefreshAt) : NaN;
  const wait = Number.isFinite(nextAt) && nextAt > now ? `Demo data can be refreshed again at ${londonClock(nextAt)}.` : null;
  const last = d.refreshedAt ? formatAge(now - Date.parse(d.refreshedAt)) : "Never";

  return (
    <div className="set-stack">
      <Panel title="Demo mode">
        <div className="set-demo">
          <p className="set-demo__intro">{DEMO_INTRO}</p>
          <div className="set-switch set-demo__row">
            <div>
              <span className="field__label">Show demo data</span>
              <p className="field__hint" aria-live="polite">
                {words}
              </p>
              {set.error && (
                <p className="field__error" role="alert">
                  {set.error.message}
                </p>
              )}
            </div>
            <Switch label="Show demo data" checked={checked} disabled={set.isPending} onCheckedChange={(on) => set.mutate(on)} />
          </div>
          <div className="set-switch set-demo__row">
            <div>
              <span className="field__label">Demo data</span>
              <p className="field__hint">Last refreshed: {last}</p>
              {wait && <p className="set-note">{wait}</p>}
              {refresh.error && (
                <p className="field__error" role="alert">
                  {refresh.error.message}
                </p>
              )}
            </div>
            <Button variant="secondary" loading={refresh.isPending} disabled={!!wait || refresh.isPending} title={wait ?? undefined} onClick={() => refresh.mutate()}>
              Refresh demo data
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
