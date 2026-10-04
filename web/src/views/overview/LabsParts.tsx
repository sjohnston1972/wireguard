// views/overview/LabsParts.tsx
//
// Plain English: the Overview's Running labs widget (off until turned on),
// loaded only when drawn (see lazyLabs.tsx). It lists each live lab with its
// state, time left, cost so far and peering, and Tear down, which asks first.

import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Trash2 } from "lucide-react";
import type { LabSession } from "@shared/api";
import { Button, Modal, Panel, cx } from "@/components";
import { useDestroyLab } from "@/api/mutations";
import { useWidget } from "@/widgets";
import { gbp } from "./model";
import { LAB_STATE_WORD, PEERING_WORD, labTimeLeft } from "./labs";
import "./LabsParts.css";

/** Asks before tearing a lab down (its session ends, resources go, back to £0). */
function TearDownLab({ session, onClose }: { session: LabSession; onClose: () => void }) {
  const destroy = useDestroyLab();
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Tear down this lab?"
      description={`${session.title}: stops the session and deletes everything it built in Azure.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" icon={<Trash2 size={16} aria-hidden />} loading={destroy.isPending} disabled={destroy.isPending} onClick={() => destroy.mutate(session.labId, { onSuccess: onClose })}>
            Tear down now
          </Button>
        </>
      }
    />
  );
}

export function RunningLabs({ labs, now }: { labs: LabSession[]; now: number }) {
  const { settings: st } = useWidget("overview.runningLabs");
  const [asking, setAsking] = useState<LabSession | null>(null);
  return (
    <Panel
      title="Running labs"
      className="ov-rlabs"
      bodyClassName="ov-scroll"
      actions={
        <Link className="ov-link" to="/labs">
          Labs <ArrowRight size={14} aria-hidden />
        </Link>
      }
    >
      {labs.length === 0 ? (
        <p className="ov-rlabs__empty">No labs running.</p>
      ) : (
        <ul className="ov-rlabs__list">
          {labs.map((s) => {
            const left = labTimeLeft(s, now);
            return (
              <li key={s.id} className="ov-rlab" aria-label={s.title}>
                <span className="ov-rlab__text">
                  <Link className="ov-rlab__title" to={`/labs/${s.labId}`}>
                    {s.title}
                  </Link>
                  <span className="ov-rlab__line">
                    <span className={cx("ov-rlab__state", `ov-rlab__state--${s.state}`)}>{LAB_STATE_WORD[s.state]}</span>
                    {left && <span>{left}</span>}
                    {st.costSoFar && <span>{s.costGbp === null ? "no cost yet" : `${gbp(s.costGbp)} so far`}</span>}
                    {st.peering && <span>{PEERING_WORD[s.peering]}</span>}
                  </span>
                </span>
                <Button size="sm" variant="danger" title="Tear down" aria-label={`Tear down ${s.title}`} icon={<Trash2 size={14} aria-hidden />} onClick={() => setAsking(s)}>
                  <span className="ov-rlab__btn">Tear down</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {asking && <TearDownLab session={asking} onClose={() => setAsking(null)} />}
    </Panel>
  );
}
