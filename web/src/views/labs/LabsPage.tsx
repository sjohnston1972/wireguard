import { NavLink } from "react-router-dom";
import { ErrorState, PageHeader, Skeleton } from "@/components";
import { useLabs } from "@/api/queries";
import { EnvironmentField } from "@/shell/StateChip";
import { Catalogue } from "./Catalogue";
import { Filters } from "./Filters";
import { Orphans, RunningStrip } from "./RunningStrip";

/** Catalogue | Your labs: the tab's two pages, as links (so each has its address). */
export function LabsNav() {
  return (
    <nav className="labs-nav" aria-label="Labs pages">
      <NavLink end to="/labs" className={({ isActive }) => (isActive ? "labs-nav__link labs-nav__link--on" : "labs-nav__link")}>
        Catalogue
      </NavLink>
      <NavLink to="/labs/history" className={({ isActive }) => (isActive ? "labs-nav__link labs-nav__link--on" : "labs-nav__link")}>
        Your labs
      </NavLink>
    </nav>
  );
}

export function LabsHeader() {
  const q = useLabs();
  const d = q.data;
  return (
    <PageHeader
      title="Labs"
      subtitle="On-demand AZ-104 and AZ-305 lab environments, each back to £0 when it ends."
      env={<EnvironmentField />}
      right={
        <>
          {d && (
            <span className="labs-capacity">
              {d.running.length} of {d.maxRunning} running · {d.slots.used} of {d.slots.total} slots
            </span>
          )}
          <LabsNav />
        </>
      }
    />
  );
}

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
          <Orphans orphans={d.orphans} />
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
