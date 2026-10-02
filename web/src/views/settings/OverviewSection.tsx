import { useNavigate } from "react-router-dom";
import type { OverviewResponse, SettingsResponse } from "@shared/api";
import { useReconcile } from "@/api/mutations";
import { Button, Col, CopyButton, DataAge, Grid, KeyValue, Panel, ProgressBar, StatusPill, cx, formatAge } from "@/components";
import { Check, Cloud, Download, Settings as Cog, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { downloadExport } from "@/api/download";
import { HealthCheckButton, useHealthCheckFlow } from "./health";
import { useDownload } from "./BackupSection";
import { Light, Stat, gbp, plural, ukTime } from "./ui";

/** The secret groups the Worker checks (worker/src/env.ts SECRET_GROUPS), in its order. */
const SETUP_GROUPS = ["Login (Cloudflare Access)", "Deploy and destroy (GitHub Actions)", "Azure checks and cost", "DNS verification", "Peer configs (server public key)"];

const DAY_PILLS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface Updated {
  settings: number;
  overview: number;
}

/** Settings overview: the whole state of the setup on one screen, each card leading to its section. */
export function OverviewSection({ s, ov, updated }: { s: SettingsResponse; ov?: OverviewResponse; updated: Updated }) {
  const nav = useNavigate();
  const go = (section: string) => () => nav(`/settings/${section}`);
  const health = useHealthCheckFlow(ov);
  const reconcile = useReconcile();
  const dl = useDownload();

  const v = s.values;
  const snap = ov?.snapshot;
  const gaps = s.setup.reduce((n, g) => n + g.missing.length, 0);
  const running = snap?.state === "running";
  const selftest = snap?.selftest ?? null;
  const budget = ov?.budget;
  const perDay = v.hourlyRateGbp * 24;
  const now = ov ? Date.parse(ov.now) : Date.now();

  const service = !snap
    ? { tone: "grey" as const, word: "no data", at: null as string | null }
    : running
      ? ov!.derived.heartbeatStale
        ? { tone: "amber" as const, word: "Not reporting", at: snap.last_agent_at }
        : { tone: "green" as const, word: "Running", at: snap.last_agent_at }
      : { tone: "grey" as const, word: "No VM running", at: snap.since };
  const dns = !running || !selftest || selftest.dns === null ? { tone: "grey" as const, word: "no data", at: null as string | null } : selftest.dns ? { tone: "green" as const, word: "Healthy", at: selftest.at } : { tone: "red" as const, word: "Failing", at: selftest.at };
  const config = gaps ? { tone: "amber" as const, word: plural(gaps, "setup gap") } : { tone: "green" as const, word: "Complete" };
  const guard = !budget ? { tone: "grey" as const, word: "no data" } : budget.level === "none" ? { tone: "grey" as const, word: "No budget set" } : budget.level === "ok" ? { tone: "green" as const, word: "Within budget" } : budget.level === "warn" ? { tone: "amber" as const, word: "Near budget" } : { tone: "red" as const, word: "Over budget" };

  const sentence = gaps
    ? `${plural(gaps, "setup item is", "setup items are")} missing; see the checklist below.`
    : !running
      ? `Setup is complete. No VM is running (${snap?.state ?? "state unknown"}), so the service and DNS checks have nothing to report.`
      : service.tone === "amber"
        ? "Setup is complete, but the VM has not reported recently."
        : "Setup is complete and the running VM is reporting.";

  const days = new Set(s.schedules.filter((r) => r.enabled).flatMap((r) => r.days.split("").map(Number)));
  const state = snap?.state;

  return (
    <div className="set-stack set-stack--overview">
      <section className="set-banner" aria-label="Settings overview">
        <span className="set-banner__icon" aria-hidden>
          <Cog size={34} />
        </span>
        <div className="set-banner__text">
          <h2 className="set-banner__title">Settings overview</h2>
          <p>{sentence}</p>
          <DataAge at={Math.min(updated.settings, updated.overview) || null} />
        </div>
        <dl className="set-banner__lights">
          <Light2 now={now} label="WireGuard service" tone={service.tone} word={service.word} at={service.at} />
          <Light2 now={now} label="DNS resolution" tone={dns.tone} word={dns.word} at={dns.at} />
          <Light2 now={now} label="Configuration" tone={config.tone} word={config.word} at={null} />
          <Light2 now={now} label="Cost guard" tone={guard.tone} word={guard.word} at={null} sub={budget && budget.level !== "none" ? `${gbp(budget.total)} of ${gbp(budget.budget)}` : undefined} />
        </dl>
        <HealthCheckButton flow={health} />
      </section>

      <Grid className="set-row2">
        <Col span={4}>
          <Panel title="Environment and deployment" actions={<Button size="sm" onClick={go("deployment")}>Edit</Button>}>
            <KeyValue
              items={[
                { label: "Region", value: s.regions[v.region] ?? v.region },
                { label: "VM size", value: v.vmSize, mono: true },
                { label: "Test VM", value: v.testVm ? "Built with the next deploy" : "Not built" },
                { label: "Auto-destroy", value: v.autoDestroyDefaultHours ? `after ${v.autoDestroyDefaultHours} h` : "no timer" },
                { label: "Idle limit", value: v.idleDestroyMinutes ? `${v.idleDestroyMinutes} min` : "off" },
                { label: "Budget warning", value: v.monthlyBudgetGbp ? gbp(v.monthlyBudgetGbp) : "none" },
              ]}
            />
          </Panel>
        </Col>
        <Col span={4}>
          <Panel title="Profile presets" actions={<Button size="sm" onClick={go("deployment")}>Manage</Button>}>
            {!s.profiles.length ? (
              <p className="set-note">No profiles yet. Add one in Deployment.</p>
            ) : (
              <ul className="set-list set-list--compact" aria-label="Profiles">
                {s.profiles.map((p) => (
                  <li key={p.id} className={cx("set-list__row", p.deployed && "set-list__row--current")}>
                    <div className="set-list__main">
                      <span className="set-list__name">{p.name}</span>
                      <span className="set-list__sub">
                        {s.regions[p.region] ?? p.region} · {p.vm_size}
                      </span>
                    </div>
                    {p.deployed ? <StatusPill status="deployed" label="Deployed now" variant="outline" /> : (
                      <Button size="sm" onClick={() => nav(`/?action=deploy&profile=${p.id}`)} aria-label={`Use ${p.name}`}>
                        Use
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Col>
        <Col span={4} className="set-col">
          <Panel title="Cost and usage" actions={<Button size="sm" onClick={go("automation")}>Edit limit</Button>}>
            <div className="set-stats">
              <Stat label="If running all day (estimate)" value={gbp(perDay)} />
              <Stat label="This month so far" value={budget ? gbp(budget.total) : "no data"} />
              <Stat label="Monthly budget" value={v.monthlyBudgetGbp ? gbp(v.monthlyBudgetGbp, Number.isInteger(v.monthlyBudgetGbp) ? 0 : 2) : "none"} />
            </div>
            {budget && budget.level !== "none" && <ProgressBar value={budget.pct} label="Budget used" tone={guard.tone === "green" ? "green" : guard.tone === "amber" ? "amber" : "red"} showValue />}
            <p className="set-note">
              <Light tone={guard.tone}>Cost guard: {guard.word}</Light>
            </p>
          </Panel>
          <Panel title="Deployment actions">
            <div className="set-actions">
              <Button variant="primary" icon={<Cloud size={14} aria-hidden />} onClick={() => nav("/?action=deploy")}>
                Deploy / Rebuild
              </Button>
              <Button icon={<ShieldCheck size={14} aria-hidden />} loading={reconcile.isPending} disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
                Check Azure
              </Button>
              <Button variant="danger" icon={<Trash2 size={14} aria-hidden />} disabled={!state || state === "destroyed"} onClick={() => nav("/?action=destroy")}>
                Tear down
              </Button>
            </div>
          </Panel>
        </Col>

        <Col span={3}>
          <Panel title="Setup checklist" status={<span className="set-muted">{gaps ? plural(gaps, "gap") : "complete"}</span>}>
            <ul className="set-check" aria-label="Setup checklist">
              {SETUP_GROUPS.map((g) => {
                const miss = s.setup.find((x) => x.group === g)?.missing ?? [];
                return (
                  <li key={g} className={miss.length ? "set-check__no" : "set-check__ok"}>
                    {miss.length ? <X size={14} aria-hidden /> : <Check size={14} aria-hidden />}
                    <span>{g}</span>
                    <em>{miss.length ? `Missing: ${miss.join(", ")}` : "Configured"}</em>
                  </li>
                );
              })}
              <li className={s.phones.length ? "set-check__ok" : "set-check__no"}>
                {s.phones.length ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}
                <span>Phone alerts (optional)</span>
                <em>{s.phones.length ? plural(s.phones.length, "phone") : "Not configured"}</em>
              </li>
            </ul>
          </Panel>
        </Col>
        <Col span={3}>
          <Panel title="Server key" actions={<Button size="sm" onClick={go("security")}>Manage</Button>}>
            <p className="set-key">
              <code>{s.key.short}</code>
              {s.key.publicKey && <CopyButton text={s.key.publicKey} label="Copy public key" />}
            </p>
            <Stat label="Last rotated" value={s.key.rotation.changedAt ? ukTime(s.key.rotation.changedAt) : "never rotated here"} />
          </Panel>
        </Col>
        <Col span={3}>
          <Panel title="Backup and recovery" actions={<Button size="sm" onClick={go("backup")}>Open</Button>}>
            <div className="set-stats">
              <Stat label="Latest" value={ukTime(s.backups.config.newest)} />
              <Stat label="Kept" value={plural(s.backups.config.count, "backup")} />
            </div>
            <div className="set-actions">
              <Button size="sm" icon={<Download size={14} aria-hidden />} loading={dl.busy === "export"} disabled={!!dl.busy} onClick={() => void dl.run("export", downloadExport)}>
                Download export
              </Button>
              <Button size="sm" icon={<Upload size={14} aria-hidden />} onClick={go("backup")}>
                Restore
              </Button>
            </div>
          </Panel>
        </Col>
        <Col span={3}>
          <Panel title="Schedules" actions={<Button size="sm" onClick={go("automation")}>Add</Button>}>
            <div className="set-days" role="group" aria-label="Days with a schedule">
              {DAY_PILLS.map((d, i) => (
                <span key={d} className={cx("set-days__pill", days.has(i + 1) && "set-days__pill--on")} aria-label={`${d}: ${days.has(i + 1) ? "has a schedule" : "no schedule"}`}>
                  {d}
                </span>
              ))}
            </div>
            {!s.schedules.length ? (
              <p className="set-note">No schedules. Everything starts by hand.</p>
            ) : (
              <p className="set-note">
                {s.schedules.map((r) => `${r.daysText} ${r.start_time}–${r.end_time}`).join("; ")} <span className="set-muted">UK time</span>
                <br />
                Next start: {s.nextScheduledStart ?? "none"}
              </p>
            )}
          </Panel>
        </Col>
      </Grid>
    </div>
  );
}

function Light2({ label, tone, word, at, sub, now }: { label: string; tone: "green" | "amber" | "red" | "grey"; word: string; at: string | null; sub?: string; now: number }) {
  return (
    <div className="set-banner__light">
      <dt>{label}</dt>
      <dd>
        <Light tone={tone}>{word}</Light>
        <span className="set-muted">{sub ?? (at ? formatAge(Math.max(0, now - Date.parse(at))) : "")}</span>
      </dd>
    </div>
  );
}
