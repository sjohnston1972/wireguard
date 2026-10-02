import { useMemo, useRef, useState } from "react";
import { ErrorState } from "@/components";
import { useFirewall } from "@/api/queries";
import { RulesPanel } from "./RulesPanel";
import { NO_FILTER, ruleViews, type RuleFilter } from "./model";
import { FirewallSkeleton } from "./FirewallSkeleton";
import "./Firewall.css";

/** /firewall and /firewall/rules/:id (the same page; the rule route opens its drawer). */
export function FirewallPage() {
  const fw = useFirewall();
  const [filter, setFilter] = useState<RuleFilter>(NO_FILTER);
  const tableRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (fw.data ? ruleViews(fw.data) : []), [fw.data]);

  if (fw.isPending) return <FirewallSkeleton />;
  if (fw.isError || !fw.data) return <ErrorState title="Could not load the firewall" message={fw.error?.message ?? "No answer."} onRetry={() => void fw.refetch()} />;
  const data = fw.data;

  return (
    <div className="fw">
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
    </div>
  );
}

export const FirewallRulePage = FirewallPage;
