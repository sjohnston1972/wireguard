import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { OverviewResponse, SettingsResponse } from "@shared/api";
import { useDestroy, useReleaseLock } from "@/api/mutations";
import { Button, KeyValue, Panel, formatAge } from "@/components";
import { ConfirmDialog, Lead, ukTime } from "./ui";
import { HealthCheckButton, useHealthCheckFlow } from "./health";
import { KeyRotationHelp } from "./SecuritySection";

/** Maintenance: the rarely needed, consequential actions, each with its own sentence. */
export function MaintenanceSection({ s, ov }: { s: SettingsResponse; ov?: OverviewResponse }) {
  const nav = useNavigate();
  const release = useReleaseLock();
  const destroy = useDestroy();
  const health = useHealthCheckFlow(ov);
  const [ask, setAsk] = useState<"lock" | "destroy" | null>(null);
  const now = ov ? Date.parse(ov.now) : Date.now();
  const held = s.lock.held;
  const age = s.lock.since ? formatAge(Math.max(0, now - Date.parse(s.lock.since))) : null;
  const state = ov?.snapshot.state;
  const canDestroy = !!state && state !== "destroyed" && state !== "destroying";
  return (
    <div className="set-stack">
      <Lead>These are for when something is stuck or you are starting over. Each one says what it will do before it does it.</Lead>
      <Panel title="Health check">
        <p className="set-note">Asks the running VM to re-run its self-test (handshake, tunnel, DNS, internet). The VM answers at its next heartbeat, within about 30 seconds.</p>
        <HealthCheckButton flow={health} />
      </Panel>
      <Panel title="Run lock" status={<span className="set-muted">{held ? "Held" : "Free"}</span>}>
        {held ? (
          <>
            <KeyValue
              items={[
                { label: "Held by run", value: s.lock.runId, mono: true },
                { label: "Since", value: s.lock.since ? ukTime(s.lock.since) : null },
                { label: "Held for", value: age },
              ]}
            />
            <p className="set-note">
              One deploy or tear-down runs at a time. The lock frees itself after 45 minutes. Release it by hand only if that run is truly dead; check GitHub Actions first, or a second run could start on top of it.
            </p>
            <Button variant="danger" onClick={() => setAsk("lock")}>
              Release lock
            </Button>
          </>
        ) : (
          <p className="set-note">The lock is free. One run at a time: a second click gets a clear message instead of a second VM.</p>
        )}
      </Panel>
      <div className="set-two">
        <Panel title="Rotate the server key">
          <KeyRotationHelp />
        </Panel>
        <Panel title="Restore dashboard data">
          <p className="set-note">Replace the clients, firewall rules, ports and settings held here with those from an export file. You see what the file holds before anything changes.</p>
          <Button onClick={() => nav("/settings/backup")}>Go to restore</Button>
        </Panel>
      </div>
      <Panel title="Destroy infrastructure">
        <p className="set-note">
          Tears down the VM and everything Azure built for it. Clients cannot connect until you deploy again, and the next server may get a new public address. Your clients, rules and settings here are kept.
        </p>
        <Button variant="danger" disabled={!canDestroy} onClick={() => setAsk("destroy")}>
          Destroy infrastructure
        </Button>
        {!canDestroy && <span className="set-muted"> Nothing is deployed.</span>}
      </Panel>
      <ConfirmDialog
        open={ask === "lock"}
        onClose={() => setAsk(null)}
        title="Release the run lock"
        consequence={`Run ${s.lock.runId ?? "unknown"} will no longer be protected from a second run. Only continue if it is dead.`}
        phrase="release lock"
        actionLabel="Release lock"
        pending={release.isPending}
        onConfirm={() => release.mutate(undefined, { onSuccess: () => setAsk(null) })}
      />
      <ConfirmDialog
        open={ask === "destroy"}
        onClose={() => setAsk(null)}
        title="Destroy infrastructure"
        consequence="The VM and its Azure resources are deleted. All clients lose their connection until the next deploy."
        phrase="destroy"
        actionLabel="Destroy infrastructure"
        pending={destroy.isPending}
        onConfirm={() => destroy.mutate({ confirm: "destroy" }, { onSuccess: () => setAsk(null) })}
      />
    </div>
  );
}
