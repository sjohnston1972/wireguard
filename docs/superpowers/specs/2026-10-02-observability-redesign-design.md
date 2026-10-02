# wg-admin observability redesign: design

Date: 2026-10-02. Status: approved in conversation, awaiting written-spec review.
Inputs: `redesign/REDESIGN-SPECIFICATION.md` (the brief), `redesign/screenshots/` (today's
views), and the decisions below, made with Steven on 2026-10-02.

## 1. Intent

Rebuild the wg-admin dashboard as an observability-first console: system state is
the first thing on every screen, panels are dense and purposeful, detail lives in
drawers, and long procedural text moves into help. Every operational capability of
today's dashboard is kept. No screen ever shows invented numbers: missing data is
shown as missing.

Users: Steven only. One Azure VM, one environment, a handful of clients (four today,
including the home site). Desktop is the main target (his screen is 2560 x 1440);
the phone remains a first-class way to check state and run the core actions.

Success:
- All six views rebuilt to this design, desktop and phone, in light and dark themes.
- Every capability in the "capability map" (section 13) works in the new app.
- 24h / 7d / 30d history exists for VM health and per-client latency and traffic.
- At 1100 x 600 and larger, no desktop view scrolls the page.
- The live checklist (section 12.4) passes after switch-over.

## 2. Decisions

| Topic | Decision |
|---|---|
| Data scope | Add a history store. Defer firewall rule simulator, cost breakdown by resource type, cost-forecast modelling beyond a simple projection, SSE streaming, bulk client actions. |
| Stack | React + TypeScript app built with Vite, served by the same Worker; the Worker gains a JSON API under `/api/v1`. |
| Look | The brief's navy palette and Inter + JetBrains Mono, with a matching light theme. Follows the OS setting; manual override. |
| Rollout | Build the whole UI on the `redesign` branch; switch over in one deploy when all six views are done. |
| History | The recorder ships first to today's dashboard (on `main`) so history accumulates before switch-over. |
| Phone | Today's phone concept (bottom tab bar, one screen of lights and big buttons, slide-up sheets) rebuilt in the new look. |
| Firewall | Rule changes become draft then apply. Published ports and captures stay instant. |
| Dropped from the brief | Environment selector, multi-user avatar menu, bulk client operations, grid/list toggle, drag-to-reorder rules (keyboard and button moves remain), per-category alert toggles. |

## 3. Architecture

One Worker, one address (`wg-admin.clydeford.net`), one login (Cloudflare Access).

```
browser (React app)  --JSON-->  /api/v1/*  -->  domain modules  -->  D1 / KV / R2 / DO / GitHub / Azure
VM agent             ------->  /api/agent        (unchanged)
GitHub workflow      ------->  /api/callback*    (unchanged)
phone alert buttons  ------->  /api/act/:token   (unchanged)
cron (*/5)           ------->  watchman          (gains history roll-up)
```

Layers:
1. **Domain modules** (kept): `runs`, `peers`, `firewall`, `profiles`, `schedule`,
   `backup`, `keyrotation`, `budget`, `standby`, `speedtest`, `capture`, `webpush`,
   `settings`, `state`, `monitor`, `lock`, `azure`, `github`, `dns`. The redesign calls
   them; it does not rewrite them. New logic goes in new modules (`history`,
   `fwdraft`).
2. **JSON API** (new, `worker/src/api/`): one file per area (`overview.ts`,
   `clients.ts`, `firewall.ts`, `activity.ts`, `cost.ts`, `settings.ts`,
   `history.ts`, `session.ts`), mounted as a Hono sub-app at `/api/v1`, behind the
   existing `requireAccess` and `sameOriginOnly` middleware. Responses are typed
   (shared TypeScript types in `shared/api.ts`, imported by both Worker and app).
3. **React app** (new, `web/`): Vite project, output to `worker/public/` at build
   time. Static assets are served by the Workers assets layer; unknown GET paths
   return `index.html` (single-page app routing); `/api/*`, `/captures/*`,
   `/manifest.webmanifest`, `/health` run the Worker first.

Unchanged: VM agent and heartbeat protocol, `wg.yml`, Terraform, cloud-init, the
home container, Access applications and bypass apps, push subscription storage,
`sw.js` push handling (it gains deep links only).

Build and dev:
- `npm run build` builds `web/` into `worker/public/`.
- `npm run deploy-worker` runs the build, then migrations, then `wrangler deploy`.
- `npm run dev` runs Vite (with live reload) proxying `/api` to `wrangler dev`
  started with `--local-upstream localhost:9` (the custom-domain route otherwise
  rewrites the host and the localhost login bypass refuses the request).

Front-end libraries: React, React Router, TanStack Query (polling, caching, retry),
Radix UI primitives (Dialog, DropdownMenu, Tabs, Tooltip, Popover; unstyled, for
accessibility and focus handling), cmdk (command palette), uPlot (time-series
charts), lucide-react (icons), `@fontsource` Inter and JetBrains Mono (self-hosted
fonts), `qrcode-generator` (already a dependency). Styling: plain CSS with design
tokens as custom properties, one CSS file per component; no utility framework.
Tests: Vitest, React Testing Library, jsdom.

## 4. API

All under `/api/v1`, JSON in and out, behind Access and the same-origin check.
Mutations are POST/PUT/DELETE and return the updated resource or a structured error:

```ts
type ApiError = { error: { code: string; message: string; field?: string } };
```

HTTP status: 400 validation (with `field`), 401 Access session expired, 409 conflict
(run lock held, firewall draft based on an old version), 422 refused by policy
(budget not confirmed, typed confirmation missing), 502 upstream failure (GitHub,
Azure). The app shows `message` in place.

Reads:

| Endpoint | Returns |
|---|---|
| `GET session` | user email, build id, setup gaps, unacknowledged watchman notes |
| `GET overview` | state, snapshot facts, run progress (steps, log tail), available actions and why any are unavailable (no GitHub, lock holder, budget), profiles, nearest region, speed tests, home site, next scheduled start, Azure inventory, current deployment summary, typical deploy and destroy duration (median of the last 10 successful runs) |
| `GET history?scope=vm\|client&id=&range=1h\|24h\|7d\|30d` | time series from the history store, with resolution and data-age |
| `GET clients`, `GET clients/:id` | inventory with live state, latency, session traffic, computed AllowedIPs, expiry, stale flags; detail adds top destinations and the client's change history |
| `GET firewall` | live rules and version, draft (if any) and its diff, default action, counters, drops (stored), zones, published ports, captures, applied state |
| `GET activity?range=&tab=&kind=&q=&page=` | KPIs for the range, timeline buckets, rows for the tab |
| `GET runs/:id`, `GET runs/:id/log` | run detail with saved steps; log fetched from GitHub on demand (masked by GitHub) |
| `GET cost?range=` | session estimate, month-to-date actual with as-of date, projection with its basis, budget, cost-guard state, daily series, previous-period series where stored, sessions |
| `GET settings` | settings values, profiles, schedules (with next start in UK time), setup checklist, key info, backups, run lock, push status |
| `GET ssh-password` | unchanged behaviour (fetched only on press) |

Writes (each maps to an existing handler's logic):

| Area | Endpoints |
|---|---|
| Lifecycle | `POST deploy`, `move`, `hibernate`, `resume`, `destroy` (body `{confirm:"destroy"}`), `cleanup`, `cancel`, `reconcile`, `extend`, `speedtest`, `allow-ssh`, `notes/ack` |
| Clients | `POST clients`, `POST clients/:id/rekey`, `PUT clients/:id` (home_lan, azure_vnet, tunnel_dns, expiry, enabled), `DELETE clients/:id` |
| Firewall draft | `POST firewall/draft/rules`, `PUT firewall/draft/rules/:id`, `POST firewall/draft/rules/:id/move` (`{dir:"up"\|"down"}`), `DELETE firewall/draft/rules/:id`, `PUT firewall/draft/default`, `POST firewall/draft/from-drop`, `POST firewall/draft/apply` (`{baseVersion}`), `DELETE firewall/draft` |
| Firewall instant | `POST firewall/forwards`, `PUT firewall/forwards/:id`, `DELETE firewall/forwards/:id`, `POST firewall/captures`, `POST firewall/counters/clear` |
| Settings | `PUT settings`, `POST profiles`, `PUT profiles/:id`, `DELETE profiles/:id`, `POST schedules`, `PUT schedules/:id`, `DELETE schedules/:id`, `POST lock/release`, `GET backup/export`, `GET backup/config/:day`, `POST backup/restore/preview`, `POST backup/restore/confirm` |
| Push | `POST push/subscribe`, `POST push/unsubscribe`, `GET push/status`, `POST push/test`, `DELETE push/:id` |

Captures keep their download path `GET /captures/:id`. The old form routes and
`/api/peers*`, `/api/push/*` stay until switch-over, then are removed.

## 5. History store

Recorded on every agent heartbeat (about every 30 s while running) into one-minute
slots. A minute rather than 30 s, because heartbeats drift: two can land in one
30 s slot and leave the next empty, which would read as downtime. Recording runs
inside the heartbeat handler, after the snapshot work, guarded so a history error
never fails the heartbeat. Migration `0012_history.sql` (exact SQL in plan 1):

- `hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max,
  tx_rate_max, peers_online, dns_up)`, key `(res, t)`; `res` is 60 (raw) or 300.
- `hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max,
  rx, tx)`, key `(res, peer_id, t)`; `peer_id` is `peers.id`, stable across re-keys;
  rx/tx are counter deltas, and a counter reset counts from 0.
- `hist_drops (t, src, dst, proto, dport, in_if, out_if, n)`: one row per minute
  per distinct flow with a count, so a port scan cannot flood D1 (the agent sends
  up to 20 drops per heartbeat).
- `runs.steps_json`: the run's GitHub steps with start and end times.

Rules:
- Missing heartbeats: the 5-minute watchman writes a raw row with `received = 0`
  for each fully elapsed minute without a heartbeat while the state is `running`,
  starting at the session's first heartbeat (boot and self-test can take several
  minutes after GitHub reports the VM built; that is not downtime) and leaving the
  last 2 minutes alone (a heartbeat may be in flight). Availability
  over a range = sum(received) / sum(expected) over rows while running. Not running
  writes nothing, so it does not count against availability.
- Roll-up (watchman, every 5 minutes): raw rows older than 48 h are folded into
  `res = 300` rows (sums for counts and bytes, averages for rates and latency,
  maxima kept in the `_max` columns), then deleted. Roll-up rows older than 30 days
  are deleted. Drops older than 30 days are deleted.
- Online is handshake-based: a client is online if its latest handshake is under
  3 minutes old (the same rule as today's `peerOnline`). The UI explains this in a
  tooltip: WireGuard has no session, only handshakes.
- Write volume: every heartbeat (about 2 a minute) upserts the VM row and a row for
  each client that is online, moved bytes or answered a ping; an idle, offline
  client gets no row (no row means idle and offline). Tables are WITHOUT ROWID, so
  each write touches one row. With 4 active clients all day: about 14,400 writes
  plus about 7,200 roll-up deletes, about 22,000 a day; D1 Free allows 100,000.
- Reads: every roll-up and expiry statement is an index range read (the client
  key is `(res, t, peer_id)`), so the tidy-up reads only what it folds or deletes.
- Run steps: every GitHub poll during a run saves the step list (with start and end
  times) to `runs.steps_json`, so a finished run keeps the last list seen; the run
  drawer may refresh it from GitHub when opened.

## 6. Firewall drafts

Migration `0013_firewall_draft.sql`: table `fw_draft_rules` (same columns as
`fw_rules`, plus `live_id` linking to the rule it edits, null for new rules) and a
`fw_policy` row holding `live_version` (incremented on every apply) and the draft's
`base_version` and draft default action.

- The first edit creates the draft as a copy of the live rules and default action,
  recording `base_version = live_version`.
- `GET firewall` returns the draft and a diff: added, removed, changed (field by
  field), moved, default changed.
- Apply: in one D1 batch, refuse with 409 if `base_version != live_version`,
  replace `fw_rules` with the draft, set the default, increment `live_version`,
  clear the draft, write one audit entry with the full diff. The VM picks the new
  rule set up at its next heartbeat; the UI shows "waiting for VM" until the agent
  reports the new compiled-rules hash (the existing applied-state check), and
  "refused by the VM" with its error if the agent rejects it (the VM keeps the
  previous rule set, as today).
- Discard deletes the draft. "Allow this" on a drop adds an allow rule to the draft.
- Published ports and captures change Azure or the VM directly and remain instant.

## 7. Design system

Tokens (dark; light theme defines the same names):

```css
--bg-app: #08111f; --bg-panel: #0e1a2b; --bg-panel-alt: #111f32; --bg-elevated: #15243a;
--border: rgba(148,163,184,.15); --border-strong: rgba(148,163,184,.25);
--text-primary: #f8fafc; --text-secondary: #a9b8cc; --text-muted: #64748b;
--blue: #3b82f6; --blue-bright: #4f8cff; --green: #10d98c; --amber: #f59e0b;
--red: #ef4444; --purple: #8b5cf6;
```

- Light theme: same roles (app background light grey-blue, white panels, slate text,
  the same hues darkened for contrast). Every pair used for text is checked for
  WCAG AA contrast in both themes; `--text-muted` is for non-essential text only.
- Status colours mean status only: green healthy, amber busy or degraded, red failed
  or down, grey idle or unknown; always with a word or icon.
- Type: Inter for text, JetBrains Mono for addresses, keys, logs and config.
- Spacing scale 4, 8, 12, 16, 20, 24, 32; 12 px grid gaps; control radius 8-12 px,
  panel radius 12-16 px; subtle borders and elevation, no glow.
- Layout: 12-column grid. Desktop rule: at 1100 x 600 and larger every view fits
  the window; the page never scrolls; lists scroll inside their panel with sticky
  headings; a column too tall for the window scrolls on its own.
- Motion: short transitions only; none when the OS asks for reduced motion.

Shared components (`web/src/components/`):
- `app-shell/`: `AppHeader` (52 px: wordmark with status light, tabs, search
  trigger, state chip, connection indicator, account menu with theme and sign out),
  `CommandPalette`, `PhoneTabBar`.
- `layout/`: `PageHeader`, `Grid`, `Panel`, `Drawer` (right, ~420 px; becomes a
  sheet on the phone), `Modal`, `Sheet`.
- `data/`: `MetricTile`, `StatusBadge`, `DataAge`, `DataTable` (sticky header,
  sort, keyboard rows, empty and loading states), `Sparkline`, `TimeSeriesChart`,
  `BarChart`, `Timeline`, `LogView`, `Diff`, `CopyValue`.
- `forms/`: `Field`, `Select`, `Toggle`, `Chips`, `SegmentedControl`,
  `SearchInput`, `ConfirmByTyping`.
- `feedback/`: `Toast`, `Skeleton`, `EmptyState`, `ErrorState`, `StaleBanner`.
- View folders: `overview/`, `clients/`, `firewall/`, `activity/`, `cost/`,
  `settings/`.

URLs: `/`, `/clients`, `/clients/:id`, `/firewall`, `/firewall/rules/:id`,
`/activity?range=&tab=`, `/activity/runs/:id`, `/cost?range=`,
`/settings/:section`. Refresh and Back preserve context.

Command palette (Ctrl/Cmd+K; a search icon on the phone): navigate to any tab,
Settings section, client (by name or IP), rule, or the latest run; actions Deploy,
Tear down, Hibernate, Resume, Extend, Add client, Add firewall rule, Start capture,
Speed test. Actions open the normal reviewed form; nothing destructive runs from
the palette.

## 8. Views

### 8.1 Overview
- Page header: "Overview", "Deploy and monitor your WireGuard environment on Azure",
  read-only context (region, VM size).
- Status banner (full width): state; current operation; "step n of m" from the real
  GitHub steps; elapsed; "usually about X" from the median of recent runs (never a
  countdown); Cancel during a GitHub run. Destroyed: the Deploy form (duration
  chips, profile chips, over-budget confirmation). Running: action row Extend,
  Hibernate, Move, Speed test, Tear down (typed confirmation). Standby: Resume,
  Tear down. Failed: failed step, link to its log, Clean up.
- Topology (clickable): clients and home site -> `wg.clydeford.net` (the VM) -> Azure
  VNet and workloads. Edge and node colours show operational, degraded, down,
  unknown.
- Metric tiles with range switch (Live, 1h, 24h, 7d, 30d): public endpoint and DNS,
  clients online (n/m), average latency, availability, heartbeat age, tunnel DNS,
  self-test, session cost. Each states its window and data age.
- During a run: step list (state and duration per step, running row highlighted,
  skipped and failed distinct) beside `LogView` (search, auto-scroll toggle with a
  "new lines" marker, copy line, colour on ERROR/WARN/success lines). Clicking a
  step jumps to its group in the log where GitHub marks group boundaries.
- Lower row: traffic chart (in/out; 5m, 15m, 1h, session), health summary (VM
  reachable, WireGuard up, DNS resolving, self-test), recent events, cost (session
  estimate vs a typical session).
- SSH and "In Azure right now" stay as drawers opened from the topology or a menu.

### 8.2 Clients
- KPI tiles (each filters the table): total, online, average latency, full tunnel,
  stale (no handshake in 30 days), expiring within 7 days.
- Quick filters: All, Online, Offline, Expiring, Home site, Full tunnel; search;
  sort.
- Table: name with tags, address, status (online / offline / disabled / expired /
  loading onto VM / unknown), last handshake, latency with 24 h sparkline, session
  traffic, routes (exact AllowedIPs), expiry, overflow menu.
- Drawer tabs: Overview (keys, endpoint, copy buttons), Configuration (route and DNS
  toggles, expiry, Get new config), Traffic (24h/7d chart, top destinations),
  Activity (this client's changes and network moves).
- Add-client wizard: Name -> Routing (Standard, +Home LAN, +Azure VNet, Full tunnel;
  shows the exact routes) -> Expiry -> Delivery (QR, .conf download, copy). Keys are
  made in the browser with WebCrypto X25519 (the existing method) and shown once;
  the private key is never sent to the server or kept after the dialog closes. Input
  is kept on server error.
- Home site: no re-key or config from the dashboard (it is managed by `npm run
  home`); enable/disable only.
- Lower: top talkers for the session.

### 8.3 Firewall
- KPI tiles: rules (enabled/total), default action, drops in 24 h (from
  `hist_drops`), published ports, capture state.
- Draft bar when a draft exists: "n unpublished changes", Review (diff modal, then
  Apply), Discard.
- Policy table: order, name, source and destination as zone chips, service, action,
  hits, status, actions; sticky header; filters All, Enabled, Disabled; move up/down
  by button and keyboard; the default row is fixed last.
- Right panel tabs: Drops (Allow adds to the draft; shows matched rule where known),
  Zones (relationship view; clicking a zone filters rules), Published ports (cards,
  guided create, edit, disable, delete; instant), Capture (start, progress,
  download; instant).
- Rule drawer: rule detail and edit form (edits go to the draft).

### 8.4 Activity
- KPI tiles for the selected range, each with its basis: deploys, median deploy
  duration, success rate ("of n runs"), failed runs, config changes, watchman
  problems (notes of kind failure, drift, cost_guard or unreachable).
- Timeline: stacked bars by type (Deploy, Tear down, Failure, Config, Firewall,
  Watchman) over 1h, 6h, 24h, 7d, 30d; hover counts; brush to select a window that
  filters the panels below.
- Tabs: Runs, All activity, Config changes, Watchman notes. Runs columns: when,
  action, result, duration, estimated session cost (marked as an estimate), by,
  source (dashboard, schedule, auto-destroy, watchman), notes.
- Run drawer: saved steps with durations, log loaded from GitHub on open. Change
  drawer: before/after diff, actor, time.

### 8.5 Cost
- KPI tiles: session spend (estimate), month to date (Azure actual, as-of date),
  month projection (estimate; basis: month-to-date actual divided by days elapsed,
  times days in the month, stated in a tooltip), budget, cost guard.
  Budget progress shows "spent" and "projected" as two separate figures.
- Chart: daily actual bars, budget line, dashed projection, previous period where
  stored. Currency GBP, UK time, Azure figures lag up to 24 h (stated).
- Sessions table: start, region, VM size, duration, estimated cost, cost per hour;
  drawer with the session's run, clients used and traffic.
- Insights only from evidence (for example standby cost per day while in standby).

### 8.6 Settings
Left menu, one section at a time, unsaved-changes state with Save / Discard:
1. Overview: setup checklist (configured / verified / missing / unknown), run lock.
2. Deployment: next-deploy settings; profiles (use, create, edit, delete; the
   deployed profile marked).
3. Automation: schedules (UK time, next start, enable, edit, delete), auto-destroy
   default, idle limit, expiry action, standby limit, cost guard and budget.
4. Security: server public key (short, copy, last rotated), SSH allowed-from, "How
   key rotation works" help drawer.
5. Backup & Recovery: export, dashboard-data backups list, staged restore (upload,
   preview of changes, confirm).
6. Mobile: install QR and instructions, phone alerts on/off, test notification,
   signed-up phones.
7. Maintenance: release lock (shows holder and age), rotate key, restore, destroy
   infrastructure; each with a consequence-specific confirmation.

## 9. Phone (max-width 640 px)

Bottom tab bar (six icons). Each tab is one screen of status lights and big buttons;
details and forms open as slide-up sheets (`Drawer` renders as a `Sheet`).
- Overview: state word, compact topology, lights (tunnel, DNS, clients online, home
  site), the state's main action (Deploy, Extend or Resume), smaller buttons
  (Hibernate, Tear down, Speed, Move, Details); during a run a progress line with the
  current step, steps and log one tap away.
- Clients: one line per device (light, name, latency or state) opening a sheet; Add
  a client opens the wizard as a sheet with a large QR.
- Firewall: lights (applied, rules, recent drops, default), rule list opening sheets,
  draft bar pinned above the tab bar.
- Activity: last run and last note, buttons for the lists. Cost: session and month
  totals, chart and sessions in sheets. Settings: section list opening sheets.
- 641-1099 px: desktop panels stack; drawers open full height.
- Installed app: manifest, `sw.js`, push subscriptions and `/api/act` buttons are
  unchanged; notification taps open the relevant route (for example a failed run).

## 10. States and errors

Every data panel distinguishes: loading (skeleton matching its shape), empty
(what is empty, for which range, the next action), error (API message, Retry),
stale (last values greyed with their age; heartbeat older than 2 minutes), and
disconnected (API unreachable: top-bar banner, retries with backoff). A 401 shows
"Session expired, sign in again". Missing values render as "no data", never 0 or
healthy.

Mutations: submit disabled while pending; server validation shown at the field;
input kept on failure; success only after the server confirms; VM-applied changes
show "waiting for VM" until a heartbeat confirms. Toasts summarise outcomes; long
tasks keep in-page progress. No browser `alert`/`confirm` dialogs.

Refresh (TanStack Query polling): run progress and log every 5 s while a run or
power operation is in progress; overview, clients and firewall every 15 s;
activity every 30 s; cost and settings every 60 s; history on range change and
every 60 s. Polling pauses while the tab is hidden and refetches on return.

## 11. Security

- All `/api/v1` routes behind `requireAccess` and `sameOriginOnly`; mutation
  handlers keep their existing checks (run lock, typed destroy confirmation, budget
  confirmation, input validation).
- Content-Security-Policy stays strict: scripts and styles from self only; fonts
  self-hosted; no inline scripts (Vite output is external files).
- Client private keys exist only in browser memory during the add or re-key dialog.
- SSH password fetched only on press, as today.
- Local test scenarios (section 12.3) are only served when the request host is
  localhost and `AUTH_DEV_BYPASS` is set, the same guard as the login bypass, and
  are excluded from production builds.

## 12. Testing

1. API (Vitest, existing Worker harness): every endpoint's response shape; Access
   and same-origin enforcement; run lock 409; destroy confirmation; history
   recording, missing-heartbeat rows, roll-up and retention; firewall draft create,
   diff, apply (including the 409 on a stale base), discard, from-drop.
2. Components (Vitest + React Testing Library): each shared component's states;
   keyboard use; focus trapping and restoring in Modal and Drawer; command palette
   never executes destructive actions on select.
3. Screens: a local-only scenario seeder (destroyed, deploying, running with
   clients and history, failed, standby, empty) feeds `wrangler dev`. Headless
   screenshots of every view at 1600 x 900, 1100 x 700 and 390 px phone (phone via
   Chrome DevTools Protocol device emulation, since headless windows will not go
   below ~500 px), both themes. Every desktop view at 1100 x 600 and above must have
   zero page scroll (measured).
4. Live after switch-over: deploy and tear down; add a client by QR and confirm a
   handshake; firewall draft apply reaches "applied"; restore preview; test push
   notification; phone tab bar and sheets on the real phone.

## 13. Capability map (nothing may be lost)

Lifecycle: deploy (duration, profile or nearest region, over-budget confirm), move,
hibernate, resume, tear down, clean up, cancel, reconcile (check Azure), extend
timer, speed test, allow SSH from this address, SSH password reveal, Azure
inventory, notes acknowledge. Clients: add (routes, DNS, home LAN, full tunnel,
expiry), get config (re-key), toggle home LAN / Azure / tunnel DNS, expiry, enable,
delete, home-site special case, needs-new-config after key rotation, stale and
expiry markers, top talkers, traffic chart. Firewall: rules add, move, enable,
delete, default action, allow-from-drop, counters clear, published ports, packet
capture and download, zones and test VM. Activity: runs, watchman notes, change log
with filter and paging. Cost: session, month actual, budget, daily chart, sessions.
Settings: next-deploy settings, profiles, schedules, setup checklist, phone alerts
(subscribe, test, remove phone), install panel, backups (export, config by day,
restore with preview), run lock release, server key and rotation guidance.

## 14. Delivery order

1. History recorder (section 5's tables, recording, watchman roll-up, drop
   history, run steps) on `main`, deployed to the current dashboard.
2. JSON API with tests (section 4), on `redesign`; old pages untouched.
3. App foundation: Vite project, build and dev scripts, tokens and themes, fonts,
   shell, command palette, shared components, query layer, scenario seeder.
4. Views, each with its phone layout and tests: Overview, Clients, Firewall (with
   section 6's draft backend), Activity, Cost, Settings.
5. Switch-over: remove the old views, htmx, `app.js`, `app.css` and the old routes;
   deploy; run the live checklist. Rollback is `wrangler rollback` to the previous
   version; all migrations are additive, so the old version still works.

Each step ends with tests passing and, for steps 3-4, the screenshot and
zero-scroll checks. Steps 2-4 suit autonomous runs, one phase per run.

## 15. Deferred (not in this project)

Firewall rule simulator; drag-to-reorder; cost breakdown by resource type and
region comparison; SSE or WebSocket streaming; bulk client operations; per-category
alert toggles; on-demand health check (needs agent support); environment selector.
