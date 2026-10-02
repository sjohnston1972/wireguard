import type { SettingsResponse } from "@shared/api";
import { usePushRemove, usePushTest } from "@/api/mutations";
import { Button, EmptyState, Panel, QrCode, Switch } from "@/components";
import { BellRing, Trash2 } from "lucide-react";
import { Lead, Light, plural, ukTime } from "./ui";
import { usePushDevice, type DeviceState } from "./push";

const WORDS: Record<DeviceState["kind"], string> = {
  checking: "Checking this device...",
  unsupported: "This browser cannot receive alerts. On Android use Chrome; on iPhone install the app first (Share, Add to Home Screen).",
  denied: "Notifications are blocked for this site. Allow them in the phone's settings for wg-admin, then come back.",
  off: "Alerts are off on this device.",
  on: "Alerts are on for this device.",
  stale: "This device was signed up once, but the dashboard no longer sends to it (it was removed, or the phone's push service replaced it). Turn alerts on again.",
  error: "",
};

/** Mobile: install the app on a phone, and phone alerts. */
export function MobileSection({ s }: { s: SettingsResponse }) {
  const dev = usePushDevice(s.vapidPublic);
  const test = usePushTest();
  const remove = usePushRemove();
  const on = dev.state.kind === "on";
  const canToggle = dev.state.kind === "on" || dev.state.kind === "off" || dev.state.kind === "stale" || dev.state.kind === "error";
  return (
    <div className="set-stack">
      <Lead>Put wg-admin on a phone like an app, and get an alert when a deploy finishes, a run fails or the budget is close.</Lead>
      <div className="set-two">
        <Panel title="Install on a phone">
          <div className="set-install">
            <QrCode value={s.publicUrl} label={`QR code for ${s.publicUrl}`} size={168} />
            <div>
              <p className="set-note">Scan this with the phone's camera, or open the address below.</p>
              <p className="set-code">
                <code>{s.publicUrl}</code>
              </p>
              <ol className="set-steps">
                <li>Open the address and sign in.</li>
                <li>iPhone: Share, then Add to Home Screen. Android: menu, then Install app.</li>
                <li>Open the app from the home screen and turn alerts on here.</li>
              </ol>
            </div>
          </div>
        </Panel>
        <Panel title="Phone alerts on this device">
          <div className="set-switch">
            <div>
              <span className="field__label">Alerts</span>
              <p className="field__hint" role="status">
                {dev.state.kind === "error" ? dev.state.message : WORDS[dev.state.kind]}
              </p>
            </div>
            <Switch label="Phone alerts on this device" checked={on} disabled={!canToggle || dev.busy} onCheckedChange={(v) => void (v ? dev.enable() : dev.disable())} />
          </div>
          <div className="set-actions">
            <Button icon={<BellRing size={14} aria-hidden />} loading={test.isPending} disabled={test.isPending || !s.phones.length} onClick={() => test.mutate()}>
              Send test notification
            </Button>
            {!s.phones.length && <span className="set-muted">Turn alerts on for a phone first.</span>}
          </div>
          {s.notifyError && (
            <p className="set-note" data-level="warn" role="alert">
              The last alert did not send ({ukTime(s.notifyError.at)}): {s.notifyError.why}
            </p>
          )}
        </Panel>
      </div>
      <Panel title="Signed-up phones" status={<span className="set-muted">{plural(s.phones.length, "phone")}</span>}>
        {!s.phones.length ? (
          <EmptyState title="No phones signed up" description="Turn alerts on above, on the phone itself, to add it here." />
        ) : (
          <ul className="set-list" aria-label="Signed-up phones">
            {s.phones.map((p) => (
              <li key={p.id} className="set-list__row">
                <div className="set-list__main">
                  <span className="set-list__name">{p.label ?? "Unnamed device"}</span>
                  <span className="set-list__sub">
                    Added {ukTime(p.created_at)} · {p.last_error ? <Light tone="red">Last send failed: {p.last_error}</Light> : p.last_ok ? <Light tone="green">Last alert {ukTime(p.last_ok)}</Light> : <Light tone="grey">No alert sent yet</Light>}
                  </span>
                </div>
                <div className="set-list__actions">
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`Remove ${p.label ?? "device"}`} disabled={remove.isPending} onClick={() => remove.mutate(p.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
