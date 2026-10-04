import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { forwardRef, useEffect, useId, useState, type FormEvent } from "react";
import type { FirewallResponse } from "@shared/api";
import { Button, ConfirmByTyping, Drawer, EmptyState, Field, IconButton, Modal, Panel, Select, Switch, cx, formatAge } from "@/components";
import { useWidget } from "@/widgets";
import { useForwardAdd, useForwardDelete, useForwardEdit } from "@/api/mutations";
import "./Ports.css";

type Forward = FirewallResponse["forwards"][number];

interface FormState {
  name: string;
  proto: "tcp" | "udp";
  public_port: string;
  target_ip: string;
  target_port: string;
  allow_from: string;
  enabled: boolean;
}
const blank: FormState = { name: "", proto: "tcp", public_port: "", target_ip: "", target_port: "", allow_from: "", enabled: true };
const fromForward = (f: Forward): FormState => ({
  name: f.name,
  proto: f.proto,
  public_port: String(f.public_port),
  target_ip: f.target_ip,
  target_port: String(f.target_port),
  allow_from: f.allow_from,
  enabled: !!f.enabled,
});
const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

/** Add or edit a published port: a guided form, applied at once (not part of the draft). Azure's warning shows as a toast. */
export function ForwardModal({ fw, open, onOpenChange, editing }: { fw: FirewallResponse; open: boolean; onOpenChange: (o: boolean) => void; editing: Forward | null }) {
  const add = useForwardAdd();
  const edit = useForwardEdit();
  const m = editing ? edit : add;
  const [f, setF] = useState<FormState>(blank);
  const formId = useId();
  const { reset } = m;
  useEffect(() => {
    if (open) {
      setF(editing ? fromForward(editing) : blank);
      reset();
    }
  }, [open, editing, reset]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const vnet = fw.zones.find((z) => z.zone === "azure")?.v4[0];
  const home = fw.zones.find((z) => z.zone === "home")?.v4[0];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = {
      name: f.name.trim(),
      proto: f.proto,
      public_port: num(f.public_port),
      target_ip: f.target_ip.trim(),
      target_port: num(f.target_port) ?? num(f.public_port),
      allow_from: f.allow_from.trim(),
    };
    const done = { onSuccess: () => onOpenChange(false) };
    if (editing) edit.mutate({ id: editing.id, ...body, enabled: f.enabled }, done);
    else add.mutate(body, done);
  };
  const general = m.error && !(m.error as { field?: string }).field ? m.error.message : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.name}` : "Add published port"}
      description="Expose a server on your network to the internet through the VM. This changes Azure and the VM at once; it is not part of the draft."
      width={520}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} loading={m.isPending} disabled={m.isPending}>
            {editing ? "Save" : "Publish"}
          </Button>
        </>
      }
    >
      <form id={formId} className="fw-form" onSubmit={submit} noValidate>
        {general && (
          <p className="fw-form__error" role="alert">
            {general}
          </p>
        )}
        <Field label="Name" error={m.fieldError("name")}>
          {(p) => <input {...p} className="input" value={f.name} maxLength={60} onChange={(e) => set("name", e.target.value)} placeholder="Test VM web page" />}
        </Field>
        <div className="fw-form__row">
          <Select label="Protocol" showLabel value={f.proto} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} onValueChange={(v) => set("proto", v as "tcp" | "udp")} />
          <Field label="Public port" error={m.fieldError("public_port")}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={f.public_port} onChange={(e) => set("public_port", e.target.value)} placeholder="8080" />}
          </Field>
        </div>
        <div className="fw-form__row">
          <Field label="Target address" hint={`An address in the Azure VNet${vnet ? ` (${vnet})` : ""}${home ? ` or the home LAN (${home})` : ""}.`} error={m.fieldError("target_ip")}>
            {(p) => <input {...p} className="input input--mono" value={f.target_ip} onChange={(e) => set("target_ip", e.target.value)} placeholder="10.50.2.4" />}
          </Field>
          <Field label="Target port" hint="Blank: the same as the public port." error={m.fieldError("target_port")}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={f.target_port} onChange={(e) => set("target_port", e.target.value)} />}
          </Field>
        </div>
        <Field label="Allowed from" hint="An IPv4 address or network. Blank: anywhere on the internet." error={m.fieldError("allow_from")}>
          {(p) => <input {...p} className="input input--mono" value={f.allow_from} onChange={(e) => set("allow_from", e.target.value)} placeholder="anywhere" />}
        </Field>
        {editing && (
          <label className="fw-form__switch">
            <Switch checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} label="Published" />
            Published (turn off to close the port but keep its settings)
          </label>
        )}
      </form>
    </Modal>
  );
}

/** "3 connections · last hit 4 m ago": what the VM counted for a published port (the Published ports widget's setting). */
function usage(f: Forward, now: string): string {
  const n = f.connections?.[0];
  const count = n === undefined ? "no data" : `${n.toLocaleString("en-GB")} ${n === 1 ? "connection" : "connections"}`;
  const last = f.lastHit ? formatAge(Date.parse(now) - Date.parse(f.lastHit)) : "never";
  return `${count} · last hit ${last}`;
}

/**
 * Published-port cards with edit and delete (delete asks for the name). The
 * Published ports widget's settings: whether turned-off ports are listed, and
 * each port's connection count and last hit. `all` lists turned-off ports
 * whatever the setting (the manage sheet, where one is turned back on).
 */
export function PortsList({ fw, onAdd, onEdit, all = false }: { fw: FirewallResponse; onAdd: () => void; onEdit: (f: Forward) => void; all?: boolean }) {
  const del = useForwardDelete();
  const [deleting, setDeleting] = useState<Forward | null>(null);
  const { settings } = useWidget("firewall.ports");
  if (fw.forwards.length === 0) {
    return <EmptyState icon={<Globe />} title="No published ports" description="Nothing on your network is reachable from the internet." action={{ label: "Add published port", onClick: onAdd }} />;
  }
  const shown = settings.showOff || all ? fw.forwards : fw.forwards.filter((f) => f.enabled);
  if (shown.length === 0) return <p className="fw-ports__none">Every published port is turned off.</p>;
  return (
    <>
      <ul className="fw-ports">
        {shown.map((f) => (
          <li key={f.id} className="fw-ports__card">
            <span className={cx("fw-ports__dot", f.enabled ? "fw-ports__dot--on" : "fw-ports__dot--off")} aria-hidden />
            <span className="fw-ports__main">
              <span className="fw-ports__name">
                {f.name}
                {!f.enabled && <span className="fw-ports__off">off</span>}
              </span>
              <span className="fw-ports__map">
                {f.proto.toUpperCase()} {f.public_port} → {f.target_ip}:{f.target_port}
              </span>
              <span className="fw-ports__from">{f.allow_from ? `from ${f.allow_from}` : "from anywhere"}</span>
              {settings.connections && <span className="fw-ports__usage">{usage(f, fw.now)}</span>}
            </span>
            <IconButton size="sm" label={`Edit ${f.name}`} onClick={() => onEdit(f)}>
              <Pencil size={14} aria-hidden />
            </IconButton>
            <IconButton size="sm" label={`Delete ${f.name}`} className="fw-ports__del" onClick={() => setDeleting(f)}>
              <Trash2 size={14} aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
      <Modal open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Stop publishing ${deleting?.name ?? ""}?`} description="The port closes on Azure and the VM at once. This is not part of the draft.">
        {deleting && <ConfirmByTyping phrase={deleting.name} actionLabel="Delete published port" pending={del.isPending} onConfirm={() => del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })} />}
      </Modal>
    </>
  );
}

export const PortsPanel = forwardRef<HTMLButtonElement, { fw: FirewallResponse; onAdd: () => void; onEdit: (f: Forward) => void }>(function PortsPanel({ fw, onAdd, onEdit }, addRef) {
  return (
    <Panel
      title="Published ports"
      scroll
      className="fw-ports-panel"
      actions={
        <Button ref={addRef} size="sm" variant="primary" icon={<Plus size={14} aria-hidden />} onClick={onAdd}>
          Add published port
        </Button>
      }
    >
      <p className="fw-panel-sub">Expose a server on your network to the internet.</p>
      <PortsList fw={fw} onAdd={onAdd} onEdit={onEdit} />
    </Panel>
  );
});

/**
 * Every published port in a drawer (a bottom sheet on the phone), to add,
 * edit (which turns one off or on) or delete: how ports are managed while the
 * Published ports widget is hidden.
 */
export function PortsSheet({ fw, open, onOpenChange, onAdd, onEdit }: { fw: FirewallResponse; open: boolean; onOpenChange: (o: boolean) => void; onAdd: () => void; onEdit: (f: Forward) => void }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Published ports" subtitle="Expose a server on your network to the internet.">
      <div className="fw-ports-sheet">
        <Button size="sm" variant="primary" icon={<Plus size={14} aria-hidden />} onClick={onAdd}>
          Add published port
        </Button>
        <PortsList fw={fw} onAdd={onAdd} onEdit={onEdit} all />
      </div>
    </Drawer>
  );
}
