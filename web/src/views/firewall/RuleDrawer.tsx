import { useEffect, useId, useState, type FormEvent } from "react";
import type { DraftRuleBody, FirewallResponse } from "@shared/api";
import { BarChart, Button, Drawer, EmptyState, ErrorState, Field, SegmentedControl, Select, Skeleton, Switch, Tabs, useIsPhone } from "@/components";
import { useDraftAddRule, useDraftDeleteRule, useDraftEditRule } from "@/api/mutations";
import { useRuleHistory, type HistoryRange } from "@/api/queries";
import { EndPicker } from "./EndPicker";
import { changedFields, fmtCount, ruleBody, type Proto, type RuleView } from "./model";
import "./RuleDrawer.css";

const NEW_RULE: Required<DraftRuleBody> = {
  name: "",
  from: { kind: "zone", value: "clients" },
  to: { kind: "zone", value: "internet" },
  proto: "any",
  ports: "",
  action: "allow",
  enabled: true,
  log: false,
};

const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

/** A rule's hits over 24 h, 7 d or 30 d (the counter "r<id>"). */
function HitHistory({ id, name }: { id: number; name: string }) {
  const [range, setRange] = useState<HistoryRange>("24h");
  const h = useRuleHistory(`r${id}`, range);
  const fmt = range === "24h" || range === "1h" ? hourFmt : dayFmt;
  const total = h.data?.points.reduce((n, p) => n + p.packets, 0) ?? 0;
  return (
    <div className="fw-hist">
      <SegmentedControl
        aria-label="History range"
        value={range}
        onChange={(v) => setRange(v as HistoryRange)}
        items={[
          { value: "24h", label: "24h" },
          { value: "7d", label: "7d" },
          { value: "30d", label: "30d" },
        ]}
      />
      {h.isPending ? (
        <Skeleton variant="block" height={180} />
      ) : h.isError ? (
        <ErrorState message={h.error.message} onRetry={() => void h.refetch()} />
      ) : h.data.points.length === 0 ? (
        <EmptyState title="No hits recorded" description={`Nothing matched ${name} in the last ${range}, or the VM was not running.`} />
      ) : (
        <>
          <p className="fw-hist__total">
            {fmtCount(total)} packets in the last {range}
          </p>
          <BarChart title={`Hits for ${name}, last ${range}`} bars={h.data.points.map((p) => ({ label: fmt.format(new Date(p.t)), value: p.packets }))} height={180} />
        </>
      )}
    </div>
  );
}

export interface RuleDrawerProps {
  fw: FirewallResponse;
  /** The rule being edited; null with `adding` for a new rule, or when the id is unknown. */
  rule: RuleView | null;
  adding: boolean;
  /** The id in the URL, for the "no such rule" message. */
  id: string | null;
  open: boolean;
  tab: "rule" | "history";
  onTab: (t: "rule" | "history") => void;
  onClose: () => void;
}

/** /firewall/rules/:id and Add rule: the edit form (saves to the draft) and the rule's hit history. */
export function RuleDrawer({ fw, rule, adding, id, open, tab, onTab, onClose }: RuleDrawerProps) {
  const phone = useIsPhone();
  const add = useDraftAddRule();
  const edit = useDraftEditRule();
  const del = useDraftDeleteRule();
  const m = adding ? add : edit;
  const [f, setF] = useState(() => (adding || !rule ? NEW_RULE : ruleBody(rule)));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const formId = useId();
  const key = adding ? "new" : (rule?.id ?? "none");
  const { reset: resetAdd } = add;
  const { reset: resetEdit } = edit;
  // A fresh form whenever another rule (or Add) opens.
  useEffect(() => {
    if (!open) return;
    setF(adding || !rule ? NEW_RULE : ruleBody(rule));
    setConfirmDelete(false);
    resetAdd();
    resetEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the drawer opens on a different rule
  }, [open, key]);

  const set = <K extends keyof DraftRuleBody>(k: K, v: Required<DraftRuleBody>[K]) => setF((s) => ({ ...s, [k]: v }));
  const hasPorts = f.proto === "tcp" || f.proto === "udp";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Required<DraftRuleBody> = { ...f, name: f.name.trim(), ports: hasPorts ? f.ports.trim() : "" };
    if (adding) {
      const { ports, ...rest } = body;
      add.mutate(hasPorts && ports ? body : rest, { onSuccess: onClose });
      return;
    }
    if (!rule) return;
    const changed = changedFields(ruleBody(rule), body);
    if (Object.keys(changed).length === 0) return onClose();
    edit.mutate({ id: rule.id, ...changed }, { onSuccess: onClose });
  };
  // A server error about a field this form shows sits at that field; any other
  // (no field, or proto/enabled/log/unknown, or ports while they are hidden) goes at the top.
  const errField = (m.error as { field?: string } | null)?.field;
  const shown = ["name", "from", "to", "action", ...(hasPorts ? ["ports"] : [])];
  const general = m.error && (!errField || !shown.includes(errField)) ? m.error.message : null;
  const hasHistory = !!rule && fw.rules.some((r) => r.id === rule.id);

  const title = adding ? "Add rule" : rule ? rule.name : `Rule ${id ?? ""}`;
  const subtitle = adding ? "New rules go last, above the default. Saved to the draft." : rule ? `Rule ${rule.place}${rule.mark ? ` · ${rule.mark} in the draft` : ""}` : undefined;

  const form = (
    <form id={formId} className="fw-form fw-rule-form" onSubmit={submit} noValidate>
      {general && (
        <p className="fw-form__error" role="alert">
          {general}
        </p>
      )}
      {rule?.problem && (
        <p className="fw-form__error" role="note">
          The VM cannot apply this rule: {rule.problem}
        </p>
      )}
      <Field label="Name" error={m.fieldError("name")}>
        {(p) => <input {...p} className="input" maxLength={60} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Clients to the test server" />}
      </Field>
      <EndPicker label="From (source)" end={f.from} onChange={(v) => set("from", v)} fw={fw} error={m.fieldError("from")} />
      <EndPicker label="To (destination)" end={f.to} onChange={(v) => set("to", v)} fw={fw} error={m.fieldError("to")} />
      <div className="fw-form__row">
        <Select
          label="Protocol"
          showLabel
          value={f.proto}
          onValueChange={(v) => set("proto", v as Proto)}
          options={[
            { value: "any", label: "Any" },
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
            { value: "icmp", label: "ICMP" },
          ]}
        />
        {hasPorts && (
          <Field label="Ports" hint="443, 80,443 or 8000-8100. Blank: every port." error={m.fieldError("ports")}>
            {(p) => <input {...p} className="input input--mono" value={f.ports} onChange={(e) => set("ports", e.target.value)} />}
          </Field>
        )}
      </div>
      <div className="fw-rule-form__action">
        <span className="field__label">Action</span>
        <SegmentedControl
          aria-label="Action"
          value={f.action}
          onChange={(v) => set("action", v as "allow" | "deny")}
          items={[
            { value: "allow", label: "Allow", dot: "green" },
            { value: "deny", label: "Deny", dot: "red" },
          ]}
        />
        {m.fieldError("action") && <p className="field__error">{m.fieldError("action")}</p>}
      </div>
      <label className="fw-form__switch">
        <Switch checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} label="Enabled" />
        Enabled
      </label>
      <label className="fw-form__switch">
        <Switch checked={f.log} onCheckedChange={(v) => set("log", v)} label="Log matches" />
        Log matches (shows in the VM's firewall log)
      </label>
    </form>
  );

  const footer =
    !adding && !rule ? undefined : (
      <div className="fw-rule-foot">
        {!adding && rule && (
          <span className="fw-rule-foot__left">
            {confirmDelete ? (
              <>
                <Button variant="danger" size="sm" loading={del.isPending} onClick={() => del.mutate(rule.id, { onSuccess: onClose })}>
                  Remove from draft
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" className="fw-rule-foot__del" onClick={() => setConfirmDelete(true)}>
                Delete rule
              </Button>
            )}
          </span>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} loading={m.isPending} disabled={m.isPending}>
          {adding ? "Add to draft" : "Save to draft"}
        </Button>
      </div>
    );

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} side={phone ? "bottom" : "right"} title={title} subtitle={subtitle} footer={tab === "rule" ? footer : undefined} className="fw-rule-drawer">
      {!adding && !rule ? (
        <EmptyState title={`No rule ${id ?? ""}`} description="It may have been deleted, or the draft that held it was discarded or applied." action={{ label: "Back to the rules", onClick: onClose }} />
      ) : adding || !hasHistory ? (
        <>
          {form}
          {!adding && <p className="fw-hist__none">No hit history yet: this rule is new in the draft.</p>}
        </>
      ) : (
        <Tabs
          aria-label="Rule sections"
          value={tab}
          onValueChange={(v) => onTab(v as "rule" | "history")}
          items={[
            { value: "rule", label: "Rule", content: form },
            { value: "history", label: "Hit history", content: <HitHistory id={rule!.id} name={rule!.name} /> },
          ]}
        />
      )}
    </Drawer>
  );
}
