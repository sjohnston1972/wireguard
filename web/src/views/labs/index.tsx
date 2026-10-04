// views/labs/index.tsx
//
// Plain English: the Labs tab (/labs, /labs/:id, /labs/history), loaded lazily
// by views/pages.tsx, so the first page load never carries it. The default
// export is the whole tab: the catalogue page (with a lab's modal at
// /labs/:id), the history page, or the phone's own composition.

import { useLocation, useParams } from "react-router-dom";
import { useIsPhone } from "@/components";
import { HistoryPage } from "./HistoryPage";
import { LabModal } from "./LabModal";
import { LabsPage } from "./LabsPage";
import { PhoneLabs } from "./PhoneLabs";
import "./labs.css";

export default function LabsTab() {
  const { pathname } = useLocation();
  const { id } = useParams();
  const phone = useIsPhone();
  const history = pathname.replace(/\/+$/, "") === "/labs/history";
  if (phone) return <PhoneLabs id={history ? null : (id ?? null)} history={history} />;
  if (history) return <HistoryPage />;
  return <LabsPage>{id && <LabModal key={id} id={id} />}</LabsPage>;
}
