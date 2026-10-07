import { ErrorState, Skeleton } from "@/components";
import { useLabs } from "@/api/queries";
import { LabsHeader } from "./LabsHeader";
import { Catalogue } from "./Catalogue";
import { Filters } from "./Filters";
import { LabsNotices } from "./LabsNotices";
import { RunningStrip } from "./RunningStrip";

/** /labs on a desktop or tablet: the running strip, filters on the left and the catalogue. */
export function LabsPage({ children }: { children?: React.ReactNode }) {
  const q = useLabs();
  const d = q.data;
  return (
    <section className="labs">
      <LabsHeader />
      {children}
      {q.isError && !d ? (
        <ErrorState title="Could not load the labs" message={q.error instanceof Error ? q.error.message : "The catalogue could not be loaded."} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <div className="labs-main" aria-busy="true">
          <Skeleton variant="block" height={240} />
          <Skeleton variant="block" height={240} />
        </div>
      ) : (
        <>
          <LabsNotices data={d} />
          <RunningStrip sessions={d.running} />
          <div className="labs-main">
            <Filters cards={d.labs} />
            <Catalogue cards={d.labs} />
          </div>
        </>
      )}
    </section>
  );
}
