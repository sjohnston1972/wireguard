// views/labs/index.tsx
//
// Plain English: the Labs tab (/labs, /labs/:id, /labs/:id/diagram,
// /labs/history), loaded lazily by views/pages.tsx, so the first page load
// never carries it. The default export is the whole tab: the catalogue page
// (with a lab's modal at /labs/:id), a lab's full-screen diagram, the history
// page, or the phone's own composition.

import { lazy, Suspense } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PageHeader, useIsPhone } from "@/components";
import { useLab } from "@/api/queries";
import { HistoryPage } from "./HistoryPage";
import { CouldNotOpen, LabModal, subtitle } from "./LabModal";
import { LabsPage } from "./LabsPage";
import { stateWord } from "./model";
import { PhoneLabs } from "./PhoneLabs";
import { Word } from "./RunningStrip";
import "./labs.css";

// The full-screen diagram is in the diagram's own lazy chunk (lab topology spec ruling 21).
const FullScreen = lazy(() => import("./topology").then((m) => ({ default: m.default.FullScreen })));

/**
 * /labs/:id/diagram (lab topology spec §9.1): the lab's diagram filling the
 * page, desktop and phone. A lab that cannot be opened shows the page with the
 * lab modal's could-not-open notice, as /labs/:id does.
 */
function LabFullScreen({ id, phone }: { id: string; phone: boolean }) {
  const q = useLab(id);
  const navigate = useNavigate();
  const { search } = useLocation();
  const d = q.data;
  if (!d) {
    if (q.isError) {
      const notice = <CouldNotOpen id={id} error={q.error} onRetry={() => void q.refetch()} onDismiss={() => navigate({ pathname: "/labs", search })} />;
      return phone ? (
        <section className="labs labs--phone">
          <PageHeader title="Labs" subtitle="On-demand AZ-104, AZ-305 and AZ-700 labs." />
          {notice}
        </section>
      ) : (
        <LabsPage>{notice}</LabsPage>
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

export default function LabsTab() {
  const { pathname } = useLocation();
  const { id } = useParams();
  const phone = useIsPhone();
  const path = pathname.replace(/\/+$/, "");
  const history = path === "/labs/history";
  if (id && path.endsWith("/diagram")) return <LabFullScreen key={id} id={id} phone={phone} />;
  if (phone) return <PhoneLabs id={history ? null : (id ?? null)} history={history} />;
  if (history) return <HistoryPage />;
  return <LabsPage>{id && <LabModal key={id} id={id} />}</LabsPage>;
}
