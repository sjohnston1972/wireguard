# Widgets with settings cogs: implementation plan

## W0 names as built

W0 is on branch `feat/widgets-w0` (the plan's `feat/widgets-contract`); areas branch from its last commit. Pixel baseline tag: `widgets-baseline`. Everything below is the whole public surface; anything else in `web/src/widgets/` is internal.

**`@shared/widgets`** (pure; app and Worker)
- Types: `PageId`, `Section`, `Option`, `Threshold` (`{warn, bad}`, null = off), `SettingSpec`, `WidgetDef`, `LayoutItem`, `LayoutRow` (`in?`: the stack a nested row sits in), `PageLayout`, `Registry`, `PrefsProblem` (`{field, message, outdated?}`).
- Data: `WIDGETS` (37), `LAYOUTS`, `REGISTRY`, `PAGE_IDS`, `PAGE_TITLES`, `SECTIONS`, `SECTION_TITLES`, `EVENT_TYPES`, `AUDIT_KIND_OPTIONS` ("all" stands for AUDIT_KINDS' ""), `CAPTURE_IFACE_OPTIONS`, `MAX_PREFS_BODY_BYTES` (16 KiB), `MAX_PAGE_PREFS_BYTES` (8 KiB).
- Functions: `widgetDef(id)`, `pageWidgets(page)`, `widgetDefaults(id)`, `itemKey(item)`, `rowItemKeys(page, row)`, `thresholdTone(value, threshold, direction)` → `"ok" | "warn" | "bad" | null` (null = no data), `settingProblem(spec, value)` → message or null, `normalisePagePrefs(page, raw)` (lenient, sparse), `validatePagePrefs(page, prefs)` → `PrefsProblem | null`.
- Row and stack ids: Overview `r1 [status]`, `r2 [topology, keyMetrics]`, `r3 [run, traffic, side(events, speedTest)]`, `r4 [health, costImpact, notes]`. Clients `r1 [kpis]`, `r2 [table]`, `r3 [talkers, statusDonut, sessionTraffic]`. Firewall `r1 [kpis]`, `r2 [left(rules, bottom), right(drops, ports, capture)]`, nested row `bottom` (in `left`) `[zones, simulator]`. Activity `r1 [kpis]`, `r2 [left(timeline, list), right(stream, changeLog)]`, `r3 [runDetails, liveOutput]`. Cost `r1 [kpis]`, `r2 [spend, breakdown, forecast]`, `r3 [split, perSession, insights]`, `r4 [sessions]`. Weights as spec §8.

**`@shared/api`**: `SettingValue`, `PagePrefs` (`{layout?: {order?, hidden?}, widgets?: {[id]: {v, s}}}`), `PrefsPage` (`{version, updatedAt, prefs}`, version 0 = never saved), `PrefsResponse` (`{pages}`), `PrefsPutBody` (`{baseVersion, prefs}`).

**`@/widgets`** (app)
- `<Widget id headerless?>`: wraps a widget's content; renders null when hidden. The outermost `Panel` inside draws the chrome: handle at the left of its header, cog after its `actions`; a Panel with no header (or `headerless`) gets a corner overlay. A block that is not a Panel puts `<WidgetCorner />` inside its root element (which becomes `position: relative`). A second Panel of the same widget takes `widgetChrome={false}`. Every chrome element has `data-widget-chrome`.
- `useWidget(id)` → `{def, settings, set(key, value) → boolean, reset(), differs, hidden, hide(), show(), readOnly, status, canMove: {movable, left, right, row, index, count}, move("left" | "right") → boolean}`. `settings` = defaults overlaid with saved values: read `settings.rows` etc., never `undefined`. `set` refuses (false) an invalid value or while read-only.
- `<WidgetRow page row {...divProps}>{{[itemKey]: node}}</WidgetRow>`: the row's div with its visible items in the user's order; `style.gridTemplateColumns` is set only once the row differs from default (keep the view's class for today's columns); renders null when nothing is visible. `<WidgetStack page stack {...divProps}>{{[memberId]: node}}</WidgetStack>`: visible members in declared order, null when none.
- `useRowItems(page, row)` → `{id, items: [{key, kind: "widget" | "stack", weight, members}], template, isDefault, visible}` for views that keep their own markup.
- `<LayoutMenu page />` in `PageHeader` `right`: Show hidden widgets, Reset this page (Modal), and on the phone Widget settings (every widget of the page).
- `usePrefsStatus()` → `"loading" | "ready" | "failed"`; `usePagePrefs(page)` → `{prefs, status}`; `usePrefs()` (already called by `AppShell`); `thresholdTone`; `WidgetCog`, `WidgetSettings`, `SettingsForm`, `THRESHOLD_HINT`, `SAVE_DELAY_MS` (600), `PREFS_MIRROR_KEY` (`wg.prefs.v1`), `WIDGET_DRAG_TYPE` (`application/x-wg-widget`).
- Reorder: the handle (desktop only, only for a row's direct items when 2+ are visible) drags onto another widget of the same row, or Alt+Left/Right on it (focus kept, position announced); the cog has Move left / Move right. Hide: cog "Hide widget" (not on pinned); unhide from the Layout menu.

**`@/components`**: `DataTable` `density?: "comfortable" | "compact"` (adds `dt--compact`; set your page's compact row height on it); `LogView` `wrap?` (false), `timestamps?` (true), `levelTags?` (true); `Panel` `widgetChrome?`; `PanelChromeContext`.

**Test helpers** (`@/test/...`): `prefsFixture(pages, version = 1)` (a GET answer); `prefsServer(initial)` → `{routes, state, puts}`, a working fake of GET and PUT for all pages (409 stale, 400/409 outdated as the Worker); `renderWithProviders(ui, {routes?, url?})`; `mockFetch` answers `GET /api/v1/prefs` with nothing saved unless a test routes it; waiting saves are dropped after each test. In a whole-app test: `renderApp(url, { routes: prefsServer({cost: {...}}).routes })`.

**API**: `GET /api/v1/prefs` → 200 `PrefsResponse`. `PUT /api/v1/prefs/:page` `{baseVersion, prefs}` → 200 `PrefsPage`; 400 `bad_input` with `field` (validation, unknown body field, body over 16 KiB before parsing, stored page over 8 KiB); 404 `not_found` "No such page."; 409 `stale`; 409 `outdated`; 403 `cross_site` without same-origin. Migration `worker/migrations/0018_ui_prefs.sql` (deploy needs `npm run migrate` first).

**Screens**: `npm run shots -- --scenario S --freeze-time --widget-chrome off [--prefs a.json,b.json] [--base URL --api URL]`; `--freeze-time` seeds at 2026-10-02T14:00Z (or `--now`) and stops the dev Worker's clock and the browser's there (the run fails if the Worker reloads mid-run: do not edit `worker/` or `shared/` while shooting). A `--prefs` file is `{"<page>": PagePrefs}`. `npm run shots:diff -- A B` exits 1 on any differing pixel. Baseline (in a copy of the tag, short path to keep wrangler's state under Windows' 260-character limit): `git archive widgets-baseline` unpacked into `.superpowers/shots/b`, `cp .env.example .env`, `npm ci`, `npm run build:web`, `PORT=8798 node scripts/dev.mjs --api` (a free port per worktree; stop it by its own PID), then for each scenario `node scripts/shots.mjs --scenario S --freeze-time --base http://localhost:8798 --api http://localhost:8798 --out ../widgets-baseline/S`. New shots the same way from your worktree after `npm run build:web` (the Worker serves `web/dist`), adding `--widget-chrome off`. (The built app has no `/__gallery`, so its shots never differ; W0's widget demo there is seen with `npm run dev:web`.)

**Setting keys** (values in brackets; `=` the default):

| Widget | Title | Settings |
|---|---|---|
| `overview.status` (pinned) | Status banner | progress = true; timing = true; autoDestroy = true |
| `overview.topology` | Live topology | secondLines = true; edgeLabels = true |
| `overview.keyMetrics` | Key metrics | range (live/1h/24h/7d/30d) = live; tiles [endpoint,clients,latency,dns,heartbeat,sessionCost,availability] min 1 = all; charts = true; subLines = true; availability (threshold below, 0–100 step 0.1) = 99/90; dnsUp (below, 0–100 step 0.1) = 100/off; latency (above, 1–1000) = off/off |
| `overview.run` | Last run | stepFilter (all/running/done/pending) = all; logLevel (all/warn/error) = all; logTimestamps = true |
| `overview.traffic` | Network traffic | window (5m/15m/1h/session/24h/7d) = session; units (kBps/mbps) = kBps; series [in,out] min 1 = all; peak = false |
| `overview.events` | Recent events | rows (3–10) = 5; range (1h/6h/24h/7d) = 24h; types [deploy,destroy,failure,config,firewall,watchman] min 1 = all; detail = true |
| `overview.speedTest` | Speed test | shown (1–5) = 3; jitter = false; server = false |
| `overview.health` | Health summary | checks [vm,wireguard,dns,tunnel,selftest] min 1 = all; ages = true |
| `overview.costImpact` | Cost impact | sessions (4–30) = 16; typical = true; session (above, 0–500 step 0.01) = off/off |
| `overview.notes` | Watchman notes | max (all/3/5/10) = all; times = true |
| `clients.kpis` | Client figures | tiles [total,online,latency,fullTunnel,stale,expiring] min 1 = all; subLines = true; onlineRing = true; latency (above, 1–1000) = off/off |
| `clients.table` (pinned) | Clients | filter (all/online/offline/expiring/home/fullTunnel) = all; sort (nameAsc/nameDesc/address/handshake/latency/traffic/expires) = nameAsc; columns [address,handshake,latency,traffic,allowedIps,expires,ipv6,created,note] min 0 = first six; sparkline = true; density (comfortable/compact) = comfortable; latency (above, 1–1000) = off/off |
| `clients.talkers` | Top talkers | rows (3–10) = 5; measure (total/sent/received) = total |
| `clients.statusDonut` | Client status | extras [expiring,fullTunnel] min 0 = all; percentages = true |
| `clients.sessionTraffic` | Traffic this session | range (session/1h/24h/7d/30d) = session; units (auto/mbps) = auto; series [in,out] min 1 = all |
| `firewall.kpis` | Firewall figures | tiles [policy,default,drops,ports,capture] min 1 = all; sparkline = true; deltas = true; subLines = true; drops (above, 1–100000) = off/off |
| `firewall.rules` (pinned) | Firewall rules | tab (all/custom/default/disabled) = all; columns [service,hits,lastHit,lifetime] min 0 = [service,hits]; sparkline = true; density = comfortable |
| `firewall.zones` | Network zones | addresses = true; ruleCounts = true; arrows = true |
| `firewall.simulator` | Test specific traffic | from, to (clients/home/azure/workloads/internet) = clients, home; proto (tcp/udp/icmp) = tcp; port (1–65535) = 22 |
| `firewall.drops` | Recent drops | max (all/10/25/50) = all; timeZone (uk/utc) = uk; zoneChip = true; allowButton = true |
| `firewall.ports` | Published ports | showOff = true; connections = false |
| `firewall.capture` | Packet capture | iface (wg0/eth0/any) = wg0; seconds (5–300 step 5) = 30; recent (1–10) = 5 |
| `activity.kpis` | Activity figures | tiles [deploys,duration,success,failed,config,watchman] min 1 = all; deltas = true; subLines = true; successRate (below, 0–100 step 0.1) = 90/70; failedRuns (above, 1–1000) = off/1; watchman (above, 1–1000) = 1/off |
| `activity.timeline` | Activity timeline | series [deploy,destroy,failure,config,firewall,watchman] min 1 = all; legend = true |
| `activity.list` (pinned) | Runs and activity | tab (runs/all/changes/notes) = runs; runColumns [duration,cost,actor,source,notes,publicIp] min 0 = first five; density = comfortable |
| `activity.stream` | Live event stream | type (all + the six event types) = all; autoScroll = true; detail = true; timeFormat (clock/relative) = clock |
| `activity.changeLog` | Change log | kind (all/client/firewall/settings/profile/schedule/push/capture/lock/config) = all; whatChanged = true; by = true |
| `activity.runDetails` | Run details | run (newest/newestFailed) = newest; durations = true; nameLines (1/2) = 2 |
| `activity.liveOutput` | Live output | lines (20–200 step 20) = 60; wrap = false; timestamps = true; levelTags = true |
| `cost.kpis` | Cost figures | tiles [session,month,estimate,budget,guard] min 1 = all; deltas = true; budgetBar = true; budgetUsed (above, 1–200) = 80/100 |
| `cost.spend` | Spend over time | forecast = true; budgetLine = true; previous = false; note = true; legend = true |
| `cost.breakdown` | Spend breakdown | groupBy (auto/region) = auto; percentages = true (the legend's share column; off hides it). **Version 2** (v1 entries keep groupBy, drop percentages) |
| `cost.forecast` | Forecast vs budget | chart = true; forecast (above, 1–200) = off/100 |
| `cost.split` | Spend by region | view (region/resource) = region; order (listed/largest) = listed; tracks = true; percent = true |
| `cost.perSession` | Cost per session | shown (all/10/20/50) = all; session (above, 0–500 step 0.01) = off/off |
| `cost.insights` | Insights | none |
| `cost.sessions` | Sessions | status (all/running/ended) = all; sort (started/cost/duration) = started; columns [region,vmSize,duration,cost,rate,ended] min 0 = first five; density = comfortable |

Numbers without a step have step 1. Threshold defaults read warn/bad.

> **For agentic workers:** the integrator first lands the contract and framework branch (W0). Then five areas (W1 Overview, W2 Clients, W3 Firewall, W4 Activity, W5 Cost) run **in parallel**, each in its own git worktree, each built by one implementer under superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** turn every panel on Overview, Clients, Firewall, Activity and Cost into a widget with a settings cog (Data / Thresholds / Display, Reset to default), hide and in-row reorder with a Layout menu, saved per user in D1 and synced to PC and phone; with no saved preferences every screen is pixel-identical to today.

**Architecture:** `shared/widgets.ts` is the single registry (page layouts, 37 widget schemas, defaults, versions, `normalisePagePrefs`, `validatePagePrefs`), imported by both the app and the Worker. The Worker adds `ui_prefs` (migration `0018_ui_prefs.sql`), `worker/src/prefs.ts` and `worker/src/api/prefs.ts` (`GET /api/v1/prefs`, `PUT /api/v1/prefs/:page` with `baseVersion`). The app adds `web/src/widgets/` (prefs store with optimistic save and revert, `Widget` frame, cog popover / phone sheet, generated settings form, `WidgetRow` / `WidgetStack`, `LayoutMenu`). Each view wraps its panels in `<Widget>` and reads `useWidget(id).settings`.

**Tech stack:** unchanged: React 19, TypeScript, Vite, TanStack Query, Radix (`react-popover`, `react-dropdown-menu`, already dependencies), lucide-react, plain CSS per component; Worker: Hono, D1, Vitest harness (`worker/test/harness.ts` on `node:sqlite`, `api-helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-10-03-widgets-design.md`. Section 8 (catalogue) is binding for ids, settings, ranges and defaults; section 3 lists the rulings.

## Global Constraints

- **Inherited:** plan 3 and plan 4 Global Constraints apply (one `.css` per component, tokens, status colours always with a word or icon, accessibility, "no data" not 0, Vitest + RTL behaviour tests, commit trailer `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`, push after every commit, no deploy).
- **Base:** W0 branches `feat/widgets-contract` from `main` (live production). Every area branches from `feat/widgets-contract` after W0 is pushed. Integration branch `feat/widgets` from `feat/widgets-contract`. The PR goes into `main`. **STOP before merging the PR and before deploying: ask Steven.** Deploy needs `npm run migrate` for 0018 before `npm run deploy-worker`; that too is Steven's call.
- **Defaults are today.** A widget with no saved settings renders exactly today's markup; any constant a view hard-codes today becomes that setting's default, value for value (spec §8). No view behaviour changes in this project except through a setting.
- **Shared files are frozen for areas.** Only W0 / the integrator edits `shared/**`, `worker/**`, `web/src/widgets/**`, `web/src/components/**`, `web/src/api/**`, `web/src/shell/**`, `web/src/test/**`, `scripts/**` (except the areas' prefs fixtures), `package.json`. Areas edit only `web/src/views/<page>/**` and `scripts/shots-prefs/<page>.*.json`. A schema change an area needs (an option, a range) goes to the integrator, who changes `shared/widgets.ts` and the spec table together.
- **One-screen rule:** at 1100×600 and larger no desktop page scrolls, with any combination of hidden and reordered widgets; rows keep their heights; lists scroll inside their panels. 641–1099 px stacks; ≤ 640 px is the phone composition.
- **Thresholds are colouring only.** No change to `worker/src/budget.ts`, `notify.ts`, `monitor.ts`, the watchman, the cost guard or push. Thresholds only colour the dashboard, always with a word or icon beside the colour.
- **Never trust the client.** The Worker validates every PUT against `shared/widgets.ts`, caps sizes (16 KiB request, 8 KiB stored page), and uses only `c.get("user")` as the owner.
- **No personal data:** fixtures use `dev@localhost`, `wg.example.net`, TEST-NET addresses.
- **Screens:** `npm run shots -- --scenario <s> --routes <r>` (1600×900, 1100×700, 1100×600, 390×844; dark and light) must exit 0. New options from W0: `--freeze-time`, `--widget-chrome off`, `--prefs FILE[,FILE]`; `npm run shots:diff -- <baseline> <new>` exits 1 on any differing pixel.
- **States:** each page's existing `states.test.tsx` must still pass; a widget's cog is usable in loading, empty and error states (the frame does not depend on data).
- **Gate (every area):** `npm test`, `npm run typecheck`, `npm run build:web` all pass.

## Review Focus

1. **Defaults are pixel-identical to today.** Shots with no prefs, `--freeze-time --widget-chrome off`, diffed against the baseline from tag `widgets-baseline`, show zero differing pixels for every scenario, size and theme. Tests: W0 `pngdiff: identical images pass, one changed pixel fails with its box`; W0 `Widget with chrome hidden renders the child panel's markup unchanged`; each area `with no prefs <page> renders today's tiles, columns, ranges and colours`.
2. **A failed save reverts.** Optimistic change, then 500, network error or 409 → the page shows the last confirmed state and a toast says why; nothing is left half-applied. Tests: W0 `a failed save puts the page back and says so`, `a 409 refetches and shows the other device's layout`, `changes made during a save are sent after it with the new version`, `typing in a number field sends one save`.
3. **Bad prefs are refused by the server.** Tests: W0 worker `PUT refuses an unknown widget, unknown key, wrong enum, off-step or out-of-range number, unknown or duplicate column, with the field path`, `PUT over 16 KiB is 400 before parsing`, `hidden may not include a pinned widget`, `order must be a permutation of its row`, `a stale baseVersion is 409 and changes nothing`, `prefs are per user`, `saving prefs writes only ui_prefs`.
4. **Hide and reorder never break one screen.** Each area's shots with `--prefs scripts/shots-prefs/<page>.hidden.json` and `<page>.reordered.json` at 1600×900 and 1100×600 dark/light exit 0. Tests: W0 `hiding a widget gives its weight to the rest of the row`, `a stack with nothing visible leaves the row`, `a row with nothing visible is not rendered`.
5. **Keyboard reorder works.** Tests: W0 `Alt+ArrowRight on the move handle moves the widget one place, keeps focus and announces the position`, `Move left / Move right in the cog`, `a widget in a stack or alone in its row has no move controls`.
6. **The phone sheet works.** Tests: W0 `on the phone the cog opens a bottom sheet with the same sections`, `the phone Layout menu lists every widget and opens its settings`; each area `phone: a hidden widget's block is gone and settings apply to its phone content`.
7. **A schema version bump drops stale keys safely.** Tests: W0 shared `normalise drops an entry whose version has no migration`, `normalise runs migrate from v1 to v2`, `unknown keys and invalid values fall back to defaults`; worker `GET normalises a stored entry after a schema bump`, `PUT with an old schema version is 409 outdated`.
8. **Widget drag never fights the firewall rules drag.** Tests: W0 `a drop without the widget data type is ignored`; W3 `dragging a rule still sends one draft move and moves no widget`.

---

## W0: Contract and framework (integrator, first)

**Branch:** `feat/widgets-contract` from `main`. **Owns:** every frozen file above. **Produces:** everything areas consume, by import path:

- `@shared/widgets`: `PageId`, `SettingSpec`, `WidgetDef`, `PageLayout`, `WIDGETS` (all 37 from spec §8), `LAYOUTS` (five pages), `widgetDefaults(id)`, `normalisePagePrefs(page, raw)`, `validatePagePrefs(page, prefs)` (returns `{field, message}` or null), option lists `EVENT_TYPES`, `AUDIT_KIND_OPTIONS`, `CAPTURE_IFACE_OPTIONS`.
- `@shared/api`: `SettingValue`, `PagePrefs`, `PrefsPage`, `PrefsResponse`, `PrefsPutBody`.
- `@/widgets`: `<Widget id headerless? >` (wraps a `Panel` or a block; renders null when hidden), `useWidget(id)` → `{settings, set, reset, hidden, hide, move, canMove}`, `<WidgetRow page row>` and `<WidgetStack>` (or `useRowItems(page, rowId)` → visible items in user order with grid template, for views that keep their own markup), `<LayoutMenu page>`, `thresholdTone(value, threshold, direction)` → `"ok" | "warn" | "bad" | null`, `usePrefsStatus()` (`"loading" | "ready" | "failed"`).
- `@/components`: `DataTable` `density?`; `LogView` `wrap?`, `timestamps?`, `levelTags?`; defaults unchanged.

- [ ] **W0.1 Pixel baseline tooling (no app change).** `scripts/test/pngdiff.test.mjs`:
  - `pngdiff: identical images pass, one changed pixel fails with its box`
  - `pngdiff: different sizes fail`
  - `pngdiff: reads RGB and RGBA 8-bit PNGs`
  - `scripts/test/shots.test.mjs` adds `parseArgs: --freeze-time, --widget-chrome off, --prefs a.json,b.json`
  - and `buildPlan: --prefs is read and validated before the browser starts`
  - FAIL.
  - Implement `scripts/lib/pngdiff.mjs` (zlib inflate, the five PNG filters; no dependencies), `scripts/shots-diff.mjs` (`npm run shots:diff -- A B`: pairs files by name, prints differing count and bounding box, exit 1 on any difference or missing file), and in `scripts/shots.mjs`: `--freeze-time` (`Page.addScriptToEvaluateOnNewDocument` pinning `Date` to the seeded `now`), `--widget-chrome off` (injects `[data-widget-chrome]{display:none!important}`), `--prefs` (after seeding, `GET /api/v1/prefs` then `PUT` each page with its version; a refusal stops the run with the server's message).
  - PASS.
  - Commit, tag `widgets-baseline`, push the tag.
- [ ] **W0.2 Take the baseline.** With the app at `widgets-baseline`:
  - start `npm run dev:api` and `npm run dev:web`;
  - for each scenario `running deploying busy-month destroyed empty failed standby`: `npm run shots -- --scenario <s> --freeze-time --out .superpowers/shots/widgets-baseline/<s>`;
  - run `running` twice and `npm run shots:diff` the two runs.
  - **Done when:** the two runs diff to zero (if not, fix the nondeterminism in the harness, not the app). Put the exact commands in the report so areas can regenerate the baseline in their own worktrees from the tag.
- [ ] **W0.3 Shared registry.** `worker/test/widgets-schema.test.ts`:
  - `every widget id is page.camelCase, unique, and appears once in its page layout`
  - `every default validates`
  - `normalise drops unknown keys and invalid values`
  - `normalise drops an entry whose version has no migration`
  - `normalise runs migrate from v1 to v2` (a test-only def)
  - `normalise inserts a new widget missing from a stored order at its declared index and removes pinned ids from hidden`
  - `validate names the field for each refusal kind` (table-driven over spec §6.3)
  - `change kind options match AUDIT_KINDS`
  - `capture interfaces match CAPTURE_IFACES`
  - `event types match EventType`
  - FAIL.
  - Write `shared/widgets.ts` from spec §4–§5 and the §8 tables (37 defs, five layouts with today's weights), and the prefs types in `shared/api.ts`.
  - PASS.
  - Commit.
- [ ] **W0.4 Storage and API.** `worker/test/prefs.test.ts` and `worker/test/api-prefs.test.ts` (harness as `api-settings.test.ts`):
  - `migration 0018 creates ui_prefs`
  - `GET prefs for a new user is five pages at version 0`
  - `PUT then GET round-trips, normalised and sparse (defaults stripped)`
  - `PUT refuses an unknown widget, unknown key, wrong enum, off-step or out-of-range number, unknown or duplicate column, with the field path`
  - `PUT over 16 KiB is 400 before parsing`
  - `a normalised page over 8 KiB is 400`
  - `hidden may not include a pinned widget`
  - `order must be a permutation of its row`
  - `unknown page is 404`
  - `a stale baseVersion is 409 stale and changes nothing`
  - `PUT with an old schema version is 409 outdated`
  - `reset writes {} and the version still rises`
  - `prefs are per user` (db layer with two identities)
  - `GET normalises a stored entry after a schema bump` (write an old row directly)
  - `saving prefs writes only ui_prefs` (row counts of `settings`, `alerts`, `audit` unchanged)
  - `PUT without same-origin is refused`
  - FAIL.
  - Add `worker/migrations/0018_ui_prefs.sql` (spec §6.1), `worker/src/prefs.ts` (`getPrefs(env, user)`, `putPrefs(env, user, page, baseVersion, prefs)` with the atomic insert/update and `meta.changes` check), `worker/src/api/prefs.ts` (`registerPrefs`, using `body`, `fail`; raw-length check before `body()`), one mount line in `worker/src/api/index.ts`, `ui_prefs` in the `devseed.ts` wipe list (test `every scenario wipes ui_prefs` in `devseed.test.ts`).
  - PASS.
  - Commit.
- [ ] **W0.5 Prefs store.** `web/src/widgets/prefs.test.tsx`:
  - `prefs load with the session and widgets read saved settings`
  - `a change shows at once and saves after 600 ms`
  - `typing in a number field sends one save`
  - `changes made during a save are sent after it with the new version`
  - `a failed save puts the page back and says so` (500 and `NetworkError`)
  - `a 409 refetches and shows the other device's layout`
  - `a 409 outdated says reload`
  - `the last good prefs are mirrored to localStorage and used while loading; a throwing localStorage is ignored`
  - `if prefs fail to load, cogs are read-only and nothing is saved`
  - `a hidden tab flushes the pending save`
  - FAIL.
  - Implement `usePrefs`, `useWidget`, `usePrefsStatus` (`web/src/widgets/usePrefs.ts`, `useWidget.ts`), `prefs` added to `web/src/test/fixtures.ts` and `mockFetch` defaults (GET answers empty pages so every existing test keeps passing).
  - PASS.
  - Commit.
- [ ] **W0.6 Frame, cog and form.** `web/src/widgets/widget.test.tsx`:
  - `Widget with chrome hidden renders the child panel's markup unchanged` (compare `innerHTML` with and without the wrapper, chrome removed)
  - `a titled widget's cog sits after the panel actions and is named "<Title> settings"`
  - `a headerless widget's cog is a corner overlay reachable by Tab`
  - `the cog shows only non-empty sections Data, Thresholds, Display`
  - `form: enum, boolean, number with unit, multi with minSelected, threshold pair with Off` (one test per kind: change → `set` called with a valid value; invalid number shows the message and is not saved)
  - `Reset to default is disabled until something differs, then clears the widget`
  - `Hide widget is absent on a pinned widget`
  - `on the phone the cog opens a bottom sheet with the same sections`
  - `threshold hint says it colours this dashboard only`
  - FAIL.
  - Implement `Widget.tsx`, `WidgetCog.tsx` (Radix Popover; `Sheet` when `useIsPhone()`), `SettingsForm.tsx`, `widgets.css`; `thresholdTone`.
  - PASS.
  - Commit.
- [ ] **W0.7 Rows, reorder, hide, Layout menu.** `web/src/widgets/layout.test.tsx` (on a test-only page layout):
  - `hiding a widget gives its weight to the rest of the row`
  - `a stack with nothing visible leaves the row`
  - `a row with nothing visible is not rendered`
  - `drag by the handle reorders within the row and saves the order`
  - `a drop without the widget data type is ignored`
  - `a widget cannot be dropped into another row`
  - `Alt+ArrowRight on the move handle moves the widget one place, keeps focus and announces the position`
  - `Move left / Move right in the cog`
  - `a widget in a stack or alone in its row has no move controls`
  - `Layout menu: Show hidden widgets lists hidden ones and Show brings one back`
  - `Layout menu says No hidden widgets when none are`
  - `Reset this page asks in a Modal, then resets order, hidden and every widget`
  - `the phone Layout menu lists every widget and opens its settings`
  - FAIL.
  - Implement `layout.ts` (pure: visible items, grid template from weights, move, permutation checks), `WidgetRow.tsx`, `WidgetStack.tsx`, `useRowItems`, `LayoutMenu.tsx` (Radix DropdownMenu, `Modal` for reset).
  - PASS.
  - Commit.
- [ ] **W0.8 Shared component options.** `components/data/data.test.tsx` adds:
  - `DataTable density compact sets the compact row class; default unchanged`
  - `LogView wrap, timestamps and levelTags; defaults unchanged`
  - FAIL. Implement; add the new props and a widget demo to `web/src/gallery.tsx`. PASS. Commit.
- [ ] **W0.9 Contract check.**
  - Gate passes.
  - `npm run shots -- --scenario running --freeze-time --widget-chrome off` diffed against the baseline is zero (no view uses widgets yet, so this proves W0 changed nothing visible).
  - Push; tell the areas the commit and the `@/widgets` API above.
  - **Done when:** gate, zero diff, push.

---

## Area template (W1–W5)

Each area: **Branch** `feat/widgets-<page>` from `feat/widgets-contract`. **Owns** `web/src/views/<page>/**`, `scripts/shots-prefs/<page>.hidden.json` (every optional widget hidden except one per row), `scripts/shots-prefs/<page>.reordered.json` (every row with 2+ items reversed). **Consumes** `@/widgets`, `@shared/widgets`, spec §8 for its page. Steps, in order, each failing-test-first and committed:

1. **Frame:** wrap every panel in `<Widget id>`, rows via `WidgetRow`/`useRowItems` keeping the page's existing CSS classes and grid templates when the layout is default. Tests: `every panel on <page> is a widget with a cog named "<Title> settings"`; `with no prefs <page> renders today's tiles, columns, ranges and colours` (assert today's constants explicitly).
2. **Data settings:** one test per Data setting proving it changes what renders or what is fetched (query params via `mockFetch` calls).
3. **Thresholds and display:** one test per threshold (value just below/at each cutoff gives the word and tone) and per display toggle.
4. **Layout:** `hiding <widget> widens the rest of its row`; `the reordered layout renders in the saved order`; responsive folds follow user order minus hidden (where the page has folds).
5. **Phone:** `phone: a hidden widget's block is gone and settings apply to its phone content`.
6. **Screens:** with the baseline regenerated from tag `widgets-baseline` (W0.2 command, in a temporary worktree): `npm run shots -- --scenario <s> --routes <routes> --freeze-time --widget-chrome off` then `npm run shots:diff` → zero for every listed scenario; then shots with `--prefs` for each fixture at 1600×900 and 1100×600 dark/light → exit 0 (default `--sizes` also covers 1100×700 and the phone).

**Done when:** gate passes, the diff is zero, every prefs shot run exits 0, and the report lists any schema change requested from the integrator.

## W1: Overview

**Branch:** `feat/widgets-overview`. **Widgets (10):** `overview.status` (pinned, headerless), `topology`, `keyMetrics`, `run`, `traffic`, `events`, `speedTest`, `health`, `costImpact`, `notes`. **Scenarios:** `running`, `deploying` (run arrangement), `destroyed`, `failed`, `standby`.

- [ ] **W1.1** Frame and defaults:
  - `overview: every panel is a widget`
  - `with no prefs overview renders today's tiles, columns, ranges and colours` (Key metrics Live, 7 tiles 3+4, ring 99/90, traffic Session in KB/s, 5 events over 24h, 3 speed tests, 16 cost bars)
  - Keep `.ov-rows` tracks; `.ov-row--3` and `--4` templates come from weights only when changed.
- [ ] **W1.2** Data:
  - `key metrics starting range fetches that history range`
  - `tiles setting removes a tile and the rest flow into two rows`
  - `traffic 24h reads vm history rx_rate and tx_rate`
  - `traffic Mbit/s converts`
  - `events rows, range and types filter the list and the activity query range`
  - `speed test results shown`
  - `health checks setting hides a check`
  - `cost impact sessions in chart`
  - `notes show at most`
  - `run starting step filter and log level`
- [ ] **W1.3** Thresholds/display:
  - `availability below 99 is amber with its word, below 90 red`
  - `DNS warn threshold`
  - `latency thresholds off by default, amber when set and exceeded`
  - `cost impact session threshold`
  - display toggles for status, topology, key metrics, run timestamps, events detail, speed test jitter/server, health ages, notes times
- [ ] **W1.4** Layout:
  - `hiding topology widens key metrics`
  - `hiding speed test gives recent events the side column`
  - `during a run the run widget widens over traffic and traffic joins the side stack, hidden widgets stay hidden`
  - `status banner cannot be hidden`
- [ ] **W1.5** Phone: status display toggles apply to the phone state block; phone has no reorder; Layout menu lists all 10. **Done when:** area template done condition.

## W2: Clients

**Branch:** `feat/widgets-clients`. **Widgets (5):** `clients.kpis` (headerless), `table` (pinned, headerless; the toolbar belongs to it), `talkers`, `statusDonut`, `sessionTraffic`. The side panel is not a widget. **Scenarios:** `running`, `busy-month`, `empty`.

- [ ] **W2.1** Frame and defaults:
  - `clients: every panel is a widget`
  - `with no prefs clients renders today's tiles, columns, ranges and colours` (6 tiles, Name A→Z, six optional columns, 5 talkers, donut legend extras, session traffic)
- [ ] **W2.2** Data:
  - `starting filter and sort apply when the URL has none`
  - `columns setting adds IPv6 address, Created and Note and removes Allowed IPs`
  - `kpi tiles setting`
  - `talkers rows and measure Sent sums up+bu`
  - `session traffic 7d reads vm history`
  - `units Mbit/s`
  - `series Outbound only`
- [ ] **W2.3** Thresholds/display:
  - `latency thresholds colour the tile and the latency cell with a word`
  - `compact density`
  - `latency sparkline off`
  - `donut percentages off and legend extras`
- [ ] **W2.4** Layout:
  - `hiding talkers widens the other two`
  - `the table cannot be hidden`
  - `the table still fills the space when the lower row is entirely hidden`
- [ ] **W2.5** Phone:
  - `phone: summary line follows kpis tiles; the list follows filter and sort`
  - **Done when:** area template done condition.

## W3: Firewall

**Branch:** `feat/widgets-firewall`. **Widgets (7):** `firewall.kpis` (headerless), `rules` (pinned), `zones`, `simulator`, `drops`, `ports`, `capture`. **Scenarios:** `running`, `busy-month`, `destroyed`.

- [ ] **W3.1** Frame and defaults:
  - `firewall: every panel is a widget`
  - `with no prefs firewall renders today's tiles, columns, ranges and colours` (simulator Clients→Home TCP 22, capture wg0 30 s, 5 recent captures, all drops in UK time)
  - The header (policy status, draft bar) stays outside the widgets.
- [ ] **W3.2** Data:
  - `rules starting tab`
  - `last hit and lifetime hits columns`
  - `simulator starting values prefill the form`
  - `drops show at most`
  - `capture starting interface, seconds and recent count`
  - `kpi tiles`
- [ ] **W3.3** Thresholds/display:
  - `recent drops threshold colours the tile with a word`
  - `drops UTC times`
  - `zone chip and Allow button off`
  - `zones addresses, counts and arrows off`
  - `ports turned-off hidden, connections and last hit shown`
  - `rules compact density and hits sparkline off`
- [ ] **W3.4** Layout:
  - `hiding zones gives the simulator the whole bottom row`
  - `swapping zones and simulator`
  - `hiding drops lets ports and capture share the column`
  - `narrow tabs follow the stack order minus hidden widgets`
  - `short tabs include zones and simulator only when visible`
  - `dragging a rule still sends one draft move and moves no widget`
  - `rules cannot be hidden`
- [ ] **W3.5** Phone:
  - `phone: hidden drops, ports or capture remove their button; the lights follow kpis tiles`
  - **Done when:** area template done condition.

## W4: Activity

**Branch:** `feat/widgets-activity`. **Widgets (7):** `activity.kpis` (headerless), `timeline`, `list` (pinned, headerless tabs), `stream`, `changeLog`, `runDetails`, `liveOutput`. **Scenarios:** `running`, `busy-month`, `failed`, `empty`; routes `/activity` and `/activity/runs/:id`.

- [ ] **W4.1** Frame and defaults:
  - `activity: every panel is a widget`
  - `with no prefs activity renders today's tiles, columns, ranges and colours` (success 90/70, failed red at 1, watchman amber at 1, 60 log lines, nowrap)
- [ ] **W4.2** Data:
  - `starting tab applies only without ?tab=`
  - `runs columns add Public IP`
  - `timeline series`
  - `stream starting event type`
  - `change log starting kind sets kind on the query when the URL has none`
  - `run details Newest failed run on /activity; /activity/runs/:id ignores it`
  - `live output lines`
- [ ] **W4.3** Thresholds/display:
  - `success rate, failed runs and watchman thresholds with words`
  - `deltas off`
  - `stream time format relative and detail off`
  - `live output wrap, timestamps and level tags`
  - `compact density`
  - `step name lines`
- [ ] **W4.4** Layout:
  - `hiding the timeline gives the list the column`
  - `hiding the change log gives the stream the column`
  - `hiding the whole right stack widens the left`
  - `swapping run details and live output`
  - `the bottom row is still not rendered at 720 px tall`
- [ ] **W4.5** Phone:
  - `phone: last run and last note cards follow run details and list settings; hidden widgets' buttons are gone`
  - **Done when:** area template done condition.

## W5: Cost

**Branch:** `feat/widgets-cost`. **Widgets (8):** `cost.kpis` (headerless), `spend`, `breakdown`, `forecast`, `split`, `perSession`, `insights`, `sessions`. **Scenarios:** `running`, `busy-month`, `destroyed`, `empty`.

- [ ] **W5.1** Frame and defaults:
  - `cost: every panel is a widget`
  - `with no prefs cost renders today's tiles, columns, ranges and colours` (budget 80/100, forecast pill at 100 %, split by region in API order, all sessions)
- [ ] **W5.2** Data:
  - `kpi tiles`
  - `spend forecast and budget overlays off; previous line on at start and the Compare switch still toggles it`
  - `breakdown group by region`
  - `split starting view and largest first`
  - `per session last 10`
  - `sessions starting status, sort and the Ended column`
- [ ] **W5.3** Thresholds/display:
  - `budget thresholds colour the budget tile only, with a word; the cost guard tile still follows the server`
  - `forecast warn threshold`
  - `per-session threshold colours bars`
  - `breakdown percentages`
  - `split track bars and percent off`
  - `spend note and legend off`
  - `sessions compact density`
- [ ] **W5.4** Layout:
  - `hiding forecast widens spend and breakdown`
  - `hiding insights widens split and per session`
  - `the short-window named layout is used while rows are default and the generic rows once they change` (spec §3.12)
- [ ] **W5.5** Phone:
  - `phone: hidden spend, breakdown or sessions remove their button; hidden insights is not shown inline; kpis tiles apply`
  - **Done when:** area template done condition.

---

## Integration

1. **Merge order** onto `feat/widgets`: W1, W2, W3, W4, W5 (independent folders; conflicts mean an area edited a frozen file and that diff is rejected or folded into the contract). Gate after each merge.
2. **Hot spots:** `shared/widgets.ts` (integrator only; any schema change requested by an area lands here and in the spec §8 table in the same commit), `web/src/test/fixtures.ts`, `scripts/shots-prefs/` (one pair per page, no clashes).
3. **Full gate:** `npm test`, `npm run typecheck`, `npm run build:web`, `npm run bundle-size` (report the growth; the widget framework should be small).
4. **Pixel diff, all pages:** for each scenario `running deploying busy-month destroyed empty failed standby`: shots with `--freeze-time --widget-chrome off` and `shots:diff` against the baseline → zero differing pixels.
5. **One-screen with prefs:** `npm run shots -- --scenario running --prefs scripts/shots-prefs/<page>.hidden.json` and `.reordered.json` for all five pages together (`--prefs` takes the ten files), and once with every page's `hidden` file combined on `busy-month`: every run exits 0. Look at the 1100×600 dark shots by eye for clipped headers or cramped widened rows.
6. **Live-ish check** in `npm run dev:web` + `npm run dev:api`: change a setting in one browser profile and see it after focusing a second; stop the API and change a setting to see the revert toast.
7. **Whole-branch review:** one fresh reviewer on the most capable model (opus), given this plan, the spec and the shots, asked specifically about the Review Focus list, `worker/src/api/prefs.ts` input handling, and whether any default differs from today.
8. **One fix pass:** each finding fixed failing-test-first (or a shot for a visual finding); gate, pixel diff and prefs shots again.
9. **PR** from `feat/widgets` into `main` with CI green and the shots summary in the description. **STOP: ask Steven before merging and before deploying** (deploy order: `npm run migrate` for 0018, then `npm run deploy-worker`, then check `/api/v1/prefs` answers on wg-admin.clydeford.net).

## Final review checklist

- All 37 widgets of spec §8 exist with exactly those ids, settings, ranges and defaults; four pinned.
- No saved prefs → every desktop and phone shot is pixel-identical to the baseline (chrome hidden).
- Every setting changes what it says; every threshold colours with a word or icon and changes nothing server-side (`saving prefs writes only ui_prefs`).
- Hidden and reordered layouts never scroll a desktop page at 1100×600 or larger, either theme.
- Reorder by mouse, Alt+Arrow and cog menu; Layout menu unhide and Reset this page; Reset to default per widget.
- PC → phone sync on focus; a failed or conflicting save reverts with a toast; a load failure makes cogs read-only.
- Server refuses unknown, invalid, oversized and stale-version prefs with the field; owner is always the Access identity.
- No personal data in fixtures, prefs fixtures, tests or committed screenshots.
