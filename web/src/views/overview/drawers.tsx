import { useState } from "react";
import type { OverviewResponse } from "@shared/api";
import { Button, CopyButton, Drawer, KeyValue } from "@/components";
import { fetchSshPassword, useAllowSsh, useReconcile } from "@/api/mutations";
import { ageOf } from "./model";
import "./drawers.css";

/** The per-deploy password: hidden until pressed, fetched then, gone when the drawer closes (this unmounts). */
function Password() {
  const [state, setState] = useState<{ value: string | null; error: string | null; busy: boolean }>({ value: null, error: null, busy: false });
  const show = async () => {
    setState({ value: null, error: null, busy: true });
    try {
      const r = await fetchSshPassword();
      setState({ value: r.password, error: null, busy: false });
    } catch (e) {
      setState({ value: null, error: (e as Error).message, busy: false });
    }
  };
  return (
    <div className="ov-secret">
      {state.value ? (
        <>
          <span className="mono">{state.value}</span>
          <CopyButton text={state.value} label="Copy password" />
          <Button size="sm" variant="ghost" onClick={() => setState({ value: null, error: null, busy: false })}>
            Hide
          </Button>
        </>
      ) : (
        <>
          <span className="mono ov-secret__mask" aria-hidden>
            ••••••••••••
          </span>
          <Button size="sm" variant="secondary" loading={state.busy} disabled={state.busy} onClick={show}>
            Show password
          </Button>
        </>
      )}
      {state.error && (
        <p className="ov-form__error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

export function SshDrawer({ o, open, onClose }: { o: OverviewResponse; open: boolean; onClose: () => void }) {
  const allow = useAllowSsh();
  const s = o.snapshot;
  const running = s.state === "running";
  const dep = o.deployment;
  const loopback = o.config.loopbackIp;
  return (
    <Drawer open={open} onOpenChange={(v) => !v && onClose()} title="SSH to the VM" subtitle="User, password and allow-list for this deployment">
      {!running ? (
        <p className="ov-drawer__note">SSH needs a running VM. Nothing is running now ({s.state}).</p>
      ) : (
        <div className="ov-drawer__stack">
          <KeyValue
            items={[
              { label: "User", value: "azureuser", mono: true },
              { label: "Over the tunnel", value: loopback || null, mono: true, copy: true },
              { label: "Over the internet", value: s.public_ip, mono: true, copy: true },
              { label: "Allowed from", value: dep?.sshAllowedFrom ?? "nobody (no SSH rule)", mono: true },
            ]}
          />
          <div>
            <p className="ov-drawer__caption">Password</p>
            {dep?.hasSshPassword ? <Password /> : <p className="ov-drawer__note">No password on this deployment; use the key.</p>}
            <p className="ov-drawer__note">Made for this deploy only; it dies with the VM.</p>
          </div>
          <div>
            <Button variant="secondary" loading={allow.isPending} disabled={allow.isPending} onClick={() => allow.mutate()}>
              Allow SSH from this address
            </Button>
            <p className="ov-drawer__note">Lets only this browser's IPv4 address reach port 22.</p>
          </div>
          <div>
            <p className="ov-drawer__caption">Commands</p>
            <code className="ov-drawer__code">ssh azureuser@{loopback || s.public_ip}</code>
            <p className="ov-drawer__note">Over the tunnel from any connected client; port 22 is never exposed that way.</p>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function AzureDrawer({ o, now, open, onClose }: { o: OverviewResponse; now: number; open: boolean; onClose: () => void }) {
  const reconcile = useReconcile();
  const az = o.snapshot.azure;
  const rows = az?.resources ?? [];
  const sub = az ? `${rows.length} resource${rows.length === 1 ? "" : "s"} in ${az.resource_group}, checked ${ageOf(az.checked_at, now) ?? "at an unknown time"}` : "Not checked yet";
  return (
    <Drawer
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="In Azure right now"
      subtitle={sub}
      footer={
        <Button variant="secondary" loading={reconcile.isPending} disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
          Check Azure now
        </Button>
      }
    >
      {az?.error && (
        <p className="ov-form__error" role="alert">
          The last check failed: {az.error}
        </p>
      )}
      {rows.length ? (
        <ul className="ov-inventory">
          {rows.map((r) => (
            <li key={`${r.kind}-${r.name}`}>
              <span className="ov-inventory__kind">{r.kind}</span>
              <span className="ov-inventory__name mono">{r.name}</span>
              <span className="ov-inventory__detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      ) : az && !az.exists ? (
        <p className="ov-drawer__note">Azure reports nothing in {az.resource_group}.</p>
      ) : (
        <p className="ov-drawer__note">Waiting for the first Azure check (every 5 minutes), or press Check Azure now.</p>
      )}
    </Drawer>
  );
}
