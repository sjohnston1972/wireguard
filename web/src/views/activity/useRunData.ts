import { useMemo } from "react";
import { useRun, useRunLog } from "@/api/queries";
import { parseLog } from "@/lib/parseLog";

/**
 * One run for the page and its drawer: the saved (or live) steps and the log.
 * The run refreshes every 5 s only while it is the run in progress; its log is
 * fetched once on open (and every 5 s while the run is active). A run in
 * progress always has a log to ask for (the live copy the workflow sends, even
 * before GitHub has a run for it); a finished one only if it reached GitHub.
 * The page's log panel and the drawer ask the same question, so they share
 * one request.
 */
export function useRunData(id: string | null) {
  const detail = useRun(id ?? "", { enabled: id !== null });
  const run = detail.data?.run;
  const active = detail.data?.active ?? false;
  const hasLog = active || !!run?.github_run_url;
  const log = useRunLog(id ?? "", active, { enabled: id !== null && hasLog });
  const lines = useMemo(() => (log.data ? parseLog(log.data.log).lines : []), [log.data]);
  const source = log.data?.source;
  /** The run is going and its log is the live copy, growing as it runs. */
  const streaming = active && source === "live" && log.data?.active !== false;
  /** Streaming, but nothing has arrived yet. */
  const waiting = streaming && lines.length === 0;
  /** Finished, but GitHub had no log, so this is the copy sent while it ran. */
  const liveCopy = !!log.data && source === "live" && !log.data.active;
  return { detail, run, steps: detail.data?.steps ?? [], active, hasLog, log, lines, streaming, waiting, liveCopy };
}
