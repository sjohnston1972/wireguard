import { useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useConnection } from "@/api/connection";
import { useOverview } from "@/api/queries";
import { Button } from "@/components/forms/Button";
import "./status.css";

export type ConnectionLevel = "connecting" | "live" | "stale" | "disconnected";

/**
 * live: the dashboard answers and the VM is reporting.
 * stale: it answers but something is old (the last refresh failed, or the VM has not reported for two minutes).
 * disconnected: the dashboard cannot be reached.
 */
export function useConnectionLevel(): ConnectionLevel {
  const conn = useConnection();
  const { data, isError } = useOverview();
  if (conn.disconnected) return "disconnected";
  if (!data) return isError ? "stale" : "connecting";
  if (isError) return "stale";
  if (data.snapshot.state === "running" && data.derived.heartbeatStale) return "stale";
  return "live";
}

const WORDS: Record<ConnectionLevel, string> = { connecting: "Connecting", live: "Live", stale: "Stale", disconnected: "Disconnected" };

/**
 * Announces the connection level to screen readers. It shows nothing: on
 * screen the state chip's dot carries it (amber stale, grey disconnected),
 * with the word in the chip's details, and the disconnected banner.
 */
export function ConnectionIndicator() {
  const level = useConnectionLevel();
  return (
    <span className="visually-hidden" role="status" aria-label="Connection" data-level={level}>
      {WORDS[level]}
    </span>
  );
}

/** Shown under the top bar while the dashboard cannot be reached. */
export function DisconnectedBanner() {
  const conn = useConnection();
  const qc = useQueryClient();
  if (!conn.disconnected) return null;
  return (
    <div className="conn-banner" role="alert">
      <WifiOff size={16} aria-hidden="true" />
      <span>Cannot reach the dashboard. Showing the last values and refreshing them when it answers; changes are not sent until then.</span>
      <Button size="sm" className="conn-banner__retry" onClick={() => void qc.refetchQueries({ type: "active" })}>
        Retry
      </Button>
    </div>
  );
}
