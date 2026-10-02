import { AlertTriangle, ArrowRight } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { FirewallDraft } from "@shared/api";
import { Button, Modal, cx } from "@/components";
import { useDraftApply } from "@/api/mutations";
import "./ReviewModal.css";

export interface ReviewModalProps {
  draft: FirewallDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Apply worked: the page shows "waiting for VM" until the VM reports the new rules. */
  onApplied: () => void;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Section({ title, kind, children }: { title: string; kind: "add" | "remove" | "change" | "move"; children: ReactNode }) {
  const id = `fw-review-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section className="fw-review__section">
      <h3 className={cx("fw-review__h", `fw-review__h--${kind}`)} id={id}>
        {title}
      </h3>
      <ul className="fw-review__list" aria-labelledby={id}>
        {children}
      </ul>
    </section>
  );
}

function Mark({ kind }: { kind: "add" | "remove" | "change" | "move" }) {
  const sign = { add: "+", remove: "−", change: "~", move: "↕" }[kind];
  return (
    <span className={cx("fw-review__mark", `fw-review__mark--${kind}`)} aria-hidden>
      {sign}
    </span>
  );
}

/** What Apply would change, in words; Apply sends the draft's base version. 409 and 422 answers are shown here. */
export function ReviewModal({ draft, open, onOpenChange, onApplied }: ReviewModalProps) {
  const apply = useDraftApply();
  const { reset } = apply;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  if (!draft) return null;
  const d = draft.diff;
  const n = draft.changes;
  const label = `${n} ${n === 1 ? "change" : "changes"}`;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={620}
      title={`Review ${label}`}
      description="Nothing reaches the VM until you apply. Apply replaces the live rules with this draft in one step."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={apply.isPending} disabled={apply.isPending || draft.stale} onClick={() => apply.mutate({ baseVersion: draft.baseVersion }, { onSuccess: () => onApplied() })}>
            Apply {label}
          </Button>
        </>
      }
    >
      <div className="fw-review">
        {draft.stale && (
          <p className="fw-review__warn" role="alert">
            <AlertTriangle size={16} aria-hidden />
            The live rules changed since this draft began (an apply elsewhere, a restore or a new default in Settings). Apply will be refused: discard this draft and
            start again.
          </p>
        )}
        {apply.error && (
          <p className="fw-review__error" role="alert">
            <AlertTriangle size={16} aria-hidden />
            {apply.error.message}
          </p>
        )}
        {d.added.length > 0 && (
          <Section title="Added" kind="add">
            {d.added.map((r) => (
              <li key={r.id} className="fw-review__item">
                <Mark kind="add" />
                <span className="visually-hidden">added: </span>
                <span className="fw-review__name">{r.name}</span>
                <span className="fw-review__where">as rule {r.place}</span>
              </li>
            ))}
          </Section>
        )}
        {d.removed.length > 0 && (
          <Section title="Removed" kind="remove">
            {d.removed.map((r) => (
              <li key={r.id} className="fw-review__item">
                <Mark kind="remove" />
                <span className="visually-hidden">removed: </span>
                <span className="fw-review__name">{r.name}</span>
                <span className="fw-review__where">was rule {r.place}</span>
              </li>
            ))}
          </Section>
        )}
        {d.changed.length > 0 && (
          <Section title="Changed" kind="change">
            {d.changed.map((r) => (
              <li key={r.id} className="fw-review__item fw-review__item--block">
                <span className="fw-review__row">
                  <Mark kind="change" />
                  <span className="fw-review__name">{r.name}</span>
                </span>
                <span className="fw-review__fields">
                  {r.fields.map((f) => (
                    <span key={f.field} className="fw-review__field">
                      <span className="fw-review__fname">{f.field}</span>
                      <del className="fw-review__before">{f.before || "(none)"}</del>
                      <ArrowRight size={13} aria-label="becomes" />
                      <ins className="fw-review__after">{f.after || "(none)"}</ins>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </Section>
        )}
        {d.moved.length > 0 && (
          <Section title="Moved" kind="move">
            {d.moved.map((r) => (
              <li key={r.id} className="fw-review__item">
                <Mark kind="move" />
                <span className="fw-review__name">{r.name}</span>
                <span className="fw-review__where">
                  from rule {r.from} to rule {r.to}
                </span>
              </li>
            ))}
          </Section>
        )}
        {d.defaultChanged && (
          <Section title="Default action" kind="change">
            <li className="fw-review__item">
              <Mark kind="change" />
              <span className="fw-review__name">Unmatched traffic</span>
              <del className="fw-review__before">{cap(d.defaultChanged.before)}</del>
              <ArrowRight size={13} aria-label="becomes" />
              <ins className="fw-review__after">{cap(d.defaultChanged.after)}</ins>
            </li>
          </Section>
        )}
      </div>
    </Modal>
  );
}
