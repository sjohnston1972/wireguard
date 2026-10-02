# Redesign plan 4: the six views (and the firewall draft backend)

> **For agentic workers:** the integrator first lands a small contract branch (I0). Then seven areas (A firewall draft backend, B Overview, C Clients, D Firewall, E Activity, F Cost, G Settings) run **in parallel**, each in its own git worktree, each built by one implementer under superpowers:test-driven-development. D codes against I0's contract types with mocked fetch and does not wait for A. Steps use checkbox (`- [ ]`) syntax.

**Goal:** replace the nine placeholder pages with the six real views, desktop and phone, dark and light, matching Steven's mockups; and build the firewall draft backend (spec §6) that the Firewall view edits.

**Architecture:** every view lives in `web/src/views/<view>/` and is built only from the shared library (`@/components`), the data layer (`@/api/queries`, `@/api/mutations`) and the shell. Each view has a desktop composition on the 12-column `Grid` and a separate phone composition chosen by `useIsPhone()`. The draft backend adds `worker/src/fwdraft.ts` (pure diff/move/drop logic) and `worker/src/api/fwdraft.ts` (routes), over migration `0015_firewall_draft.sql`.

**Tech stack:** as plan 3: React 19, TypeScript, Vite, React Router, TanStack Query, Radix, uPlot, lucide-react, plain CSS per component; Worker: Hono, D1, Vitest harness.

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md`. Sections 4 (Firewall draft routes), 6, 7, 8, 9, 10, 12 and 14 govern this plan.

**Visual target (binding for layout):** `C:\cloudflare_projects\wireguard\redesign\screenshots\ChatGPT Image Oct 2, 2026, <time>.png`: Overview `01_30_04 PM-1`, Clients `01_29_44 PM-2`, Firewall `01_29_44 PM-3`, Activity `01_29_45 PM-4`, Cost `01_29_46 PM-5`, Settings `01_29_46 PM-6`. Local files, not in git; open yours with the Read tool before writing UI code. Each area below describes its mockup's regions; the image is the authority on spacing and look.

## Global Constraints

- **Inherited:** plan 3's Global Constraints apply unchanged (stack, one `.css` per component, tokens, status colours with a word or icon, accessibility, "no data" not 0, `DataAge` on live panels, Vitest + RTL behaviour tests, commit trailer, push, no PR, no deploy).
- **Base:** I0 branches `feat/views-contract` from `redesign` **after** plan 3's PR (`feat/web-foundation` plus its fix pass) has merged. Every area branches from `feat/views-contract`.
- **Fix-pass names:** this plan calls the fix pass's additions `SidePanel` (non-modal in-page panel), `PageHeader`'s `context` slot holding `EnvironmentControl` (read-only "Production"), `MetricTile iconStyle="plain"|"circle"|"square"`, `Sparkline variant="bars"` (nulls are gaps), `BarChart` null values as gaps, `useRuleHistory`, `useSimulate`, `useHealthCheck`, `downloadFile(name, text|url)`. If the fix pass named them differently, I0 records the real names at the top of this file and everyone uses those.
- **Shared files are frozen for areas.** Areas B–G edit only `web/src/views/<view>/**`. Area A edits only the Worker files it lists. Nobody but the integrator edits `shared/api.ts`, `web/src/api/queries.ts`, `web/src/api/mutations.ts`, `web/src/components/**`, `web/src/routes.ts`, `web/src/views/pages.tsx`, `web/src/App.tsx`, `web/src/test/fixtures.ts`, `web/src/gallery.tsx`. A hook you lack goes in `views/<view>/api.ts`, written with the exported `endpoint()` / `useApiMutation`. A component you lack is built in your folder and listed in your report; the integrator may promote it.
- **One-screen rule (spec §7):** at 1100 × 600 and larger the page (`#main`) never scrolls; long lists scroll inside their `Panel` with sticky headings; a column too tall scrolls on its own. 641–1099 px: panels stack, page may scroll, drawers full height. ≤ 640 px: the phone composition (spec §9).
- **Mockup deviations, decided once:** the "Technical UX notes" regions are not UI; each area says what fills that slot. Out of scope and therefore not built: row checkboxes and bulk actions, export configs, grid/list toggle, saved views/saved filters, "Columns", an editable environment selector, the Cost header's region filter and Export, the drops "Block" button (a drop is already blocked), "Reset to defaults", countdowns ("about 2 minutes remaining" becomes "usually about 4 min" from `typicalSeconds`).
- **No personal data:** fixtures and tests use `dev@localhost`, `wg.example.net` and TEST-NET addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`). Never copy names, addresses or emails from the mockups.
- **Palette actions:** a view reads `?action=` once, opens the normal reviewed form (never runs anything), and removes the parameter when the form closes: Overview `deploy|destroy|hibernate|resume|extend|speedtest`, Clients `add`, Firewall `add-rule|capture`.
- **Mutations:** submit disabled while pending; server `field` errors shown at the field; input kept on failure; destructive actions use `ConfirmByTyping`; no `alert`/`confirm`; VM-applied changes show "waiting for VM" until the heartbeat confirms.
- **Screenshots:** `npm run shots -- --scenario <s> --routes <r>` shoots 1600 × 900, 1100 × 600 and 390 × 844, dark and light, into `.superpowers/shots/<date>/`, and exits non-zero if any desktop shot scrolls. Each view area runs it for its scenarios and states in its report, region by region, where its 1600 × 900 dark shot differs from the mockup.
- **States (every view area):** a `states.test.tsx` proving a shape-matched `Skeleton` while loading, `ErrorState` with the API message and a working Retry on a 500, and an `EmptyState` naming what is empty and the next action (spec §10).
- **Gate (every area):** `npm test`, `npm run typecheck`, `npm run build:web` all pass.

## Review Focus

1. **Stale draft apply.** If live rules changed after the draft began (a restore, a default change in Settings, another tab's apply), Apply must answer 409 and leave everything as it was; the screen keeps the draft bar and says why. Tests: A `apply with a stale baseVersion is 409 and changes nothing`, A `restore and a settings default change bump live_version`, D `a 409 on apply keeps the draft bar and shows the message`.
2. **The private key's lifetime.** Closing the wizard (Done, Escape, navigating away, a server error) must wipe the key, QR and download URL; the key must never appear in a request body, the query cache or storage. Tests: C `the private key is never sent and is gone after close`, C `a server error keeps the name and routing but makes a fresh key on retry`.
3. **One screen with real volumes.** 13 clients, 30 days of runs, 20 drops, 6+ rules at 1100 × 600: panels scroll inside, the page never does. Proved by each area's `shots` run (exit 0) on `running` and `busy-month`.
4. **Nothing invented when there is nothing.** Destroyed with no history, no Azure actuals, no runs: tiles say "no data", availability is not 100 %, cost breakdown says "estimate" or "no data", never 0 % slices. Tests: B `destroyed with no history shows no data, not zeros`, F `no actuals and no sessions shows no data in every tile and the donut`.
5. **Reorder edits the draft exactly once.** Drag, buttons and keyboard each send one move; dropping a rule on its own place sends nothing; the default row cannot move or be dropped on. Tests: D `drag to a new place sends one move with to`, D `dropping in place sends nothing`, D `keyboard reorder with Alt+Arrow sends dir and keeps focus on the row`.

---

## I0: Contract (integrator, first, small)

**Branch:** `feat/views-contract` from `redesign`. **Owns:** the frozen shared files above.

- [ ] **`shared/api.ts`** gains the draft contract; `FirewallResponse` gains `version: number; draft: FirewallDraft | null`; `SimRequest` gains `policy?: "live" | "draft"`:
  ```ts
  export interface DraftRuleRow extends FwRule {           // id = live rule's id for copied rules
    liveId: number | null; place: number; fromLabel: string; toLabel: string; service: string;
    problem: string | null; mark: "added" | "changed" | "moved" | null;
  }
  export interface DraftDiff {
    added: { id: number; name: string; place: number }[];
    removed: { id: number; name: string; place: number }[];          // place in the live list
    changed: { id: number; name: string; fields: { field: string; before: string; after: string }[] }[];
    moved: { id: number; name: string; from: number; to: number }[];
    defaultChanged: { before: "allow" | "deny"; after: "allow" | "deny" } | null;
  }
  export interface FirewallDraft { baseVersion: number; stale: boolean; defaultAction: "allow" | "deny"; rules: DraftRuleRow[]; diff: DraftDiff; changes: number }
  export interface DraftRuleBody { name: string; from: SimEnd; to: SimEnd; proto: "any" | "tcp" | "udp" | "icmp"; ports?: string; action: "allow" | "deny"; enabled?: boolean; log?: boolean }
  export type DraftMoveBody = { dir: "up" | "down" } | { to: number };   // to = 0-based index in the draft list
  ```
- [ ] **`mutations.ts`:** `useDraftAddRule`, `useDraftEditRule` (`{id, ...Partial<DraftRuleBody>}`), `useDraftMoveRule` (`{id} & DraftMoveBody`), `useDraftDeleteRule`, `useDraftDefault` (`{action}`), `useDraftFromDrop` (`{src,dst,proto,dport}`), `useDraftApply` (`{baseVersion}`), `useDraftDiscard`; all invalidate `["firewall"]`. `useSimulate` passes `policy`.
- [ ] **`pages.tsx`** becomes re-exports (`export { OverviewPage } from "./overview"`, `ClientsPage, ClientDetailPage` from `./clients`, `FirewallPage, FirewallRulePage` from `./firewall`, `ActivityPage, RunDetailPage` from `./activity`, `CostPage` from `./cost`, `SettingsPage` from `./settings`); each folder gets an `index.tsx` stub returning today's `Placeholder`. Areas replace only their own `index.tsx`.
- [ ] **`web/src/lib/useIsPhone.ts`** (`matchMedia("(max-width: 640px)")`, false without `matchMedia`, live on change) and **`web/src/test/viewport.ts`** `setViewport("phone" | "desktop")` stubbing `matchMedia`.
- [ ] **`web/src/lib/wgkeys.ts`** (port of `worker/public/app.js` `genKeypair`: WebCrypto X25519, JWK → base64; the same "this browser cannot make X25519 keys" message; `confFileName(name)` ≤ 15 chars) and **`components/data/QrCode.tsx`** (`qrcode-generator` SVG, `aria-label`), both tested. C and G use them.
- [ ] **Done when:** the gate passes and every route still shows its placeholder. Push; tell areas the commit.

---

## Area A: Firewall draft backend

**Branch:** `feat/fw-draft`. **Owns:** `worker/migrations/0015_firewall_draft.sql`, `worker/src/fwdraft.ts`, `worker/src/api/fwdraft.ts`, one mount line in `worker/src/api/index.ts`, edits to `worker/src/api/firewall.ts` (GET adds `version`, `draft`), `worker/src/api/simulate.ts` (`policy`), `worker/src/db.ts` (`bumpFwVersion`, draft queries, `auditStmt`), `applyRestore` in `worker/src/backup.ts`, `PUT settings` in `worker/src/api/settings.ts`, the old form routes `/firewall/rules*`, `/firewall/default`, `/firewall/allow-drop` in `worker/src/index.ts` (one `bumpFwVersion` call each), `worker/src/devseed.ts`, tests `worker/test/fwdraft.test.ts`, `worker/test/api-fwdraft.test.ts`, `worker/test/devseed.test.ts`.
**Consumes:** I0's types; `compileFirewall`, `endLabel`, `serviceLabel`, `parsePorts`, `parseCidr`, `ZONE_LABEL` (`worker/src/firewall.ts`); `simulate()`; `body`, `fail`, `idParam`; plan 2b's rules (strict input, 400 names the field).
**Produces:** the routes of spec §4 "Firewall draft", plus `{to}` on move, and `GET /firewall` `version` + `draft` exactly as I0 typed them.

**Schema (`0015_firewall_draft.sql`):**
```sql
CREATE TABLE IF NOT EXISTS fw_draft_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, live_id INTEGER, position INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL, src_kind TEXT NOT NULL CHECK (src_kind IN ('any','zone','client','cidr')), src_value TEXT NOT NULL DEFAULT '',
  dst_kind TEXT NOT NULL CHECK (dst_kind IN ('any','zone','client','cidr')), dst_value TEXT NOT NULL DEFAULT '',
  proto TEXT NOT NULL CHECK (proto IN ('any','tcp','udp','icmp')), ports TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('allow','deny')), log INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fw_policy (id INTEGER PRIMARY KEY CHECK (id = 1), live_version INTEGER NOT NULL,
  draft_base INTEGER, draft_default TEXT CHECK (draft_default IN ('allow','deny')), apply_token TEXT);
INSERT OR IGNORE INTO fw_policy (id, live_version) VALUES (1, 1);
```
**Rulings (spec gaps, decided here):**
- The live default stays where it is (`settings.firewall_default`); `fw_policy` holds the version and the draft's base and default.
- **Ids:** the first edit copies every live rule **with its own id** (`id = live_id`); new draft rules take AUTOINCREMENT ids, which are above every copied id. So the screen addresses a rule by the same id whether or not a draft exists, and every draft route first calls `ensureDraft` (one batch: copy where `draft_base IS NULL`, then set `draft_base = live_version`, `draft_default = firewall_default`).
- **Apply keeps ids:** kept rules are `UPDATE`d in place by `live_id`, removed ones deleted, new ones inserted. Counters and hit history (`r<id>`) carry on across an apply.
- **Atomic 409:** apply is one `DB.batch`. Statement 1 is `UPDATE fw_policy SET live_version = live_version + 1, apply_token = ?tok WHERE id = 1 AND live_version = ?base AND draft_base = ?base`; every later statement (rule writes, `settings` upsert of the default, draft delete, `draft_base = NULL`, the `auditStmt` insert of action `firewall.apply` with the full diff) carries `WHERE (SELECT apply_token FROM fw_policy WHERE id = 1) = ?tok`. If statement 1 changed no row, answer 409 `"The live rules changed since this draft began. Discard it and start again."`.
- **Empty drafts vanish:** after any draft write, if the diff is empty the draft is deleted, so `GET /firewall` gives `draft: null`.
- **Apply refuses broken rules:** 422 `"Rule <place>, <name>: <problem>"` (field `rules`) when an added or changed enabled rule has a compile problem; unchanged copies of already-broken live rules do not block.
- **Version bumps outside apply:** restore confirm, `PUT settings` changing `firewallDefault`, and the old form routes call `db.bumpFwVersion(env)`.
- **Moved** = the minimal set: among rules present in both lists, those outside the longest increasing subsequence of live order. `stale` = `draft_base != live_version`.

**Routes** (all `ApiOk` unless noted; 404 `"No such rule."` for an unknown id): `POST firewall/draft/rules` (`DraftRuleBody`; inserted last), `PUT firewall/draft/rules/:id` (partial), `POST firewall/draft/rules/:id/move` (`{dir}` or `{to}`; `to` must be an integer in `0..n-1`, else 400 field `to`; moving past either end is a no-op), `DELETE firewall/draft/rules/:id`, `PUT firewall/draft/default` (`{action}`), `POST firewall/draft/from-drop` (`{src,dst,proto,dport}`, the old `/firewall/allow-drop` logic moved into `fwdraft.ruleFromDrop`), `POST firewall/draft/apply` (`{baseVersion}` → `ApiOk` whose message says "Applied n changes. The VM picks them up within 30 seconds."), `DELETE firewall/draft` (ok with no draft). Validation: `name` 1–60 chars; ends as `simulate.ts` `checkEnd` except IPv6 CIDRs are allowed in rules; `ports` only for tcp/udp and must pass `parsePorts`. `POST firewall/simulate` with `policy: "draft"` and no draft is 400 field `policy`.

- [ ] **A1** Write `worker/test/fwdraft.test.ts`: `diff: an untouched copy has no changes`; `diff: added, removed, changed field by field, default changed`; `diff: moving rule 4 to the top reports one moved rule, not four`; `moveTo: index rules and dir rules give the same order`; `ruleFromDrop: a client source becomes a client end and ICMP gets no port`. Run `npx vitest run worker/test/fwdraft.test.ts`: FAIL (module missing). Implement `fwdraft.ts` (`draftDiff(live, liveDefault, draft, draftDefault, peers)`, `moveTo(rules, id, to)`, `ruleFromDrop(drop, peers)`); PASS. Commit.
- [ ] **A2** Write `worker/test/api-fwdraft.test.ts` (harness as `api-firewall.test.ts`): `first edit copies live rules and default with base = live version`; `draft edits leave GET firewall rules live and fill draft.diff`; `add validates name, ends, proto and ports with the field`; `move with dir and with to, to out of range is 400 to, unknown id 404`; `from-drop adds an allow rule to the draft`; `an edit back to live deletes the draft`. FAIL; add migration, db helpers, routes, GET fields; PASS. Commit.
- [ ] **A3** Add: `apply replaces fw_rules keeping kept ids, sets the default, bumps version, clears the draft, writes one firewall.apply audit`; `apply with a stale baseVersion is 409 and changes nothing`; `apply refuses 422 for a broken added rule but not for an unchanged broken copy`; `restore and a settings default change bump live_version`; `discard deletes the draft and is ok with none`; `simulate with policy draft uses draft rules and default`; `after apply the policy state is pending until the agent reports the new hash`. FAIL; implement; PASS. Commit.
- [ ] **A4** `worker/test/devseed.test.ts`: `every scenario wipes drafts and resets fw_policy`; `running has a two-change draft (one edited rule, one added)`. FAIL; edit `devseed.ts`; PASS. Commit.
- [ ] **Done when:** `npx vitest run worker/test/fwdraft.test.ts worker/test/api-fwdraft.test.ts worker/test/devseed.test.ts` passes, then the gate.

---

## Area B: Overview

**Branch:** `feat/view-overview`. **Owns:** `web/src/views/overview/**`. **Consumes:** `useOverview`, `useHistory({scope:"vm"})`, `useRunLog(id, true)`, `useActivity({range:"24h"})`, `useSession` (notes), `useCost("month")`, lifecycle mutations, `useAckNotes`, `fetchSshPassword`. **Scenarios:** `deploying` (compare to mockup), `running`, `destroyed`, `failed`, `standby`, `empty`.

**Mockup regions (`01_30_04 PM-1`):**
1. **Header:** "Overview" + subtitle (spec text); right: `EnvironmentControl`, read-only Region (flag, name) and VM size from `config`, gear `IconButton` → `/settings/deployment`.
2. **Status banner (12 cols):** state icon + word (amber "Deploying"), sub-line, `ProgressBar` with %, "6 of 12 steps completed" from `snapshot.steps`; divider; clock "Elapsed time" + "usually about N min" (`typicalSeconds`); right: the state's actions. Destroyed: Deploy form (duration `Chips`, profile `Chips` incl. nearest region, over-budget confirm). Running: Extend, Hibernate, Move, Speed test, Tear down (`ConfirmByTyping`). Standby: Resume, Tear down. Failed: failed step, "View log" (→ `/activity/runs/:id`), Clean up. During a GitHub run: Cancel.
3. **Row 2:** Live topology (7 cols): three node cards Clients (configured, online) → WireGuard endpoint (dns name, subnet, `UDP <port>` chip on the edge) → Microsoft Azure (region, online), with a status pill; node and edge colours healthy/degraded/down/unknown; clicking Clients → `/clients`, endpoint → SSH drawer (address, Allow SSH from this address, password revealed only on press via `fetchSshPassword`), Azure → "In Azure right now" drawer (inventory with its age, Check Azure → `useReconcile`). Key metrics (5 cols): `SegmentedControl` Live/1h/24h/7d/30d; a 3 + 4 tile grid: Public endpoint (copy), Connected clients n/m with `ProgressBar`, Latency avg with `Sparkline`; DNS status (tunnel DNS), Heartbeat age, Session cost, Availability `Ring`. Each tile states its window and age.
4. **Row 3 during a run:** a chip row All/In progress/Completed/Pending with counts and an Auto-scroll `Switch`; Deployment pipeline `StepList` (5 cols; click a step to jump to its log group); Live logs `LogView` (4 cols; search, level filter, full-screen `Modal`); right column (3 cols) Recent events (latest 5 of `activity.all`) over Network traffic `TimeSeriesChart` (in/out, 5m/15m/1h/session). **No run:** Last run `StepList` (read-only, link to its log) in the pipeline slot and the traffic chart widened into the log slot; the right column shows Recent events over Speed test (latest results + Run speed test).
5. **Row 4:** Health summary (4 cols: VM reachable, WireGuard service, DNS resolving, tunnel connectivity, self-test, each with age), Cost impact (4 cols: session £, `Sparkline variant="bars"`, typical session, link `/cost`), Watchman notes (4 cols, fills the mockup's "Activity feed" slot: unacknowledged notes, Acknowledge).

**Phone:** state word, compact topology (three dots and lines), lights (tunnel, DNS, clients online, home site), the state's main action as a full-width button, small buttons (Hibernate, Tear down, Speed, Move, Details); during a run a progress line with the current step; steps and log open a `Sheet`.

- [ ] **B1** `overview.test.tsx`: `deploying shows step n of m, elapsed and usually about, never a countdown`; `Cancel is offered only during a GitHub run`; `destroyed shows the deploy form; an over-budget deploy needs the confirmation`; `running shows Extend, Hibernate, Move, Speed test and Tear down; Tear down needs the typed word`; `failed links to the failed step's log and offers Clean up`. FAIL; build banner + actions; PASS. Commit.
- [ ] **B2** `metrics.test.tsx`: `the range switch refetches vm history with that range`; `destroyed with no history shows no data, not zeros`; `a stale heartbeat greys the tiles and shows their age`; `topology nodes take degraded and down colours with words`. FAIL; build; PASS. Commit.
- [ ] **B3** `run.test.tsx`: `clicking a step scrolls the log to its group`; `step filter chips filter the list`; `the log polls every 5 s while running and stops after`. Then `lower.test.tsx`: `acknowledging notes calls notes/ack and hides them`; `?action=deploy opens the deploy form and runs nothing`. FAIL; build; PASS. Commit.
- [ ] **B4** `phone.test.tsx` (`setViewport("phone")`): `phone shows the state's main action and opens steps in a sheet`. FAIL; build; PASS. Commit.
- [ ] **Done when:** gate passes and `npm run shots -- --scenario deploying --routes /` and `--scenario running --routes /` exit 0.

---

## Area C: Clients

**Branch:** `feat/view-clients`. **Owns:** `web/src/views/clients/**`. **Consumes:** `useClients`, `useClient(id)`, `useHistory({scope:"client"})`, `useAddClient`, `useRekeyClient`, `useEditClient`, `useDeleteClient`, `SidePanel`, `genKeypair`, `confFileName`, `QrCode`, `downloadFile`. **Scenarios:** `running` (compare), `destroyed`, `empty`.

**Mockup regions (`01_29_44 PM-2`):**
1. **Header:** "Clients" + subtitle; right: `EnvironmentControl`, read-only Region, gear, primary "Add client".
2. **KPI row (6 tiles, each filters the table, `aria-pressed`):** Total, Online now (`Ring`), Average latency, Full-tunnel, Stale handshakes (no handshake in 30 days), Expiring soon (7 days).
3. **Toolbar:** filter tabs All / Online / Offline / Expiring / Home site / Full tunnel with counts; `SearchInput` (name, address, public key); Sort `Select`.
4. **Table (9 cols with the panel open, 12 without):** Name (icon, tags incl. "needs new config" after a key rotation, stale), Address, Status pill (online/offline/disabled/expired/loading onto VM/unknown), Last handshake, Latency, Session traffic (`Sparkline` + ↑/↓ bytes), Allowed IPs (exact, "Full tunnel" tag), Expires (with "n days" chip), overflow menu. Rows link to `/clients/:id`.
5. **Split view (3 cols, `SidePanel`, open at `/clients/:id`, close returns to `/clients`):** header (status dot, name, address, close); tabs Overview / Configuration / Traffic / Activity. Overview: online card with latency, Session traffic + Latency mini tiles, `KeyValue` (tunnel address, public key, endpoint, allowed IPs, client type, expires) with copy. Configuration: Home LAN / Azure VNet / tunnel DNS `Switch`es, expiry, enabled, **Get new config** (re-key → the wizard's Delivery step). Traffic: 24h/7d chart, top destinations. Activity: this client's changes and network moves. Footer actions: Get new config, Enable/Disable, Delete (typed). Home site: no re-key, no config; enable/disable only, with the reason shown.
6. **Lower row:** Top talkers (bars, 4 cols), Client status `Donut` (online/offline/expiring/full tunnel, 4 cols), and in the UX-notes slot **Traffic this session** for all clients from `trafficHist` (4 cols).
7. **Add-client wizard (`Modal`, `Sheet` on phone):** Name → Routing (Standard, +Home LAN, +Azure VNet, Full tunnel; shows the exact AllowedIPs) → Expiry → Delivery (QR, `.conf` download, copy). Keys made in the browser; private key only in component state.

**Phone:** one line per client (light, name, latency or state) opening a `Sheet` with the panel's tabs; "Add a client" opens the wizard as a sheet with a large QR.

- [ ] **C1** `clients.test.tsx`: `KPI tiles filter the table and show pressed`; `filter tabs and search narrow rows by name, address and key`; `status words cover disabled, expired and loading onto VM`; `offline latency shows a dash, not 0`. FAIL; build; PASS. Commit.
- [ ] **C2** `panel.test.tsx`: `opening a row sets /clients/:id and Back closes the panel`; `route toggles send PUT with only the changed field`; `the home site offers enable/disable only`; `Delete needs the typed name`. FAIL; build; PASS. Commit.
- [ ] **C3** `wizard.test.tsx` (stub `crypto.subtle`): `routing step shows the exact AllowedIPs for each choice`; `the private key is never sent and is gone after close` (assert every `fetchMock` call body lacks it, the POST carries only the public key, and the DOM has no key after Done and after Escape); `a server error keeps the name and routing but makes a fresh key on retry`; `a browser without X25519 shows the message`; `?action=add opens the wizard`. FAIL; build; PASS. Commit.
- [ ] **C4** `phone.test.tsx`: `phone rows open a sheet`. FAIL; build; PASS. Commit.
- [ ] **Done when:** gate passes and `npm run shots -- --scenario running --routes /clients,/clients/1` exits 0.

---

## Area D: Firewall

**Branch:** `feat/view-firewall`. **Owns:** `web/src/views/firewall/**`. **Consumes:** `useFirewall` (with I0's `version`, `draft`), the `useDraft*` mutations, `useSimulate`, `useRuleHistory`, forward and capture mutations, `useClearCounters`, `Diff`, `SidePanel`/`Drawer`. Codes against I0's types with `mockFetch`; does not need A merged. **Scenarios:** `running` (has A's draft; compare), `destroyed`.

**Mockup regions (`01_29_44 PM-3`):**
1. **Header:** shield icon, "Firewall", subtitle; right: Policy status (Active/waiting for VM/refused by the VM, "last applied" age) and the **draft bar** when `draft` exists: "n unpublished changes", Discard, primary "Review & apply". Without a draft the buttons are absent.
2. **KPI row (5 tiles):** Policy set (n rules, "x custom · y default", Manage → focuses the table), Default action (Allow/Deny; changing it edits the draft), Recent drops 24h (count, ▲/▼ vs `previous24h`, "from n unique sources", `Sparkline variant="bars"` of `hourly24h`), Published ports (n active, Manage), Packet capture (Ready/Running, Start capture).
3. **Rules panel (8 cols):** tabs All / Custom / Default (starter) / Disabled with counts; search; zone `Select`; action `Select`. Table: drag handle, #, Name (+ "Custom" tag, problem warning), From (zone icon, label, address), →, To, Service/Port, Action pill, Hits 24h (+ bar `Sparkline`; click opens rule history), Status `Switch`, menu (Edit, Move up/down, Delete). The default row is last, locked, "Always on". When a draft exists the table shows draft rules with their `mark`. Footer: "Drag to reorder. Top to bottom, first match wins.", Add rule, Test simulation (focuses the simulator), Clear hit counters (instant, with confirmation; shows `countersClearedAt`).
4. **Right column (4 cols):** Recent drops (live age; time, proto+port, src → dst, zone chips, **Allow** → `from-drop`) over Published ports (cards: name, proto+port → target, edit, delete; Add published port, guided create; instant).
5. **Bottom row:** Network zones (5 cols: five zone cards with flow arrows coloured by whether a rule allows them; clicking a zone filters the table), Test specific traffic (4 cols: From/To `Select` of zones, clients, or an address; protocol; port; Live/Draft switch when a draft exists; result card "Would be ALLOWED/DENIED", matched rule and place, partial and limited notes), and in the UX-notes slot **Packet capture** (3 cols: interface, who, seconds, filter, Start; progress; download list).
6. Below 1400 px wide the right column becomes one `Tabs` panel (Drops | Published ports | Capture), as spec §8.3's right-panel tabs.
7. **Review modal:** `Diff`-style list of added/removed/changed (field before → after)/moved/default; `stale` warning; Apply sends `baseVersion`; 409/422 messages shown in the modal; success closes and the header shows "waiting for VM" until `policy.state === "applied"`.
8. **Rule drawer** (`/firewall/rules/:id`, and Add rule): the edit form (name, from, to, proto, ports, action, enabled, log); saves to the draft; hit history chart via `useRuleHistory`.

**Phone:** lights (applied, rules, recent drops, default), rule list opening sheets, draft bar pinned above the tab bar.

- [ ] **D1** `rules.test.tsx`: `filter tabs use starter for Default and Custom`; `the default row is last and has no toggle or handle`; `toggling a rule sends PUT draft rule enabled`; `hits show no data when hits24h is null`. FAIL; build; PASS. Commit.
- [ ] **D2** `reorder.test.tsx`: `drag to a new place sends one move with to`; `dropping in place sends nothing`; `keyboard reorder with Alt+Arrow sends dir and keeps focus on the row`; `the default row is not a drop target`. FAIL; build (pointer events + keyboard; no new dependency); PASS. Commit.
- [ ] **D3** `draft.test.tsx`: `the draft bar shows the change count and Discard calls DELETE firewall/draft`; `review lists added, removed, changed fields, moved and default`; `apply sends baseVersion and then shows waiting for VM until applied`; `a 409 on apply keeps the draft bar and shows the message`; `refused by the VM shows the agent's error`. FAIL; build; PASS. Commit.
- [ ] **D4** `panels.test.tsx`: `Allow on a drop calls from-drop`; `the simulator sends policy draft when Draft is chosen and shows partial and limited notes`; `clicking a zone filters the rules`; `published port create shows Azure's warning`; `?action=capture focuses the capture form`; `?action=add-rule opens the rule drawer`. FAIL; build; PASS. Commit.
- [ ] **D5** `phone.test.tsx`: `phone pins the draft bar and opens rules in sheets`. FAIL; build; PASS. Commit.
- [ ] **Done when:** gate passes; after A is merged into the integration branch, `npm run shots -- --scenario running --routes /firewall,/firewall/rules/1` exits 0 (before that, shoot against D's own branch with `--scenario running` and note that the draft bar is absent).

---

## Area E: Activity

**Branch:** `feat/view-activity`. **Owns:** `web/src/views/activity/**`. **Consumes:** `useActivity({range, tab, kind, q, page})` (includes `previous`), `useRun(id)`, `useRunLog(id, live)`, `Diff`, `StackedBars`. **Scenarios:** `busy-month` (compare), `deploying`, `empty`.

**Mockup regions (`01_29_45 PM-4`):**
1. **Header:** "Activity" + subtitle; right: range `Select` (1h, 6h, 24h, 7d, 30d; URL `?range=`), refresh `IconButton`, Live indicator (`DataAge`).
2. **KPI row (6 tiles, each with its basis and a "vs previous period" delta from `previous`):** Deploys, Median deploy duration, Success rate (`Ring`, "n successful / m total"), Failed runs, Config changes, Watchman problems (spec wording; the mockup's "Watchman state").
3. **Timeline (8 cols):** `StackedBars` by type (Deploy, Tear down, Failure, Config, Firewall, Watchman) with legend, hover counts, brush selection that filters the table and stream; Reset clears it.
4. **Tabs + table (8 cols):** Runs / All activity / Config changes / Watchman notes (spec's four; the mockup's "Firewall events" is the Config changes kind filter `firewall`); search; kind filter. Runs columns: When, Action, Result pill, Duration, Cost impact (marked "est."), Actor, Source (dashboard, schedule, auto-destroy, watchman), Notes, chevron. Paging for changes (`more`).
5. **Right column (4 cols):** Live event stream (`all`, newest first, type icon and word, kind `Select`, Auto-scroll `Switch`; polled, not streamed) over Change log (search, kind `Select`; When, Change, What changed, By; row opens the change drawer).
6. **Bottom row:** Run details (6 cols: the selected run, else the latest; horizontal step progress with durations and a result pill) and Live output (6 cols: the run's log tail, "Open in logs" → `/activity/runs/:id`). The UX-notes slot closes up into these two.
7. **Drawers:** run drawer at `/activity/runs/:id` (saved steps with durations, log loaded on open); change drawer (before/after `Diff`, actor, time).

**Phone:** last run and last note as cards, buttons for Runs, Notes and Changes opening lists in sheets.

- [ ] **E1** `activity.test.tsx`: `range select updates the URL and refetches`; `KPIs show deltas against previous and no delta when previous is empty`; `success rate with no finished runs shows no data`. FAIL; build; PASS. Commit.
- [ ] **E2** `timeline.test.tsx`: `brushing a window filters the table and the stream, Reset clears`; `tabs switch rows and keep range in the URL`; `changes page forward when more is true`. FAIL; build; PASS. Commit.
- [ ] **E3** `drawers.test.tsx`: `opening a run loads its log once and polls only while active`; `a change opens with its before and after diff`; `Back closes the run drawer`. Then `phone.test.tsx`: `phone shows last run and last note`. FAIL; build; PASS. Commit.
- [ ] **Done when:** gate passes and `npm run shots -- --scenario busy-month --routes /activity` exits 0, then again with `--routes /activity/runs/ID` where ID is the newest run's `id` from `GET /api/v1/activity?range=30d`.

---

## Area F: Cost

**Branch:** `feat/view-cost`. **Owns:** `web/src/views/cost/**`. **Consumes:** `useCost(range)` (`breakdown`, `previous`, `projection`, `budget`, `insights`, `sessions`), `useRun`, `BarChart`, `Donut`, `ProgressBar`. **Scenarios:** `busy-month` (compare), `running`, `empty`.

**Mockup regions (`01_29_46 PM-5`):**
1. **Header:** "Cost" + subtitle; right: range `Select` (This month, Last 7 days, Last 30 days; URL `?range=`), "Compare to previous period" `Switch` (only when `previous` has days).
2. **KPI row (5 tiles):** This session (estimate; Idle/Running), Month to date (Azure actual, as-of date, vs previous), Estimated this month (projection; basis in a tooltip), Monthly budget (`ProgressBar`; "spent" and "projected" as two figures), Cost guard (state; → `/settings/automation`).
3. **Row 2:** Spend over time (5 cols: `BarChart` daily actuals, budget line, dashed projection, previous period when switched on; footnote "GBP · UK time · Azure figures lag up to 24 h"), Spend breakdown `Donut` by type with legend £ and % (4 cols; "Azure actual, as of <day>" or "Estimate"), Forecast vs budget (3 cols: forecast, budget, on-track pill, cumulative actual vs budget chart).
4. **Row 3:** Spend by region (4 cols, bars; `SegmentedControl` Region / Resource type), Cost per session (4 cols: average, most expensive, total sessions, `BarChart` per session), Insights (4 cols: `insights` only, each with evidence; empty state when none).
5. **Row 4:** Sessions table (12 cols, closing up the UX-notes slot): search, status chips All / Running / Ended, region `Select`; columns Started, Status, Region, VM size, Duration, Estimated cost, Cost / hour, chevron → session drawer (its run, clients used, traffic).

**Phone:** session and month totals with budget bar; buttons open the chart and sessions in sheets.

- [ ] **F1** `cost.test.tsx`: `range select updates the URL and refetches`; `budget shows spent and projected as two figures`; `projection tooltip states its basis`; `no actuals and no sessions shows no data in every tile and the donut`. FAIL; build; PASS. Commit.
- [ ] **F2** `charts.test.tsx`: `compare switch adds the previous series and is hidden without previous days`; `breakdown labelled Estimate when basis is estimate`; `region and resource type toggle swap the bars`; `days with no figure are gaps, not zero bars`. FAIL; build; PASS. Commit.
- [ ] **F3** `sessions.test.tsx`: `chips and search filter sessions; a running session says running`; `a session opens its drawer with its run`. Then `phone.test.tsx`: `phone shows totals and opens sessions in a sheet`. FAIL; build; PASS. Commit.
- [ ] **Done when:** gate passes and `npm run shots -- --scenario busy-month --routes /cost` and `--scenario empty --routes /cost` exit 0.

---

## Area G: Settings

**Branch:** `feat/view-settings`. **Owns:** `web/src/views/settings/**`. **Consumes:** `useSettings`, `useSession`, `useOverview`, settings/profile/schedule/lock/restore/push mutations, `useHealthCheck`, `useReconcile`, `downloadFile`, `QrCode`, `ConfirmByTyping`. **Scenarios:** `running` (compare), `destroyed`, `empty`.

**Sections (horizontal tabs, URL `/settings/<section>`, default `overview`):** Overview, Deployment, Automation, Security, Backup & Recovery, Mobile, Maintenance. **Ruling:** the mockup's separate "Scheduling" tab is folded into Automation (spec §8.6), and Maintenance is added; seven tabs.

**Mockup regions (`01_29_46 PM-6`, the Overview section):**
1. **Header:** "Settings" + subtitle; right: `EnvironmentControl`, read-only Region and VM size, Estimated cost / day (`hourlyRateGbp × 24`, marked estimate).
2. **Section tab bar** (icon + word, pill active state).
3. **Overview summary banner (12 cols):** icon, "Settings overview" + one honest sentence; WireGuard service, DNS resolution, Configuration (setup gaps), Cost guard, each with age; **Run health check** (`useHealthCheck`: disabled unless running, then "waiting for the VM" until `snapshot.selftest` is newer than the request, then the result).
4. **Row 2:** Environment & Deployment summary (5 cols: region, VM size, test VM, auto-destroy, idle limit, budget warning; "Edit" → Deployment), Profile presets (4 cols: current profile, others with Use / menu, Add profile → Deployment), Cost & usage (3 cols: per day, per month, budget, cost guard state, Edit limit → Automation) over Deployment actions (Deploy → `/?action=deploy`, Check Azure → `useReconcile`, Tear down → `/?action=destroy`).
5. **Row 3:** Setup checklist (3 cols: configured / missing / unknown per group), Server key (3 cols: short key, copy, last rotated, → Security), Backup & recovery (3 cols: latest, count, Download export, Restore → Backup section), Schedules (3 cols: day pills, from/until, profile, Add → Automation).
6. **Other sections**, one at a time, with an unsaved-changes bar (Save / Discard) when a form is dirty, and a guard when leaving a dirty section: **Deployment** (next-deploy settings form; profiles table: use, create, edit, delete, deployed one marked). **Automation** (schedules list: UK time, next start, enable, edit, delete, day `Chips`; auto-destroy default, idle limit, expiry action, standby limit, cost guard and budget). **Security** (server public key, copy, last rotated; SSH allowed-from; "How key rotation works" help `Drawer`). **Backup & Recovery** (Download export, configs by day list, staged restore: file → preview of counts → confirm). **Mobile** (install QR of `publicUrl` + instructions, phone alerts on/off, test notification, signed-up phones with remove). **Maintenance** (release lock with holder and age, rotate key, restore, destroy infrastructure; each with its own consequence sentence and `ConfirmByTyping`).

**Phone:** a list of the seven sections, each opening a `Sheet`.

- [ ] **G1** `settings.test.tsx`: `tabs follow /settings/:section and Back restores the section`; `an unknown section falls back to overview`; `editing marks the section dirty; Discard restores; Save sends only changed keys`; `leaving a dirty section asks first, in the page, not with confirm()`. FAIL; build; PASS. Commit.
- [ ] **G2** `overview-section.test.tsx`: `health check is disabled unless running, then waits for a newer self-test and shows its result`; `a 409 from health check shows its message`; `deployment actions navigate with ?action= and run nothing`. FAIL; build; PASS. Commit.
- [ ] **G3** `sections.test.tsx`: `schedules live under Automation with UK times and next start`; `restore shows the preview counts before confirm`; `export downloads through downloadFile`; `release lock shows holder and age and needs confirmation`; `push test and remove phone call their endpoints`. Then `phone.test.tsx`: `phone lists seven sections that open sheets`. FAIL; build; PASS. Commit.
- [ ] **Done when:** gate passes and `npm run shots -- --scenario running --routes /settings,/settings/automation,/settings/maintenance` exits 0.

---

## Integration

1. **Merge order** onto `feat/views` (from `feat/views-contract`): A, then D (D's draft UI meets the real backend), then B, C, E, F, G. Run the gate after each merge.
2. **Hot spots:** `shared/api.ts` (only I0 and A: keep I0's types, A must not rename), `worker/src/api/index.ts` (one mount line), `worker/src/devseed.ts` (A only), `web/src/views/pages.tsx` / `routes.ts` / `queries.ts` / `mutations.ts` (should be untouched by areas; any area diff there is folded into I0's shape or rejected). Promote any component an area built locally that two areas built twice.
3. **Gallery:** add promoted components to `web/src/gallery.tsx`.
4. **Full gate:** `npm test`, `npm run typecheck`, `npm run build:web`.
5. **All-views shots:** `npm run shots -- --scenario <s>` for each of `running`, `deploying`, `busy-month`, `destroyed`, `empty`, `failed`, `standby` (all routes): every run exits 0. Put each view's 1600 × 900 dark shot beside its mockup and list the differences.
6. **Whole-branch review:** one fresh reviewer on the most capable model (opus), given this plan, the spec, the six mockups and the shots; asked specifically about the Review Focus list.
7. **One fix pass:** each finding fixed failing-test-first (or a shot for a visual finding); gate and shots again.
8. **PR** from `feat/views` into `redesign` with CI green, then merge. Not `main`, no deploy: switch-over is plan 5.

## Final review checklist

- Every capability in spec §13 has a control in some view (walk the list against the merged app at 1600 × 900).
- Every view: loading skeleton, empty, error with Retry, stale greyed with age, disconnected banner (spec §10).
- No desktop view scrolls at 1100 × 600 in either theme; phone views at 390 × 844 have no horizontal scroll.
- No personal data in fixtures, seeds, tests or screenshots committed anywhere.
- Firewall: draft → review → apply → "waiting for VM" → "applied" works end to end against the `running` scenario in `npm run dev:web` + `npm run dev:api`.
