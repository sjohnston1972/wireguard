// views/labs/index.tsx
//
// Plain English: the Labs tab (/labs, /labs/:id, /labs/:id/diagram,
// /labs/history), loaded lazily by views/pages.tsx, so the first page load
// never carries it. The default export is the whole tab: the catalogue page
// (with a lab's dialog at /labs/:id drawn over it), a lab's full-screen
// diagram (or, with ?popout=1, its pop-out window), or the history page. One composition for every screen size: the
// catalogue lays itself out for wide, tablet and phone (labs redesign spec §9).

import { lazy, Suspense, useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useLab } from "@/api/queries";
import { HistoryPage } from "./HistoryPage";
import { CouldNotOpen, LabModal, subtitle } from "./LabModal";
import { LabsPage } from "./LabsPage";
import { stateWord } from "./model";
import { Word } from "./RunningStrip";
import "./labs.css";

// The full-screen diagram is in the diagram's own lazy chunk (lab topology spec ruling 21).
const FullScreen = lazy(() => import("./topology").then((m) => ({ default: m.default.FullScreen })));
// The pop-out window's diagram (issue #93), in the same chunk.
const PopOut = lazy(() => import("./topology").then((m) => ({ default: m.default.PopOut })));

/**
 * /labs/:id/diagram (lab topology spec §9.1): the lab's diagram filling the
 * page, desktop and phone. A lab that cannot be opened shows the catalogue
 * with the lab dialog's could-not-open notice, as /labs/:id does.
 */
function LabFullScreen({ id }: { id: string }) {
  const q = useLab(id);
  const navigate = useNavigate();
  const { search } = useLocation();
  const d = q.data;
  if (!d) {
    if (q.isError) {
      return (
        <LabsPage>
          <CouldNotOpen id={id} error={q.error} onRetry={() => void q.refetch()} onDismiss={() => navigate({ pathname: "/labs", search })} />
        </LabsPage>
      );
    }
    return (
      <section className="labs labs--full" aria-busy="true">
        <p className="labs-sr" role="status">
          Opening the lab…
        </p>
      </section>
    );
  }
  const st = d.session ? stateWord(d.session) : null;
  return (
    <section className="labs labs--full">
      <Suspense
        fallback={
          <p className="labs-muted" role="status">
            Loading the diagram…
          </p>
        }
      >
        <FullScreen labId={d.card.id} session={d.session} title={d.card.title} subtitle={subtitle(d)} leading={st ? <Word {...st} /> : undefined} />
      </Suspense>
    </section>
  );
}

/**
 * /labs/:id/diagram?popout=1 (issue #93): the lab's diagram in its own
 * window, drawn without the app's navigation (shell/Chromeless.tsx), titled
 * "<lab id> diagram · wg-admin". A lab that cannot be opened says so, alone.
 */
function LabPopOut({ id }: { id: string }) {
  const q = useLab(id);
  const navigate = useNavigate();
  useEffect(() => {
    const before = document.title;
    document.title = `${id} diagram · wg-admin`;
    return () => {
      document.title = before;
    };
  }, [id]);
  const d = q.data;
  if (!d) {
    return (
      <section className="labs labs--full labs--popout" aria-busy={!q.isError}>
        {q.isError ? (
          <CouldNotOpen id={id} error={q.error} onRetry={() => void q.refetch()} onDismiss={() => navigate("/labs")} />
        ) : (
          <p className="labs-sr" role="status">
            Opening the lab…
          </p>
        )}
      </section>
    );
  }
  const st = d.session ? stateWord(d.session) : null;
  return (
    <section className="labs labs--full labs--popout">
      <Suspense
        fallback={
          <p className="labs-muted" role="status">
            Loading the diagram…
          </p>
        }
      >
        <PopOut labId={d.card.id} session={d.session} title={d.card.title} subtitle={subtitle(d)} leading={st ? <Word {...st} /> : undefined} />
      </Suspense>
    </section>
  );
}

export default function LabsTab() {
  const { pathname, search } = useLocation();
  const { id } = useParams();
  const path = pathname.replace(/\/+$/, "");
  if (id && path.endsWith("/diagram")) return new URLSearchParams(search).get("popout") === "1" ? <LabPopOut key={id} id={id} /> : <LabFullScreen key={id} id={id} />;
  if (path === "/labs/history") return <HistoryPage />;
  return <LabsPage dialogId={id ?? null}>{id && <LabModal key={id} id={id} />}</LabsPage>;
}
