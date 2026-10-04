import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import type { LabSession } from "@shared/api";
import { Button, Modal } from "@/components";
import { useCancelLab, useDestroyLab, useExtendLab } from "@/api/mutations";
import { endsAt, extendChoices, fmtGbp, fmtSpan, peeringWord, stateWord, timeLeft, useLabClock } from "./model";

/** A coloured word: the colour never stands alone. */
export function Word({ label, tone, className }: { label: string; tone: string; className?: string }) {
  return <span className={`labs-word labs-word--${tone}${className ? ` ${className}` : ""}`}>{label}</span>;
}

/** "1 h 15 min left" to the timer; before the timer is set (deploying), the time to the hard stop. */
export function TimeLeft({ s, now }: { s: LabSession; now: number }) {
  if (s.state === "tearing_down") return null;
  if (!s.autoDestroyAt) return <span className="labs-left">{fmtSpan(Date.parse(s.maxUntil) - now)} to max</span>;
  return (
    <span className="labs-left" title={`Ends ${new Date(endsAt(s)).toLocaleString("en-GB", { timeZone: "Europe/London" })}`}>
      {timeLeft(s, now)}
    </span>
  );
}

/** "£0.0071 so far", or the words when Azure and the estimate have nothing yet (never £0). */
export const CostSoFar = ({ s }: { s: LabSession }) => <span className="labs-sofar">{s.costGbp === null ? "cost not known yet" : `${fmtGbp(s.costGbp)} so far`}</span>;

/** Extend (1 h, 2 h, to max: only what fits before the hard stop) and Tear down (after a confirm). */
export function SessionActions({ s, now, size = "sm" }: { s: LabSession; now: number; size?: "sm" | "md" }) {
  const choices = extendChoices(s, now);
  const extend = useExtendLab();
  const [confirm, setConfirm] = useState(false);
  const canTearDown = s.state === "running" || s.state === "deploying" || s.state === "failed";
  return (
    <div className="labs-actions">
      {choices.length > 0 && (
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <Button variant="secondary" size={size} loading={extend.isPending} disabled={extend.isPending}>
              Extend
              <ChevronDown size={14} aria-hidden />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="menu" align="end" sideOffset={6}>
              {choices.map((c) => (
                <Dropdown.Item key={c.label} className="menu__item" onSelect={() => extend.mutate("toMax" in c ? { id: s.labId, toMax: true } : { id: s.labId, hours: c.hours })}>
                  {c.label}
                </Dropdown.Item>
              ))}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      )}
      {canTearDown && (
        <Button variant="danger" size={size} onClick={() => setConfirm(true)}>
          Tear down
        </Button>
      )}
      {confirm && <TearDownDialog s={s} onClose={() => setConfirm(false)} />}
    </div>
  );
}

/**
 * Tear down, confirmed in a dialog (spec §15: a confirm, not typing). While a
 * deploy is still going, it cancels that run first (POST /cancel), which then
 * destroys; otherwise POST /destroy.
 */
export function TearDownDialog({ s, onClose }: { s: LabSession; onClose: () => void }) {
  const destroy = useDestroyLab();
  const cancel = useCancelLab();
  const deploying = s.state === "deploying";
  const m = deploying ? cancel : destroy;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !m.isPending && onClose()}
      title={`Tear down ${s.title}?`}
      description={
        deploying
          ? `Cancels the deploy in progress, then removes everything in rg-lab-${s.labId} and the lab's Entra objects, back to £0.`
          : `Removes everything in rg-lab-${s.labId} and the lab's Entra objects, back to £0. Your note is kept.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Keep it
          </Button>
          <Button variant="danger" loading={m.isPending} disabled={m.isPending} onClick={() => m.mutate(s.labId, { onSuccess: onClose })}>
            {deploying ? "Cancel and tear down" : "Tear down now"}
          </Button>
        </>
      }
    />
  );
}

/** One running session: state, title, time left, cost so far, peering, and its actions. */
function Chip({ s, now }: { s: LabSession; now: number }) {
  const { search } = useLocation();
  const st = stateWord(s);
  const peer = peeringWord(s.peering);
  return (
    <li className={`labs-chip labs-chip--${st.tone}`}>
      <div className="labs-chip__head">
        <Word {...st} />
        <Link className="labs-chip__title" to={{ pathname: `/labs/${encodeURIComponent(s.labId)}`, search }}>
          {s.title}
        </Link>
      </div>
      <div className="labs-chip__facts">
        <TimeLeft s={s} now={now} />
        <CostSoFar s={s} />
        <Word {...peer} />
      </div>
      <SessionActions s={s} now={now} />
    </li>
  );
}

/** Top of the page (spec §10), hidden when nothing runs. */
export function RunningStrip({ sessions }: { sessions: LabSession[] }) {
  const now = useLabClock();
  if (sessions.length === 0) return null;
  return (
    <section className="labs-strip" aria-label="Running labs">
      <ul className="labs-strip__list">
        {sessions.map((s) => (
          <Chip key={s.id} s={s} now={now} />
        ))}
      </ul>
    </section>
  );
}
