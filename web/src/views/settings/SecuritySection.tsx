import { useState } from "react";
import type { SettingsResponse } from "@shared/api";
import { Button, CopyButton, Drawer, KeyValue, Panel } from "@/components";
import { HelpCircle } from "lucide-react";
import { Lead, SettingInput, UnsavedBar, plural, ukTime } from "./ui";

/** Security: the server's public key, who may SSH in, and how a key rotation works. */
export function SecuritySection({ s }: { s: SettingsResponse }) {
  const [help, setHelp] = useState(false);
  const rot = s.key.rotation;
  const waiting = rot.clients.filter((c) => !c.done);
  return (
    <div className="set-stack">
      <Lead>The server's public key is safe to share: it is what every client config trusts. The private key never reaches this dashboard.</Lead>
      <Panel
        title="Server key"
        actions={
          <Button size="sm" variant="ghost" icon={<HelpCircle size={14} aria-hidden />} onClick={() => setHelp(true)}>
            How key rotation works
          </Button>
        }
      >
        <KeyValue
          items={[
            { label: "Public key", value: s.key.publicKey, mono: true, copy: true },
            { label: "Short form", value: s.key.short, mono: true },
            { label: "Last rotated", value: rot.changedAt ? ukTime(rot.changedAt) : "never rotated here" },
          ]}
        />
        {rot.changedAt && (
          <p className="set-note" data-level={waiting.length ? "warn" : "ok"}>
            {waiting.length ? `${plural(waiting.length, "client")} still need a new config: ${waiting.map((c) => c.name).join(", ")}.` : "Every client has reconnected since the rotation."}
          </p>
        )}
      </Panel>
      <Panel title="SSH access">
        <div className="set-form set-form--one">
          <SettingInput name="ssh_allowed_cidr" label="SSH allowed from" mono hint="An address range like 203.0.113.7/32. Empty means SSH is closed to everyone. To open it for your current address, use Overview, Allow SSH." />
        </div>
      </Panel>
      <UnsavedBar section="security" label="Security" />
      <Drawer open={help} onOpenChange={setHelp} title="How key rotation works" subtitle="Server key, step by step" footer={<Button onClick={() => setHelp(false)}>Close</Button>}>
        <KeyRotationHelp />
      </Drawer>
    </div>
  );
}

export const ROTATE_COMMAND = "npm run keys -- --rotate";

/** Shared by Security's help drawer and Maintenance's rotate-key card. */
export function KeyRotationHelp() {
  return (
    <div className="set-help">
      <p>Rotate the server key only if its private key may have leaked. A lost phone does not need this: delete that client instead.</p>
      <ol>
        <li>On your computer, in the project folder, run the command below. It asks you to type <code>rotate</code>, makes a new key pair in .env, keeps the old one as commented-out lines, and prints the new public key.</li>
        <li>Put that public key in <code>wrangler.toml</code> as <code>WG_SERVER_PUBLIC_KEY</code>.</li>
        <li>Run <code>npm run secrets</code> to send the new private key to GitHub, where the VM build picks it up.</li>
        <li>Run <code>npm run deploy-worker</code> so this dashboard hands out configs with the new key. Every client is then marked as needing a new config.</li>
        <li>If the VM is running or in Standby, tear it down and deploy again. A VM only takes the new key when it is built fresh; Resume keeps the old one.</li>
        <li>On each device, press Get config on the Clients page and import it, replacing the old tunnel. Each client ticks off in Security at its first connection with the new key.</li>
      </ol>
      <p className="set-code">
        <code>{ROTATE_COMMAND}</code> <CopyButton text={ROTATE_COMMAND} label="Copy rotate command" />
      </p>
      <p>It is deliberately not a button here: the dashboard never holds the private key.</p>
    </div>
  );
}
