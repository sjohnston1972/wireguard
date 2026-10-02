import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  CalendarClock,
  Clock,
  Database,
  Globe,
  HeartPulse,
  Inbox,
  Laptop,
  Plus,
  Search,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  BarChart,
  Button,
  Chips,
  Col,
  ConfirmByTyping,
  DataAge,
  DataTable,
  Diff,
  Donut,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Grid,
  IconButton,
  KeyValue,
  LogView,
  MetricTile,
  Modal,
  PageHeader,
  Panel,
  ProgressBar,
  Ring,
  SearchInput,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  Sparkline,
  StackedBars,
  StaleBanner,
  StatusPill,
  StepList,
  Switch,
  Tabs,
  TimeSeriesChart,
  useToast,
  type Column,
  type LogLine,
  type PillStatus,
} from "@/components";
import "./gallery.css";

// ---- deterministic sample data (no randomness: screenshots must be stable) ----
const wave = (n: number, base: number, amp: number, phase = 0) =>
  Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + amp * Math.sin(i / 2.3 + phase) + amp * 0.6 * Math.sin(i / 0.9 + phase * 2))));

const T0 = 1_760_000_000;
const traffic = (n: number, step: number) => ({
  x: Array.from({ length: n }, (_, i) => T0 + i * step),
  inbound: wave(n, 160, 120, 0.4),
  outbound: wave(n, 60, 45, 1.7),
});

const LOG_TEXT = [
  "Applying Terraform configuration...",
  "azurerm_network_interface.wg: Creating...",
  "azurerm_network_security_group.wg: Creating...",
  "azurerm_network_interface.wg: Creation complete (2.1s)",
  "azurerm_public_ip.wg: Creating...",
  "azurerm_linux_virtual_machine.wg: Still creating... (10s)",
  "Provisioning VM with cloud-init...",
  "Installing WireGuard...",
  "High deploy frequency detected (6 in 1 hour)",
  "Firewall rule apply failed: nft returned 1",
];
const mkLines = (n: number): LogLine[] =>
  Array.from({ length: n }, (_, i) => {
    const text = LOG_TEXT[i % LOG_TEXT.length];
    return {
      id: String(i),
      time: `10:24:${String(27 + i).padStart(2, "0")}`,
      level: text.startsWith("High") ? "WARN" : text.startsWith("Firewall rule apply failed") ? "ERROR" : "INFO",
      text,
    };
  });

interface ClientRow {
  id: string;
  name: string;
  address: string;
  status: PillStatus;
  latency: number | null;
  spark: number[];
  traffic: string;
  allowed: string;
  expires: string;
}
const CLIENTS: ClientRow[] = [
  { id: "home", name: "home-site", address: "10.13.13.10", status: "online", latency: 18, spark: wave(14, 18, 6), traffic: "12.4 MB ↑ 8.1 MB ↓", allowed: "0.0.0.0/0", expires: "Never" },
  { id: "gaming", name: "sj-gaming", address: "10.13.13.2", status: "offline", latency: null, spark: [], traffic: "1.2 GB ↑ 420 MB ↓", allowed: "0.0.0.0/0", expires: "Never" },
  { id: "phone", name: "sj-phone", address: "10.13.13.3", status: "online", latency: 32, spark: wave(14, 32, 9, 1), traffic: "284 MB ↑ 96 MB ↓", allowed: "192.168.1.0/24", expires: "Dec 15, 2024" },
  { id: "laptop", name: "laptop", address: "10.13.13.4", status: "offline", latency: null, spark: [], traffic: "42 MB ↑ 11 MB ↓", allowed: "192.168.1.0/24", expires: "Never" },
  { id: "mac", name: "work-mac", address: "10.13.13.5", status: "online", latency: 28, spark: wave(14, 28, 7, 2), traffic: "1.1 GB ↑ 512 MB ↓", allowed: "192.168.10.0/24", expires: "Never" },
];

const clientColumns: Column<ClientRow>[] = [
  {
    key: "name",
    header: "Name",
    sortValue: (r) => r.name,
    cell: (r) => (
      <span className="g-name">
        {r.id === "phone" ? <Smartphone size={15} aria-hidden /> : <Laptop size={15} aria-hidden />}
        {r.name}
      </span>
    ),
  },
  { key: "address", header: "Address", sortValue: (r) => r.address, cell: (r) => <code>{r.address}</code> },
  { key: "status", header: "Status", sortValue: (r) => r.status, cell: (r) => <StatusPill status={r.status} /> },
  { key: "latency", header: "Latency", sortValue: (r) => r.latency, cell: (r) => (r.latency === null ? "—" : `${r.latency} ms`) },
  { key: "spark", header: "Session traffic", cell: (r) => <Sparkline label={`${r.name} latency`} data={r.spark} tone={r.status === "online" ? "green" : "red"} unit=" ms" /> },
  { key: "traffic", header: "", cell: (r) => <span className="g-muted">{r.traffic}</span> },
  { key: "allowed", header: "Allowed IPs", cell: (r) => <code>{r.allowed}</code> },
  { key: "expires", header: "Expires", cell: (r) => r.expires },
];

const ALL_STATUSES: PillStatus[] = ["online", "offline", "running", "success", "failure", "allow", "deny", "healthy", "degraded", "down", "pending", "deployed", "stopped", "unknown", "custom"];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="g-section" id={id}>
      <h2 className="g-h2">{title}</h2>
      {children}
    </section>
  );
}

function ToastButtons() {
  const { toast } = useToast();
  return (
    <div className="g-row">
      <Button onClick={() => toast({ title: "Rule applied", description: "Applied 2 rules to wg-clydeford.net", tone: "success" })}>Success toast</Button>
      <Button onClick={() => toast({ title: "Saved with a warning", description: "VM did not confirm yet", tone: "warning" })}>Warning toast</Button>
      <Button onClick={() => toast({ title: "Could not save", description: "Network unreachable", tone: "error" })}>Error toast</Button>
    </div>
  );
}

/** Dev-only route /__gallery: every component in every state. Not built into production. */
export default function Gallery() {
  const [range, setRange] = useState("1h");
  const [tab, setTab] = useState("all");
  const [days, setDays] = useState(["mon", "tue", "wed", "thu", "fri"]);
  const [dur, setDur] = useState(["30m"]);
  const [sw, setSw] = useState(true);
  const [region, setRegion] = useState("uks");
  const [search, setSearch] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState(false);
  const [selected, setSelected] = useState<string | null>("phone");
  const [brush, setBrush] = useState<string>("none");
  const [lines, setLines] = useState(() => mkLines(14));

  const net = useMemo(() => traffic(60, 60), []);
  const spendBars = useMemo(
    // Day 9 Sept has no data (a gap on the chart, the day kept on the axis).
    () => Array.from({ length: 24 }, (_, i): { label: string; value: number | null } => ({ label: `${i + 3} Sept`, value: i === 6 ? null : i > 15 && i < 22 ? 0.03 + (i - 15) * 0.012 : 0.004 + (i % 4) * 0.002 })),
    [],
  );
  const forecast = useMemo(() => Array.from({ length: 8 }, (_, i) => ({ label: `${i + 27} Sept`, value: 0.05 - i * 0.003 })), []);
  const buckets = useMemo(
    () =>
      Array.from({ length: 32 }, (_, i) => ({
        label: `${19 + Math.floor(i / 4)} Sept`,
        values: { ok: 3 + ((i * 7) % 9), bad: i % 6 === 0 ? 2 : i % 5 === 0 ? 1 : 0, down: i % 4 === 0 ? 2 : 0, change: 1 + (i % 3) },
      })),
    [],
  );

  // Toasts use the app-wide ToastProvider mounted in App.tsx.
  return (
    <>
      <div className="gallery">
        <PageHeader
          title="Component gallery"
          subtitle="Every shared component in every state. Dev only."
          right={
            <>
              <Select label="Region" showLabel value={region} onValueChange={setRegion} options={[{ value: "uks", label: "UK South (London)" }, { value: "ire", label: "Ireland (Dublin)" }, { value: "eus", label: "East US" }]} />
              <Button variant="primary" icon={<Plus size={15} aria-hidden />}>Add client</Button>
            </>
          }
        />

        <Section id="tiles" title="Metric tiles">
          <Grid>
            <Col span={3}>
              <MetricTile icon={<Users size={22} />} label="Total clients" value="12" sub="3 online · 9 offline" />
            </Col>
            <Col span={3}>
              <MetricTile icon={<Ring value={25} label="Online now" centre="" size={44} />} tone="green" label="Online now" value="3" sub="25% of clients" />
            </Col>
            <Col span={3}>
              <MetricTile icon={<Activity size={22} />} label="Average latency" value="28 ms" delta={{ text: "34%", direction: "down", good: true }} sub="Across online clients" />
            </Col>
            <Col span={3}>
              <MetricTile icon={<Clock size={22} />} tone="red" label="Stale handshakes" value="5" sub="No handshake > 7 days" />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" icon={<Globe size={22} />} label="Public endpoint" value="wg.clydeford.net" sub="10.13.13.0/24" />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" icon={<Users size={22} />} label="Connected clients" value="2 / 3" progress={{ value: 67 }} />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" icon={<TrendingUp size={22} />} label="Latency (avg)" value="28 ms" spark={wave(24, 28, 8)} />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" icon={<ShieldCheck size={22} />} tone="green" label="DNS status" value="Healthy" valueTone sub="Tunnel DNS resolving" />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" icon={<HeartPulse size={22} />} tone="blue" label="Heartbeat (VM)" value="Online" valueTone sub="Last seen 3s ago" />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" icon={<Database size={22} />} tone="amber" label="Session cost" value="£0.00" sub="Today (est. £0.01)" />
            </Col>
            <Col span={3}>
              <MetricTile variant="inset" tone="green" label="Availability" value="100%" ring={{ value: 100 }} sub="Last 24 hours" />
            </Col>
            <Col span={3}>
              <MetricTile icon={<CalendarClock size={22} />} label="Latency" value={null} sub="No heartbeat received" />
            </Col>
            <Col span={3}>
              <MetricTile iconStyle="circle" icon={<Clock size={22} />} label="Average duration" value="2m 18s" delta={{ text: "34% vs last week", direction: "down", good: true }} />
            </Col>
            <Col span={3}>
              <MetricTile iconStyle="circle" icon={<CalendarClock size={22} />} tone="purple" label="Month to date (actual)" value="£0.00" delta={{ text: "100%", direction: "up", good: false }} sub="vs. previous 30 days (£0.13)" />
            </Col>
            <Col span={3}>
              <MetricTile iconStyle="square" icon={<ShieldCheck size={22} />} tone="red" label="Default action" value="Deny" valueTone sub="Unmatched traffic is blocked" />
            </Col>
            <Col span={3}>
              <MetricTile
                iconStyle="square"
                icon={<Activity size={22} />}
                tone="red"
                label="Recent drops (24h)"
                value="342"
                delta={{ text: "12%", direction: "up", good: false }}
                sub="From 18 unique sources"
                action={<Sparkline variant="bars" tone="blue" label="Drops per hour" data={[2, 1, 3, 2, null, null, 1, 4, 6, 3, 5, 8, 4, 2, 6, 9, 5, 3, 4, 7, 5, 3, 6, 4]} width={80} height={30} />}
              />
            </Col>
          </Grid>
        </Section>

        <Section id="pills" title="Status pills">
          <div className="g-row">
            {ALL_STATUSES.map((s) => (
              <StatusPill key={s} status={s} />
            ))}
            <StatusPill status="custom" dot={false} variant="outline" label="Custom" />
            <StatusPill status="healthy" variant="outline" />
          </div>
        </Section>

        <Section id="buttons" title="Buttons, icon buttons, toggles">
          <div className="g-row">
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="danger">Cancel deploy</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="primary" loading>Applying</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
            <Button size="lg" variant="primary">Large</Button>
            <IconButton label="Search"><Search size={16} aria-hidden /></IconButton>
            <IconButton label="Plain" variant="plain"><Plus size={16} aria-hidden /></IconButton>
            <Switch label="Enable rule" checked={sw} onCheckedChange={setSw} />
            <Switch label="Disabled off" checked={false} onCheckedChange={() => {}} disabled />
          </div>
        </Section>

        <Section id="forms" title="Form controls">
          <div className="g-grid3">
            <Field label="Idle limit (minutes)" hint="Disconnect idle clients (0 = off)">{(p) => <input className="input" defaultValue="0" {...p} />}</Field>
            <Field label="Monthly budget warning (£)" error="Must be a positive number">{(p) => <input className="input" defaultValue="-1" {...p} />}</Field>
            <Field label="Public key" hint="Mono input">{(p) => <input className="input input--mono" defaultValue="wqbe4S5UsZoeFARHVLSAR2KHjCU3DJ3Mc6iXQ+3yc=" {...p} />}</Field>
          </div>
          <div className="g-row">
            <SearchInput label="Search clients by name, address, or public key..." value={search} onChange={setSearch} shortcut="⌘ F" />
            <SegmentedControl aria-label="Range" value={range} onChange={setRange} items={[{ value: "live", label: "Live", dot: "green" }, { value: "1h", label: "1h" }, { value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }]} />
            <Chips aria-label="Days" value={days} onChange={setDays} items={["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))} />
            <Chips aria-label="Duration" mode="single" shape="rect" value={dur} onChange={setDur} items={[{ value: "30m", label: "30 min" }, { value: "1h", label: "1 hour" }, { value: "3h", label: "3 hours" }]} />
          </div>
          <div className="g-grid3">
            <Panel title="Confirm by typing">
              <ConfirmByTyping phrase="tear down" actionLabel="Tear down" onConfirm={() => {}} />
            </Panel>
          </div>
        </Section>

        <Section id="tabs" title="Tabs">
          <div className="g-row">
            <Tabs
              variant="pill"
              aria-label="Filter"
              value={tab}
              onValueChange={setTab}
              items={[{ value: "all", label: "All", count: 12 }, { value: "online", label: "Online", count: 3 }, { value: "offline", label: "Offline", count: 9 }, { value: "exp", label: "Expiring", count: 1 }]}
            />
          </div>
          <div className="g-narrow">
            <Tabs
              aria-label="Client"
              items={[
                { value: "overview", label: "Overview", content: <p className="g-muted">Overview panel content</p> },
                { value: "config", label: "Configuration", content: <p className="g-muted">Configuration panel</p> },
                { value: "traffic", label: "Traffic", content: <p className="g-muted">Traffic panel</p> },
                { value: "activity", label: "Activity", content: <p className="g-muted">Activity panel</p> },
              ]}
            />
          </div>
        </Section>

        <Section id="charts" title="Charts">
          <Grid>
            <Col span={6}>
              <Panel title="Network traffic" actions={<span className="g-muted">this session</span>}>
                <TimeSeriesChart title="Network traffic" range="1h" x={net.x} unit=" KB/s" series={[{ label: "In", color: "blue", data: net.inbound }, { label: "Out", color: "purple", data: net.outbound }]} />
              </Panel>
            </Col>
            <Col span={6}>
              <Panel title="Spend over time">
                <BarChart title="Spend over time" bars={spendBars} forecast={forecast} budget={0.2} previous={spendBars.map((b, i) => (b.value === null ? null : i % 3 === 0 ? b.value * 1.2 : b.value * 0.8))} format={(v) => `£${v.toFixed(2)}`} />
              </Panel>
            </Col>
            <Col span={8}>
              <Panel title="Activity timeline" actions={<span className="g-muted">brush: {brush}</span>}>
                <StackedBars
                  title="Activity timeline"
                  series={[
                    { key: "ok", label: "Successful runs", color: "green" },
                    { key: "bad", label: "Failed runs", color: "red" },
                    { key: "down", label: "Tear downs", color: "blue" },
                    { key: "change", label: "Configuration changes", color: "purple" },
                  ]}
                  buckets={buckets}
                  height={150}
                  onBrush={(r) => setBrush(`${r.from}-${r.to}`)}
                />
              </Panel>
            </Col>
            <Col span={4}>
              <Panel title="Session cost breakdown">
                <Donut
                  title="Session cost breakdown"
                  centre={{ value: "£0.13", label: "Total (30 days)" }}
                  size={150}
                  segments={[
                    { label: "Compute (VM)", value: 62, color: "blue", display: "£0.08" },
                    { label: "Network (egress)", value: 23, color: "purple", display: "£0.03" },
                    { label: "Disk (managed)", value: 15, color: "green", display: "£0.02" },
                    { label: "Other", value: 0.4, color: "amber", display: "£0.00" },
                  ]}
                />
              </Panel>
            </Col>
            <Col span={12}>
              <Panel title="Empty and small">
                <div className="g-row">
                  <TimeSeriesChart title="Latency, no data" range="24h" x={[]} series={[{ label: "ms", color: "green", data: [] }]} height={80} />
                  <BarChart title="Spend, no data" bars={[]} height={80} />
                  <StackedBars title="Timeline, no data" series={[]} buckets={[]} height={80} />
                  <Donut title="Empty" segments={[]} />
                  <Sparkline label="Latency" data={[]} />
                  <Ring value={null} label="Availability" />
                  <Ring value={96} label="Success rate" centre="96%" size={56} />
                  <Ring value={40} label="Budget" tone="amber" />
                  <Sparkline label="Latency" data={wave(20, 30, 10)} />
                  <Sparkline label="Errors" tone="red" data={[1, 2, null, 6, 3, 8, 4]} />
                  <Sparkline variant="bars" tone="blue" label="Hits (24h)" data={[4, 6, 3, null, null, 2, 5, 8, 6, 9, 7, 3, 2, 5, 6, 8, 11, 9, 6, 4, 3, 5, 7, 6]} width={64} height={22} />
                  <Sparkline variant="bars" tone="red" label="Recent drops (24h)" data={[2, 1, 3, 2, null, null, null, 1, 4, 6, 3, 5, 8, 4, 2, 6, 9, 5, 3, 4, 7, 5, 3, 6]} width={90} height={32} />
                  <div style={{ width: 180 }}>
                    <ProgressBar label="Budget used" value={1} showValue />
                  </div>
                  <div style={{ width: 180 }}>
                    <ProgressBar label="Budget used" value={78} tone="amber" showValue />
                  </div>
                  <div style={{ width: 180 }}>
                    <ProgressBar label="Budget used" value={null} />
                  </div>
                </div>
              </Panel>
            </Col>
          </Grid>
        </Section>

        <Section id="table" title="Data table">
          <Grid>
            <Col span={8}>
              <Panel title="Clients" flush status={<StatusPill status="healthy" variant="outline" />} actions={<DataAge at={Date.now() - 8000} />}>
                <div className="g-table">
                  <DataTable
                    aria-label="Clients"
                    columns={clientColumns}
                    rows={CLIENTS}
                    rowKey={(r) => r.id}
                    onRowClick={(r) => {
                      setSelected(r.id);
                      setDrawer(true);
                    }}
                    selectedKey={selected}
                    rowActions={(r) => [{ label: `Edit ${r.name}`, onSelect: () => {} }, { label: "Delete", danger: true, onSelect: () => {} }]}
                  />
                </div>
              </Panel>
            </Col>
            <Col span={4}>
              <Panel title="Table states" flush>
                <div className="g-table g-table--short">
                  <DataTable aria-label="Loading" columns={clientColumns.slice(0, 3)} rows={[]} rowKey={(r) => r.id} loading />
                </div>
                <div className="g-table g-table--short">
                  <DataTable aria-label="Empty" columns={clientColumns.slice(0, 3)} rows={[]} rowKey={(r) => r.id} empty={<EmptyState icon={<Inbox size={20} />} title="No clients yet" description="Add the first client to get started." action={{ label: "Add client", onClick: () => {} }} />} />
                </div>
                <div className="g-table g-table--short">
                  <DataTable aria-label="Error" columns={clientColumns.slice(0, 3)} rows={[]} rowKey={(r) => r.id} error="The clients endpoint did not answer." onRetry={() => {}} />
                </div>
              </Panel>
            </Col>
          </Grid>
        </Section>

        <Section id="steps-logs" title="Step list, log view">
          <Grid>
            <Col span={5}>
              <Panel title="Deployment pipeline">
                <StepList
                  aria-label="Deployment pipeline"
                  steps={[
                    { id: "1", label: "Check out code from GitHub", state: "done", duration: "12s", time: "10:22:14" },
                    { id: "2", label: "Parse deployment configuration", state: "done", duration: "3s", time: "10:22:26" },
                    { id: "3", label: "Create Azure resources (VM, network, disk)", state: "done", duration: "38s", time: "10:23:08" },
                    { id: "4", label: "Apply Terraform configuration", state: "running", time: "10:24:28" },
                    { id: "5", label: "Configure firewall rules", state: "pending" },
                    { id: "6", label: "Verify Azure is clean (fallback delete)", state: "failed", duration: "4s", time: "10:25:01" },
                    { id: "7", label: "Set DNS record", state: "skipped" },
                  ]}
                />
              </Panel>
            </Col>
            <Col span={7}>
              <Panel title="Live logs" actions={<Button size="sm" onClick={() => setLines((l) => [...l, ...mkLines(l.length + 3).slice(l.length)])}>Append 3 lines</Button>}>
                <div className="g-log">
                  <LogView aria-label="Live logs" lines={lines} />
                </div>
              </Panel>
            </Col>
          </Grid>
        </Section>

        <Section id="kv" title="Key/value, diff, data age">
          <Grid>
            <Col span={4}>
              <Panel title="Client details">
                <KeyValue
                  items={[
                    { label: "Tunnel address", value: "10.13.13.3", copy: true, mono: true },
                    { label: "Public key", value: "8z+tZ9IPUSuaF9I9yn3cNhk/CCy=", copy: true, mono: true },
                    { label: "Endpoint", value: "wg.clydeford.net:51820", copy: true },
                    { label: "Client type", value: "Standard client" },
                    { label: "Last handshake", value: null },
                  ]}
                />
              </Panel>
            </Col>
            <Col span={4}>
              <Panel title="Pending changes">
                <Diff before={["allow tunnel -> internet", "deny any -> any", "port 8080 open"]} after={["allow tunnel -> internet", "allow tunnel -> home LAN", "deny any -> any"]} />
              </Panel>
            </Col>
            <Col span={4}>
              <Panel title="Data age">
                <div className="g-col">
                  <DataAge at={Date.now() - 8000} />
                  <DataAge at={Date.now() - 400_000} />
                  <DataAge at={null} />
                </div>
              </Panel>
            </Col>
          </Grid>
        </Section>

        <Section id="feedback" title="Feedback states">
          <Grid>
            <Col span={4}>
              <Panel title="Skeletons">
                <div className="g-col">
                  <Skeleton variant="tile" />
                  <Skeleton variant="line" />
                  <Skeleton variant="line" width="60%" />
                  <Skeleton variant="row" />
                  <Skeleton variant="circle" />
                </div>
              </Panel>
            </Col>
            <Col span={4}>
              <Panel title="Empty state">
                <EmptyState icon={<AlertCircle size={20} />} title="No runs in the last 7 days" description="Deploy the VM to see runs here." action={{ label: "Deploy", onClick: () => {} }} />
              </Panel>
            </Col>
            <Col span={4}>
              <Panel title="Error state">
                <ErrorState message="API unreachable. Retrying in the background." onRetry={() => {}} />
              </Panel>
            </Col>
            <Col span={12}>
              <StaleBanner at={Date.now() - 300_000} onRetry={() => {}} message="The VM has not sent a heartbeat. Showing the last known values." />
            </Col>
            <Col span={12}>
              <ToastButtons />
            </Col>
          </Grid>
        </Section>

        <Section id="overlays" title="Drawer, sheet, modal">
          <div className="g-row">
            <Button onClick={() => setDrawer(true)}>Open drawer</Button>
            <Button onClick={() => setSheet(true)}>Open sheet</Button>
            <Button variant="danger" onClick={() => setModal(true)}>Open modal</Button>
          </div>
        </Section>

        <Drawer open={drawer} onOpenChange={setDrawer} title="sj-phone" subtitle="10.13.13.3 · azure" leading={<StatusPill status="online" />} footer={<Button variant="danger">Delete client</Button>}>
          <Tabs
            aria-label="Client"
            items={[
              {
                value: "overview",
                label: "Overview",
                content: (
                  <KeyValue
                    items={[
                      { label: "Tunnel address", value: "10.13.13.3", copy: true, mono: true },
                      { label: "Client type", value: "Standard client" },
                    ]}
                  />
                ),
              },
              { value: "traffic", label: "Traffic", content: <TimeSeriesChart title="Traffic this session" range="1h" x={net.x} unit=" KB/s" series={[{ label: "Inbound", color: "blue", data: net.inbound }, { label: "Outbound", color: "purple", data: net.outbound }]} height={120} /> },
            ]}
          />
        </Drawer>
        <Sheet open={sheet} onOpenChange={setSheet} title="Add a client" subtitle="Scan the QR code on the device">
          <p className="g-muted">Bottom sheet content.</p>
        </Sheet>
        <Modal open={modal} onOpenChange={setModal} title="Tear down the VM?" description="This destroys the VM and its disk. Clients disconnect." footer={<Button onClick={() => setModal(false)}>Cancel</Button>}>
          <ConfirmByTyping phrase="tear down" actionLabel="Tear down" onConfirm={() => setModal(false)} />
        </Modal>
      </div>
    </>
  );
}
