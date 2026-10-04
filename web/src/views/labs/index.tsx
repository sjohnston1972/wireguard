// views/labs/index.tsx
//
// Plain English: the Labs tab (/labs, /labs/:id, /labs/history), loaded lazily
// by views/pages.tsx, so the first page load never carries it. The default
// export is the whole tab: the catalogue page (with a lab's modal at
// /labs/:id), the history page, or the phone's own composition.

import { useLocation, useParams } from "react-router-dom";
import { LabModal } from "./LabModal";
import { LabsPage } from "./LabsPage";
import "./labs.css";

export default function LabsTab() {
  const { pathname } = useLocation();
  const { id } = useParams();
  const history = pathname.replace(/\/+$/, "") === "/labs/history";
  void history;
  return <LabsPage>{id && <LabModal key={id} id={id} />}</LabsPage>;
}
