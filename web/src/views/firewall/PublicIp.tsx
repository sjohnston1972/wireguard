// Plain English: the Firewall's Public IP and DDoS widget (spec 2026-10-04
// section 10.1, off until turned on). Azure's own counts at its edge for the
// VM's public IPv4 address: whether DDoS mitigation is active, the data
// path's availability, and the packets, bytes, SYN packets and packets
// dropped by mitigation per 5 minutes. A panel in the right-hand column, or
// a tab's content (`bare`) when the column is tabbed.

import type { ReactNode } from "react";
import type { FirewallResponse, SettingValue } from "@shared/api";
import { Panel, cx } from "@/components";
import { useAzureMetrics, useAzureSummary, type HistoryRange } from "@/api/queries";
import { useWidget } from "@/widgets";
import { levelOf } from "../overview/widgetSettings";
import { AzNote, AzureFoot, Figure, NOTHING_TEXT, NOT_CONNECTED_TEXT, NO_DATA, WAITING_TEXT, azNames, bytes, column, feedOf, lastOf } from "../overview/Insights";
import "./PublicIp.css";

/** Azure's slots are 5 minutes: a per-second figure times 300. */
const SLOT_S = 300;
/** The DDoS mitigation metrics (IfUnderDDoSAttack and the four in/dropped counts). */
const DDOS_COLUMNS = ["ddos_max", "pkts_in_ddos", "pkts_drop_ddos", "bytes_in_ddos", "bytes_drop_ddos"] as const;
const count = (v: number | null) => (v === null ? NO_DATA : `${Math.round(v).toLocaleString("en-GB")} per 5 min`);

export function PublicIp({ fw, bare }: { fw: FirewallResponse; bare?: boolean }) {
  const { settings: st } = useWidget("firewall.publicIp");
  const s = useAzureSummary().data;
  const q = useAzureMetrics("pip", st.range as HistoryRange);
  const feed = feedOf(s, "pipMetrics");
  const pts = q.data?.points;
  const has = !!pts && pts.length > 0;
  const az = (...cols: string[]) => (st.azureNames ? azNames(...cols) : null);
  const now = Date.parse(fw.now);

  let body: ReactNode;
  if (!s || (!q.data && q.isLoading)) body = <AzNote>Loading…</AzNote>;
  else if (!s.configured) body = <AzNote>{NOT_CONNECTED_TEXT}</AzNote>;
  else if (!has && !fw.running) body = <AzNote>{NOTHING_TEXT}</AzNote>;
  else if (!has && !feed?.lastOkAt) body = <AzNote>{WAITING_TEXT}</AzNote>;
  else if (!has) body = <AzNote>No figures from Azure in this range.</AzNote>;
  else {
    const c = (col: string) => column(pts, col);
    // Under Azure's free DDoS infrastructure protection the DDoS metrics (and
    // often VipAvailability) come back with no values: say so once, show the
    // traffic Azure does report, and never read a missing figure as "no attack".
    const reported = (cols: readonly string[]) => cols.some((k) => c(k).some((v) => v !== null));
    const ddosReported = reported(DDOS_COLUMNS);
    const ddos = lastOf(c("ddos_max"));
    const attack = ddos === null ? null : ddos > 0;
    const avail = lastOf(c("vip_avail"));
    const dropped = lastOf(c("pkts_drop_ddos"));
    const series: Record<string, ReactNode> = {
      packets: <Figure key="packets" name="Packets" az={az("packets")} value={count(lastOf(c("packets")))} />,
      bytes: <Figure key="bytes" name="Bytes" az={az("bytes")} value={`${bytes(lastOf(c("bytes")))} per 5 min`} />,
      syn: <Figure key="syn" name="SYN packets" az={az("syn")} value={count(lastOf(c("syn")))} />,
      dropped: ddosReported ? <Figure key="dropped" name="Dropped by DDoS mitigation" az={az("pkts_drop_ddos")} value={count(dropped === null ? null : dropped * SLOT_S)} level={levelOf(dropped === null ? null : dropped * SLOT_S, st.dropped as SettingValue, "above")} /> : null,
    };
    body = (
      <>
        <p className={cx("ov-az__state", attack === true && "ov-az__state--red", attack === false && "ov-az__state--green")}>
          <span className="ov-az__dot" aria-hidden />
          <span>{attack === null ? "DDoS attack: no data" : attack ? "Under DDoS attack" : "No DDoS attack"}</span>
        </p>
        {!ddosReported && <AzNote>DDoS figures: not reported by Azure for this IP</AzNote>}
        <ul className="ov-az__list">
          <Figure name="Data path availability" az={az("vip_avail")} value={avail !== null ? `${Math.round(avail * 10) / 10}%` : reported(["vip_avail"]) ? NO_DATA : "not reported by Azure"} level={levelOf(avail, st.availability as SettingValue, "below")} dir="below" />
          {(st.series as string[]).map((k) => series[k])}
        </ul>
      </>
    );
  }
  const content = (
    <>
      {body}
      {s?.configured && <AzureFoot feed={feed} now={now} />}
    </>
  );
  if (bare) return <div className="ov-az__body fw-pip">{content}</div>;
  return (
    <Panel title="Public IP and DDoS" className="ov-az fw-pip-panel" bodyClassName="ov-scroll ov-az__body">
      {content}
    </Panel>
  );
}
