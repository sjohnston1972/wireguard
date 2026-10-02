import { useRef, useState } from "react";
import type { RestorePreviewResponse, SettingsResponse } from "@shared/api";
import { downloadConfigBackup, downloadExport } from "@/api/download";
import { useRestoreConfirm, useRestorePreview } from "@/api/mutations";
import { Button, ConfirmByTyping, EmptyState, Panel, useToast } from "@/components";
import { Download, Upload } from "lucide-react";
import { Lead, plural, ukTime } from "./ui";

/** Runs a download; a failure is a toast with the server's words, never a silent nothing. */
export function useDownload() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (err) {
      // An expired sign-in is already shown by the sign-in banner.
      if ((err as Error).name !== "SessionExpiredError") toast({ tone: "error", title: (err as Error).message || "The download did not work." });
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("That file could not be read."));
    r.readAsText(file);
  });
}

/** Backup & Recovery: the export, the nightly copies, and a staged restore. */
export function BackupSection({ s }: { s: SettingsResponse }) {
  const dl = useDownload();
  const days = s.backups.config.days;
  return (
    <div className="set-stack">
      <Lead>Everything the dashboard keeps (clients, firewall rules, settings, history) can be downloaded as one file and put back later. A restore replaces what is here now.</Lead>
      <Panel
        title="Export"
        actions={
          <Button variant="primary" icon={<Download size={14} aria-hidden />} loading={dl.busy === "export"} disabled={!!dl.busy} onClick={() => void dl.run("export", downloadExport)}>
            Download export
          </Button>
        }
      >
        <p className="set-note">
          Includes clients (with their public keys, never private keys), firewall rules, published ports, profiles, schedules and settings.
        </p>
        <p className="set-muted">
          Terraform state backups: {s.backups.state.count} {s.backups.state.newest ? `(newest ${ukTime(s.backups.state.newest)})` : ""}
        </p>
      </Panel>
      <Panel title="Nightly config backups" status={<span className="set-muted">{plural(days.length, "day")} kept</span>}>
        {s.backups.error && (
          <p className="set-note" data-level="warn" role="alert">
            Could not list the backups: {s.backups.error}
          </p>
        )}
        {!days.length ? (
          <EmptyState title="No nightly backups yet" description="One is saved each night once the dashboard has been running. You can still download an export now." />
        ) : (
          <ul className="set-list" aria-label="Config backups by day">
            {days.map((d) => (
              <li key={d} className="set-list__row">
                <div className="set-list__main">
                  <span className="set-list__name">{d}</span>
                  <span className="set-list__sub">Dashboard data as saved that night</span>
                </div>
                <div className="set-list__actions">
                  <Button size="sm" icon={<Download size={14} aria-hidden />} loading={dl.busy === d} disabled={!!dl.busy} aria-label={`Download backup ${d}`} onClick={() => void dl.run(d, () => downloadConfigBackup(d))}>
                    Download
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <RestorePanel />
    </div>
  );
}

/** Restore from a file in two steps: preview the counts, then confirm by typing. */
export function RestorePanel() {
  const preview = useRestorePreview();
  const confirm = useRestoreConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<RestorePreviewResponse | null>(null);
  const [fileName, setFileName] = useState("");
  const [problem, setProblem] = useState("");

  const pick = async (file: File | undefined) => {
    setProblem("");
    setPlan(null);
    if (!file) return;
    setFileName(file.name);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readText(file));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    } catch {
      setProblem("That file is not a wg-admin export (it is not valid JSON).");
      return;
    }
    preview.mutate(parsed, { onSuccess: setPlan, onError: (e) => setProblem(e.message) });
  };
  const tables = plan ? (Object.keys(plan.labels) as (keyof typeof plan.labels)[]) : [];
  return (
    <Panel
      title="Restore from a file"
      actions={
        <Button icon={<Upload size={14} aria-hidden />} loading={preview.isPending} disabled={preview.isPending} onClick={() => input.current?.click()}>
          Choose export file
        </Button>
      }
    >
      <input ref={input} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Export file" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
      {!plan && !problem && <p className="set-note">Choose a file you downloaded from here. Nothing changes until you have seen what it holds and confirmed.</p>}
      {problem && (
        <p className="set-note" data-level="warn" role="alert">
          {problem}
        </p>
      )}
      {plan && (
        <div className="set-restore">
          <p className="set-note">
            <strong>{fileName || "The file"}</strong> was exported {ukTime(plan.exportedAt)}. Restoring replaces what is held now with what the file holds:
          </p>
          <table className="set-table" aria-label="Restore preview">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">In the file</th>
                <th scope="col">Held now</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t}>
                  <th scope="row">{plan.labels[t]}</th>
                  <td>{plan.file[t]}</td>
                  <td>{plan.current[t]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="set-note" data-level="warn">
            The preview is kept for 15 minutes. If the database refuses the file, nothing is changed.
          </p>
          <ConfirmByTyping phrase="restore" actionLabel="Restore from this file" pending={confirm.isPending} onConfirm={() => confirm.mutate({ token: plan.token, confirm: "restore" }, { onSuccess: () => setPlan(null) })} />
        </div>
      )}
    </Panel>
  );
}
