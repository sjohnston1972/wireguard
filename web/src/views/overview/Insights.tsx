// Plain English: the Overview's Azure insights widgets (spec 2026-10-04
// section 10.1), all off until turned on from the widget library:
//   - VM performance: Azure's own measurements of the VM, one row per chart;
//     on a tall panel (1600x900) each chart grows to fill its share of it
//   - Azure health: what Azure says about the VM, its maintenance and issues
//   - System vitals: the VM's own figures, from the heartbeat
// Plus the small parts they share with the Firewall's Public IP widget: the
// feed footer ("Azure health · 2 m ago", amber and "stale" after 3
// cadences), the state notes, and a figure row (plain name large, Azure's
// name in small print, the value, a threshold word, a sparkline or bar).
// Thresholds colour this dashboard only, always with a word. Pages never
// call Azure: these read the Worker's stored copies.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AzureSummaryResponse, FeedId, FeedStatus, OverviewResponse, SettingValue } from "@shared/api";
import { feedIsStale, metricByColumn } from "@shared/azureMetrics";
import { Panel, ProgressBar, Sparkline, cx, formatAge } from "@/components";
import { useAzureMetrics, useAzureSummary, type HistoryRange } from "@/api/queries";
import { useWidget } from "@/widgets";
import { BootLogModal } from "./BootLog";
import { LEVEL_TONE, levelOf, levelWord, type Level } from "./widgetSettings";
import "./Insights.css";

// ── Shared parts (also used by the Firewall's Public IP widget) ──

export const NOT_CONNECTED_TEXT = "Azure isn't connected. Add the service principal secrets to the Worker.";
export const WAITING_TEXT = "Waiting for the first reading from Azure.";
export const NOTHING_TEXT = "Nothing running.";

export const feedOf = (s: AzureSummaryResponse | undefined, id: FeedId): FeedStatus | undefined => s?.feeds.find((f) => f.id === id);

/** A widget's state line instead of figures. */
export const AzNote = ({ children }: { children: ReactNode }) => <p className="ov-az__note">{children}</p>;

/** The footer: the source and how old its last success is (at `now`, ms); amber with "stale"; the last error in plain words. */
export function FeedFoot({ title, at, now, stale, error }: { title: string; at: string | null; now: number; stale: boolean; error?: string | null }) {
  const ms = at ? now - Date.parse(at) : null;
  if (error) return <p className="ov-az__foot ov-az__foot--red">{`${title} · error: ${error}${ms !== null ? ` · last good ${formatAge(ms)}` : ""}`}</p>;
  if (ms === null) return null;
  return <p className={cx("ov-az__foot", stale && "ov-az__foot--amber")}>{`${title} · ${formatAge(ms)}${stale ? " · stale" : ""}`}</p>;
}

/** A feed's footer, from the summary's feed status: stale after 3 cadences. */
export function AzureFoot({ feed, now }: { feed: FeedStatus | undefined; now: number }) {
  if (!feed || feed.status === "not_configured") return null;
  return <FeedFoot title={feed.title} at={feed.lastOkAt} now={now} stale={feedIsStale(feed, now)} error={feed.status === "error" ? feed.error : null} />;
}

export interface FigureProps {
  name: string;
  /** Azure's own metric names, in small print (null: not shown). */
  az?: string | null;
  value: string;
  level?: Level;
  dir?: "above" | "below";
  extra?: string | null;
  children?: ReactNode;
}

/** One figure: plain name large, Azure's name small, the value with its threshold word, then a sparkline or bar. */
export function Figure({ name, az, value, level = null, dir = "above", extra, children }: FigureProps) {
  const word = levelWord(level, dir);
  return (
    <li className="ov-az__row">
      <span className="ov-az__label">
        <span className="ov-az__name">{name}</span>
        {az && <span className="ov-az__azname">{az}</span>}
      </span>
      <span className="ov-az__figs">
        <span className={cx("ov-az__value", word && level && `ov-az__value--${LEVEL_TONE[level]}`)}>{value}</span>
        {word && level && <span className={cx("ov-az__word", `ov-az__value--${LEVEL_TONE[level]}`)}>{word}</span>}
        {extra && <span className="ov-az__extra">{extra}</span>}
      </span>
      {children && <span className="ov-az__chart">{children}</span>}
    </li>
  );
}

// ── Number words ──

const round = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
export const NO_DATA = "no data";
export const pct = (v: number | null | undefined) => (v == null ? NO_DATA : `${round(v)}%`);
export function bytes(v: number | null | undefined): string {
  if (v == null) return NO_DATA;
  const u = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (Math.abs(v) >= 1000 && i < u.length - 1) (v /= 1000), i++;
  return `${round(v)} ${u[i]}`;
}
export const rate = (v: number | null | undefined) => (v == null ? NO_DATA : `${bytes(v)}/s`);

/** A column of metric points, oldest first; anything not a number is a gap. */
export const column = (points: Record<string, number | string | null>[] | undefined, col: string): (number | null)[] => (points ?? []).map((p) => (typeof p[col] === "number" ? (p[col] as number) : null));
export const lastOf = (v: (number | null)[]) => [...v].reverse().find((x): x is number => x !== null) ?? null;
const nums = (v: (number | null)[]) => v.filter((x): x is number => x !== null);
export const maxOf = (v: (number | null)[]) => (nums(v).length ? Math.max(...nums(v)) : null);
const minOf = (v: (number | null)[]) => (nums(v).length ? Math.min(...nums(v)) : null);
const sum = (a: (number | null)[], b: (number | null)[]) => a.map((x, i) => (x === null || b[i] === null ? null : x + (b[i] as number)));
/** Azure's names for these stored columns, each once. */
export const azNames = (...cols: string[]) => [...new Set(cols.map((c) => metricByColumn(c)?.name ?? c))].join(", ");

const spark = (data: (number | null)[], label: string, unit = "") => <Sparkline data={data} label={label} unit={unit} tone="blue" width={84} height={22} />;

// ── VM performance ──

const num = (v: number | null) => (v === null ? NO_DATA : round(v));
interface Chart {
  name: string;
  /** Stored columns: one, or two shown as words ("in X · out Y") and charted as their sum. */
  cols: string[];
  words?: string[];
  f: (v: number | null) => string;
  /** Its threshold setting, if any. */
  th?: string;
  dir?: "above" | "below";
  /** Peaks: the lowest figure instead of the highest. */
  low?: boolean;
  /** Peaks: read this column (CPU's maximum). */
  peak?: string;
}
/** The Charts setting's options. */
const CHARTS: Record<string, Chart> = {
  cpu: { name: "CPU used", cols: ["cpu_avg"], f: pct, th: "cpu", peak: "cpu_max" },
  credits: { name: "Credits left", cols: ["credits_min"], f: num, th: "credits", dir: "below", low: true },
  memory: { name: "Memory free", cols: ["mem_free_min"], f: bytes, th: "memory", low: true },
  network: { name: "Data in / out", cols: ["net_in", "net_out"], words: ["in", "out"], f: rate },
  disk: { name: "Disk read / written", cols: ["disk_read", "disk_write"], words: ["read", "write"], f: rate },
  diskQuota: { name: "Disk IOPS used", cols: ["os_iops_max"], f: pct, th: "diskIops" },
};

/** A row this tall or taller (px) draws its chart full width under the name, as tall as the row allows. */
export const FILL_ROW_MIN = 64;
/** The gap between rows when the charts fill the panel (px; matches .ov-az__list--fill). */
const FILL_GAP = 8;

/** An element's height (0 until measured, and where ResizeObserver is missing), through a callback ref: the element may appear late. */
function useBoxHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(Math.floor(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, height];
}

/** A sparkline drawn at the size of its box (the box is absolutely placed, so the chart never sizes the row). */
function FillSpark({ data, label }: { data: (number | null)[]; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      if (w > 0 && h > 0) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="ov-az__fill-spark">
      {size && <Sparkline data={data} label={label} tone="blue" width={size.w} height={size.h} />}
    </div>
  );
}

export function VmPerformance({ o, now }: { o: OverviewResponse; now: number }) {
  const { settings: st } = useWidget("overview.vmPerformance");
  // The space the list has: on a tall panel each chart takes an equal share of it (no empty half-panel at 1600x900).
  const [boxRef, boxHeight] = useBoxHeight();
  const sum0 = useAzureSummary().data;
  const q = useAzureMetrics("vm", st.range as HistoryRange);
  const feed = feedOf(sum0, "vmMetrics");
  const pts = q.data?.points;
  const has = !!pts && pts.length > 0;
  const az = (...cols: string[]) => (st.azureNames ? azNames(...cols) : null);
  const peaks = st.peaks as boolean;
  const th = (k: string) => st[k] as SettingValue;

  let body: ReactNode;
  if (!sum0 || (!q.data && q.isLoading)) body = <AzNote>Loading…</AzNote>;
  else if (!sum0.configured) body = <AzNote>{NOT_CONNECTED_TEXT}</AzNote>;
  else if (!has && o.snapshot.state !== "running") body = <AzNote>{NOTHING_TEXT}</AzNote>;
  else if (!has && !feed?.lastOkAt) body = <AzNote>{WAITING_TEXT}</AzNote>;
  else if (!has) body = <AzNote>No figures from Azure in this range.</AzNote>;
  else {
    const n = (st.charts as string[]).length;
    const fill = n > 0 && (boxHeight - FILL_GAP * (n - 1)) / n >= FILL_ROW_MIN;
    body = (
      <div ref={boxRef} className="ov-az__box">
        <ul className={cx("ov-az__list", fill && "ov-az__list--fill")}>
          {(st.charts as string[]).map((k) => {
            const ch = CHARTS[k]!;
            const cols = ch.cols.map((col) => column(pts, col));
            const line = cols.length > 1 ? sum(cols[0]!, cols[1]!) : cols[0]!;
            // The memory threshold is on memory used (%), which only the VM's own vitals know.
            const used = k === "memory" ? (sum0.vitals?.memUsedPct ?? null) : null;
            const judged = k === "memory" ? used : lastOf(line);
            const peak = ch.low ? minOf(line) : maxOf(ch.peak ? column(pts, ch.peak) : line);
            const extra = [used !== null && `${pct(used)} used`, peaks && peak !== null && `${ch.low ? "lowest" : "peak"} ${ch.f(peak)}`].filter(Boolean).join(" · ");
            return (
              <Figure key={k} name={ch.name} az={az(...ch.cols)} value={ch.words ? ch.words.map((w, i) => `${w} ${ch.f(lastOf(cols[i]!))}`).join(" · ") : ch.f(lastOf(line))} level={ch.th ? levelOf(judged, th(ch.th), ch.dir ?? "above") : null} dir={ch.dir} extra={extra || null}>
                {fill ? <FillSpark data={line} label={ch.name} /> : spark(line, ch.name)}
              </Figure>
            );
          })}
        </ul>
      </div>
    );
  }
  return (
    <Panel title="VM performance" className="ov-az" bodyClassName="ov-scroll ov-az__body">
      {body}
      {sum0?.configured && <AzureFoot feed={feed} now={now} />}
    </Panel>
  );
}

// ── Azure health ──

const HEALTH_TONE: Record<string, string> = { Available: "green", Degraded: "amber", Unavailable: "red", Unknown: "grey" };
const PLAIN: Record<string, string> = { Available: "Healthy", Degraded: "Having problems", Unavailable: "Down", Unknown: "Not known" };
const plainPower = (p: string | null) => (p ? p.replace(/^VM /i, "").replace(/^./, (ch) => ch.toUpperCase()) : NO_DATA);
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)).replace(" at ", ", ") : "no time given";

export function AzureHealth({ o, now }: { o: OverviewResponse; now: number }) {
  const { settings: st } = useWidget("overview.azureHealth");
  const s = useAzureSummary().data;
  const [boot, setBoot] = useState(false);
  const h = s?.health ?? null;
  const terms = st.azureTerms as boolean;
  const facts: [string, ReactNode][] = h
    ? [
        ["Power", terms ? (h.power ?? NO_DATA) : plainPower(h.power)],
        ["VM agent", h.vmAgent ? [h.vmAgent.status, h.vmAgent.version].filter(Boolean).join(" · ") || NO_DATA : NO_DATA],
        [
          "Boot log",
          h.bootDiagnostics === false ? (
            "Turns on with the next deploy"
          ) : (
            <button type="button" className="ov-az__link" aria-label="Boot log" onClick={() => setBoot(true)}>
              View
            </button>
          ),
        ],
      ]
    : [];
  const issues = st.serviceIssues ? (s?.serviceIssues ?? []) : [];
  const events = st.maintenance ? (s?.maintenance ?? []) : [];

  let body: ReactNode;
  if (!s) body = <AzNote>Loading…</AzNote>;
  else if (!s.configured) body = <AzNote>{NOT_CONNECTED_TEXT}</AzNote>;
  else
    body = (
      <>
        {!h ? (
          <AzNote>{o.snapshot.state === "running" ? WAITING_TEXT : NOTHING_TEXT}</AzNote>
        ) : (
          <>
            <p className={cx("ov-az__state", `ov-az__state--${HEALTH_TONE[h.state]}`)}>
              <span className="ov-az__dot" aria-hidden />
              <span>{terms ? h.state : PLAIN[h.state]}</span>
            </p>
            {h.summary && <p className="ov-az__summary">{h.summary}</p>}
            <ul className="ov-az__facts">
              {facts.map(([k, v]) => (
                <li key={k}>
                  <span className="ov-az__key">{k}</span>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
            {h.annotations.slice(0, st.annotations as number).map((a) => (
              <p key={a.at + a.title} className="ov-az__item">
                <span className="ov-az__key">{when(a.at)}</span> <span>{a.title}</span>
              </p>
            ))}
          </>
        )}
        {events.map((e) => (
          <p key={e.id} className="ov-az__item ov-az__item--amber">{`${e.type} by Azure · ${e.status === "Started" ? "started" : `not before ${when(e.notBefore)}`}`}</p>
        ))}
        {issues.map((i) => (
          <p key={i.trackingId} className="ov-az__item ov-az__item--amber">
            <span className="ov-az__key">Azure issue</span> <span>{i.title}</span>
          </p>
        ))}
      </>
    );
  return (
    <Panel title="Azure health" className="ov-az" bodyClassName="ov-scroll ov-az__body">
      {body}
      {s?.configured && (st.feedAges as boolean) && <AzureFoot feed={feedOf(s, "health")} now={now} />}
      <BootLogModal open={boot} onOpenChange={setBoot} />
    </Panel>
  );
}

// ── System vitals ──

function uptime(s: number | null): string {
  if (s === null) return NO_DATA;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} m` : `${m} m`;
}
const worse = (a: Level, b: Level): Level => (a === "bad" || b === "bad" ? "bad" : a === "warn" || b === "warn" ? "warn" : (a ?? b));
/** Vitals older than three heartbeats are stale. */
const VITALS_STALE_MS = 90_000;

export function Vitals({ o, now }: { o: OverviewResponse; now: number }) {
  const { settings: st } = useWidget("overview.vitals");
  const s = useAzureSummary().data;
  const v = s?.vitals ?? null;
  const bars = st.bars as boolean;
  const th = (k: string) => st[k] as SettingValue;
  const bar = (value: number | null, label: string, level: Level) => (bars ? <ProgressBar value={value} label={label} tone={level && level !== "ok" ? LEVEL_TONE[level] : "blue"} /> : null);

  let body: ReactNode;
  if (!s) body = <AzNote>Loading…</AzNote>;
  else if (o.snapshot.state !== "running") body = <AzNote>{NOTHING_TEXT}</AzNote>;
  else if (s.agent === "needsDeploy") body = <AzNote>Needs the next deploy: this VM's agent is older than these figures.</AzNote>;
  else if (!v) body = <AzNote>Waiting for the first heartbeat with vitals.</AzNote>;
  else {
    const ct = v.conntrack && v.conntrack.max > 0 ? (v.conntrack.count / v.conntrack.max) * 100 : null;
    const perCpu = v.load1 !== null && v.ncpu ? v.load1 / v.ncpu : null;
    const t = v.net?.targets ?? [];
    const rtt = maxOf(t.map((x) => x.rttMs));
    const loss = maxOf(t.map((x) => x.lossPct));
    const lv = {
      memory: levelOf(v.memUsedPct, th("memory"), "above"),
      disk: levelOf(v.diskUsedPct, th("disk"), "above"),
      ct: levelOf(ct, th("conntrack"), "above"),
    };
    const rows: Record<string, ReactNode> = {
      memory: (
        <Figure key="memory" name="Memory" value={`${pct(v.memUsedPct)} used`} level={lv.memory}>
          {bar(v.memUsedPct, "Memory used", lv.memory)}
        </Figure>
      ),
      disk: (
        <Figure key="disk" name="Disk" value={`${pct(v.diskUsedPct)} used`} level={lv.disk} extra={v.diskFreeBytes !== null ? `${bytes(v.diskFreeBytes)} free` : null}>
          {bar(v.diskUsedPct, "Disk used", lv.disk)}
        </Figure>
      ),
      load: <Figure key="load" name="Load" value={perCpu === null ? NO_DATA : `${perCpu.toFixed(2)} per vCPU`} level={levelOf(perCpu, th("load"), "above")} />,
      steal: <Figure key="steal" name="CPU steal" value={pct(v.stealPct)} level={levelOf(v.stealPct, th("steal"), "above")} />,
      conntrack: (
        <Figure key="conntrack" name="Connections" value={v.conntrack ? `${v.conntrack.count} of ${v.conntrack.max}` : NO_DATA} level={lv.ct}>
          {bar(ct, "Connection table used", lv.ct)}
        </Figure>
      ),
      uptime: <Figure key="uptime" name="Uptime" value={uptime(v.uptimeS)} />,
      updates: <Figure key="updates" name="Updates" value={v.updates ? `${v.updates.pending} waiting, ${v.updates.security} security` : NO_DATA} level={levelOf(v.updates?.security ?? null, th("securityUpdates"), "above")} />,
      internet: (
        <Figure key="internet" name="Internet" value={v.net ? `${rtt === null ? NO_DATA : `${round(rtt)} ms`} · ${loss === null ? NO_DATA : `${round(loss)}% loss`}` : NO_DATA} level={worse(levelOf(rtt, th("latency"), "above"), levelOf(loss, th("loss"), "above"))} extra={v.net?.method === "tcp" ? "ping blocked: checked over TCP" : null} />
      ),
    };
    body = <ul className="ov-az__list">{(st.rows as string[]).map((k) => rows[k])}</ul>;
  }
  return (
    <Panel title="System vitals" className="ov-az" bodyClassName="ov-scroll ov-az__body">
      {body}
      {v && o.snapshot.state === "running" && s?.agent !== "needsDeploy" && <FeedFoot title="VM agent" at={v.at} now={now} stale={now - Date.parse(v.at) > VITALS_STALE_MS} />}
    </Panel>
  );
}
