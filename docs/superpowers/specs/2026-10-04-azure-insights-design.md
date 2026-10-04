# wg-admin Azure insights widgets: design

Date: 2026-10-04. Status: Steven approved the scope in conversation: items 1–13, free features only, and the binding ruling
that widgets can be turned on and off. This written spec awaits his review. Builds on `2026-10-03-widgets-design.md` (live). Plan: `docs/superpowers/plans/2026-10-04-azure-insights-plan.md`.
Borrowed from the parked Azure Observability design (`C:\cloudflare_projects\Azure Observability\spec.md`): feeds as modules
(fetch → normalise → store), a poller separate from the display, each feed's last-success age on screen, a "not configured" state,
plain-English titles with the Azure metric name in small print, and a verdict line first.

## 1. Intent

wg-admin learns what Azure and the VM itself know about the headend and shows it in **new widgets that are off until Steven turns
them on**. Azure data is collected by the Worker on a timer and stored in D1. Pages read D1 only and never wait on Azure. VM data
comes from the existing 30-second heartbeat.

| # | Item | Source | Where it shows |
|---|---|---|---|
| 1 | VM performance | Azure Monitor platform metrics (VM) | `overview.vmPerformance` |
| 2 | Azure health and power | Resource Health, VM instance view | `overview.azureHealth`, verdict |
| 3 | Azure change log | Activity Log, resource group scope | `activity.azureChanges`, opt-in in `activity.changeLog`, watchman note |
| 4 | Region capacity and quota | Resource SKUs, Compute usages | Overview deploy form, Settings → Deployment (warnings only) |
| 5 | Azure Service Health | Resource Health events API, subscription scope | top-bar pill (only during an issue), `activity.serviceHealth`, verdict |
| 6 | Boot log | Managed boot diagnostics, `retrieveBootDiagnosticsData` | Boot log modal (from Azure health and from the verdict) |
| 7 | Public IP and DDoS | Azure Monitor platform metrics (public IP) | `firewall.publicIp` |
| 8 | Exact VM price | Azure Retail Prices API, no auth | Settings → Deployment, and every cost estimate |
| 9–12 | Memory, disk, vitals, scheduled events, internet check | VM agent heartbeat | `overview.vitals`, `overview.azureHealth`, verdict |
| 13 | Verdict | All of the above plus today's checks | Head line of `overview.health` |

**Nothing changes until Steven changes something.** New widgets ship off. The only things that appear without his choice are
warnings, and they appear only while something is wrong: the Service Health pill, the capacity warning on the deploy form, and the
verdict wording in the Health summary head (§10.3).

## 2. Decisions made while writing this spec (Steven may change these)

1. **A second cron line, `2-59/5 * * * *`, runs the collector**, dispatched on `event.cron`. The watchman keeps its own
   invocation, subrequest budget and failure domain, so Azure can never delay auto-destroy or the cost guard. Sharing the
   watchman's invocation would fit, but only just (§7).
2. **Azure metrics are stored at 5-minute resolution in wide rows** (one row per slot per resource). D1 bills per row written:
   2 rows per run instead of about 60.
3. **Azure changes get their own widget, plus an opt-in in the Change log**, but no new event type, because that would change
   the option lists of 4 live widgets. A change by anyone other than wg-admin's service principal to the VM, NSG, public IP or
   NIC also writes one watchman note ("Changed in Azure outside wg-admin: …"), which reaches the event stream and the bell.
4. **The verdict is a setting of `overview.health`: `verdict`, default on.** It rewrites the head's existing title and sub-line,
   adding no height. With no Azure or vitals data it gives today's head text exactly, so the pixel baseline holds. Off brings back
   today's check count.
5. **The Service Health "banner" is a top-bar pill** beside the notes bell, because a real banner would push pages past one
   screen. It renders only while an active event affects VMs or networking in the configured region.
6. **A full row offers Replace and never adds a row (§9.3).** Every home row is already full today at 1100×600.
7. **The price comes from Azure automatically.** A new setting, `rate_source`, is `azure` or `fixed`. With nothing saved, it
   is `fixed` if an `hourly_rate_gbp` override exists, otherwise `azure`. Under `azure`: hourly = VM + E4 disk + static IPv4 for
   the deployed (or configured) region and size; standby = disk + IP; test VM = B1ls + S4 disk. With no GBP price under 7 days
   old, the fixed values apply and Settings says why.
8. **Each new scheduled event writes one watchman note and sends one push.** wg-admin never approves an event: approving brings
   the reboot forward.
9. **Only the IPv4 public IP (`pip-wg`) is watched.** Watching IPv6 too would double the calls for little traffic.
10. **The boot log is a modal, not a widget**, so it never takes a slot.
11. **Phone:** an enabled Azure widget is a card after the phone page's existing blocks. A widget that is off shows nothing.

## 3. Architecture

```
cron */5   → runScheduled (watchman, unchanged)
cron 2/5   → runInsights(env, now) ─ token ─ feeds[]: due? → fetch → normalise → store (D1) → az_feed status
heartbeat  → handleAgent ─ parseVitals (never throws) → snapshot.agent.vitals + hist_vm columns + event notes
browser    → /api/v1/azure/* → D1 only (except POST bootlog and a capacity cache miss: one Worker-side fetch, rate-limited)
```

- **A feed is a module** in `worker/src/insights/feeds/<id>.ts`:
  `{ id, title, cadenceMin, when: "always" | "rg" | "vm" | "running", calls, run(ctx) }`. The `ctx` holds `arm(path, init)`,
  `fetch` (for the no-auth price API and SAS blobs), `db`, `now`, `snap`, `cfg` and `budget`. Each feed exports `fetch`,
  `normalise` and `store` separately, so all three can be tested without a network.
- **The runner** (`worker/src/insights/runner.ts`) reads `az_feed` and takes the due feeds whose `when` holds, in §4's priority
  order. It skips any feed whose `calls` would pass the remaining budget; a skipped feed stays due for the next run. Each feed
  runs in its own `try/catch` with `AbortSignal.timeout(8000)` on every fetch, and its result is recorded as `ok`, `error`,
  `not_configured` or `skipped`. A failed sign-in marks every ARM feed `error` and still runs the price feed, which needs no token.
- **Budget guard:** `ctx.budget.take(n)` throws `BudgetExceeded` before any fetch that would pass `AZ_RUN_BUDGET` (25). That
  ends the one feed only.
- **Plain-English catalogue** `shared/azureMetrics.ts`: Azure metric name → `{ title, unit, aggregation, column }`, for example
  `"Percentage CPU" → { title: "CPU used", unit: "%", aggregation: "Average", column: "cpu_avg" }`. Widgets show
  `title` large and the Azure name in small print.

## 4. Feeds and schedule

API versions are what is believed current. **(V)** marks "verify at build time with a live call", recorded in the X1 report.

| Feed (priority order) | Azure call(s) | Every | Runs when | Calls | Stores |
|---|---|---|---|---|---|
| `health` | `GET {vm}/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=2022-10-01` (V: newer) + `GET {vm}/instanceView?api-version=2024-07-01` | 5 min | resource group exists | 2 | `az_latest['health']`: availabilityState, title, summary, reasonType, occurredTime, recommended actions; power, provisioning, VM agent status and version, boot diagnostics on/off |
| `vmMetrics` | `GET {vm}/providers/Microsoft.Insights/metrics?api-version=2023-10-01&metricnames=…&interval=PT5M&timespan=<last 20 min>&aggregation=Average,Maximum,Minimum,Total` | 5 min | VM running, or up to 15 min after it stops | 1 | `hist_az_vm` (upsert the last 3 complete slots) |
| `pipMetrics` | the same on `pip-wg` | 5 min | the public IP exists (running or Standby) | 1 | `hist_az_pip` |
| `metricDefs` | `GET {res}/providers/Microsoft.Insights/metricDefinitions?api-version=2023-10-01` (V), VM and IP | daily, and after each deploy | resource exists | 2 | `az_latest['metricDefs']`: the names this resource emits. Metric calls ask only for these, because one unknown name fails the whole call with 400 |
| `activity` | `GET /subscriptions/{s}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=eventTimestamp ge '{last−10 min}' and resourceGroupName eq '{rg}'&$select=eventDataId,eventTimestamp,operationName,status,caller,resourceId,category,correlationId,level,subStatus` | 5 min while the resource group exists or a run ended < 2 h ago, otherwise 60 min; due at once when a run starts or ends | always | 1–2 (at most 2 pages; a first run or one after a 2 h gap reaches back 7 days and may read up to 5 pages while 8 calls of the budget remain) | `az_activity` |
| `serviceHealth` | `GET /subscriptions/{s}/providers/Microsoft.ResourceHealth/events?api-version=2022-10-01&queryStartTime={−7 d}` (V: server-side `$filter` on EventType; otherwise filtered here) | 15 min | always | 1 | `az_service_events`: ServiceIssue and PlannedMaintenance only, impact limited to Virtual Machines, Virtual Network, Network Infrastructure, Load Balancer, Azure DNS (V: service names) |
| `capacity` | `GET /subscriptions/{s}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '{r}'` + `GET …/Microsoft.Compute/locations/{r}/usages?api-version=2024-07-01` (V) | daily per region in use (configured, profiles); on demand for the "nearest" region | always | 2 per region, 1 region per run | `az_capacity` |
| `prices` | `GET https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&currencyCode='GBP'&$filter=armRegionName eq '{r}' and priceType eq 'Consumption' and (…VM sizes… or meterName eq 'E4 LRS Disk' or meterName eq 'S4 LRS Disk' or meterName eq 'Standard IPv4 Static Public IP')` (V: whether one OR filter works; otherwise 3 calls) | daily per region in use | always | 1–3 | `az_prices`. Linux only: skip names containing Windows, Spot or Low Priority, and units that are not "1 Hour" / "1/Month" |
| `bootLog` | `POST {vm}/retrieveBootDiagnosticsData?api-version=2024-07-01&sasUriExpirationTimeInMinutes=5`, then `HEAD` and a ranged `GET` of `serialConsoleLogBlobUri` | once per stale-heartbeat episode (`flag:unreachable` set, or the "boot" problem) | VM exists | 3 | `az_latest['bootlog']` (§11) |
| `housekeeping` | none | daily | always | 0 | prunes per §6 |

**VM metrics** (Microsoft.Compute/virtualMachines; 13 of the 20 allowed per call), as Azure name → plain title (aggregation):
- **CPU:** `Percentage CPU` → CPU used (Avg, Max).
- **Memory:** `Available Memory Bytes` → Memory free (Min). (V) it may still be Preview.
- **Network:** `Network In Total` and `Network Out Total` → Data in / out (Total).
- **Disk:** `Disk Read Bytes` and `Disk Write Bytes` → Disk read / written (Total); `Disk Read Operations/Sec` and
  `Disk Write Operations/Sec` → Disk reads / writes per second (Avg); `OS Disk IOPS Consumed Percentage` and
  `OS Disk Bandwidth Consumed Percentage` → Disk IOPS / bandwidth used (Max).
- **CPU credits** (B-series only; (V) on Basv2): `CPU Credits Remaining` → Credits left (Min); `CPU Credits Consumed` →
  Credits used (Total).
- **Availability:** `VmAvailabilityMetric` → Azure availability (Avg). (V) the name, and that Azure emits it.

**Public IP metrics** (Microsoft.Network/publicIPAddresses, Standard SKU; (V) that they are emitted under free DDoS
infrastructure protection):
- `IfUnderDDoSAttack` → Under DDoS attack (Max)
- `PacketsInDDoS`, `PacketsDroppedDDoS`, `BytesInDDoS` and `BytesDroppedDDoS` → Inbound and dropped packets and bytes (Max)
- `PacketCount`, `ByteCount` and `SynCount` → Packets, bytes and SYN packets (Total)
- `VipAvailability` → Data path availability (Avg)

**Activity normalising.**
- Events are grouped by `correlationId`, and the final status (Succeeded or Failed) wins over Started and Accepted.
- `caller_kind` is `wgadmin` when the caller is `AZURE_CLIENT_ID`, `person` when it looks like an email address, and `azure`
  otherwise (platform and Resource Health events).
- `resource_type` becomes a plain name: Virtual machine, Network security group, Public IP, Network interface, Disk, Virtual
  network, Resource group or Other.
- Rows with category `ResourceHealth` are Azure's annotations (for example a host reboot for repair), which
  `overview.azureHealth` shows.

**Capacity normalising.** For each offered size, the result records `available` (no restriction of type `Location`),
`reason` (for example `NotAvailableForSubscription`), `vcpus` and `family`. The family is joined to usages by `family` =
`name.value`. `cores` is the total regional vCPUs. A deploy needs the size's vCPUs, plus 1 when `test_vm` is on (B1ls,
`standardBSFamily`). The SKU list for a region is about 1–3 MB, so `skuRestrictions(text, sizes)` slices out only the wanted
size objects before `JSON.parse`, to keep CPU low (§7).

## 5. Agent additions (items 9–12)

The heartbeat stays fast because it only reads cache files. Anything that could wait runs in the background in the new
`infra/agent/wg-vitals.sh <job>`, started with `systemd-run --no-block` once that job's cache is older than its interval.

| Field | How | Interval | Cost per heartbeat |
|---|---|---|---|
| `vitals.mem {total, available}` | `/proc/meminfo` MemTotal, MemAvailable (bytes) | every heartbeat | file read |
| `vitals.disk {total, used, avail}` | `df -B1 --output=size,used,avail /` | every heartbeat | one exec |
| `vitals.cpu {steal_pct, iowait_pct, ncpu}` | `/proc/stat` delta against `/run/wg-admin/cpustat` from the previous heartbeat | every heartbeat | file read |
| `vitals.conntrack {count, max}` | `/proc/sys/net/netfilter/nf_conntrack_{count,max}`; null if absent | every heartbeat | file read |
| `vitals.updates {pending, security, at}` | job `updates`: `/usr/lib/update-notifier/apt-check` (V on the 24.04 server image; it writes `N;M` to stderr). Cached in `/run/wg-admin/updates.json` | 6 h | cache read |
| `vitals.events {incarnation, at, items[]}` | job `events`: `curl -s -H Metadata:true --max-time 2 'http://169.254.169.254/metadata/scheduledevents?api-version=2020-07-01'`. Each item keeps id, type (Reboot / Redeploy / Freeze / Preempt / Terminate), status, not_before, source, duration_s, description (≤ 200 chars) and `self` (this VM is in Resources). At most 10 items. Read only, never POSTed | 60 s | cache read |
| `vitals.net {at, method, targets[{ip, rtt_ms, loss_pct}]}` | job `net`: `ping -n -q -c 3 -i 0.2 -W 1` to 1.1.1.1 and 8.8.8.8 in parallel. If both lose every packet, a TCP connect to port 53 (`timeout 2 bash -c '</dev/tcp/IP/53'`) tells "ICMP blocked" (`method: "tcp"`) from "no internet" (loss 100) | 5 min | cache read |

- The payload gains `agent_version: 7` and `vitals: {…}`. Uptime and load are already sent.
- **Old agents:** `AgentReport` gains `agent_version` and `vitals` (null when absent). On a running VM with `agent_version < 7`,
  the agent-fed widgets say "Needs the next deploy: this VM's agent is older than these figures". That is not an error.
- **Ingestion:** `parseVitals(raw)` in `worker/src/vitals.ts` clamps and type-checks every number, caps every string, turns
  anything malformed into null, and never throws. A new scheduled-event id writes one note and one push (§2.8); seen ids are kept
  in `snapshot.sched_events_seen` (the last 20).
- **History:** `hist_vm` gains `mem_used_pct`, `disk_used_pct`, `steal_pct`, `conntrack_pct`, `net_rtt_ms` and `net_loss_pct`.
  Roll-up averages them and keeps the maximum for steal and loss.

## 6. Data model (migration `0019_azure_insights.sql`; renumber if `main` gains a 0019)

```sql
-- Every new table is WITHOUT ROWID, like hist_*. Times are ISO UTC.
ALTER TABLE hist_vm ADD COLUMN mem_used_pct REAL;    -- and disk_used_pct, steal_pct, conntrack_pct, net_rtt_ms, net_loss_pct
CREATE TABLE hist_az_vm  (res INTEGER NOT NULL, t TEXT NOT NULL,          -- res 300 only
  cpu_avg REAL, cpu_max REAL, mem_free_min REAL, net_in REAL, net_out REAL, disk_read REAL, disk_write REAL,
  disk_rops REAL, disk_wops REAL, credits_min REAL, credits_used REAL, avail_avg REAL, os_iops_max REAL, os_bw_max REAL,
  PRIMARY KEY (res, t)) WITHOUT ROWID;
CREATE TABLE hist_az_pip (res INTEGER NOT NULL, t TEXT NOT NULL,
  ddos_max REAL, pkts_in_ddos REAL, pkts_drop_ddos REAL, bytes_in_ddos REAL, bytes_drop_ddos REAL,
  packets REAL, bytes REAL, syn REAL, vip_avail REAL, PRIMARY KEY (res, t)) WITHOUT ROWID;
CREATE TABLE az_feed (feed TEXT PRIMARY KEY, last_try_at TEXT, last_ok_at TEXT, status TEXT NOT NULL,  -- ok|error|not_configured|skipped|idle
  error TEXT, next_due_at TEXT) WITHOUT ROWID;
CREATE TABLE az_latest (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL) WITHOUT ROWID; -- health, metricDefs, bootlog
CREATE TABLE az_activity (id TEXT PRIMARY KEY, at TEXT NOT NULL, correlation_id TEXT, operation TEXT NOT NULL, status TEXT NOT NULL,
  caller TEXT, caller_kind TEXT NOT NULL, resource_type TEXT NOT NULL, resource_name TEXT, category TEXT, level TEXT) WITHOUT ROWID;
CREATE INDEX az_activity_at ON az_activity (at);
CREATE TABLE az_service_events (tracking_id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, level TEXT, title TEXT NOT NULL,
  summary TEXT, services TEXT NOT NULL, regions TEXT NOT NULL, starts_at TEXT, ends_at TEXT, updated_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE az_capacity (region TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE az_prices (region TEXT NOT NULL, item TEXT NOT NULL, gbp REAL NOT NULL, unit TEXT NOT NULL, meter TEXT NOT NULL,
  fetched_at TEXT NOT NULL, PRIMARY KEY (region, item)) WITHOUT ROWID;                -- item: a VM size, 'disk:E4', 'disk:S4', 'ip:v4'
```

**Retention** (new tables pruned by the daily `housekeeping` feed; heartbeat history by the existing `rollUp`):
- `hist_az_vm` and `hist_az_pip`: 30 days. The new `hist_vm` columns follow `hist_vm`: raw for 48 h, then 5-minute rows to 30 days.
- `az_activity`: 90 days, as Azure keeps it. `az_service_events`: 90 days after `updated_at`.
- `az_prices`: the latest per item, stale after 7 days. `az_capacity`: the latest per region, fresh for 24 h.
- The boot log: until 7 days after the tear-down.

None of these tables is in the R2 backup. The seeder wipes them, and only the new `insights` scenario fills them.

## 7. Subrequest and platform budget

Design target: the Workers **Free** plan (50 external subrequests and 10 ms CPU per invocation, 100k D1 rows written per day,
1k KV writes per day). (V) the account's plan; the Paid plan has far more of everything.

| Insights run (own invocation) | Typical, VM running | Typical, destroyed | Worst case |
|---|---|---|---|
| Token (cached in KV for about an hour) | 0 (1 per hour) | 0 | 1 |
| health 2, vmMetrics 1, pipMetrics 1, activity 1 | 5 | 0 (activity 1 per hour) | 6 |
| serviceHealth (every 3rd run) | 0–1 | 0–1 | 1 |
| metricDefs, capacity, prices (daily, one region per run) | 0 | 0 | 2 + 2 + 3 |
| bootLog (once per stale episode) | 0 | 0 | 3 |
| **Total** | **5–6** | **0–2** | **18** (guard `AZ_RUN_BUDGET` = 25) |

- **On-demand routes** run in their own request: POST boot log uses 4 calls, a capacity cache miss 3.
- **Why a separate cron:** the watchman's own worst case is about 28 calls, so sharing its invocation would reach about 46 of 50.
- **CPU:** replies are trimmed (`$select`, at most 2 pages), the SKU list is sliced before parsing, and the boot log is capped
  at 64 KB.
- **D1:** about 15 rows per run while running (about 180 an hour); az_feed is read once per run and every result written in one
  batch, so a worst-case run is 70 statements in 31 round trips (tested in `api-azure.test.ts`). **KV:** no new writes. **Cron triggers:** this Worker uses 2
  of the 5 Free allows per account; (V) how many the account's other Workers use.

## 8. API and shared types (`shared/api.ts`)

```ts
type FeedId = "health" | "vmMetrics" | "pipMetrics" | "metricDefs" | "activity" | "serviceHealth" | "capacity" | "prices" | "bootLog";
interface FeedStatus { id: FeedId; title: string; status: "ok" | "error" | "not_configured" | "skipped" | "idle"; lastOkAt: string | null; error: string | null }
interface AzureHealth { state: "Available" | "Degraded" | "Unavailable" | "Unknown"; title, summary, reason, since: string | null; power, provisioning: string | null;
  vmAgent: { status: string | null; version: string | null } | null; bootDiagnostics: boolean | null; annotations: { at: string; title: string }[]; checkedAt: string }
interface ScheduledEvent { id: string; type: "Reboot" | "Redeploy" | "Freeze" | "Preempt" | "Terminate"; status: string; notBefore, source, description: string | null; durationS: number | null }
interface AgentVitals { at: string; memUsedPct, diskUsedPct, diskFreeBytes, load1, ncpu, stealPct, uptimeS: number | null; conntrack: { count: number; max: number } | null;
  updates: { pending: number; security: number; at: string } | null; net: { at: string; method: "icmp" | "tcp"; targets: { ip: string; rttMs: number | null; lossPct: number | null }[] } | null }
interface ServiceEvent { trackingId: string; type: "ServiceIssue" | "PlannedMaintenance"; status: "Active" | "Resolved"; level: string | null; title: string; summary: string | null; services: string[]; startsAt, endsAt: string | null; updatedAt: string }
interface AzureSummaryResponse { configured: boolean; feeds: FeedStatus[]; health: AzureHealth | null; maintenance: ScheduledEvent[]; serviceIssues: ServiceEvent[] /* active, VMs or networking, this region: the pill */;
  vitals: AgentVitals | null; agent: "current" | "needsDeploy" | "none"; latest: { cpuPct, creditsLeft, memFreeBytes, vipAvailPct: number | null; underDdos: boolean | null; at: string | null } }
interface AzureMetricsResponse { resource: "vm" | "pip" | "vitals"; range: HistoryRange; step: number; columns: string[]; points: Record<string, number | string | null>[] }
interface AzureChangesResponse { range: "24h" | "7d" | "30d" | "90d"; feed: FeedStatus; rows: { id, at, operation, status: string; caller: string | null; callerKind: "wgadmin" | "person" | "azure"; resourceType: string; resourceName: string | null }[] }
interface AzureServiceHealthResponse { events: ServiceEvent[]; feed: FeedStatus }
interface CapacityCheck { region, size: string; available: boolean | null; reason: string | null; vcpusNeeded: number; family: { name: string; used: number; limit: number } | null;
  total: { used: number; limit: number } | null; ok: boolean | null; message: string | null; fetchedAt: string | null }
interface PriceInfo { region, size: string; vmGbpPerHour, diskGbpPerHour, ipGbpPerHour, totalGbpPerHour, standbyGbpPerHour: number | null; fetchedAt: string | null; stale: boolean; source: "azure" | "fixed" }
interface BootLogResponse { fetchedAt: string | null; bytes: number; truncated: boolean; redactions: number; text: string | null; reason: string | null }
```
Shorthand: `a, b: T` means each listed field has type `T`. Every route sits behind `requireAccess` and `sameOriginOnly`.

| Route | Behaviour |
|---|---|
| `GET /api/v1/azure/summary` | `AzureSummaryResponse`, from D1 and the snapshot. Polled every 30 s by Overview and the shell |
| `GET /api/v1/azure/metrics?resource=vm\|pip\|vitals&range=1h\|24h\|7d\|30d` | `AzureMetricsResponse` (vitals reads the new `hist_vm` columns) |
| `GET /api/v1/azure/changes?range=…&who=all\|others\|wgadmin` | `AzureChangesResponse` |
| `GET /api/v1/azure/service-health?range=7d\|30d\|90d` | `AzureServiceHealthResponse` (region-filtered) |
| `GET /api/v1/azure/capacity?region=&size=` | `CapacityCheck`. A cache miss for an offered region fetches at most once per region per 10 min, otherwise `ok: null` |
| `GET /api/v1/azure/price?region=&size=` | `PriceInfo` |
| `GET /api/v1/azure/diagnostics` | Each feed's status and last error, plus the metric names Azure emits for the VM and IP (confirms the (V) items). No secrets |
| `GET /api/v1/azure/bootlog` / `POST /api/v1/azure/bootlog` | The last stored log / fetch now. POST is limited to one per 60 s; otherwise 429 `slow_down` |
| `GET /api/v1/settings` (existing) | gains `rateSource`, `price: PriceInfo`; `PUT` accepts `rate_source` |
| `GET /api/v1/overview` (existing) | gains `capacity: CapacityCheck \| null` for the deploy form's current target |

Routes use the house error shape. Without Azure credentials, everything answers `configured: false`, every feed reports
`not_configured`, and nothing answers 500.

## 9. Widget library (framework extension)

### 9.1 Schema (`shared/widgets.ts`)

- **`WidgetDef`** gains `description` (one line, for all 37 existing widgets and the 6 new ones), `icon?` (a lucide name) and
  `defaultOff?: true` (on the 6 new ones).
- **Capacity:** `LayoutRow` and stack items gain `max?`, the most items visible at once. It defaults to the item count declared
  before this project, so every existing row is full. New widgets are declared in their home row or stack, after the existing
  items, with a `weight`.
- **`PagePrefs.layout.shown?: string[]`** lists the default-off widgets that are turned on. A widget is visible when
  `defaultOff ? shown.includes(id) : !hidden.includes(id)`. `hidden` may never name a default-off widget, and `shown` may name
  only default-off widgets.
- **Validation:** `validatePagePrefs` refuses a row or stack with more than `max` visible items (400 `field: layout.shown`,
  "‹Row› is full. Turn a widget off first."). `normalisePagePrefs` repairs an over-full row by dropping the newest `shown` entries.
- **Prefs migration:** stored data needs none. Existing rows have no `shown`, so existing widgets keep their visible or hidden
  state and every new widget is off. An older bundle would strip `shown` when it saves, so `PrefsPutBody` gains `schema: 2` and
  a PUT without it gets 409 `outdated` ("Reload to change widget settings"), the existing path.

### 9.2 Add widgets (Layout menu)

**Show hidden widgets** becomes **Add widgets…**, a library that opens as a popover on desktop and a `Sheet` on the phone. It
lists every widget of the page by row, with icon, title, one-line description and an On/Off `Switch`; pinned widgets read
"Always on". On puts a widget in its home row or stack at its declared index. Off is the same as Hide. **Reset this page** also
turns every default-off widget off.

### 9.3 Full rows: Replace, never a new row

Turning on a widget whose home row or stack is at `max` opens **Replace a widget**: a `Modal` with radio buttons for that row's
visible, non-pinned items (a stack's members, when the home is a stack), with the row's suggestion preselected. **Replace**
hides the chosen item and shows the new one in its place, in one PUT, so the row's geometry is unchanged. **Cancel** changes
nothing. An extra row was rejected: Overview at 1100×600 has no flexible row to give up height, and elsewhere the flexible row
(the rules table, the runs list) is already near its minimum. Replace keeps the one-screen rule by construction, because a row
never shows more items than it does today.

## 10. New widgets and warnings

### 10.1 Catalogue rows (all `defaultOff`; the notation follows the widgets spec §8; thresholds colour this dashboard only)

| Widget id · home (row, weight, suggested Replace) | Title · description | Settings = default | Thresholds (dir) warn / bad |
|---|---|---|---|
| `overview.vmPerformance` · r3, 45, replaces `traffic` | VM performance · "CPU, memory, network and disk as Azure measures them" | Data: Range (1h/24h/7d/30d) = 24h; Charts (multi cpu, credits, memory, network, disk, diskQuota; min 1) = cpu, credits, network. Display: Azure metric names (bool) = on; Peaks (bool) = off | CPU % (above, 0–100) 80 / 95; Credits left (below, 0–2000) 30 / 10; Memory used % (above) 85 / 95; Disk IOPS used % (above) 80 / 95 |
| `overview.azureHealth` · r4, 32, replaces `notes` | Azure health · "What Azure says about the VM: health, power, agent, maintenance" | Data: Annotations shown (number 0–5) = 3; Maintenance (bool) = on; Service issues (bool) = on. Display: Feed ages (bool) = on; Azure terms (bool) = on | none (states are facts) |
| `overview.vitals` · r4, 32, replaces `costImpact` | System vitals · "Memory, disk, load, steal, connections, updates and internet from the VM" | Data: Rows (multi memory, disk, load, steal, conntrack, uptime, updates, internet; min 1) = all. Display: Bars (bool) = on | Memory % (above) 85 / 95; Disk % (above) 80 / 90; Load per vCPU (above, 0–16 step 0.1) 1.0 / 2.0; Steal % (above) 10 / 25; Conntrack % (above) 70 / 90; Internet latency ms (above, 1–1000) 100 / 250; Loss % (above) 2 / 10; Security updates (above, 0–500) 1 / off |
| `firewall.publicIp` · stack `right`, replaces `capture` | Public IP and DDoS · "Packets at Azure's edge and DDoS mitigation on the public IP" | Data: Range (1h/24h/7d) = 24h; Series (multi packets, bytes, syn, dropped; min 1) = packets, dropped. Display: Azure metric names = on | Data path availability % (below, 0–100 step 0.1) 99.9 / 99; Dropped packets / 5 min (above, 1–1e9) off / off |
| `activity.azureChanges` · stack `right`, replaces `changeLog` | Azure change log · "Who changed what in Azure, including the portal" | Data: Range (24h/7d/30d/90d) = 7d; Who (enum all, others, wgadmin) = all; Types (multi vm, nsg, pip, nic, disk, vnet, rg, other; min 1) = all. Display: Status column = on; Caller column = on; Failed only (bool) = off | none |
| `activity.serviceHealth` · r3, 2, replaces `liveOutput` | Azure service health · "Azure issues and planned maintenance in your region" | Data: Range (7d/30d/90d) = 30d; Types (multi issue, maintenance; min 1) = both. Display: Summaries (bool) = on | none |
| `overview.health` (existing, v1) | adds **Verdict line** (bool, display) = on (§2.4) | | uses the thresholds of `vitals` and `vmPerformance` (their defaults when those widgets are off) |
| `activity.changeLog` (existing, v1) | adds **Include Azure changes** (bool, data) = off | rows tagged "Azure" | |

Each new widget's footer shows its feed's last-success age ("Azure · 3 min ago", amber after 3 cadences) and the §13 states.

### 10.2 Warnings (not widgets, never configurable away)

| Warning | Where | Behaviour |
|---|---|---|
| Service Health pill | `web/src/shell/ServiceHealthIndicator.tsx`, top bar | Only while `serviceIssues` is not empty: amber "Azure issue in UK South", red for a ServiceIssue at level Error. Clicking opens a popover (title, services, start, last update, summary) linking to `/activity?widget=serviceHealth`. PlannedMaintenance never lights the pill. |
| Capacity warning | Overview deploy form; Settings → Deployment, under region and size | Only when `ok === false`. Examples: "Standard_B2s isn't offered to this subscription in UK South (NotAvailableForSubscription)." and "Needs 2 B-series vCPUs; 9 of 10 used in UK South." Deploy is not blocked: the button becomes "Deploy anyway", because the data can be up to 24 h old. When the check passes, Settings shows a quiet line: "Available · vCPU quota 1 of 10 used · checked 2 h ago". |
| Price line | Settings → Deployment cost fields | "Azure list price, UK South: VM £0.0093 + disk £0.0027 + IP £0.0037 = £0.0157/h (4 Oct)", plus a `rate_source` control: Azure price / Fixed. |

### 10.3 Verdict rules (`shared/verdict.ts`, pure; the first match wins)

`verdict(input) → { tone: "green" | "amber" | "red" | "grey", title, sub }`. When it is off, or nothing below rule 13 applies, the
head is today's `HealthSummary` head, unchanged.

| # | Condition | Tone | Title, and the sub-line's content |
|---|---|---|---|
| 1 | Running and the VM-reachable check fails | red | Today's title. Sub: today's names + " · Azure says: ‹health title›" when known + "Boot log" link |
| 2 | Resource Health Unavailable | red | "Azure reports the VM as unavailable" · summary |
| 3 | Other failing checks (WireGuard, DNS, tunnel, self-test) | red | Today's title and sub, unchanged |
| 4 | Under DDoS attack | red | "Azure is mitigating a DDoS attack on the public IP" |
| 5 | Internet check: loss ≥ bad on both targets | red | "The VM can't reach the internet" |
| 6 | Scheduled event Started, or NotBefore ≤ 15 min | red | "Azure will ‹reboot› the VM at ‹HH:MM›" |
| 7 | Resource Health Degraded | amber | "Azure reports the VM as degraded" · summary |
| 8 | Credits left ≤ bad, or memory, disk or conntrack ≥ bad | amber | e.g. "CPU credits nearly gone: the VM will slow to its 10% baseline" |
| 9 | Active Service Health issue in the region | amber | "Azure has an active issue in UK South" · title |
| 10 | A later scheduled event, or planned maintenance within 7 days | amber | "Azure maintenance planned for ‹date›" |
| 11 | Any warn-level threshold (credits, CPU, memory, disk, steal, conntrack, latency, loss, security updates) | amber | the most severe one, in that order |
| 12 | Not running and the next deploy's capacity check fails | amber | "The next deploy may fail: ‹message›" |
| 13 | otherwise | as today | today's head ("All systems healthy" / "No health data") |

**CPU credits (rules 8 and 11), changed after the live test of 4 Oct:** a fresh B-series VM sits on its launch credits (about
30 on a B1s, which banks up to 144) and earns more while idle, so "28.9 credits left" right after a deploy is not running low.
The summary's `latest.creditsTrend` compares the newest `credits_min` with the oldest in the hour before it (at least 10 minutes
older; a change of more than 1 credit is a direction). Credits at warn count only while `falling`; credits at bad count unless
`rising`, so a VM spent out at 0 still says so.

## 11. Boot log security

- **SAS URLs never leave the Worker.** They are requested with a 5-minute expiry, used at once, and never stored, logged or
  returned; errors are rewritten so they never quote a URL.
- **Size cap:** `HEAD` for the length, then a ranged `GET` of the last 64 KB (`truncated` when there is more). A non-206 reply
  is cut at 64 KB.
- **Redaction** (`worker/src/insights/redact.ts`, pure) replaces each match with `‹redacted›` and counts them. It catches PEM
  private keys, WireGuard-shaped keys (`[A-Za-z0-9+/]{42,43}=`), a value after `password|passwd|secret|token|apikey|authorization|bearer`
  and `[:=\s]`, base64 runs of 64+ characters, URLs containing `sig=`, and the current run's SSH password.
- **Stored and served:** the redacted text lives in `az_latest['bootlog']` and is served only to Access-authenticated
  same-origin requests, in a `LogView` modal.
- **Not available:** without boot diagnostics or without a VM, the reply carries
  `reason: "Boot diagnostics turn on with the next deploy"` or `"No VM"`.

## 12. Terraform change (`infra/main.tf`)

Add `boot_diagnostics {}` to `azurerm_linux_virtual_machine.wg`. It has no `storage_account_uri`, so Azure uses managed
storage. The test VM is unchanged.
- **Effect:** from the next deploy, Azure keeps the serial log and a screenshot in Microsoft-managed storage. Nothing is added
  to the resource group, and the log goes away with the VM. A VM built earlier has none until rebuilt, and the API says so.
- **Applying it:** an existing VM would be updated in place, but every deploy builds a fresh VM. CI's `fmt -check` and
  `validate` cover the change.

## 13. Failure isolation and states

**One feed failing never touches another feed, the watchman or the heartbeat.** The collector has its own cron invocation
(§2.1), a try/catch and timeout per feed, and separate writes per feed, so a partial reply is never stored half-normalised.
`parseVitals` cannot throw, and the history write stays inside the heartbeat's existing try/catch.

**Widget states:**
- **Not configured** (no Azure credentials): "Azure isn't connected. Add the service principal secrets to the Worker."
- **Waiting:** no first reading yet. **Stale:** older than 3 cadences, so the last values show with the age in amber.
- **Needs the next deploy:** an old agent, or boot diagnostics off.
- **Nothing running:** the VM is destroyed. The always-on feeds (service health, changes) still show.
- **Error:** the last error in plain words, next to the last good values.
A panel is never blank, and "no data" is never drawn as 0.

## 14. Rollout

1. **PR 1, `feat/azure-insights` → `main`:** shared, Worker, web, migration 0019, the second cron, and the Worker half of
   heartbeat ingestion. **STOP for Steven.** He merges, then runs `npm run migrate`, then `npm run deploy-worker`. Azure feeds
   fill within 5 minutes, agent widgets say "Needs the next deploy", and the boot log says it turns on with the next deploy.
2. **Check live:** `/api/v1/azure/summary` answers, `az_feed` rows read `ok`, and a live call confirms each (V) item (X1 report).
3. **PR 2, `feat/azure-insights-infra` → `main`:** `infra/agent/*`, `infra/cloud-init.yaml.tftpl` and `infra/main.tf`.
   **STOP for Steven.** It takes effect at the next deploy, because GitHub Actions builds from `main`. The order is safe either
   way: the Worker from PR 1 accepts `vitals`, and an older Worker ignores it.

## 15. Not free, or uncertain

| Item | Status |
|---|---|
| Managed boot diagnostics storage | Believed free. (V) on the Azure pricing page before PR 2; the worst case is pennies a month. |
| Azure Monitor metric API calls | About 17k a month, against a free allowance quoted in millions. (V) on the pricing page. `metrics:getBatch` is billed, so it is not used. |
| DDoS metrics with free infrastructure protection, `Available Memory Bytes`, `VmAvailabilityMetric`, credit metrics on Basv2 | (V). A metric Azure doesn't emit drops out through `metricDefs`. |
| Capacity | The SKU API shows sizes not offered to this subscription. It can't predict a temporary `AllocationFailed` capacity shortage, so the warning says "may", not "will". |
| Retail price | A GBP list price, before discounts and VAT, so not the invoice. Cost Management actuals stay the truth for month to date. |
| `apt-check` on the Ubuntu 24.04 `server` image | (V). `unattended-upgrades` is on, so the security count is normally 0. |
| Outbound ICMP from Azure | (V). The TCP fallback covers it. |
| Workers plan | (V). The design fits Free; there, the one CPU risk is the SKU parse, which is reduced by slicing. |
| Least privilege (backlog 13) | Every read works under Reader except `retrieveBootDiagnosticsData` (an action). A future re-scope needs Virtual Machine Contributor or a custom role for it. |

None of these are used: Log Analytics, the Azure Monitor Agent, flow logs, Connection Monitor, paid Network Watcher features,
DDoS Network Protection.

## 16. Testing

| Layer | Tests |
|---|---|
| Worker | Each feed's `normalise` against recorded fixture replies (trimmed real shapes, TEST-NET addresses). Runner: budget, priority, skip, isolation (one feed throws, the rest store), login failure, not configured. `skuRestrictions` slicing. Price filtering (Windows, Spot and Low Priority skipped; GBP only; stale after 7 d). `rate_source` precedence. Redaction of every pattern, and no SAS in any error. Boot log rate limit and size cap. `parseVitals` fuzz (never throws). New `hist_vm` columns and roll-up. One scheduled-event note per id. Activity grouping and the outside-change note. Migration 0019. Route shapes and errors. |
| Agent | `bash -n` on both scripts. `wg-vitals.sh` with `WG_ROOT` pointing at fixture `/proc` files and fake `apt-check`, `ping` and `curl` on `PATH`: right JSON for each job, and a hanging job never delays the heartbeat (it only reads the cache). |
| Shared | Catalogue: every new widget is `defaultOff`, described, and in its home row. Capacity validation. `shown`/`hidden` rules. A PUT without `schema: 2` is 409 outdated. **Prefs migration:** a stored page from before this project normalises to the same visibility, with every new widget off. Verdict: one test per rule, plus "no new data gives today's head, byte for byte". |
| App | **Defaults unchanged:** with no prefs, every scenario's shots diff to zero against the widgets baseline. **Enabling from the library:** Add widgets → On renders the widget in its home row and saves `shown`. **Full rows:** the Replace modal preselects the suggestion, saves in one PUT and keeps geometry; Cancel changes nothing. Each widget's settings, thresholds and states. The pill shows only during an active regional issue. The deploy warning shows only when `ok === false`. The boot log modal never renders a URL. |
| Screens | `--scenario insights` with `--prefs` fixtures turning every new widget on (each replacing its suggestion): exit 0 at 1600×900 and 1100×600, dark and light. |
