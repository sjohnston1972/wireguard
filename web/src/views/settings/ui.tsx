import type { ReactNode } from "react";
import { Button, ConfirmByTyping, Field, Modal, Select, Skeleton, Switch, cx, type SelectOption } from "@/components";
import { useEdits } from "./edits";

// Small pieces used by more than one Settings section.

/** "02 Oct, 10:21" in UK time (the dashboard's clock for schedules). */
export function ukTime(iso: string | null | undefined): string {
  if (!iso) return "no data";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "no data";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(" at ", ", ");
}

/** £0.38 */
export const gbp = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? "no data" : `£${n.toFixed(digits)}`);

/** The words for a count: 1 phone, 2 phones. */
export const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** A section's lead sentence. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="set-lead">{children}</p>;
}

/** A label over a value (header stats, panel facts). */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx("set-stat", className)}>
      <span className="set-stat__label">{label}</span>
      <span className="set-stat__value">{value}</span>
      {sub && <span className="set-stat__sub">{sub}</span>}
    </div>
  );
}

/** A coloured dot with a word: status is never colour alone. */
export function Light({ tone, children }: { tone: "green" | "amber" | "red" | "grey"; children: ReactNode }) {
  return (
    <span className={cx("set-light", `set-light--${tone}`)}>
      <span className="set-light__dot" aria-hidden />
      {children}
    </span>
  );
}

/** One row of a settings form: a text-like input bound to a setting. */
export function SettingInput({ name, label, hint, mono }: { name: string; label: string; hint?: ReactNode; mono?: boolean }) {
  const e = useEdits();
  return (
    <Field label={label} hint={hint} error={e.fieldError(name)}>
      {(p) => <input {...p} className={cx("input", mono && "input--mono")} inputMode="decimal" autoComplete="off" value={e.value<string>(name)} onChange={(ev) => e.set(name, ev.target.value)} />}
    </Field>
  );
}

/** A labelled Select with a hint and the server's complaint beneath it. */
export function SelectField({ label, hint, error, options, value, onValueChange }: { label: string; hint?: ReactNode; error?: string; options: SelectOption[]; value: string; onValueChange: (v: string) => void }) {
  return (
    <div className="field">
      <span className="field__label" aria-hidden>
        {label}
      </span>
      <Select label={label} options={options} value={value} onValueChange={onValueChange} />
      {hint && <p className="field__hint">{hint}</p>}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A switch with its words beside it, bound to a boolean setting. */
export function SettingSwitch({ name, label, hint }: { name: string; label: string; hint?: ReactNode }) {
  const e = useEdits();
  return (
    <div className="set-switch">
      <div>
        <span className="field__label">{label}</span>
        {hint && <p className="field__hint">{hint}</p>}
        {e.fieldError(name) && (
          <p className="field__error" role="alert">
            {e.fieldError(name)}
          </p>
        )}
      </div>
      <Switch label={label} checked={e.value<boolean>(name)} onCheckedChange={(v) => e.set(name, v)} />
    </div>
  );
}

/** Save / Discard for a section's unsaved settings; nothing at all while it is clean. */
export function UnsavedBar({ section, label }: { section: string; label: string }) {
  const e = useEdits();
  if (!e.isDirty(section)) return null;
  return (
    <section className="set-unsaved" role="region" aria-label="Unsaved changes">
      <p>
        <strong>Unsaved changes</strong> in {label}. They apply to the next deploy once saved.
      </p>
      <div className="set-unsaved__actions">
        <Button variant="ghost" onClick={() => e.discard(section)} disabled={e.saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={() => e.save(section)} loading={e.saving} disabled={e.saving}>
          Save
        </Button>
      </div>
    </section>
  );
}

/** A reviewed destructive action: what it does, then the typed word. Never window.confirm. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  consequence,
  phrase,
  actionLabel,
  onConfirm,
  pending,
  variant,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  consequence: ReactNode;
  phrase: string;
  actionLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  variant?: "danger" | "primary";
}) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title} description={consequence}>
      <ConfirmByTyping phrase={phrase} actionLabel={actionLabel} onConfirm={onConfirm} pending={pending} variant={variant} />
    </Modal>
  );
}

/** A panel-shaped skeleton while the settings load. */
export function SettingsSkeleton() {
  return (
    <div className="set-skeleton" role="status" aria-busy="true" aria-label="Loading settings">
      <Skeleton variant="block" height={88} />
      <div className="set-skeleton__row">
        <Skeleton variant="block" height={220} />
        <Skeleton variant="block" height={220} />
        <Skeleton variant="block" height={220} />
      </div>
      <div className="set-skeleton__row">
        <Skeleton variant="block" height={150} />
        <Skeleton variant="block" height={150} />
        <Skeleton variant="block" height={150} />
      </div>
    </div>
  );
}
