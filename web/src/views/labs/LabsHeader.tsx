// views/labs/LabsHeader.tsx
//
// Plain English: the Labs tab's header (labs redesign spec §4 item 1): the
// shared PageHeader titled "Azure Labs", the environment, and Catalogue | Your
// labs as two links styled as the segmented control, so each page has its own
// address and the current one is marked for screen readers. Both /labs and
// /labs/history use it.

import { NavLink } from "react-router-dom";
import { PageHeader } from "@/components";
import { EnvironmentField } from "@/shell/StateChip";
import "./LabsHeader.css";

const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? "segmented__item labs-nav__link labs-nav__link--on" : "segmented__item labs-nav__link");

/** Catalogue | Your labs: the tab's two pages, as links (NavLink sets aria-current="page"). */
export function LabsNav() {
  return (
    <nav className="segmented labs-nav" aria-label="Labs pages">
      <NavLink end to="/labs" className={linkClass}>
        Catalogue
      </NavLink>
      <NavLink to="/labs/history" className={linkClass}>
        Your labs
      </NavLink>
    </nav>
  );
}

export const LABS_SUBTITLE = "Hands-on AZ-104, AZ-305 and AZ-700 environments: pick a lab, deploy it, learn by doing.";

export function LabsHeader() {
  return <PageHeader title="Azure Labs" subtitle={LABS_SUBTITLE} env={<EnvironmentField />} right={<LabsNav />} />;
}
