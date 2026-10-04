import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SettingsResponse } from "@shared/api";
import { useAddProfile, useDeleteProfile, useEditProfile, useSaveSettings } from "@/api/mutations";
import { useCapacity } from "@/api/queries";
import { Button, EmptyState, Field, Modal, Panel, SegmentedControl, StatusPill, cx, formatAge } from "@/components";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { useEdits } from "./edits";
import { ConfirmDialog, Lead, SelectField, SettingSwitch, UnsavedBar, plural } from "./ui";

type Profile = SettingsResponse["profiles"][number];

/** Deployment: what the next deploy builds, and the named presets. */
export function DeploymentSection({ s }: { s: SettingsResponse }) {
  const e = useEdits();
  const regionOptions = Object.entries(s.regions).map(([value, label]) => ({ value, label }));
  const sizeOptions = s.vmSizes.map((v) => ({ value: v, label: v }));
  return (
    <div className="set-stack">
      <Lead>What the next deploy builds. Changing these does not touch a VM that is already running; it applies when you next deploy or rebuild.</Lead>
      <Panel title="Next deploy" actions={<StatusPill status="custom" label="Applies to the next deploy" dot={false} variant="outline" />}>
        <div className="set-form">
          <SelectField label="Azure region" hint="The closest region to you. Changing it needs a tear-down and a fresh deploy." error={e.fieldError("region")} options={regionOptions} value={e.value<string>("region")} onValueChange={(v) => e.set("region", v)} />
          <SelectField label="VM size" hint="Small is plenty for a handful of devices." error={e.fieldError("vm_size")} options={sizeOptions} value={e.value<string>("vm_size")} onValueChange={(v) => e.set("vm_size", v)} />
          <CapacityLine region={e.value<string>("region")} size={e.value<string>("vm_size")} />
          <SettingSwitch name="test_vm" label="Test VM behind the firewall" hint="Builds a small second server to test firewall rules against. Costs a little more while it runs." />
          <PriceLine s={s} />
        </div>
      </Panel>
      <UnsavedBar section="deployment" label="Deployment" />
      <ProfilesPanel s={s} />
    </div>
  );
}

/**
 * Can Azure give the next deploy this size here? A warning only when the
 * check fails (it never blocks: the data can be a day old); a quiet line
 * when it passes; nothing while it is not known.
 */
function CapacityLine({ region, size }: { region: string; size: string }) {
  const c = useCapacity(region, size).data;
  if (!c || c.ok === null) return null;
  if (c.ok === false)
    return (
      <p className="set-cap set-cap--warn" role="note">
        <AlertTriangle size={14} aria-hidden />
        <span>{c.message ?? "Azure may not have this size for you here."}</span>
      </p>
    );
  const q = c.family ?? c.total;
  return <p className="set-cap">{["Available", q && `vCPU quota ${q.used} of ${q.limit} used`, c.fetchedAt && `checked ${formatAge(Date.now() - Date.parse(c.fetchedAt))}`].filter(Boolean).join(" · ")}</p>;
}

const per = (n: number | null) => (n === null ? "no data" : `£${n.toFixed(4)}`);
const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(new Date(iso));

/**
 * Where cost estimates take the hourly price from: Azure's list price for the
 * region and size, or the fixed rates (and why). Shown only when the choice
 * means something: Azure has priced this region and size (fresh or stale), or
 * a rate source was saved. Otherwise estimates use the fixed rates exactly as
 * before, and the section is today's screen.
 */
function PriceLine({ s }: { s: SettingsResponse }) {
  const save = useSaveSettings();
  const p = s.price;
  if (!p || (p.fetchedAt === null && s.overrides.rate_source === undefined)) return null;
  const region = (s.regions[p.region] ?? p.region).replace(/\s*\(.*\)$/, "");
  const line =
    p.source === "azure"
      ? `Azure list price, ${region}: VM ${per(p.vmGbpPerHour)} + disk ${per(p.diskGbpPerHour)} + IP ${per(p.ipGbpPerHour)} = ${per(p.totalGbpPerHour)}/h${p.fetchedAt ? ` (${day(p.fetchedAt)})` : ""}`
      : `Fixed rates: ${per(p.totalGbpPerHour)}/h while running, ${per(p.standbyGbpPerHour)}/h in standby.`;
  return (
    <div className="set-price">
      <div>
        <p className="set-price__line">{line}</p>
        {p.reason && <p className="field__hint">{p.reason}</p>}
      </div>
      <SegmentedControl
        aria-label="Cost estimates use"
        items={[
          { value: "azure", label: "Azure price" },
          { value: "fixed", label: "Fixed rates" },
        ]}
        value={s.rateSource}
        onChange={(v) => v !== s.rateSource && save.mutate({ rate_source: v })}
      />
    </div>
  );
}

export function ProfilesPanel({ s, compact }: { s: SettingsResponse; compact?: boolean }) {
  const nav = useNavigate();
  const del = useDeleteProfile();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const usedBy = (p: Profile) => s.schedules.filter((x) => x.profile_id === p.id).length;
  return (
    <Panel
      title="Profiles"
      actions={
        <Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setEditing("new")}>
          Add profile
        </Button>
      }
    >
      {!s.profiles.length ? (
        <EmptyState title="No profiles yet" description="A profile is a named place to deploy, such as a region and size you use often." action={{ label: "Add a profile", onClick: () => setEditing("new") }} />
      ) : (
        <ul className={cx("set-list", compact && "set-list--compact")} aria-label="Profiles">
          {s.profiles.map((p) => (
            <li key={p.id} className="set-list__row">
              <div className="set-list__main">
                <span className="set-list__name">
                  {p.name} {p.deployed && <StatusPill status="deployed" label="Deployed now" variant="outline" />}
                </span>
                <span className="set-list__sub">
                  {s.regions[p.region] ?? p.region} · {p.vm_size}
                  {usedBy(p) > 0 && ` · used by ${plural(usedBy(p), "schedule")}`}
                </span>
              </div>
              <div className="set-list__actions">
                <Button size="sm" onClick={() => nav(`/?action=deploy&profile=${p.id}`)}>
                  Use
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Edit ${p.name}`} icon={<Pencil size={14} aria-hidden />} onClick={() => setEditing(p)} />
                <Button size="sm" variant="ghost" aria-label={`Delete ${p.name}`} icon={<Trash2 size={14} aria-hidden />} onClick={() => setDeleting(p)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <ProfileForm s={s} profile={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.name}`}
          consequence={
            <>
              Removes the profile{p0(deleting.deployed)}. {usedBy(deleting) > 0 ? `${plural(usedBy(deleting), "schedule")} that use it will fall back to the usual settings. ` : ""}A running VM built from it is not touched.
            </>
          }
          phrase="delete"
          actionLabel="Delete profile"
          pending={del.isPending}
          onConfirm={() => del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </Panel>
  );
}
const p0 = (deployed: boolean) => (deployed ? " (it is the one deployed now)" : "");

function ProfileForm({ s, profile, onClose }: { s: SettingsResponse; profile: Profile | null; onClose: () => void }) {
  const add = useAddProfile();
  const edit = useEditProfile();
  const m = profile ? edit : add;
  const [name, setName] = useState(profile?.name ?? "");
  const [region, setRegion] = useState(profile?.region ?? Object.keys(s.regions)[0] ?? "");
  const [size, setSize] = useState(profile?.vm_size ?? s.vmSizes[0] ?? "");
  const submit = () => {
    const body = { name: name.trim(), region, vmSize: size };
    if (profile) edit.mutate({ id: profile.id, ...body }, { onSuccess: onClose });
    else add.mutate(body, { onSuccess: onClose });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={profile ? `Edit ${profile.name}` : "Add a profile"}
      description="A named place to deploy."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={m.isPending || !name.trim()} loading={m.isPending}>
            {profile ? "Save profile" : "Add profile"}
          </Button>
        </>
      }
    >
      <div className="set-form set-form--one">
        <Field label="Name" hint="Up to 24 characters, for example Japan exit." error={m.fieldError("name")}>
          {(p) => <input {...p} className="input" maxLength={24} value={name} onChange={(ev) => setName(ev.target.value)} />}
        </Field>
        <SelectField label="Profile region" error={m.fieldError("region")} options={Object.entries(s.regions).map(([value, label]) => ({ value, label }))} value={region} onValueChange={setRegion} />
        <SelectField label="Profile VM size" error={m.fieldError("vmSize")} options={s.vmSizes.map((v) => ({ value: v, label: v }))} value={size} onValueChange={setSize} />
      </div>
    </Modal>
  );
}
