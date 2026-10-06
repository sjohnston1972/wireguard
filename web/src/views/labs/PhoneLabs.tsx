import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, ErrorState, PageHeader, Sheet, Skeleton } from "@/components";
import { useLabSessions, useLabs } from "@/api/queries";
import { Catalogue } from "./Catalogue";
import { CoverageMap } from "./CoverageMap";
import { SessionsTable } from "./HistoryPage";
import { LabModal } from "./LabModal";
import { Orphans, RunningStrip } from "./RunningStrip";

function YourLabs() {
  const q = useLabSessions(undefined, 200);
  return (
    <div className="labs-phone__history">
      <SessionsTable sessions={q.data?.sessions ?? []} loading={!q.data && !q.isError} error={q.isError && !q.data ? "Could not load the sessions." : null} onRetry={() => void q.refetch()} />
      <CoverageMap bare />
    </div>
  );
}

/**
 * The phone (spec §10): one screen of running labs, each with its light, time
 * left, Extend and Tear down; "Catalogue" and "Your labs" open sheets; a lab
 * opens as a sheet with Deploy (the lab modal is a Drawer side="auto").
 */
export function PhoneLabs({ id, history }: { id: string | null; history: boolean }) {
  const q = useLabs();
  const navigate = useNavigate();
  const [catalogue, setCatalogue] = useState(false);
  // A lab opened from the catalogue sheet takes its place.
  useEffect(() => {
    if (id) setCatalogue(false);
  }, [id]);
  const d = q.data;
  return (
    <section className="labs labs--phone">
      <PageHeader title="Labs" subtitle="On-demand AZ-104, AZ-305 and AZ-700 labs." />
      {id && <LabModal key={id} id={id} />}
      <Orphans orphans={d?.orphans ?? []} />
      {q.isError && !d ? (
        <ErrorState title="Could not load the labs" message={q.error instanceof Error ? q.error.message : "The catalogue could not be loaded."} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <Skeleton variant="block" height={120} />
      ) : d.running.length > 0 ? (
        <RunningStrip sessions={d.running} />
      ) : (
        <p className="labs-phone__none">No labs running.</p>
      )}
      <div className="labs-phone__buttons">
        <Button onClick={() => setCatalogue(true)}>Catalogue</Button>
        <Button onClick={() => navigate("/labs/history")}>Your labs</Button>
      </div>
      {d && (
        <p className="labs-muted">
          {d.running.length} of {d.maxRunning} running · {d.labs.length} labs in the catalogue
        </p>
      )}
      <Sheet open={catalogue} onOpenChange={setCatalogue} title="Catalogue">
        <Catalogue cards={d?.labs ?? []} bare />
      </Sheet>
      <Sheet open={history} onOpenChange={(o) => !o && navigate("/labs")} title="Your labs">
        <YourLabs />
      </Sheet>
    </section>
  );
}
