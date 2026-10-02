import { FlaskConical, GripVertical, Plus, RotateCcw } from "lucide-react";
import { forwardRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { FirewallResponse } from "@shared/api";
import { Button, EmptyState, Modal, Panel, SearchInput, Select, Tabs, formatAge } from "@/components";
import { useClearCounters, useDraftDeleteRule, useDraftEditRule, useDraftMoveRule } from "@/api/mutations";
import { RulesTable } from "./RulesTable";
import { useReorder } from "./useReorder";
import { NO_FILTER, filterRules, shownDefault, showsDefaultRow, tabCounts, type RuleFilter, type RuleTab, type RuleView } from "./model";
import "./RulesPanel.css";

export interface RulesPanelProps {
  fw: FirewallResponse;
  rows: RuleView[];
  filter: RuleFilter;
  onFilter: (f: RuleFilter) => void;
  onAddRule: () => void;
  onTestSimulation: () => void;
  onEditDefault: () => void;
  className?: string;
}

const ZONE_OPTIONS = (fw: FirewallResponse) => [{ value: "all", label: "All zones" }, ...fw.zones.map((z) => ({ value: z.zone, label: z.label }))];
const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
];

/** "Firewall rules": filter tabs, search, zone and action filters, the table, and its footer actions. */
export const RulesPanel = forwardRef<HTMLDivElement, RulesPanelProps>(function RulesPanel({ fw, rows, filter, onFilter, onAddRule, onTestSimulation, onEditDefault, className }, ref) {
  const navigate = useNavigate();
  const edit = useDraftEditRule();
  const move = useDraftMoveRule();
  const del = useDraftDeleteRule();
  const clear = useClearCounters();
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());

  const counts = tabCounts(rows);
  const shown = filterRules(rows, filter);
  const action = shownDefault(fw);
  const reorder = useReorder({ rows, onMove: (id, body) => move.mutate({ id, ...body }) });

  const toggle = (r: RuleView, enabled: boolean) => {
    setBusy((s) => new Set(s).add(r.id));
    edit.mutate(
      { id: r.id, enabled },
      {
        onSettled: () =>
          setBusy((s) => {
            const n = new Set(s);
            n.delete(r.id);
            return n;
          }),
      },
    );
  };

  const tabs: { value: RuleTab; label: string }[] = [
    { value: "all", label: "All rules" },
    { value: "custom", label: "Custom" },
    { value: "default", label: "Default" },
    { value: "disabled", label: "Disabled" },
  ];
  const showDefault = showsDefaultRow(filter, action);
  const nothing = shown.length === 0 && !showDefault;

  return (
    <Panel title="Firewall rules" className={className} bodyClassName="fw-rp__body" flush>
      <div className="fw-rp__toolbar">
        <Tabs
          variant="pill"
          aria-label="Rule filter"
          value={filter.tab}
          onValueChange={(v) => onFilter({ ...filter, tab: v as RuleTab })}
          items={tabs.map((t) => ({ value: t.value, label: t.label, count: counts[t.value] }))}
          className="fw-rp__tabs"
        />
        <div className="fw-rp__filters">
          <SearchInput className="fw-rp__search" label="Search rules" placeholder="Search rules (source, destination, service...)" value={filter.q} onChange={(q) => onFilter({ ...filter, q })} />
          <Select label="Zone" value={filter.zone} options={ZONE_OPTIONS(fw)} onValueChange={(v) => onFilter({ ...filter, zone: v as RuleFilter["zone"] })} />
          <Select label="Action" value={filter.action} options={ACTION_OPTIONS} onValueChange={(v) => onFilter({ ...filter, action: v as RuleFilter["action"] })} />
        </div>
      </div>
      <div className="fw-rp__scroll dt" ref={ref} tabIndex={-1}>
        {rows.length === 0 ? (
          <EmptyState title="No rules yet" description={`Every flow follows the default action (${action}). Add a rule to allow or block something specific.`} action={{ label: "Add rule", onClick: onAddRule }} />
        ) : (
          nothing && <EmptyState title="No rules match" description="No rule matches these filters. Clear them to see every rule." action={{ label: "Clear filters", onClick: () => onFilter(NO_FILTER) }} />
        )}
        {!nothing && (
          <RulesTable
            rows={shown}
            showDefault={showDefault}
            defaultRow={{ action, hits24h: fw.defaultHits24h ?? null, trend24h: fw.defaultTrend24h ?? [], changed: !!fw.draft?.diff.defaultChanged }}
            zones={fw.zones}
            busyIds={busy}
            firstId={rows[0]?.id ?? null}
            lastId={rows[rows.length - 1]?.id ?? null}
            onToggle={toggle}
            onOpen={(id) => navigate(`/firewall/rules/${id}`)}
            onHistory={(id) => navigate(`/firewall/rules/${id}?tab=history`)}
            onMove={(r, dir) => reorder.moveByButton(r.id, dir)}
            onDelete={(r) => del.mutate(r.id)}
            onEditDefault={onEditDefault}
            rowProps={reorder.rowProps}
            handleProps={reorder.handleProps}
            dropMark={reorder.dropMark}
            isDragging={reorder.isDragging}
            onAltArrow={(r, dir) => reorder.moveByKey(r.id, dir)}
          />
        )}
      </div>
      <footer className="fw-rp__foot">
        <span className="fw-rp__hint">
          <GripVertical size={14} aria-hidden /> Drag to reorder rules. Top to bottom, first match wins.
        </span>
        <span className="fw-rp__actions">
          <Button variant="primary" size="sm" icon={<Plus size={15} aria-hidden />} onClick={onAddRule}>
            Add rule
          </Button>
          <Button size="sm" icon={<FlaskConical size={15} aria-hidden />} onClick={onTestSimulation}>
            Test simulation
          </Button>
          <Button size="sm" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setConfirmClear(true)} title={fw.countersClearedAt ? `Last cleared ${formatAge(Date.parse(fw.now) - Date.parse(fw.countersClearedAt))}` : "Never cleared"}>
            Clear hit counters
          </Button>
        </span>
      </footer>
      <Modal
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear hit counters?"
        description={`Every rule's hit count starts again from zero. ${fw.countersClearedAt ? `Last cleared ${formatAge(Date.parse(fw.now) - Date.parse(fw.countersClearedAt))}.` : "They have never been cleared."} This takes effect at once; it is not part of the draft.`}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="danger" loading={clear.isPending} onClick={() => clear.mutate(undefined, { onSuccess: () => setConfirmClear(false) })}>
              Clear counters
            </Button>
          </>
        }
      />
    </Panel>
  );
});
