import { useMemo, useRef, useState } from "react";
import { ErrorState } from "@/components";
import { useFirewall } from "@/api/queries";
import { RulesPanel } from "./RulesPanel";
import { FirewallHeader } from "./FirewallHeader";
import { ReviewModal } from "./ReviewModal";
import { NO_FILTER, ruleViews, type RuleFilter } from "./model";
import { FirewallSkeleton } from "./FirewallSkeleton";
import "./Firewall.css";

/** /firewall and /firewall/rules/:id (the same page; the rule route opens its drawer). */
export function FirewallPage() {
  const fw = useFirewall();
  const [filter, setFilter] = useState<RuleFilter>(NO_FILTER);
  const [reviewing, setReviewing] = useState(false);
  // When Apply last worked: until a fresher answer arrives the page says "waiting for VM".
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (fw.data ? ruleViews(fw.data) : []), [fw.data]);

  if (fw.isPending) return <FirewallSkeleton />;
  if (fw.isError || !fw.data) return <ErrorState title="Could not load the firewall" message={fw.error?.message ?? "No answer."} onRetry={() => void fw.refetch()} />;
  const data = fw.data;
  const waiting = appliedAt !== null && fw.dataUpdatedAt <= appliedAt;

  return (
    <div className="fw">
      <FirewallHeader fw={data} waiting={waiting} updatedAt={fw.dataUpdatedAt} onReview={() => setReviewing(true)} />
      <RulesPanel
        ref={tableRef}
        fw={data}
        rows={rows}
        filter={filter}
        onFilter={setFilter}
        onAddRule={() => {}}
        onTestSimulation={() => {}}
        onEditDefault={() => {}}
        className="fw__rules"
      />
      <ReviewModal
        draft={data.draft}
        open={reviewing && !!data.draft}
        onOpenChange={setReviewing}
        onApplied={() => {
          setAppliedAt(Date.now());
          setReviewing(false);
        }}
      />
    </div>
  );
}

export const FirewallRulePage = FirewallPage;
