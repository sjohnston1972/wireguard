# wg-admin widgets with settings cogs: design

Date: 2026-10-03. Status: design approved by Steven in conversation on 2026-10-03; this written spec is awaiting his review.
Builds on: `2026-10-02-observability-redesign-design.md` (the redesign, now live). Plan:
`docs/superpowers/plans/2026-10-03-widgets-plan.md`.

## 1. Intent

Every panel on Overview, Clients, Firewall, Activity and Cost becomes a **widget**: the
same panel it is today, plus a small settings cog in its top-right corner. Steven can tune
what each widget shows, how it is coloured and how much detail it has. He can also hide a
widget or reorder it within its row. His choices follow him from the PC to the phone.

Settings is excluded, because its panels are forms.

**Nothing changes until Steven changes something.** With no saved preferences, every
screen looks exactly as it does today. This is proved by a pixel diff of the screenshot
harness's shots (section 9).

## 2. Decisions (approved)

| Topic | Decision |
|---|---|
| Scope | Every panel on the five pages. Settings is excluded. |
| Cog | Opens a compact popover on desktop and a bottom sheet on the phone. Its sections are **Data**, **Thresholds** and **Display**, generated from the widget's declared settings schema. It ends with **Reset to default**. |
| Setting kinds | **Data:** time range, metric or client, units, sort, row counts, columns. **Thresholds and colours:** these change dashboard colouring only and never touch push alerts, the watchman or the cost guard. **Display:** show or hide the sparkline, ring, progress bar or sub-line; compact or detailed; wrap and timestamps. **Layout:** hide and reorder. |
| One-screen rule | Each page is a set of rows of slots. A row has a fixed height. Drag reorders a widget within its own row only. Hiding a widget lets the rest of its row widen. Desktop pages never scroll at 1600×900 or 1100×600, and `scripts/shots.mjs` enforces this. |
| Layout menu | A **Layout** menu in the page header has two items. **Show hidden widgets** lists the hidden widgets so they can be unhidden. **Reset this page** puts the page back to its defaults. |
| Keyboard | Alt+ArrowLeft and Alt+ArrowRight on a widget's move handle reorder it. The cog has **Move left** and **Move right** items. |
| Sync | Preferences are saved per signed-in user (the Access identity email) in D1, and loaded on both PC and phone. A change applies at once and saves in the background. If the save fails, the change is reverted and a toast says so. |
| Reset | **Reset to default** in the cog resets one widget. **Reset this page** in the Layout menu resets the whole page. |

## 3. Decisions made while writing this spec (Steven may change these)

1. **One D1 row per user per page**, not one row per widget (section 6.1).
2. **Server-side validation uses the exact schema module the app uses**, `shared/widgets.ts`, rather than a generic size-capped JSON blob (section 6.3).
3. **A widget keeps its width when it moves.** A row's height never changes, and its widths always add up to the same total. So reordering a row cannot change how tall the page is (section 5).
4. **Reorder happens among a row's direct items only.** A vertical stack inside a row moves as one unit. Widgets inside a stack can be hidden but not reordered. For example, Firewall's Drops / Published ports / Capture column stays in that order.
5. **Four pinned widgets cannot be hidden:** `overview.status`, `clients.table`, `firewall.rules` and `activity.list`. Pinned widgets still have a cog and can still move. They carry each page's primary actions (Deploy and Tear down; client row actions; the firewall draft) and the palette's `?action=` forms.
6. **Where the cog appears:**
   - On titled panels, the cog sits in the header, after the panel's own actions.
   - On headerless widgets (the status banner, the KPI tile rows, the Clients table and the Activity tabbed list), the cog is an overlay in the corner. It appears on hover or keyboard focus, and is always visible on touch screens (`hover: none`). Otherwise the default look would change.
7. **The phone keeps its own compositions.** Data, threshold and display settings, and hiding, apply wherever a widget's content appears on the phone. Order is desktop-only. On the phone, the Layout menu adds **Widget settings**, a list of every widget on the page, each opening its settings sheet. Widgets that the phone composition never shows can still be configured there.
8. **"Starting" settings set the initial value only.** An in-panel control, such as the Key metrics range switch or the Cost split toggle, still changes the view for the visit without saving. A URL parameter (`?tab=`, `?range=`) wins over a starting setting.
9. **A 409 is not merged.** If another device saved the page first, the local change is reverted, the other device's version is shown, and a toast says so.
10. **Preferences stay out of the backup export, the audit log and the Activity change log.** They are cosmetic and per user. The dev seeder wipes them.
11. **If preferences fail to load,** widgets render their defaults. Cogs open read-only with the message "Widget settings couldn't be loaded, so changes can't be saved right now." Nothing is ever saved on top of preferences the app could not read.
12. **The Cost page's hand-tuned short-window layout** (≤ 799 px tall, using named areas) is kept only while its rows are at their defaults. Once Steven hides or reorders a widget in those rows, a generic row layout is used instead. Both layouts must pass the one-screen check.

## 4. Widget model

```ts
// shared/widgets.ts (pure data and pure functions; no React, no Worker imports)
type PageId = "overview" | "clients" | "firewall" | "activity" | "cost";
type Section = "data" | "thresholds" | "display";
type Option = { value: string; label: string };
type SettingSpec =
  | { kind: "enum"; key: string; label: string; section: Section; options: Option[]; default: string }
  | { kind: "boolean"; key: string; label: string; section: Section; default: boolean }
  | { kind: "number"; key: string; label: string; section: Section; min: number; max: number; step: number; unit?: string; default: number }
  | { kind: "multi"; key: string; label: string; section: Section; options: Option[]; minSelected: number; default: string[] }   // order = options order
  | { kind: "threshold"; key: string; label: string; section: "thresholds"; unit: string; min: number; max: number; step: number;
      direction: "above" | "below"; default: { warn: number | null; bad: number | null } };          // null = off
interface WidgetDef { id: string; page: PageId; title: string; version: number; pinned?: boolean; settings: SettingSpec[];
  migrate?: (fromVersion: number, s: Record<string, unknown>) => Record<string, unknown> | null }
type LayoutItem = { widget: string; weight: number } | { stack: string; weight: number; widgets: string[] };
interface PageLayout { page: PageId; rows: { id: string; items: LayoutItem[] }[] }
```

- **Ids** are stable and written `page.camelCase` (catalogue below). They are never reused. Renaming one means bumping its version and adding a migration.
- **Defaults reproduce today's behaviour exactly.** Each default is the constant the view hard-codes today, and the catalogue states it.
- **Threshold `direction`:**
  - `above`: amber at or over `warn`, red at or over `bad`.
  - `below`: amber under `warn`, red under `bad`.
  - When both are set, `warn` must come before `bad` in that direction.
  - Threshold colours still pair with a word or icon, as spec 2026-10-02 §7 requires.
- **Schema version.** `version` starts at 1. Every saved entry is `{ v, s }`.
  - `normalisePagePrefs` (lenient, used on every read on both server and app) handles an entry whose `v` is not the current version. If a `migrate` exists for an older `v`, it runs. Otherwise the entry is dropped, so that widget shows its defaults.
  - Unknown keys and invalid values are dropped one by one.
  - Unknown widget ids are dropped from `order` and `hidden`.
  - New widgets missing from a stored `order` are inserted at their declared index.
  - Pinned widgets are removed from `hidden`.
- **Validation.** `validatePagePrefs` is strict and used on every write. It refuses anything `normalisePagePrefs` would have to repair (section 6.3).

## 5. Layout, reorder and hide

- **Rows.** A page is its header plus `rows`. Each row is a CSS grid whose columns are the `weight`s of its visible items (today's `fr` or column spans). Row heights come from the view's own CSS and do not change.
- **Hiding.** A hidden widget is not rendered.
  - **In a row:** its weight is dropped and the others widen in proportion.
  - **In a stack:** the stack's other widgets share the height.
  - **A stack with nothing visible** is removed from its row.
  - **A row with nothing visible** is not rendered, and the page's flexible rows take the space.
- **Reorder.** Only a row's direct items (widgets or stacks) can be reordered, and only within that row. The stored order is a permutation of the row's item keys.
  - **Mouse:** a grip handle appears at the left of the header on hover or focus (an overlay, so no layout shift). Native drag and drop uses its own data type, `application/x-wg-widget`. Drops that do not carry that type are ignored, so the firewall rules table's own drag (`text/plain`, handle-only) cannot trigger it.
  - **Keyboard:** the handle is a button, "Move ‹title›". Alt+ArrowLeft and Alt+ArrowRight move the widget one place and keep focus. A live region announces "‹title› moved to position 2 of 3".
  - **Cog menu:** the cog has Move left and Move right, disabled at the ends. Neither the handle nor these items exist for a row's only item or for widgets inside a stack.
- **Responsive folds keep working, and follow the user's order minus hidden widgets.** These are:
  - Firewall `NARROW` (< 1400 px): Drops, Ports and Capture become tabs.
  - Firewall `SHORT` (≤ 760 px tall): Zones and Simulator join those tabs.
  - Activity ≤ 720 px tall: the bottom row is dropped.
  - 641–1099 px: the page stacks and may scroll, in the user's row order.
- **Overview during a GitHub run.** The run widget widens over the traffic widget's slot, and Network traffic takes Speed test's place in the side stack (today's arrangement). Hidden widgets stay hidden. The run widget and the side stack keep the user's order.
- **Layout menu** (Radix `DropdownMenu`, in `PageHeader` `right`, labelled "Layout"):
  - **Show hidden widgets:** a sub-list of hidden widgets, each with Show. If nothing is hidden it reads "No hidden widgets".
  - **Reset this page:** opens a `Modal` asking "Reset ‹Page› to its default layout and settings?" with Reset and Cancel. Never `confirm()`.
  - **Widget settings:** phone only (section 3.7).

## 6. Storage and API

### 6.1 Migration `worker/migrations/0018_ui_prefs.sql`

0018 is the next number after the latest, `0017_run_live_log_pruned.sql`. If `main` gains a 0018 first, renumber.

```sql
CREATE TABLE IF NOT EXISTS ui_prefs (
  user       TEXT    NOT NULL,          -- Access identity email, lower case (c.get("user"))
  page       TEXT    NOT NULL CHECK (page IN ('overview','clients','firewall','activity','cost')),
  json       TEXT    NOT NULL,          -- normalised PagePrefs, sparse (only values that differ from defaults), <= 8 KB
  version    INTEGER NOT NULL,          -- revision for optimistic concurrency: 1 on first save, +1 on every save
  updated_at TEXT    NOT NULL,          -- ISO, UTC
  PRIMARY KEY (user, page)
) WITHOUT ROWID;
```

**Why one row per page, not one per widget:**
- Reorder and hide change several widgets at once, and must land together.
- "Reset this page" is a single write.
- Conflicts are detected per page, which suits one user on two devices.
- There are at most five rows per user.

Per-widget rows would need a separate layout row and multi-row transactions with a version for each, for no gain.

A reset writes `{}` and keeps the row, so `version` only ever rises. A stale tab can never match a recreated row.

### 6.2 Contract (`shared/api.ts`)

```ts
type SettingValue = string | number | boolean | string[] | { warn: number | null; bad: number | null };
interface PagePrefs {
  layout?: { order?: Record<string, string[]>;   // row id -> item keys (widget id or stack id)
             hidden?: string[] };                 // widget ids
  widgets?: Record<string, { v: number; s: Record<string, SettingValue> }>;
}
interface PrefsPage { version: number; updatedAt: string | null; prefs: PagePrefs }   // version 0 = never saved
interface PrefsResponse { pages: Record<PageId, PrefsPage> }
interface PrefsPutBody { baseVersion: number; prefs: PagePrefs }
```

| Route | Behaviour |
|---|---|
| `GET /api/v1/prefs` | Returns all five pages for the signed-in user, each normalised against the current schemas. A page never saved is `{version: 0, updatedAt: null, prefs: {}}`. |
| `PUT /api/v1/prefs/:page` | Body `PrefsPutBody`. Validates strictly (6.3), strips values equal to defaults, and stores the result. Answers `PrefsPage` with the new version. Reset widget means PUT without that widget's entry. Reset page means PUT `{}`. |

- **Errors** use the house shape (`fail`, `body`, `statusFor` in `worker/src/api/app.ts`):
  - **400:** a validation error, with `field` as a path such as `widgets.overview.keyMetrics.range` or `layout.order.r3`.
  - **404:** `"No such page."`
  - **409 `stale`:** `"Changed on another device. Showing the latest."` when `baseVersion` is not the stored version.
  - **409 `outdated`:** `"This tab is running an older dashboard. Reload to change widget settings."` when an entry's `v` is not the current schema version.
- **Concurrency is atomic:**
  - When `baseVersion = 0`: `INSERT OR IGNORE`, then 409 if no row changed.
  - Otherwise: `UPDATE … SET json, version = version + 1, updated_at WHERE user = ? AND page = ? AND version = ?base`, then 409 if no row changed.
- **Identity:** the user is always `c.get("user")`, set by `requireAccess` (`dev@localhost` under the local bypass). No route takes a user parameter, so nobody can read or write another identity's preferences. The routes sit behind `requireAccess` and `sameOriginOnly`, like every other `/api/v1` route.

### 6.3 Validation: one schema, both sides

The Worker validates against the **same `shared/widgets.ts`** the app renders from (`worker/src/prefs.ts` imports it as `shared/api.ts` is imported today). So the two can never drift, and refusals name the exact field.

A generic bounded-JSON check was rejected. It cannot stop values that are valid JSON but wrong, such as `rows: 1e9`, an enum that does not exist, or a column list containing a column the widget lacks. A widget would then have to defend itself against all of those at render time.

**Refused (400, with the field):**
- a body over **16 KiB**, checked on the raw text before parsing
- a normalised page over **8 KiB**
- a widget id not on that page
- an unknown setting key
- the wrong type
- an enum value that is not among the options
- a number that is not finite, is out of `min`–`max`, or is off `step`
- a multi-select with unknown or duplicate values, or fewer than `minSelected`
- thresholds out of range or in the wrong order
- an `order` that is not a permutation of its row
- a pinned widget in `hidden`
- unknown top-level keys

Option lists that mirror Worker constants are copied into `shared/widgets.ts`, so the app bundle never imports Worker modules. These are the change kinds (`AUDIT_KINDS`), the capture interfaces (`CAPTURE_IFACES`) and the event types. A Worker test proves the copies match.

## 7. App framework (`web/src/widgets/`)

- **`usePrefs()`:** a TanStack query of `["prefs"]`, started with the shell.
  - It sets `staleTime` 30 s and refetches on window focus. That is how the phone picks up a PC change.
  - It mirrors the last good response to `localStorage` (`wg.prefs.v1`, every access in try/catch) as `placeholderData`, so a reload doesn't flash defaults.
- **`useWidget(id)`:** returns `{ settings, set(key, value), reset(), hidden, hide(), move(dir), canMove }`.
  - `settings` is the widget's defaults overlaid with saved values.
  - `set` applies to the cache at once and saves after a quiet period.
- **Saving:** one queue per page.
  - The queue waits 600 ms for further changes, so typing a number doesn't send a request per keystroke.
  - Only one save per page is in flight at a time.
  - Changes made during a save are sent after it, with the new version.
  - A save is also flushed when the tab is hidden.
  - On failure, the page reverts to its last confirmed state and an error toast says "Couldn't save your ‹Page› widgets: ‹message›. Put back as it was."
  - On a 409 `stale`, the app refetches and the toast says "Changed on another device. Showing the latest."
  - A successful save shows no toast.
- **`<Widget id>`:** the frame. It wraps the existing `Panel`, or a headerless block, and adds the cog and the move handle as `data-widget-chrome` elements. It renders nothing when the widget is hidden. With the chrome hidden, its markup is today's markup.
- **`<WidgetCog>`:** a Radix `Popover` on desktop and a `Sheet` on the phone (`useIsPhone()`).
  - **Title:** "‹Title› settings".
  - **Sections:** Data, Thresholds and Display, each shown only if it has settings.
  - **Footer:** Move left / Move right, Hide widget (absent when pinned), and Reset to default (disabled when nothing differs).
  - **Applying:** changes apply live, with no Save button.
  - **Numbers:** commit on blur or Enter. An invalid entry shows its message at the field and is not saved.
- **`<SettingsForm>`:** generated from `SettingSpec`, using existing form components:
  - enum: `Select` (`SegmentedControl` when there are 4 options or fewer)
  - boolean: `Switch`
  - number: `Field` with the unit
  - multi: `Chips`, with at least `minSelected` kept on
  - threshold: two number fields, Warn and Bad, each with an Off switch, plus a one-line hint: "Colours this dashboard only. Alerts are unchanged."
- **`<WidgetRow row>`, `<WidgetStack>`, `<LayoutMenu page>`:** the row and stack render the layout (section 5); `LayoutMenu` is the header menu.
- **Shared component changes**, all with defaults that keep today's output:
  - `DataTable`: `density?: "comfortable" | "compact"`.
  - `LogView`: `wrap?`, `timestamps?`, `levelTags?`.

## 8. Widget catalogue (37 widgets)

**How to read the table:**
- **Settings** are written `Section: Name (type, options or range) = default`. Every default is today's behaviour.
- Every widget also has **Layout: Hide** (unless pinned) and **Move** (where its row allows) in the cog footer. These are not repeated below.
- "Starting …" settings set the initial value of an in-panel control (§3.8).
- **Thresholds** colour this dashboard only.

### Overview (10): rows R1 [status] · R2 [topology 1, keyMetrics 1] · R3 [run 41, traffic 45, stack(events, speedTest) 32] · R4 [health 54, costImpact 32, notes 32]

| Widget id | Title | Settings | Thresholds |
|---|---|---|---|
| `overview.status` (pinned) | Status banner (headerless) | Display: Step progress bar (bool) = on; Timing block (bool) = on; Auto-destroy time (bool) = on | none (state colours are server facts) |
| `overview.topology` | Live topology | Display: Second lines: addresses, region (bool) = on; Edge labels: UDP port (bool) = on | none (node health is derived by the server) |
| `overview.keyMetrics` | Key metrics | Data: Starting range (enum Live, 1h, 24h, 7d, 30d) = Live; Tiles (multi: Public endpoint, Connected clients, Latency, DNS status, Heartbeat, Session cost, Availability; min 1) = all 7. Display: Sparkline / progress / ring (bool) = on; Sub-lines (bool) = on | Availability (below, %, 0–100 step 0.1) warn 99 / bad 90 = today's ring cutoffs; DNS up (below, %) warn 100 / bad off = today's "Up N%" amber; Latency avg (above, ms, 1–1000) warn off / bad off |
| `overview.run` | Last run · during a run: Deployment pipeline + Live logs | Data: Starting step filter (enum All, In progress, Completed, Pending) = All; Starting log level (enum All, Warnings and errors, Errors only) = All. Display: Log timestamps (bool) = on | none |
| `overview.traffic` | Network traffic | Data: Starting window (enum 5m, 15m, 1h, Session, 24h, 7d) = Session (24h and 7d read VM history `rx_rate`/`tx_rate`); Units (enum KB/s, Mbit/s) = KB/s; Series (multi In, Out; min 1) = both. Display: Peak line, 24h/7d only, from `rx_rate_max`/`tx_rate_max` (bool) = off | none |
| `overview.events` | Recent events | Data: Rows (number 3–10 step 1) = 5; Range (enum 1h, 6h, 24h, 7d) = 24h; Types (multi deploy, destroy, failure, config, firewall, watchman; min 1) = all. Display: Detail line (bool) = on | none |
| `overview.speedTest` | Speed test | Data: Results shown (number 1–5) = 3. Display: Jitter (`jitter_ms`) (bool) = off; Test server (`target_name`) (bool) = off | none |
| `overview.health` | Health summary | Data: Checks (multi VM reachable, WireGuard service, DNS resolving, Tunnel connectivity, Self-test; min 1) = all 5. Display: Check ages (bool) = on | none |
| `overview.costImpact` | Cost impact | Data: Sessions in chart (number 4–30) = 16. Display: Typical session line (bool) = on | Session estimate (above, £, 0–500 step 0.01: sessions cost pennies) warn off / bad off |
| `overview.notes` | Watchman notes | Data: Show at most (enum All, 3, 5, 10) = All. Display: Times (bool) = on | none |

### Clients (5): R1 [kpis] · R2 [table] · R3 [talkers 1, statusDonut 1, sessionTraffic 1]. The client side panel is a drawer, not a widget.

| Widget id | Title | Settings | Thresholds |
|---|---|---|---|
| `clients.kpis` | Client figures (headerless tile row) | Data: Tiles (multi Total clients, Online now, Average latency, Full-tunnel clients, Stale handshakes, Expiring soon; min 1) = all 6. Display: Sub-lines (bool) = on; Online ring (bool) = on | Average latency (above, ms, 1–1000) warn off / bad off |
| `clients.table` (pinned) | Clients (headerless) | Data: Starting filter (enum All, Online, Offline, Expiring, Home site, Full tunnel) = All; Starting sort (enum Name A→Z, Name Z→A, Address, Last handshake newest, Latency lowest, Session traffic most, Expires soonest) = Name A→Z; Columns (multi Address, Last handshake, Latency, Session traffic, Allowed IPs, Expires, IPv6 address, Created, Note; min 0) = the first six (Name, Status and the menu are always shown; the width-based hiding stays). Display: Latency sparkline (bool) = on; Density (enum Comfortable 34 px, Compact 28 px) = Comfortable | Latency cell (above, ms) warn off / bad off |
| `clients.talkers` | Top talkers (this session) | Data: Rows (number 3–10) = 5; Measure (enum Total, Sent by client: `up+bu`, Received by client: `down+bd`) = Total | none |
| `clients.statusDonut` | Client status | Display: Extra legend lines (multi Expiring ≤ 7 days, Full-tunnel clients; min 0) = both; Percentages in legend (bool) = on | none |
| `clients.sessionTraffic` | Traffic this session (title follows range) | Data: Range (enum Session, 1h, 24h, 7d, 30d) = Session (other ranges read VM history `rx_rate`/`tx_rate`); Units (enum bytes/s auto, Mbit/s) = bytes/s auto; Series (multi Inbound, Outbound; min 1) = both | none |

### Firewall (7): R1 [kpis] · R2 [stack(rules, zones+simulator sub-row) 9, stack(drops, ports, capture) 3]. Zones and simulator form a row nested in the left stack, so they can swap with each other.

| Widget id | Title | Settings | Thresholds |
|---|---|---|---|
| `firewall.kpis` | Firewall figures (headerless tile row) | Data: Tiles (multi Policy set, Default action, Recent drops, Published ports, Packet capture; min 1) = all 5. Display: Drops sparkline (bool) = on; Change vs previous 24h (bool) = on; Sub-lines (bool) = on | Recent drops 24h (above, count, 1–100000) warn off / bad off |
| `firewall.rules` (pinned) | Firewall rules | Data: Starting tab (enum All rules, Custom, Default, Disabled) = All rules; Columns (multi Service / Port, Hits (24h), Last hit, Lifetime hits; min 0) = Service / Port + Hits (24h) (handle, #, Name, From, To, Action, Status and the menu are always shown). Display: Hits sparkline (bool) = on; Density (enum Comfortable 46 px, Compact 36 px) = Comfortable | none |
| `firewall.zones` | Network zones | Display: Zone addresses (bool) = on; Rule counts (bool) = on; Flow arrows (bool) = on | none |
| `firewall.simulator` | Test specific traffic | Data: Starting From zone (enum Clients, Home, Azure, Workloads, Internet) = Clients; Starting To zone (same) = Home; Starting protocol (enum TCP, UDP, ICMP) = TCP; Starting port (number 1–65535) = 22 | none |
| `firewall.drops` | Recent drops | Data: Show at most (enum All, 10, 25, 50) = All. Display: Times in (enum UK time, UTC) = UK time; Zone chip (bool) = on; Allow button (bool) = on | none |
| `firewall.ports` | Published ports | Display: Turned-off ports (bool) = on; Connections and last hit (`connections`, `lastHit`) (bool) = off | none |
| `firewall.capture` | Packet capture | Data: Starting interface (enum from `CAPTURE_IFACES`: wg0, eth0, any) = wg0; Starting seconds (number 5–300 step 5, the server's clamp) = 30; Recent captures shown (number 1–10, the server keeps 10) = 5 | none |

### Activity (7): R1 [kpis] · R2 [stack(timeline, list) 8, stack(stream, changeLog) 4] · R3 [runDetails 3, liveOutput 2] (not rendered at ≤ 720 px tall, as today)

| Widget id | Title | Settings | Thresholds |
|---|---|---|---|
| `activity.kpis` | Activity figures (headerless tile row) | Data: Tiles (multi Deploys, Median deploy duration, Success rate, Failed runs, Config changes, Watchman problems; min 1) = all 6. Display: Change vs previous period (bool) = on; Sub-lines (bool) = on | Success rate (below, %) warn 90 / bad 70 = today; Failed runs (above, count, 1–1000) warn off / bad 1 = today; Watchman problems (above, count) warn 1 / bad off = today |
| `activity.timeline` | Activity timeline | Data: Series (multi deploy, destroy, failure, config, firewall, watchman; min 1) = all 6. Display: Legend (bool) = on | none |
| `activity.list` (pinned) | Runs / All activity / Config changes / Watchman notes (headerless tabs) | Data: Starting tab (enum Runs, All activity, Config changes, Watchman notes) = Runs (the URL's `tab` wins); Runs columns (multi Duration, Cost impact, Actor, Source, Notes, Public IP; min 0) = the first five (When, Action, Result and the chevron are always shown). Display: Density (enum Comfortable 30 px, Compact 26 px) = Comfortable | none |
| `activity.stream` | Live event stream | Data: Starting event type (enum All + the 6 types) = All. Display: Auto-scroll at start (bool) = on; Detail line (bool) = on; Time format (enum HH:MM:SS, relative) = HH:MM:SS | none |
| `activity.changeLog` | Change log | Data: Starting change kind (enum All + the `AUDIT_KINDS`) = All. Display: What changed column (bool) = on; By column (bool) = on | none |
| `activity.runDetails` | Run details | Data: Run shown on /activity (enum Newest run, Newest failed run) = Newest run (`/activity/runs/:id` always shows that run). Display: Step durations (bool) = on; Step name lines (enum 1, 2) = 2 | none |
| `activity.liveOutput` | Live output | Data: Lines (number 20–200 step 20) = 60. Display: Wrap long lines (bool) = off; Timestamps (bool) = on; Level tags (bool) = on | none |

### Cost (8): R1 [kpis] · R2 [spend 5, breakdown 4, forecast 3] · R3 [split 4, perSession 4, insights 4] · R4 [sessions]

| Widget id | Title | Settings | Thresholds |
|---|---|---|---|
| `cost.kpis` | Cost figures (headerless tile row) | Data: Tiles (multi This session, Month to date, Estimated this month, Monthly budget, Cost guard; min 1) = all 5. Display: Change vs previous (bool) = on; Budget progress bar (bool) = on | Budget used (above, % of budget, 1–200) warn 80 / bad 100 = the server's levels today. These colour the tile only; the Cost guard tile, the cost guard, watchman and push alerts keep using the server's settings |
| `cost.spend` | Spend over time | Data: Forecast bars (bool) = on; Daily budget line (bool) = on; Previous period line at start (bool) = off (the header's Compare switch still toggles it). Display: Note line (bool) = on; Legend (bool) = on | none |
| `cost.breakdown` | Spend breakdown | Data: Group by (enum Auto: resource type when Azure actuals exist, otherwise region; Region) = Auto. Display: Percentages in legend (bool) = on (the legend's share column, as today; off hides the column). Version 2: version 1's off-by-default switch added a second share beside each amount, so a v1 entry keeps Group by and drops Percentages | none |
| `cost.forecast` | Forecast vs budget | Display: Month-so-far chart (bool) = on | Forecast vs budget (above, % of budget, 1–200) warn off / bad 100 = today's "Over budget" pill |
| `cost.split` | Spend by region / resource type | Data: Starting view (enum Region, Resource type) = Region; Order (enum As Azure lists them, Largest first) = As listed. Display: Track bars (bool) = on; Percent column (bool) = on | none |
| `cost.perSession` | Cost per session | Data: Sessions shown (enum All, last 10, last 20, last 50) = All | Session cost (above, £, 0–500 step 0.01: sessions cost pennies) warn off / bad off (colours bars) |
| `cost.insights` | Insights | none (cog holds only Layout and Reset) | none |
| `cost.sessions` | Sessions | Data: Starting status (enum All, Running, Ended) = All; Starting sort (enum Started newest, Estimated cost highest, Duration longest) = Started newest; Columns (multi Region, VM size, Duration, Estimated cost, Cost / hour, Ended; min 0) = the first five (Started, Status and the chevron are always shown; the short-window hiding stays). Display: Density (enum Comfortable 32 px, Compact 26 px) = Comfortable | none |

**Count:** 37 widgets (Overview 10, Clients 5, Firewall 7, Activity 7, Cost 8), 4 of them pinned.

**Notes on the data:**
- Every setting reads a field the API already returns, or a query param the API already accepts. These include history `1h|24h|7d|30d`, activity `1h|6h|24h|7d|30d` and VM points' `rx_rate`, `tx_rate` and their `_max`.
- Where a field is new to the screen, it is named in the table.
- No Worker read endpoint changes.

## 9. Testing

1. **Worker (Vitest harness):**
   - migration 0018 applies
   - GET for a new user gives five empty pages at version 0
   - PUT then GET round-trips, normalised and sparse
   - every refusal in 6.3 is a 400 that names its field
   - stale `baseVersion` gives a 409 and changes nothing
   - an old schema `v` gives a 409 `outdated`
   - preferences are per user
   - saving preferences writes only `ui_prefs` (the `settings`, `alerts` and `audit` row counts are unchanged)
   - the copied option lists match `AUDIT_KINDS` and `CAPTURE_IFACES`
2. **Shared module:**
   - normalise drops unknown keys, invalid values, stale versions without a migration, and unknown ids
   - normalise runs a migration
   - every catalogue default validates
   - every default equals the constant the view used before (each area's tests assert this for its page)
3. **App (Vitest + RTL):**
   - cog popover and sheet
   - form generation for every setting kind
   - optimistic apply, then revert with a toast on a 500, a network failure or a 409
   - save coalescing
   - Alt+Arrow reorder with focus kept and an announcement
   - hide and unhide through the Layout menu
   - Reset this page through the Modal
   - read-only cogs when preferences failed to load
   - each page: every setting changes what renders
4. **Screens (`scripts/shots.mjs`):**
   - **New options:**
     - `--freeze-time` pins the browser clock to the seeded `now`.
     - `--widget-chrome off` hides `[data-widget-chrome]` with `display: none`.
     - `--prefs FILE[,FILE]` PUTs preferences for `dev@localhost` before shooting.
   - **New script:** `npm run shots:diff -- A B` uses a dependency-free PNG decoder in `scripts/lib/pngdiff.mjs` and exits 1 on any differing pixel.
   - **Gate checks:**
     - **Pixel-identical defaults:** shots with no prefs, `--freeze-time` and `--widget-chrome off` are pixel-identical to the baseline taken before any widget code, for every scenario, all sizes, both themes.
     - **One screen with prefs:** shots with each page's prefs fixtures (hidden widgets, reversed rows, everything optional hidden) exit 0 at 1600×900 and 1100×600, dark and light.
