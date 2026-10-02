import { useMemo } from "react";
import { useRun, useRunLog } from "@/api/queries";
import { parseLog } from "@/lib/parseLog";

/**
 * One run for the page and its drawer: the saved (or live) steps and the log.
 * The run refreshes every 5 s only while it is the run in progress; its log is
 * fetched once on open (and every 5 s while the run is active), and only when
 * the run has a GitHub log at all. The page's log panel and the drawer ask the
 * same question, so they share one request.
 */
export function useRunData(id: string | null) {
  const detail = useRun(id ?? "", { enabled: id !== null });
  const run = detail.data?.run;
  const active = detail.data?.active ?? false;
  const hasLog = !!run?.github_run_url;
  const log = useRunLog(id ?? "", active, { enabled: id !== null && hasLog });
  const lines = useMemo(() => (log.data ? parseLog(log.data.log).lines : []), [log.data]);
  return { detail, run, steps: detail.data?.steps ?? [], active, hasLog, log, lines };
}
