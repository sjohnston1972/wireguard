import { useState } from "react";
import type { OverviewResponse } from "@shared/api";
import { useHealthCheck } from "@/api/mutations";
import { Button } from "@/components";
import { Activity } from "lucide-react";
import { Light } from "./ui";

// Run health check (spec 8.6): asks the running VM to re-run its boot
// self-test. The VM picks the request up at its next heartbeat, so the answer
// arrives through GET /overview: `selftest_req` while it is pending, then a
// newer `selftest`. "Newer" is judged by the result changing from what it was
// when we asked, not by comparing the phone's clock with the server's.

export type HealthView =
  | { kind: "unavailable"; why: string }
  | { kind: "idle"; last: { at: string; failures: string[] } | null }
  | { kind: "waiting" }
  | { kind: "result"; at: string; failures: string[] };

export function useHealthCheckFlow(ov: OverviewResponse | undefined) {
  const m = useHealthCheck();
  const [asked, setAsked] = useState<{ was: string | null } | null>(null);
  const snap = ov?.snapshot;
  const last = snap?.selftest ?? null;
  const failures = ov?.derived.selftestFailures ?? [];

  let view: HealthView;
  if (!snap || snap.state !== "running") view = { kind: "unavailable", why: "Needs a running VM." };
  else if (snap.selftest_req || (asked && (last?.at ?? null) === asked.was)) view = { kind: "waiting" };
  else if (asked && last) view = { kind: "result", at: last.at, failures };
  else view = { kind: "idle", last: last ? { at: last.at, failures } : null };

  const run = () => m.mutate(undefined, { onSuccess: () => setAsked({ was: last?.at ?? null }) });
  return { view, run, pending: m.isPending };
}

/** The button and the words under it. */
export function HealthCheckButton({ flow, size = "md" }: { flow: ReturnType<typeof useHealthCheckFlow>; size?: "sm" | "md" }) {
  const { view } = flow;
  const disabled = view.kind === "unavailable" || view.kind === "waiting" || flow.pending;
  return (
    <div className="set-health">
      <Button variant="secondary" size={size} icon={<Activity size={14} aria-hidden />} disabled={disabled} loading={flow.pending} onClick={flow.run}>
        Run health check
      </Button>
      <HealthWords view={view} />
    </div>
  );
}

export function HealthWords({ view }: { view: HealthView }) {
  if (view.kind === "unavailable") return <span className="set-muted">{view.why}</span>;
  if (view.kind === "waiting") return <Light tone="amber">Waiting for the VM (within about 30 seconds)</Light>;
  if (view.kind === "result") return view.failures.length ? <Light tone="red">Health check failed: {view.failures.join(", ")}</Light> : <Light tone="green">Health check passed</Light>;
  if (view.last) return view.last.failures.length ? <Light tone="red">Last self-test failed: {view.last.failures.join(", ")}</Light> : <Light tone="green">Last self-test passed</Light>;
  return <span className="set-muted">No self-test result yet</span>;
}
