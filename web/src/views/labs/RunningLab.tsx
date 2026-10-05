import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import type { LabDetail, LabRunRow, LabSecretResponse, LabSession } from "@shared/api";
import { Button, CopyButton, KeyValue, LogView, Skeleton, StatusPill } from "@/components";
import { useLabSecret, useSaveLabNote } from "@/api/mutations";
import { StepTrack } from "@/views/activity/RunPanels";
import { useRunData } from "@/views/activity/useRunData";
import { LIVE_LOG_WAITING } from "@/lib/parseLog";
import { fmtClock, fmtSpan, peeringWord, useLabClock } from "./model";
import { ReadmeView } from "./ReadmeView";
import { CostSoFar, SessionActions, TimeLeft, Word } from "./RunningStrip";

const NOTE_MAX = 2000; // shared/labs.ts LAB_NOTE_MAX

const ACTION_WORD: Record<LabRunRow["action"], string> = { deploy: "Deploy", destroy: "Tear down", peer: "Peer", unpeer: "Unpeer", test: "Release test" };

/** The run in progress: its steps and the live log, with the Activity drawer's Streaming / Stalled word. */
function Pipeline({ r }: { r: LabRunRow }) {
  const { steps, active, log, lines, streaming, stalled, waiting, detail } = useRunData(r.id);
  return (
    <section className="labs-section" aria-labelledby="labs-run-h">
      <div className="labs-section__head">
        <h3 className="labs-section__title" id="labs-run-h">
          {ACTION_WORD[r.action]} pipeline
        </h3>
        {streaming && (stalled ? <StatusPill status="degraded" label="Stalled" variant="outline" /> : <StatusPill status="online" label="Streaming" variant="outline" />)}
        <Link className="labs-link" to={`/activity/runs/${encodeURIComponent(r.id)}`}>
          Open in Activity <ExternalLink size={12} aria-hidden />
        </Link>
      </div>
      {detail.isError ? (
        <p className="labs-muted" role="alert">
          {detail.error.message}
        </p>
      ) : !detail.data ? (
        <Skeleton variant="block" height={44} />
      ) : (
        <div className="labs-track">
          <StepTrack steps={steps} active={active} durations nameLines={2} />
        </div>
      )}
      <div className="labs-log">
        {log.isError ? (
          <p className="labs-muted" role="alert">
            {log.error.message}
          </p>
        ) : !log.data ? (
          <Skeleton variant="line" />
        ) : waiting ? (
          <p className="labs-muted" role="status">
            {LIVE_LOG_WAITING}
          </p>
        ) : (
          <LogView aria-label="Live log" toolbar={false} lines={lines.slice(-200)} wrap timestamps={false} />
        )}
      </div>
    </section>
  );
}

/** The last finished run, in one line, when nothing is running. */
function LastRun({ r }: { r: LabRunRow | undefined }) {
  if (!r) return null;
  const took = r.startedAt && r.finishedAt ? fmtSpan(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : null;
  return (
    <p className="labs-muted labs-lastrun">
      {ACTION_WORD[r.action]} {r.status === "succeeded" ? "finished" : r.status}
      {took ? ` in ${took}` : ""}.{" "}
      <Link className="labs-link" to={`/activity/runs/${encodeURIComponent(r.id)}`}>
        Open in Activity <ExternalLink size={12} aria-hidden />
      </Link>
    </p>
  );
}

const shortType = (t: string) => t.split("/").pop() ?? t;

/** Resources in rg-lab-<id>* from ARM, with the portal link. */
function Resources({ d }: { d: LabDetail }) {
  const rg = `rg-lab-${d.card.id}`;
  return (
    <section className="labs-section" aria-labelledby="labs-res-h">
      <div className="labs-section__head">
        <h3 className="labs-section__title" id="labs-res-h">
          Resources
        </h3>
        {d.portalUrl && (
          <a className="labs-link" href={d.portalUrl} target="_blank" rel="noopener noreferrer">
            Open {rg} in the Azure portal <ExternalLink size={12} aria-hidden />
          </a>
        )}
      </div>
      {d.resources === null ? (
        <p className="labs-muted">Azure did not list the resources just now.</p>
      ) : d.resources.length === 0 ? (
        <p className="labs-muted">Nothing in {rg} yet.</p>
      ) : (
        <div className="labs-res">
          <table className="labs-cost__table" aria-label="Resources">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {d.resources.map((r) => (
                <tr key={`${r.group}/${r.type}/${r.name}`}>
                  <td className="labs-mono">{r.name}</td>
                  <td title={r.type}>{shortType(r.type)}</td>
                  <td>{r.state ? <Word label={r.state} tone={r.state === "Succeeded" ? "green" : r.state === "Failed" ? "red" : "amber"} /> : <span className="labs-muted">no data</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Private IPs and the lab's connect lines (Terraform outputs), each with a copy button. */
function Addresses({ s }: { s: LabSession }) {
  const o = s.outputs;
  if (!o || (Object.keys(o.privateIps).length === 0 && o.connect.length === 0)) return null;
  return (
    <section className="labs-section" aria-labelledby="labs-ips-h">
      <h3 className="labs-section__title" id="labs-ips-h">
        Private IPs
      </h3>
      {Object.keys(o.privateIps).length > 0 && <KeyValue items={Object.entries(o.privateIps).map(([label, ip]) => ({ label, value: ip, mono: true, copy: true }))} />}
      {o.connect.length > 0 && (
        <ul className="labs-connect">
          {o.connect.map((c) => (
            <li key={c}>
              <code>{c}</code>
              <CopyButton text={c} label={`Copy ${c}`} />
            </li>
          ))}
        </ul>
      )}
      {s.peering !== "on" && <p className="labs-muted">Reachable from tunnel clients once the lab is peered to the gateway.</p>}
    </section>
  );
}

/** The admin password and the lab's Entra users, fetched only on Show and dropped on Hide or close. */
function Secret({ labId, running }: { labId: string; running: boolean }) {
  const fetchSecret = useLabSecret();
  // Held only in this component: closing the modal unmounts it and the secret goes with it (nothing is cached).
  const [shown, setShown] = useState<LabSecretResponse | null>(null);
  if (!running) return null;
  const users = shown ? Object.entries(shown.users) : [];
  return (
    <section className="labs-section" aria-labelledby="labs-secret-h">
      <div className="labs-section__head">
        <h3 className="labs-section__title" id="labs-secret-h">
          Sign-in
        </h3>
        {shown ? (
          <Button size="sm" variant="secondary" onClick={() => setShown(null)}>
            Hide
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={fetchSecret.isPending} disabled={fetchSecret.isPending} onClick={() => void fetchSecret.mutateAsync(labId).then(setShown, () => undefined)}>
            Show
          </Button>
        )}
      </div>
      {fetchSecret.isError && !shown && (
        <p className="labs-muted" role="alert">
          {fetchSecret.error.message}
        </p>
      )}
      {shown ? (
        <KeyValue items={[{ label: "Admin password", value: shown.adminPassword, mono: true, copy: true }, ...users.map(([name, upn]) => ({ label: name, value: upn, mono: true, copy: true }))]} />
      ) : (
        <p className="labs-muted">The admin password and the lab's Entra user names, shown only when you ask.</p>
      )}
    </section>
  );
}

/** One note per session (at most 2000 characters), saved when you press Save. */
function Note({ s }: { s: LabSession }) {
  const save = useSaveLabNote();
  const [text, setText] = useState(s.note ?? "");
  const changed = text !== (s.note ?? "");
  return (
    <section className="labs-section" aria-labelledby="labs-note-h">
      <h3 className="labs-section__title" id="labs-note-h">
        <label htmlFor="labs-note">Note</label>
      </h3>
      <textarea id="labs-note" className="labs-note" value={text} maxLength={NOTE_MAX} rows={3} placeholder="What you tried, what you learned." onChange={(e) => setText(e.target.value)} />
      <div className="labs-note__foot">
        <span className="labs-muted">
          {text.length} of {NOTE_MAX}
        </span>
        <Button size="sm" variant="secondary" disabled={!changed || save.isPending} loading={save.isPending} onClick={() => save.mutate({ sid: s.id, note: text })}>
          Save note
        </Button>
      </div>
    </section>
  );
}

/** The session's facts in a line: ends, hard stop, peering, region and slot. */
function Facts({ s }: { s: LabSession }) {
  const peer = peeringWord(s.peering);
  return (
    <ul className="labs-facts" aria-label="Session">
      {s.autoDestroyAt && <li>Ends {fmtClock(s.autoDestroyAt)}</li>}
      <li>Hard stop {fmtClock(s.maxUntil)}</li>
      <li>
        <Word {...peer} />
      </li>
      <li>{s.region}</li>
      {s.cidr && <li className="labs-mono">{s.cidr}</li>}
      {s.test && <li>Release test</li>}
    </ul>
  );
}

/** The lab modal while a session is live (spec §10): pipeline and log, resources, addresses, sign-in, note; the readme beside them. */
export function RunningLab({ d }: { d: LabDetail }) {
  const s = d.session!;
  const r = s.activeRun;
  return (
    <div className="labs-modal__cols">
      <div className="labs-modal__side">
        <Facts s={s} />
        {r ? <Pipeline r={r} /> : <LastRun r={d.runs[0]} />}
        {s.state === "failed" && <p className="labs-deploy__blocked">The deploy failed. It is torn down by itself 15 minutes after it failed, or now with Tear down.</p>}
        <Resources d={d} />
        <Addresses s={s} />
        <Secret labId={d.card.id} running={s.state === "running"} />
        <Note key={s.id} s={s} />
      </div>
      <ReadmeView blocks={d.readme} />
    </div>
  );
}

/** Time left, cost so far, Extend and Tear down. */
export function RunningFooter({ d }: { d: LabDetail }) {
  const now = useLabClock();
  const s = d.session!;
  return (
    <div className="labs-foot">
      <span className="labs-foot__facts">
        <TimeLeft s={s} now={now} />
        <CostSoFar s={s} />
      </span>
      <SessionActions s={s} now={now} size="md" />
    </div>
  );
}
