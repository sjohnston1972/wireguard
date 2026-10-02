import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { FirewallResponse } from "@shared/api";
import { Button, DataAge, Modal, cx } from "@/components";
import { useDraftDiscard } from "@/api/mutations";
import "./FirewallHeader.css";

type PolicyState = FirewallResponse["policy"]["state"];

/** The policy status as words: what the VM is doing with the live rule set. */
export function policyView(state: PolicyState, text: string, waiting: boolean): { word: string; tone: "green" | "amber" | "red" | "grey"; detail: string } {
  if (waiting || state === "pending") return { word: "Waiting for VM", tone: "amber", detail: "The VM picks the new rules up within 30 seconds." };
  switch (state) {
    case "applied":
      return { word: "Active", tone: "green", detail: text };
    case "refused":
      return { word: "Refused by the VM", tone: "red", detail: text };
    case "no_firewall":
      return { word: "Needs a redeploy", tone: "amber", detail: text };
    default:
      return { word: "Not running", tone: "grey", detail: text };
  }
}

export function PolicyStatus({ fw, waiting, updatedAt, compact }: { fw: FirewallResponse; waiting: boolean; updatedAt: number; compact?: boolean }) {
  const v = policyView(fw.policy.state, fw.policy.text, waiting);
  return (
    <div className={cx("fw-policy", compact && "fw-policy--compact")} role="status" aria-label="Policy status">
      <span className="fw-policy__label">Policy status</span>
      <span className="fw-policy__line">
        <span className={cx("fw-policy__dot", `fw-policy__dot--${v.tone}`)} aria-hidden />
        <span className={cx("fw-policy__word", `fw-policy__word--${v.tone}`)}>{v.word}</span>
        {v.tone !== "red" && <DataAge at={updatedAt} className="fw-policy__age" />}
      </span>
      {(v.tone === "red" || v.tone === "amber") && (
        <span className="fw-policy__detail" title={v.detail}>
          {v.detail}
        </span>
      )}
    </div>
  );
}

/** "n unpublished changes", Discard (asks first) and Review & apply. Only while a draft exists. */
export function DraftBar({ fw, onReview, className, pinned }: { fw: FirewallResponse; onReview: () => void; className?: string; pinned?: boolean }) {
  const discard = useDraftDiscard();
  const [asking, setAsking] = useState(false);
  const n = fw.draft?.changes ?? 0;
  if (!fw.draft) return null;
  const words = `${n} unpublished ${n === 1 ? "change" : "changes"}`;
  return (
    <div className={cx("fw-draftbar", className)} role="region" aria-label="Unpublished changes" data-pinned={pinned ? "bottom" : undefined}>
      <span className="fw-draftbar__count">
        <span className={cx("fw-draftbar__dot", fw.draft.stale && "fw-draftbar__dot--stale")} aria-hidden />
        {words}
      </span>
      {fw.draft.stale && (
        <span className="fw-draftbar__stale" role="note">
          <AlertTriangle size={14} aria-hidden />
          <span>Draft out of date: the live rules changed since it began. Discard it, or review what it would change.</span>
        </span>
      )}
      <Button onClick={() => setAsking(true)}>Discard changes</Button>
      <Button variant="primary" icon={<Check size={15} aria-hidden />} onClick={onReview}>
        Review &amp; apply
      </Button>
      <Modal
        open={asking}
        onOpenChange={setAsking}
        title={`Discard ${words}?`}
        description="The draft is deleted. The live rules stay exactly as they are."
        footer={
          <>
            <Button onClick={() => setAsking(false)}>Keep editing</Button>
            <Button variant="danger" loading={discard.isPending} onClick={() => discard.mutate(undefined, { onSuccess: () => setAsking(false) })}>
              Discard draft
            </Button>
          </>
        }
      />
    </div>
  );
}

export interface FirewallHeaderProps {
  fw: FirewallResponse;
  waiting: boolean;
  updatedAt: number;
  onReview: () => void;
}

/** Shield, title and subtitle; on the right the policy status and, with a draft, the draft bar. */
export function FirewallHeader({ fw, waiting, updatedAt, onReview }: FirewallHeaderProps) {
  return (
    <header className="fw-head">
      <span className="fw-head__icon" aria-hidden>
        <ShieldCheck size={28} />
      </span>
      <div className="fw-head__text">
        <h1 className="fw-head__title">Firewall</h1>
        <p className="fw-head__subtitle">Control traffic between tunnel clients, your networks and the internet.</p>
      </div>
      <div className="fw-head__right">
        <PolicyStatus fw={fw} waiting={waiting} updatedAt={updatedAt} />
        <DraftBar fw={fw} onReview={onReview} />
      </div>
    </header>
  );
}
