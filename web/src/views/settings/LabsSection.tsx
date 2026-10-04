import { useState } from "react";
import type { LabCard, LabPermissions } from "@shared/api";
import { useLabs } from "@/api/queries";
import { useCheckLabPermissions, useTestLab } from "@/api/mutations";
import { Button, EmptyState, Modal, Panel } from "@/components";
import { Lead, Light, SettingInput, SettingSwitch, UnsavedBar, ukTime } from "./ui";

/** A permission result in words: never a bare colour. */
function Result({ ok }: { ok: boolean | null }) {
  return ok === null ? <Light tone="grey">not checked yet</Light> : ok ? <Light tone="green">OK</Light> : <Light tone="red">Failed</Light>;
}

const CHECKS: { key: "role" | "users" | "groups"; name: string; hint: string }[] = [
  { key: "role", name: "Governance role", hint: "The custom role that lets labs create and remove their own role assignments" },
  { key: "users", name: "Read and write users", hint: "Microsoft Graph, for the lab sign-in accounts" },
  { key: "groups", name: "Read and write groups", hint: "Microsoft Graph, for the lab groups" },
];

function PermissionsPanel({ p }: { p: LabPermissions | undefined }) {
  const check = useCheckLabPermissions();
  const perms = p ?? { checkedAt: null, role: null, users: null, groups: null, message: null };
  return (
    <Panel
      title="Permissions"
      actions={
        <Button size="sm" loading={check.isPending} disabled={check.isPending} onClick={() => check.mutate()}>
          Check permissions
        </Button>
      }
    >
      <ul className="set-list set-list--compact" aria-label="Permission checks">
        {CHECKS.map((c) => (
          <li key={c.key} className="set-list__row" aria-label={c.name}>
            <span className="set-list__main">
              <span className="set-list__name">{c.name}</span>
              <span className="set-list__sub">{c.hint}</span>
            </span>
            <Result ok={perms[c.key]} />
          </li>
        ))}
      </ul>
      {perms.message && (
        <p className="set-note" data-level="over" role="status">
          {perms.message}
        </p>
      )}
      <p className="set-note">{perms.checkedAt ? `Checked ${ukTime(perms.checkedAt)}.` : "Never checked. Run the one-time identity setup from the README first."}</p>
    </Panel>
  );
}

/** One release test line: the newest result for the lab's current version, and the Test button. */
function TestRow({ lab, onTest }: { lab: LabCard; onTest: () => void }) {
  const t = lab.lastReleaseTest;
  const busy = !!lab.running;
  return (
    <li className="set-list__row">
      <span className="set-list__main">
        <span className="set-list__name">
          Lab {lab.number}: {lab.title}
        </span>
        <span className="set-list__sub">
          <span>version {lab.version}</span>
          {t ? (
            <>
              {t.result === "pass" ? <Light tone="green">{t.version === lab.version ? "Passed" : `Passed v${t.version}`}</Light> : <Light tone="red">Failed</Light>}
              <span>{t.clean ? "clean" : "not clean"}</span>
              <span>{ukTime(t.at)}</span>
              {t.leftovers.length > 0 && <span>left behind: {t.leftovers.join(", ")}</span>}
            </>
          ) : (
            <Light tone="grey">Not tested</Light>
          )}
          {busy && <span>running now</span>}
        </span>
      </span>
      <span className="set-list__actions">
        <Button size="sm" variant="secondary" aria-label={`Test ${lab.title}`} disabled={busy} onClick={onTest}>
          Test
        </Button>
      </span>
    </li>
  );
}

function ReleaseTests({ labs }: { labs: LabCard[] }) {
  const test = useTestLab();
  const [asking, setAsking] = useState<LabCard | null>(null);
  return (
    <Panel title="Release tests">
      {labs.length === 0 ? (
        <EmptyState title="No labs in the catalogue" description="Labs appear here once their folders are built into the Worker." />
      ) : (
        <ul className="set-list set-list--compact" aria-label="Release tests">
          {labs.map((l) => (
            <TestRow key={l.id} lab={l} onTest={() => setAsking(l)} />
          ))}
        </ul>
      )}
      <p className="set-note">A lab is released when its newest version passes a real test with nothing left behind. Each test costs pennies.</p>
      {asking && (
        <Modal
          open
          onOpenChange={(o) => !o && setAsking(null)}
          title="Run a release test?"
          description={`Deploys ${asking.title} in real Azure, checks it, tears it down and checks nothing is left. It costs pennies and takes ${asking.timing.deployMin + asking.timing.destroyMin} minutes or more.`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={test.isPending} disabled={test.isPending} onClick={() => test.mutate(asking.id, { onSuccess: () => setAsking(null) })}>
                Run the test
              </Button>
            </>
          }
        />
      )}
    </Panel>
  );
}

/** Settings → Labs: limits, the permission check, slots in use and the release tests. */
export function LabsSection() {
  const q = useLabs();
  const data = q.data;
  return (
    <div className="set-stack">
      <Lead>On-demand Azure labs: how many may run at once, whether they join the gateway's network, and whether the pipeline may build them.</Lead>
      <div className="set-two">
        <Panel title="Limits">
          <div className="set-form">
            <SettingInput name="labs_max_running" label="Labs running at once" hint="1 to 5. The next deploy is refused while this many are live." />
            <SettingSwitch name="labs_default_peering" label="Peer labs to the gateway" hint="The Deploy form's tick for labs where peering is optional. Labs that need it always peer." />
          </div>
          <div className="set-stats" role="group" aria-label="Slots in use">
            <div className="set-stat">
              <span className="set-stat__label">Slots in use</span>
              <span className="set-stat__value">{data ? `${data.slots.used} of ${data.slots.total}` : "no data"}</span>
              <span className="set-stat__sub">each live lab holds one address block until it is clean</span>
            </div>
          </div>
        </Panel>
        <PermissionsPanel p={data?.permissions} />
      </div>
      <ReleaseTests labs={data?.labs ?? []} />
      <UnsavedBar section="labs" label="Labs" />
    </div>
  );
}
