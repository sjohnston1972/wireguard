// views/labs/LabsNotices.tsx
//
// Plain English: the page's notices (labs redesign spec §8.2), each its own
// block and never merged: the leftovers the sweep found, "GitHub is not
// connected", "the budget is used up", and one consolidated amber setup banner
// in place of a permission paragraph on every card. The banner counts the
// labs that need setup across the whole catalogue (never the filtered view)
// and links to the existing setup workflow (Settings → Labs → Check
// permissions). Hide hides it for this visit only.

import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import type { LabsResponse } from "@shared/api";
import { IconButton } from "@/components";
import { fmtWhen } from "./model";
import { Orphans } from "./RunningStrip";
import { blockerFix, setupAffected } from "./status";
import "./LabsNotices.css";

/** One role or Graph banner for the whole catalogue (spec §8.2). */
export function LabsSetupBanner({ data, onHide }: { data: LabsResponse; onHide: () => void }) {
  const affected = setupAffected(data.labs).length;
  if (affected === 0) return null;
  const p = data.permissions;
  return (
    <section className="labs-banner" aria-label="Labs setup">
      <TriangleAlert size={18} aria-hidden className="labs-banner__icon" />
      <div className="labs-banner__text">
        <p className="labs-banner__title">Some labs need additional Azure permissions.</p>
        <p className="labs-banner__detail">
          <span>
            {affected} of {data.labs.length} labs are affected.
          </span>{" "}
          <span>{p.checkedAt ? `Last checked ${fmtWhen(p.checkedAt)}` : "Permissions have never been checked."}</span>
        </p>
        {p.message && <p className="labs-banner__detail">{p.message}</p>}
      </div>
      <div className="labs-banner__actions">
        <Link className="btn btn--secondary btn--sm" to="/settings/labs">
          Complete setup
        </Link>
        <IconButton label="Hide" size="sm" variant="plain" onClick={onHide}>
          <X size={15} aria-hidden />
        </IconButton>
      </div>
    </section>
  );
}

/** A one-line notice with its fix (GitHub, budget): its own block, never inside the setup banner. */
function Notice({ label, icon, text, fix }: { label: string; icon: React.ReactNode; text: string; fix: { label: string; href: string } | null }) {
  return (
    <section className="labs-banner labs-banner--notice" aria-label={label}>
      {icon}
      <div className="labs-banner__text">
        <p className="labs-banner__title">{text}</p>
      </div>
      {fix && (
        <div className="labs-banner__actions">
          <Link className="btn btn--secondary btn--sm" to={fix.href}>
            {fix.label}
          </Link>
        </div>
      )}
    </section>
  );
}

/**
 * Leftovers, GitHub, budget and setup, in that order (spec §4 item 3). `setupHidden` / `onHideSetup`: the
 * page keeps whether Hide was pressed, so it outlasts this block (the phone's detail view unmounts it);
 * without them it keeps its own.
 */
export function LabsNotices({ data, setupHidden, onHideSetup }: { data: LabsResponse; setupHidden?: boolean; onHideSetup?: () => void }) {
  const [own, setOwn] = useState(false);
  const hidden = setupHidden ?? own;
  const setHidden = () => (onHideSetup ? onHideSetup() : setOwn(true));
  const github = data.labs.some((c) => c.blockers?.some((b) => b.kind === "github"));
  const budget = data.labs.flatMap((c) => c.blockers ?? []).find((b) => b.kind === "budget");
  return (
    <>
      {data.orphans.length > 0 && (
        <div id="labs-orphans" className="labs-notices__orphans">
          <Orphans orphans={data.orphans} />
        </div>
      )}
      {github && (
        <Notice
          label="GitHub not connected"
          icon={<CircleAlert size={18} aria-hidden className="labs-banner__icon labs-banner__icon--grey" />}
          text="Labs can't be deployed: GitHub is not connected."
          fix={blockerFix("github")}
        />
      )}
      {budget && <Notice label="Budget reached" icon={<CircleAlert size={18} aria-hidden className="labs-banner__icon labs-banner__icon--red" />} text={budget.message} fix={blockerFix("budget")} />}
      {!hidden && <LabsSetupBanner data={data} onHide={setHidden} />}
    </>
  );
}
