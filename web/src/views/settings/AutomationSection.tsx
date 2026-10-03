import { useState } from "react";
import type { OverviewResponse, SettingsResponse } from "@shared/api";
import { useAddSchedule, useDeleteSchedule, useEditSchedule } from "@/api/mutations";
import { Button, Chips, EmptyState, Field, Modal, Panel, Switch } from "@/components";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { SelectField, ConfirmDialog, Lead, SettingInput, UnsavedBar, gbp } from "./ui";
import { useEdits } from "./edits";

type Schedule = SettingsResponse["schedules"][number];

const DAYS = [
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
  { value: "7", label: "Sun" },
];

/** Automation: schedules, and what ends or limits a session. */
export function AutomationSection({ s, ov }: { s: SettingsResponse; ov?: OverviewResponse }) {
  const e = useEdits();
  const b = ov?.budget;
  const budget = Number(e.value<string>("monthly_budget_gbp"));
  return (
    <div className="set-stack">
      <Lead>When the VM starts by itself, and what stops it running up a bill. Times are UK time.</Lead>
      <SchedulesPanel s={s} />
      <Panel title="Limits and cost guard">
        <div className="set-form">
          <SettingInput name="auto_destroy_default_hours" label="Auto-destroy after (hours)" hint="The timer a new session starts with. 0 means no timer." />
          <SelectField
            label="When the timer ends"
            hint="Hibernate keeps the server and its address at a small standby cost."
            error={e.fieldError("expiry_action")}
            options={[
              { value: "destroy", label: "Tear down" },
              { value: "hibernate", label: "Hibernate (standby)" },
            ]}
            value={e.value<string>("expiry_action")}
            onValueChange={(v) => e.set("expiry_action", v)}
          />
          <SettingInput name="idle_destroy_minutes" label="Idle limit (minutes)" hint="Tear down if no client has been connected for this long. 0 means off." />
          <SettingInput name="standby_max_days" label="Standby limit (days)" hint="A hibernated VM is torn down after this many days (1 to 60)." />
          <SettingInput name="monthly_budget_gbp" label="Monthly budget warning (£)" hint="You are alerted at 80% and 100% of this. 0 means no budget." />
        </div>
        <p className="set-note" data-level={b?.level ?? "none"}>
          {!b
            ? "Cost guard state is not available yet."
            : budget <= 0
              ? "Cost guard is off: no monthly budget is set."
              : `Cost guard is on: ${gbp(b.total)} of ${gbp(b.budget)} this month (${Math.round(b.pct)}%).`}
        </p>
      </Panel>
      <UnsavedBar section="automation" label="Automation" />
    </div>
  );
}

/** The schedules list with add, edit, switch on/off and delete. */
export function SchedulesPanel({ s }: { s: SettingsResponse }) {
  const edit = useEditSchedule();
  const del = useDeleteSchedule();
  const [form, setForm] = useState<Schedule | "new" | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  return (
    <Panel
      title="Schedules"
      actions={
        <Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setForm("new")}>
          Add schedule
        </Button>
      }
    >
      {!s.schedules.length ? (
        <EmptyState title="No schedules" description="Everything starts by hand. A schedule deploys at the start of its window and sets the timer to its end." action={{ label: "Add a schedule", onClick: () => setForm("new") }} />
      ) : (
        <>
          <p className="set-note">
            Next start: <strong>{s.nextScheduledStart ?? "none (all switched off)"}</strong> <span className="set-muted">UK time</span>
          </p>
          <ul className="set-list" aria-label="Schedules">
            {s.schedules.map((r) => (
              <li key={r.id} className="set-list__row">
                <div className="set-list__main">
                  <span className="set-list__name">
                    {r.daysText} · {r.start_time}–{r.end_time} <span className="set-muted">UK time</span>
                  </span>
                  <span className="set-list__sub">{r.profileName ?? "Usual settings"}</span>
                </div>
                <div className="set-list__actions">
                  <Switch label={`${r.daysText} ${r.start_time} schedule on`} checked={!!r.enabled} disabled={edit.isPending} onCheckedChange={(v) => edit.mutate({ id: r.id, enabled: v })} />
                  <Button size="sm" variant="ghost" aria-label={`Edit schedule ${r.daysText} ${r.start_time}`} icon={<Pencil size={14} aria-hidden />} onClick={() => setForm(r)} />
                  <Button size="sm" variant="ghost" aria-label={`Delete schedule ${r.daysText} ${r.start_time}`} icon={<Trash2 size={14} aria-hidden />} onClick={() => setDeleting(r)} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {form && <ScheduleForm s={s} schedule={form === "new" ? null : form} onClose={() => setForm(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          onClose={() => setDeleting(null)}
          title="Delete this schedule"
          consequence={`Removes ${deleting.daysText} ${deleting.start_time}–${deleting.end_time}. Switch it off instead to keep it for later. A VM it already started keeps running until its timer ends.`}
          phrase="delete"
          actionLabel="Delete schedule"
          pending={del.isPending}
          onConfirm={() => del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </Panel>
  );
}

function ScheduleForm({ s, schedule, onClose }: { s: SettingsResponse; schedule: Schedule | null; onClose: () => void }) {
  const add = useAddSchedule();
  const edit = useEditSchedule();
  const m = schedule ? edit : add;
  const [days, setDays] = useState<string[]>(schedule ? schedule.days.split("") : ["1", "2", "3", "4", "5"]);
  const [start, setStart] = useState(schedule?.start_time ?? "08:00");
  const [end, setEnd] = useState(schedule?.end_time ?? "18:00");
  const [profile, setProfile] = useState(schedule?.profile_id ? String(schedule.profile_id) : "none");
  const submit = () => {
    const body = { days: days.map(Number).sort(), start, end, profileId: profile === "none" ? null : Number(profile) };
    if (schedule) edit.mutate({ id: schedule.id, ...body }, { onSuccess: onClose });
    else add.mutate(body, { onSuccess: onClose });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={schedule ? "Edit schedule" : "Add a schedule"}
      description="The window opens and closes in UK time. It starts once a day."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={m.isPending || !days.length} loading={m.isPending}>
            {schedule ? "Save schedule" : "Add schedule"}
          </Button>
        </>
      }
    >
      <div className="set-form set-form--one">
        <div className="field">
          <span className="field__label">Days</span>
          <Chips items={DAYS} value={days} onChange={setDays} aria-label="Days" />
          {m.fieldError("days") && (
            <p className="field__error" role="alert">
              {m.fieldError("days")}
            </p>
          )}
        </div>
        <div className="set-form set-form--pair">
          <Field label="From" error={m.fieldError("start")}>
            {(p) => <input {...p} className="input" type="time" value={start} onChange={(ev) => setStart(ev.target.value)} />}
          </Field>
          <Field label="Until" error={m.fieldError("end")}>
            {(p) => <input {...p} className="input" type="time" value={end} onChange={(ev) => setEnd(ev.target.value)} />}
          </Field>
        </div>
        <SelectField label="Profile to deploy" error={m.fieldError("profileId")} options={[{ value: "none", label: "Usual settings" }, ...s.profiles.map((p) => ({ value: String(p.id), label: p.name }))]} value={profile} onValueChange={setProfile} />
      </div>
    </Modal>
  );
}
