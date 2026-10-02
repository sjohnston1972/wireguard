import { useState } from "react";
import { ArrowDown, ArrowUp, KeyRound, Power, Trash2 } from "lucide-react";
import type { ClientsResponse } from "@shared/api";
import { useClient, useHistory } from "@/api/queries";
import { useEditClient } from "@/api/mutations";
import {
  Button,
  EmptyState,
  KeyValue,
  MetricTile,
  SegmentedControl,
  Select,
  SidePanel,
  Skeleton,
  Sparkline,
  Switch,
  TimeSeriesChart,
  cx,
} from "@/components";
import { ago, bytes, clientType, daysUntil, lastHandshakeMs, routesOf, sessionTraffic, shortDate, statusWord, type Client } from "./model";
import { deviceIcon } from "./ClientsTable";
import { HBarList } from "./LowerRow";
import type { ClientHandlers } from "./ClientsScreen";
import "./ClientPanel.css";

type Props = { id: string; client: Client | null; data: ClientsResponse; h: ClientHandlers };

/** The split-view details for one client (Clients mockup, region 5); a bottom sheet on the phone. */
export function ClientPanel({ id, client, data, h }: Props) {
  if (!client) {
    return (
      <SidePanel open onClose={h.closePanel} title={`Client ${id}`}>
        <EmptyState title="No such client" description="It may have been deleted." action={{ label: "Back to all clients", onClick: h.closePanel }} />
      </SidePanel>
    );
  }
  const w = statusWord(client);
  const Icon = deviceIcon(client);
  return (
    <SidePanel
      key={client.id}
      open
      onClose={h.closePanel}
      className="cpanel"
      title={client.name}
      subtitle={
        <>
          <span className="mono">{client.ip}</span> · {clientType(client).toLowerCase()}
        </>
      }
      leading={
        <span className="cpanel__lead">
          <span className={cx("cpanel__dot", `cpanel__dot--${w.tone}`)} title={w.label} aria-hidden />
          <Icon size={22} aria-hidden />
        </span>
      }
      tabs={[
        { value: "overview", label: "Overview", content: <OverviewTab c={client} data={data} /> },
        { value: "config", label: "Configuration", content: <ConfigTab c={client} data={data} h={h} /> },
        { value: "traffic", label: "Traffic", content: <TrafficTab c={client} /> },
        { value: "activity", label: "Activity", content: <ActivityTab c={client} /> },
      ]}
      footer={<PanelActions c={client} h={h} />}
    />
  );
}

function PanelActions({ c, h }: { c: Client; h: ClientHandlers }) {
  return (
    <div className="cpanel__actions">
      {!c.isSite && (
        <Button icon={<KeyRound size={15} aria-hidden />} onClick={() => h.rekey(c)}>
          Get new config
        </Button>
      )}
      <Button icon={<Power size={15} aria-hidden />} onClick={() => h.toggleEnabled(c)} disabled={h.togglePending}>
        {c.enabled ? "Disable" : "Enable"}
      </Button>
      {!c.isSite && (
        <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} onClick={() => h.remove(c)}>
          Delete
        </Button>
      )}
    </div>
  );
}

// ── Overview ──

function OverviewTab({ c, data }: { c: Client; data: ClientsResponse }) {
  const now = Date.parse(data.now) || Date.now();
  const w = statusWord(c);
  const hs = lastHandshakeMs(c);
  const t = sessionTraffic(c);
  const lat = c.latency.filter((v) => Number.isFinite(v));
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const routes = routesOf(c);
  return (
    <div className="cpanel__stack">
      <div className={cx("cstate", `cstate--${w.tone}`)}>
        <span className="cstate__ring" aria-hidden />
        <div className="cstate__text">
          <strong>{w.label}</strong>
          <span>{hs === null ? "Never shook hands" : `Last handshake ${ago(hs, now)}`}</span>
        </div>
        <span className="cstate__lat">{c.lastLatencyMs === null ? "—" : `${Math.round(c.lastLatencyMs)} ms`}</span>
      </div>

      <div className="cpanel__tiles">
        <MetricTile
          variant="inset"
          label="Session traffic"
          value={
            t ? (
              <span className="cpanel__traffic">
                <span>
                  <ArrowUp size={12} aria-label="sent" /> {bytes(t.up)}
                </span>
                <span>
                  <ArrowDown size={12} aria-label="received" /> {bytes(t.down)}
                </span>
              </span>
            ) : null
          }
        />
        <MetricTile variant="inset" label="Latency (avg)" value={avg === null ? null : `${avg} ms`} spark={lat.length > 1 ? lat : undefined} sparkTone="green" />
      </div>

      <KeyValue
        className="cpanel__kv"
        items={[
          { label: "Tunnel address", value: c.ip6 ? `${c.ip}, ${c.ip6}` : c.ip, mono: true, copy: true },
          { label: "Public key", value: c.public_key, mono: true, copy: true },
          { label: "Endpoint", value: `${data.config.dnsName}:${data.config.port}`, mono: true, copy: true },
          { label: "Connected from", value: c.live?.endpoint ?? null, mono: true },
          { label: c.isSite ? "Site networks" : "Allowed IPs", value: routes.join(", ") || null, mono: true, copy: true },
          { label: "Client type", value: clientType(c) },
          {
            label: "Expires",
            value: c.isSite || !c.expires_at ? "Never" : c.expired ? `Expired ${shortDate(c.expires_at)}` : `${shortDate(c.expires_at)} (${daysUntil(c.expires_at, now)} days)`,
          },
        ]}
      />
      <RecentTraffic c={c} />
    </div>
  );
}

/** The last hour of this client's traffic (the mockup's "Traffic this session" card in the panel). */
function RecentTraffic({ c }: { c: Client }) {
  const hist = useHistory({ scope: "client", id: c.id, range: "1h" });
  const pts = hist.data?.points ?? [];
  const step = hist.data?.step ?? 1;
  return (
    <div className="cpanel__recent">
      <h3 className="cpanel__h">Traffic, last hour</h3>
      {hist.isPending ? (
        <Skeleton variant="block" height={110} />
      ) : (
        <TimeSeriesChart
          title={`${c.name} traffic, last hour`}
          range="1h"
          height={110}
          x={pts.map((p) => Math.floor(Date.parse(p.t) / 1000))}
          format={(v) => `${bytes(v)}/s`}
          series={[
            { label: "Sent", color: "blue", data: pts.map((p) => p.rx / step) },
            { label: "Received", color: "purple", data: pts.map((p) => p.tx / step) },
          ]}
        />
      )}
    </div>
  );
}

// ── Configuration ──

const EXPIRY = [
  { value: "0", label: "Never" },
  { value: "1", label: "1 day from now" },
  { value: "7", label: "7 days from now" },
  { value: "30", label: "30 days from now" },
];

function ConfigTab({ c, data, h }: { c: Client; data: ClientsResponse; h: ClientHandlers }) {
  const edit = useEditClient();
  // While a change is on its way, its switch shows the asked-for value and waits.
  const pending = (edit.isPending ? edit.variables : undefined) as Record<string, unknown> | undefined;
  const val = (field: "home_lan" | "azure_vnet" | "tunnel_dns" | "enabled") => (pending && field in pending ? !!pending[field] : !!c[field]);
  const busy = (field: string) => !!pending && field in pending;
  const set = (field: string, v: unknown) => edit.mutate({ id: c.id, [field]: v });

  if (c.isSite) {
    return (
      <div className="cpanel__stack">
        <SwitchRow label="Enabled" hint="Off stops the home site's tunnel at the next heartbeat." checked={val("enabled")} disabled={busy("enabled")} onChange={(v) => set("enabled", v)} />
        <p className="cpanel__note">
          The home site is managed by <code>npm run home</code> on the home network: no re-key, routes or config from the dashboard. Its networks:{" "}
          <span className="mono">{c.siteRoutes.join(", ")}</span>.
        </p>
      </div>
    );
  }

  const full = !!c.full_tunnel;
  const expiryNow = !c.expires_at ? "Never" : c.expired ? `Expired ${shortDate(c.expires_at)}` : `Expires ${shortDate(c.expires_at)}`;
  return (
    <div className="cpanel__stack">
      <div className="cpanel__group" role="group" aria-label="Routes">
        {data.config.homeLanCidr && (
          <SwitchRow
            label="Home LAN"
            hint={full ? "Full tunnel already sends everything." : `Also reach ${data.config.homeLanCidr} through the home site.`}
            checked={full ? false : val("home_lan")}
            disabled={full || busy("home_lan")}
            onChange={(v) => set("home_lan", v)}
          />
        )}
        <SwitchRow
          label="Azure VNet"
          hint={full ? "Full tunnel already sends everything." : `Also route ${data.config.vnetCidr} through the tunnel.`}
          checked={full ? true : val("azure_vnet")}
          disabled={full || busy("azure_vnet")}
          onChange={(v) => set("azure_vnet", v)}
        />
        <SwitchRow
          label="Tunnel DNS"
          hint={full ? "Full tunnel always uses the tunnel DNS." : "Ad-blocking and .wg names; off if the device stays connected while the VM is down."}
          checked={full ? true : val("tunnel_dns")}
          disabled={full || busy("tunnel_dns")}
          onChange={(v) => set("tunnel_dns", v)}
        />
      </div>
      <p className="cpanel__note">Route and DNS changes reach the device with its next config.</p>

      <div className="cpanel__expiry">
        <span className="cpanel__expiry-now">{expiryNow}</span>
        <Select
          label="Expiry"
          options={[{ value: "keep", label: "Change expiry…" }, ...EXPIRY]}
          value="keep"
          disabled={busy("expires_days")}
          onValueChange={(v) => v !== "keep" && set("expires_days", Number(v))}
        />
      </div>

      <SwitchRow label="Enabled" hint="Off stops its config working at the next heartbeat." checked={val("enabled")} disabled={busy("enabled")} onChange={(v) => set("enabled", v)} />

      <Button variant="primary" icon={<KeyRound size={15} aria-hidden />} onClick={() => h.rekey(c)}>
        Get new config
      </Button>
      {edit.error && !edit.isPending && <p className="cpanel__error" role="alert">{edit.error.message}</p>}
    </div>
  );
}

function SwitchRow({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="srow">
      <div className="srow__text">
        <span className="srow__label">{label}</span>
        <span className="srow__hint">{hint}</span>
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

// ── Traffic ──

function TrafficTab({ c }: { c: Client }) {
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const hist = useHistory({ scope: "client", id: c.id, range });
  const detail = useClient(c.id);
  const pts = hist.data?.points ?? [];
  const step = hist.data?.step ?? 1;
  const talkers = (detail.data?.talkers ?? [])
    .map((t) => ({ key: t.r, label: t.name ?? t.r, value: t.up + t.down + t.bu + t.bd }))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  return (
    <div className="cpanel__stack">
      <div className="cpanel__row">
        <h3 className="cpanel__h">Traffic</h3>
        <SegmentedControl
          aria-label="Range"
          value={range}
          onChange={(v) => setRange(v as "24h" | "7d")}
          items={[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
          ]}
        />
      </div>
      {hist.isPending ? (
        <Skeleton variant="block" height={140} />
      ) : (
        <TimeSeriesChart
          title={`${c.name} traffic, ${range}`}
          range={range}
          height={140}
          x={pts.map((p) => Math.floor(Date.parse(p.t) / 1000))}
          format={(v) => `${bytes(v)}/s`}
          series={[
            { label: "Sent", color: "blue", data: pts.map((p) => p.rx / step) },
            { label: "Received", color: "purple", data: pts.map((p) => p.tx / step) },
          ]}
        />
      )}
      <h3 className="cpanel__h">Top destinations (this session)</h3>
      {detail.isPending ? (
        <Skeleton variant="block" height={80} />
      ) : talkers.length ? (
        <HBarList items={talkers} label={`${c.name}'s top destinations`} format={bytes} />
      ) : (
        <p className="cpanel__note">no data: nothing recorded this session</p>
      )}
    </div>
  );
}

// ── Activity ──

const ACTION_WORDS: Record<string, string> = {
  "client.add": "Added",
  "client.rekey": "New keys (Get new config)",
  "client.edit": "Settings changed",
  "client.enable": "Enabled",
  "client.disable": "Disabled",
  "client.delete": "Deleted",
};

function ActivityTab({ c }: { c: Client }) {
  const detail = useClient(c.id);
  const now = Date.now();
  if (detail.isPending) return <Skeleton variant="block" height={120} />;
  const changes = detail.data?.changes ?? [];
  return (
    <div className="cpanel__stack">
      {c.roam && (
        <div className="cpanel__move">
          <h3 className="cpanel__h">Network move</h3>
          <p>
            <span className="mono">{c.roam.from}</span> → <span className="mono">{c.roam.to}</span>{" "}
            <span className="cpanel__muted">{ago(Date.parse(c.roam.at), now)}</span>
          </p>
        </div>
      )}
      <h3 className="cpanel__h">Changes</h3>
      {changes.length ? (
        <ol className="cpanel__log">
          {changes.map((e) => (
            <li key={e.id}>
              <span>{ACTION_WORDS[e.action] ?? e.action}</span>
              <span className="cpanel__muted">
                {e.user} · <time dateTime={e.at}>{ago(Date.parse(e.at), now)}</time>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="cpanel__note">No changes recorded for this client.</p>
      )}
    </div>
  );
}
