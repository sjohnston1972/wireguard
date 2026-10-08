# wg-admin: demo mode and the dev seed-scenario picker (design)

Date: 2026-10-08. Status: direction **approved by Steven on 2026-10-08** ("Both": demo mode on the live site AND a scenario
picker on the dev server; Appendix A). The details below are decided here under that approval; §3 lists every decision made
while writing, as rulings, including one change to the approved direction (ruling 1: the demo store is a Durable Object, not a
second D1 database and KV namespace) with the measurement behind it. Builds on the redesign spec
(`2026-10-02-observability-redesign-design.md`, §7 design system, §10 states), the widgets spec (`2026-10-03-widgets-design.md`,
ui_prefs) and the dev seeder as on `main` at a525546 (`everything` story, issue #96). The plan is
`docs/superpowers/plans/2026-10-08-demo-mode-plan.md`. **(V)** marks a fact to check during the build; the area reports
record the answer.

## 1. Intent

1. **Demo mode (live site).** A signed-in person can switch their own view of wg-admin to a believable, fully populated,
   made-up environment (the dev seeder's `everything` story), for screen shares, recordings and showing the app to someone,
   without exposing a single real client, address, run or cost, and without any button being able to touch real
   infrastructure. Switching it off brings the real data straight back. Nobody else's view changes.
2. **Seed-scenario picker (dev server only).** On `npm run dev` / `dev:api`, Settings lists the seed stories (empty,
   destroyed, deploying, running, failed, standby, busy-month, insights, labs, labs-setup, everything) with a Seed button each,
   so a developer no longer needs `npm run seed -- <story>` in a terminal. On the live site the section does not exist and
   `/__dev/seed` stays a 404.

Non-goals: no demo for the token routes (VM heartbeat, GitHub callbacks, one-tap notification buttons: those are machines
acting on the real setup); no per-person demo stories; no editing inside demo mode (actions are off, by design); no change to
cron, the watchman, the lab watch or the insights collector beyond proving they never see demo data.

## 2. Decisions (approved by Steven, 2026-10-08)

| Topic | Decision |
|---|---|
| Scope | Both: demo mode on the live site and the scenario picker on the dev server. |
| Demo data | The `everything` story, dates relative to "now" at seed time; written only to a separate demo store. |
| Refresh | Settings "Refresh demo data" (POST, Access-authenticated, writes only to the demo store); automatic on first enable when the store is empty. |
| Switch | Per Access identity, stored in the real store (the only real-store write demo mode makes). |
| Reads | When on, every read for that person comes from the demo store. |
| Writes | When on, every mutating route refuses with 409 "Demo mode is on: actions are off." Exceptions: turning demo mode off, refreshing demo data. |
| Outside calls | None while serving demo: no Azure, GitHub, WireGuard/VM, Graph, DNS or push call; proven by tests with a fetch spy. |
| Background | Cron, watchman, lab watch and insights never touch the demo store and never act on demo data. |
| UI | Settings "Demo mode" section (switch, explanation, Refresh, last refreshed); app-wide amber banner "Demo data — nothing here is real. Actions are off." with Turn off; actions visibly disabled or caught by a global client guard; light and dark tokens. |
| Dev picker | Settings section on the dev server only, behind the same double lock as `/__dev/seed`; not rendered and the endpoint 404s on the live site. |

## 3. Rulings (decided while writing)

1. **The demo store is one SQLite-backed Durable Object, `DemoStore` (binding `DEMO_STORE`), not a second D1 database and KV
   namespace.** Measured on `main` a525546 (harness, 2026-10-08, `seedScenario(env, "everything")`): **563 single D1
   statements + 264 `batch()` calls carrying 3,800 statements**, about **4,600 table rows**, 10 KV puts, 18 R2 puts, **274 ms**
   wall time in Node. The account is designed for the Workers **Free** plan (azure insights spec §7: 10 ms CPU per invocation;
   `cron.ts`: 50 outside calls). Seeding a D1 + KV demo store from a Worker request would need hundreds of D1 calls and far
   more than 10 ms CPU in one invocation **(V: Cloudflare D1 limits, "queries per Worker invocation", 50 on Free)**, and every
   refresh would spend the account's shared daily D1 write allowance (100k rows/day on Free) that the real heartbeats and
   history depend on. A Durable Object has its own SQLite database, runs the seeder in-process (no per-query network call, no
   per-invocation query cap), has a 30 s CPU allowance per request **(V: Durable Objects limits on the account's plan)**, and
   its rows are billed to Durable Object storage, not D1. It also needs **no Cloudflare resource to be created by hand and no
   token step**: `wrangler deploy` applies the new class migration (`v2`, `new_sqlite_classes = ["DemoStore"]`) like RunLock's
   `v1`. Physically separate storage is kept: the demo store is its own object with its own database; the real `DB`, `STATUS`,
   `STATE` and `RUN_LOCK` bindings are never handed to any code that runs against it (ruling 3). Revisit on Workers Paid if a
   D1 copy is ever wanted (Appendix B).
2. **Demo reads are served inside the DemoStore.** For a person in demo mode the Worker forwards each read to the DemoStore
   (one RPC call), which runs the **same** `/api/v1` code (`buildApi()`) against the demo environment and returns the answer.
   One hop per request; no per-query round trips; every page and widget works unchanged because it is the same code.
3. **The demo environment is built from an allow-list, never by copying the real one.** `makeDemoEnv()` creates a fresh
   object holding: the plain `[vars]` named in `DEMO_VARS` (a test pins the list to `wrangler.toml`'s `[vars]`), and four
   facades over the DemoStore's SQLite: `DB` (D1-shaped), `STATUS` (KV-shaped), `STATE` (R2-shaped), `RUN_LOCK`
   (Durable-Object-namespace-shaped, running RunLock's own handler on demo storage). It has **no secret at all** (no Azure,
   GitHub, Cloudflare DNS, Access, ntfy or VAPID private key), no `ASSETS`, no `DEMO_STORE`, and never `AUTH_DEV_BYPASS`. It
   carries `[DEMO_MARK]: true` (a module-private `Symbol`, which survives `{ ...env }` and cannot be set from configuration);
   `isDemoEnv(env)` reads it.
4. **Classification is by method, with two short named lists, shared by Worker and app** (`shared/demo.ts`):
   `demoRouteKind(method, path)` answers `control`, `read` or `refuse`. GET and HEAD are `read`; `POST /firewall/simulate`
   (documented "nothing is written") is `read`; `GET /demo`, `PUT /demo` and `POST /demo/refresh` are `control`; **everything
   else is `refuse`**. A new mutating route is therefore refused in demo mode by default; a new GET is served from the demo
   store by default and must pass the no-outbound test (§9), whose route table must name it.
5. **The switch is one row per person in a new real table `demo_mode`** (migration `0022_demo_mode.sql`: `user TEXT PRIMARY
   KEY` (Access email, lower case, as ui_prefs), `since TEXT NOT NULL`, `WITHOUT ROWID`). D1, not KV: the switch must take
   effect on the very next request at every edge (KV can serve a stale copy for up to 60 s, which would show real data to
   someone who just switched demo on, or demo data after switching off). Plain email, not a hash, matching ui_prefs. Cosmetic
   like ui_prefs: never in the backup export, restore, audit log or Activity; the dev seeder never wipes it.
6. **Fail closed.** If the switch cannot be read (D1 error), every Access-protected request answers **503 `demo_unknown`**
   "Could not check demo mode. Try again." rather than guessing: guessing "off" could show real data during a recording;
   guessing "on" could hide a real problem. Control routes answer the same 503 for the same reason.
7. **Every `/api/v1` answer says where it came from:** header `X-WG-Data: real` or `demo`, set by the Worker's gate (also on
   errors and on control routes, where it states the person's mode after the call). The app drops any answer whose source
   differs from the mode it believes is current, clears its whole query cache and re-reads `/demo` (§8.2). This is how demo
   and real can never mix in the app, even with a request in flight across the switch.
8. **Refreshing is rate-limited by measured writes.** The DemoStore sums SQLite `rowsWritten` for every refresh and keeps
   today's total (UTC day). A refresh is refused (**409 `demo_busy`**, with the time it will be allowed) when it is less than
   **10 minutes** after the last one, or when `rowsToday + 2 × lastRefreshRows` would exceed **`DEMO_DAILY_ROWS = 30_000`**
   (well under the Free plan's 100k Durable Object rows/day, which RunLock shares) **(V: measured rows per refresh, E5)**.
9. **Enable seeds when needed.** `PUT /demo { on: true }` first asks the DemoStore to be ready: it seeds when the store is
   empty, when its schema is older than the deployed migrations, or when the data is more than **12 hours** old (the running
   story's heartbeat and timers would otherwise look stale), budget permitting. Only then is the switch row written. If the
   store is empty and cannot be seeded (budget), enabling is refused with the reason; the switch stays off.
10. **A deploy that adds a migration makes the demo store's schema stale.** The DemoStore stores the hash of the schema it
    was built with; on a mismatch, a demo read triggers a refresh (budget permitting) or answers **503 `demo_outdated`**
    "Demo data needs a refresh after an update. Press Refresh demo data in Settings." The banner's Turn off always works.
11. **The schema is bundled as a generated module.** `scripts/demo-schema.mjs` writes `worker/src/demo/schema.gen.ts` (every
    `worker/migrations/*.sql`, in order, as strings, plus their SHA-256); `--check` exits 1 when stale. A Worker test and the
    deploy steps run the check. (Wrangler's Text rule for `.sql` would avoid the file, but Vitest would need a loader; the
    generated file works in both.)
12. **RunLock's request handling becomes a function** `lockFetch(storage, request, now)` in `lock.ts`; `RunLock.fetch` calls
    it. The demo `RUN_LOCK` facade calls the same function on demo storage, so the demo snapshot behaves exactly like the real
    one. No `new RunLock()` outside the runtime.
13. **Seeder targeting needs no rewrite.** `seedScenario(env, …)` already writes only through `env.DB`, `env.STATUS`,
    `env.STATE` and `env.RUN_LOCK`; given the demo environment it can only write demo storage. It gains an `actor` option
    (default `dev@localhost`; demo uses `demo@example.com`) so demo audit rows and runs do not say "dev@localhost". The proof is
    a tripwire test (§9): the DemoStore is constructed with an env whose real bindings throw on any touch.
14. **Stand-ins are allowed in demo too.** The three dev-only stand-in checks (Azure feed rows shown as connected,
    `insights/read.ts`; backups under `devseed/`, `backup.ts`; seeded lab topology rows, `labs/topology.ts`) move behind one
    helper, `standInsAllowed(env) = env.AUTH_DEV_BYPASS === "1" || isDemoEnv(env)`, still requiring the seed's marker in the
    (demo) KV. Nothing is ever fetched on the strength of a stand-in; every fetch still asks `canAzure`/`insightsConfigured`,
    which are false in demo (no secrets).
15. **What the app is told about capabilities in demo.** The demo environment has no secrets, so the server never even tries
    an outside call. But the app must not show "GitHub not connected" or a setup checklist over the demo: in a demo
    environment `missingSecrets()` answers `{}` and the response fields `actions.canDispatch` (Overview) and `autoCleanup`
    (Labs) answer `true`. Server logic keeps calling the real `canDispatch`/`canAzure`/`canDns`, which stay false.
16. **Outside demo-routed paths:** `GET /health` for a person in demo mode answers from the demo snapshot (served by the
    DemoStore); `GET /captures/:id` answers 404 "Not available in demo mode." (seeded captures have no file); any other non-GET
    behind Access answers the 409. The token routes (`/api/agent`, `/api/callback*`, `/api/act/:token`) and `/__dev/seed` are
    untouched: they are not per-person and act on the real setup.
17. **Phone alerts stay real.** Cron and push are untouched, so real alerts keep arriving during demo mode, and their one-tap
    buttons act on the real setup (they always did; ruling 16). Tapping an alert opens the app, which shows demo data; the
    banner says so. The service worker's automatic re-subscription (`pushsubscriptionchange`) is a write and is refused like
    any other while demo mode is on; Settings → Mobile shows it after switching off and one tap restores it (the service
    worker already defers to Settings when this fails). Risk accepted: rare, visible, recoverable.
18. **Visible disabling is limited to the primary actions; everything else is caught by one client guard.** Disabled with the
    tooltip "Actions are off in demo mode": the Overview action bar (Deploy, Tear down, Hibernate, Resume, Extend, Cancel,
    Move), the lab dialog's Deploy, Clients' Add client, Firewall's Apply draft and every Settings section's Save. Any other
    write is stopped by the client guard before it is sent and shown as the toast "Demo mode is on: actions are off."
19. **Widget layouts in demo are the demo store's** (defaults after a refresh). Layout edits are writes and are refused. Reason:
    one rule ("every read from demo") is easier to trust than a carve-out, and a demo should look like the app as it ships.
20. **The dev picker is a separate Settings section, "Dev data", present only when the Worker says so.** `GET /demo` includes
    `devSeed: { scenarios }` only when `devSeedAllowed(env, url)` (AUTH_DEV_BYPASS exactly "1" AND a localhost request);
    otherwise `devSeed: null` and the section, its palette entry and its code path are not rendered. `/__dev/seed` keeps its
    lock and gains one more: a browser request from another site (`Sec-Fetch-Site` present and not `same-origin`) is refused
    403, so a web page cannot wipe a developer's database; the seed script (no such header) still works.
21. **No audit entry for the switch.** It is cosmetic per person (like widget layouts) and would itself be a real-data write
    beyond the switch row.

## 4. Architecture

```
browser ──► Worker fetch
             ├─ token routes, /__dev/seed, /assets/*      (unchanged, before the login)
             ├─ requireAccess → sameOriginOnly → HX shim  (unchanged)
             ├─ demoGate (NEW, worker/src/demo/gate.ts)
             │    path /api/v1/demo* (control) ─────────► buildApi() with the REAL env (api/demo.ts)
             │    switch row for c.var.user? ── D1 error ► 503 demo_unknown
             │      off ─────────────────────────────────► next(): real routes, X-WG-Data: real
             │      on, read (GET/HEAD, POST /firewall/simulate, GET /health)
             │           ────────────────────────────────► DEMO_STORE "demo" .serve(request, user)
             │      on, GET /captures/:id ───────────────► 404 "Not available in demo mode."
             │      on, anything else ───────────────────► 409 demo_mode "Demo mode is on: actions are off."
             └─ /api/v1 (real), /captures, /health        (unchanged)

DemoStore (Durable Object, SQLite)          cron (unchanged): watchman → lab watch → insights, real env only
  demoScope.run(…)  ← fetch guard active
  makeDemoEnv(vars allow-list, facades over ctx.storage.sql)
  serve(): Hono { user } + buildApi() + /health, against the demo env
  refresh(): deleteAll → schema → seedScenario(demoEnv, "everything", now, { actor }) → meta
  status(): { refreshedAt, rowsToday, lastRows, schemaOk, nextRefreshAt }
```

### 4.1 Files (names fixed for the plan)

| File | Role |
|---|---|
| `shared/demo.ts` | `DEMO_CONTROL` (`GET /demo`, `PUT /demo`, `POST /demo/refresh`), `DEMO_READ_POSTS` (`/firewall/simulate`), `demoRouteKind(method, path)`, `DEMO_REFUSED_MESSAGE`, `DEMO_DATA_HEADER = "X-WG-Data"`. |
| `shared/api.ts` | `DemoStatusResponse`, `DemoSetBody` (§7). |
| `worker/migrations/0022_demo_mode.sql` | The switch table (ruling 5). |
| `scripts/demo-schema.mjs` | Writes/checks `worker/src/demo/schema.gen.ts` (ruling 11). |
| `worker/src/demo/sql.ts` | `SqlLike` (the subset of `SqlStorage` used: `exec(query, ...bindings)` → cursor with `toArray()` and `rowsWritten`), `WriteMeter`, facades `d1Over`, `kvOver`, `r2Over`, `doStorageOver`. |
| `worker/src/demo/env.ts` | `DEMO_MARK`, `isDemoEnv`, `DEMO_VARS`, `makeDemoEnv(vars, sql, meter)`. |
| `worker/src/demo/guard.ts` | `demoScope` (AsyncLocalStorage), `installDemoFetchGuard()`, `DemoOutboundError`. |
| `worker/src/demo/store.ts` | `class DemoStore extends DurableObject` with RPC `status()`, `ensureReady(nowIso)`, `refresh(nowIso)`, `serve(request, user)`; budget constants. |
| `worker/src/demo/switch.ts` | `demoOn(env, user)` (throws on D1 error), `setDemo(env, user, on)`. |
| `worker/src/demo/gate.ts` | `demoGate` middleware (§5). |
| `worker/src/api/demo.ts` | Control routes (§7). |
| `worker/src/lock.ts` | `lockFetch(storage, request, now)` extracted (ruling 12). |
| `worker/src/devmarks.ts` | `standInsAllowed(env)` (ruling 14). |
| `worker/src/devseed.ts` | `seedScenario(env, scenario, now, { actor })`; `devSeed` cross-site refusal (ruling 20). |
| `worker/src/index.ts` | `export { DemoStore }`; mounts `demoGate` before `app.route("/api/v1", …)`. |
| `worker/src/env.ts` | `DEMO_STORE: DurableObjectNamespace` (typed for RPC); `missingSecrets` demo answer (ruling 15). |
| `wrangler.toml` | `[[durable_objects.bindings]] name = "DEMO_STORE" class_name = "DemoStore"`; `[[migrations]] tag = "v2" new_sqlite_classes = ["DemoStore"]`. |
| `web/src/api/client.ts` | Source tracking and the client guard (§8.2). |
| `web/src/api/demo.ts` | `useDemo()`, `useSetDemo()`, `useRefreshDemo()`, `useDevSeed()`, `useDemoOn()`. |
| `web/src/shell/DemoBanner.tsx` (+ `.css`) | The banner (§8.1). |
| `web/src/views/settings/DemoSection.tsx`, `DevDataSection.tsx` | The two sections (§8.3, §8.4). |

## 5. The gate (`demoGate`), exactly

Runs after `requireAccess`, `sameOriginOnly` and the HX shim, before `app.route("/api/v1", …)`, `/captures/:id` and `/health`.

1. `path` = URL path. If `path` starts with `/api/v1/`, `sub` = the rest with a leading `/`.
2. If `sub` is a control route (`demoRouteKind` says `control`): `await next()`; then set `X-WG-Data` from the switch as it
   stands after the call. The control handlers read and write only the switch row and the DemoStore.
3. Otherwise read the switch: `demoOn(env, c.var.user)`. On error: 503 `demo_unknown` (ruling 6).
4. Off: `await next()`; set `X-WG-Data: real` on `/api/v1` answers.
5. On:
   - `/api/v1` + kind `read`, or `GET`/`HEAD /health`: `env.DEMO_STORE.get(idFromName("demo")).serve(c.req.raw, user)`; set
     `X-WG-Data: demo`; `Cache-Control: no-store`. A DemoStore exception → 503 `demo_unavailable` "Demo data could not be
     read. Turn demo mode off or refresh it in Settings." (never a fall-through to real data).
   - `GET /captures/:id`: 404 text "Not available in demo mode."
   - Anything else (`refuse`): **409** `{ error: { code: "demo_mode", message: "Demo mode is on: actions are off." } }` with
     `X-WG-Data: demo`, before any handler runs and before the body is read.
6. The gate never calls `next()` for a person in demo mode except for control routes. This is the property the tests pin.

## 6. The DemoStore

### 6.1 Storage

One instance, `idFromName("demo")`, shared by everyone in demo mode (it is all made up). Its SQLite holds:
- the app's tables, created from `schema.gen.ts` (ruling 11) on an empty store;
- `_demo_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)` for the KV facade (`get` with `"json"`/`{ type: "json" }`,
  `put` with `expirationTtl`/`expiration`, `delete`, `list({ prefix, cursor })` as used);
- `_demo_r2 (k TEXT PRIMARY KEY, body BLOB NOT NULL, ct TEXT, uploaded TEXT)` for the R2 facade (`put`, `get` (body, `text()`,
  `json()`, `httpMetadata`), `head`, `delete` (one or many), `list({ prefix, cursor })`); a value over 1 MiB is refused;
- `_demo_do (k TEXT PRIMARY KEY, v TEXT NOT NULL)` for RunLock storage (`get`, `put`, `delete`, `list({ prefix })`), keyed
  `<instance name>|<key>` so "singleton" and "lab:<id>" stay apart as in production;
- `_demo_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`: `refreshedAt`, `schemaHash`, `story`, `day`, `rowsToday`, `lastRows`.

The D1 facade (`d1Over`): `prepare(sql).bind(...).first(col?)/all()/run()/raw()` as the code uses them, `batch(stmts)` inside
`transactionSync`; binds `undefined` → `null`, booleans → 1/0 (as D1); `run()` answers `meta.changes` from `changes()` and
`meta.last_row_id` from `last_insert_rowid()`; every cursor's `rowsWritten` goes to the `WriteMeter`. Statements D1 accepts
but SQLite in a Durable Object refuses are listed by the facade tests **(V: `DELETE FROM sqlite_sequence`, which the seeder
already tolerates)**.

### 6.2 RPC

- `status()` → `{ refreshedAt, story, rowsToday, lastRows, dailyRows, nextRefreshAt, schemaOk }` (no seeding).
- `ensureReady(nowIso)` → seeds when empty, schema stale or older than 12 h (ruling 9), budget permitting; returns status.
  When it must seed but cannot, it answers `{ ok: false, code: "demo_busy", message, nextAt }` (as built, E8: a refusal is
  a value, because an error's class does not survive Workers RPC; `DemoBudget` stays inside the object). `refresh` the same.
- `refresh(nowIso)` → refused with `DemoBudget` (rule 8) or runs: inside `blockConcurrencyWhile` (no demo read sees a
  half-built store) and `demoScope.run`: `deleteAll()`, schema, `seedScenario(demoEnv, "everything", now, { actor:
  "demo@example.com" })`, meta (carrying `rowsToday` across the wipe). Returns status and the seed's counts.
- `serve(request, user)` → inside `demoScope.run`: if the store is empty or its schema is stale, `ensureReady` first (else 503
  `demo_outdated`, ruling 10); then a Hono app that sets `user` and mounts `buildApi()` at `/api/v1` plus the `/health`
  handler, called as `app.fetch(request, demoEnv, { waitUntil: (p) => ctx.waitUntil(p), passThroughOnException() {} })`.

### 6.3 Never reachable from the background

The DemoStore has no `alarm()`. Nothing in `scheduled()`, `cron.ts`, `monitor.ts`, `labs/watch.ts`, `insights/**`,
`backup.ts` (nightly export) or the token routes references `DEMO_STORE`. A source test pins that `DEMO_STORE` appears only in
`worker/src/demo/**`, `worker/src/index.ts`, `worker/src/env.ts` and `worker/src/api/demo.ts`.

## 7. Control API (`worker/src/api/demo.ts`, real environment)

| Route | Does | Answers |
|---|---|---|
| `GET /api/v1/demo` | Reads the switch row for the caller; `DemoStore.status()` | `DemoStatusResponse` |
| `PUT /api/v1/demo` `{ on: boolean }` | On: `ensureReady(now)` then insert/replace the row. Off: delete the row. Nothing else. | `DemoStatusResponse` + `message` ("Demo mode is on." / "Demo mode is off. Showing your real data.") |
| `POST /api/v1/demo/refresh` | `DemoStore.refresh(now)` (on or off) | `DemoStatusResponse` + `message` "Demo data refreshed." |

```ts
export interface DemoStatusResponse {
  on: boolean;                 // the caller's switch
  refreshedAt: string | null;  // ISO; null = never seeded
  story: "everything";
  rowsToday: number;           // demo rows written today (UTC)
  dailyRows: number;           // DEMO_DAILY_ROWS
  nextRefreshAt: string | null;// null = a refresh is allowed now
  devSeed: { scenarios: string[] } | null; // only on the dev server (ruling 20)
}
export interface DemoSetBody { on: boolean }
```

Errors: 400 `bad_input` (body not `{ on: boolean }`), 409 `demo_busy` (budget or interval, message names the time), 503
`demo_unknown` / `demo_unavailable`. Control routes are Access-authenticated and same-origin like every `/api/v1` route.

## 8. The app

### 8.1 Banner (`DemoBanner`)

Under the top bar on every page (beside `DisconnectedBanner`), whenever `useDemo().data?.on`: an amber strip with an icon,
the words **"Demo data — nothing here is real. Actions are off."** and a **Turn off** button (`PUT /demo { on: false }`).
`role="status"`; tokens only (`--amber` family and the existing warning surface/text tokens, both themes; the contrast test
gains the pair); wraps on phones without sideways scroll; does not shift the page height on poll.

### 8.2 Data source tracking and the client guard (`web/src/api/client.ts`)

- `currentSource: "real" | "demo" | null` (null until the first answer). Every `/api/v1` answer's `X-WG-Data` is read. When
  `currentSource` is set and the header differs, the client sets `currentSource` to the header, calls the registered
  `onSourceChange` (App: `queryClient.removeQueries()` then `invalidateQueries({ queryKey: ["demo"] })`), and throws
  `SourceChangedError` instead of returning the answer, so it is never cached; queries retry as for a network blip.
- `PUT /demo` success sets `currentSource` and triggers the same clear-and-refetch (the banner and every view switch at once).
- **Client guard:** while `currentSource === "demo"`, `apiSend` throws `ApiError(409, "demo_mode", DEMO_REFUSED_MESSAGE)`
  without sending, unless `demoRouteKind` says `control` or `read`. `useApiMutation`'s existing error toast shows the message.
- No persistent query cache exists (no persister anywhere in `web/src`, checked 2026-10-08); the service worker caches nothing (`sw.js` only handles navigations offline);
  `/api/v1` answers are `Cache-Control: no-store`. Nothing else can hold the other source's data.

### 8.3 Settings → Demo mode (`DemoSection`, slug `demo`)

Text: "Demo mode shows a made-up environment instead of yours: clients, runs, costs, labs and Azure data are all invented.
Only you see it; it changes nothing for anyone else. While it is on, actions are off: nothing can deploy, change or delete
anything. Your real setup keeps running as normal, and its phone alerts still arrive." A Switch "Show demo data" (the real
state from `GET /demo`; pending while the PUT runs, which may take a few seconds on first use: "Preparing demo data…"). A
**Refresh demo data** button (disabled with the reason while `nextRefreshAt` is in the future) and "Last refreshed 2 h ago"
(or "Never"). Errors show the server's message inline. The section does not depend on `/settings` data loading, so it and the
banner still work if demo reads fail. Phone list blurb: "Show made-up data for demos".

### 8.4 Settings → Dev data (`DevDataSection`, slug `dev-data`, dev server only)

Rendered only when `useDemo().data?.devSeed` is non-null (and then also listed in the command palette and the phone list).
A short line ("Wipes this PC's local database and loads a story. Dev server only.") and one row per scenario (name + one-line
description) with **Seed**. Seed opens a confirmation (Modal: "Replace the local data with <story>?"), then `POST
/__dev/seed?scenario=<s>` (same origin), then toasts "Seeded <story>: peers 8, runs 14, …", and `queryClient.invalidateQueries()`.
The Vite dev proxy gains `/__dev` (today it proxies only `/api` and `/captures`).

### 8.5 Disabled actions

`useDemoOn()` (true when `currentSource === "demo"` or `useDemo().data?.on`) disables the buttons in ruling 18 with the
tooltip "Actions are off in demo mode". Everything else relies on §8.2's guard.

## 9. Proofs (tests that must exist)

**Worker** (`worker/test/demo-*.test.ts`, harness gains a `DEMO_STORE` namespace running `DemoStore` in-process over
`node:sqlite`):
1. *Tripwire:* a DemoStore built with an env whose `DB`, `STATUS`, `STATE`, `RUN_LOCK`, `ASSETS` throw on any property access
   and whose secrets are `TRIPWIRE-…` strings: `refresh`, `status` and every GET route via `serve` succeed; no answer
   contains "TRIPWIRE".
2. *No outbound:* with the `everything` demo seeded, **every GET route in `buildApi()`** (a table mapping each registered GET
   pattern to a concrete path; a meta-test fails when a registered GET is missing from the table) plus `POST /firewall/simulate`
   and `GET /health` answer 2xx (or the route's documented 4xx for a bad id) through the gate, and the harness's outbound log
   is **empty**; with `installDemoFetchGuard()` active, a `fetch` attempted inside `demoScope` throws `DemoOutboundError`.
3. *Refusals:* for every non-GET route registered on the app (`/api/v1` and the Access-protected rest), a person in demo mode
   gets 409 `demo_mode`, except the control routes and `POST /firewall/simulate`; the real store's fingerprint (every D1 table's
   rows, every KV key, every R2 key, the RunLock snapshot) is identical before and after, apart from `demo_mode`.
4. *Real untouched by the whole journey:* fingerprint before; enable (seeds); every GET; every refusal; refresh; disable;
   fingerprint after equals before, apart from the `demo_mode` row's insert and delete.
5. *Per person:* a `demo_mode` row for `someone@example.com` does not change what `dev@localhost` sees (real data,
   `X-WG-Data: real`); turning it on for one does not create a row for another.
6. *Fail closed:* a D1 error reading the switch answers 503 `demo_unknown`, never real data; a DemoStore error answers 503
   `demo_unavailable`, never real data.
7. *Background:* `runCron` with a `DEMO_STORE` tripwire never touches it; the source test of §6.3; the dev seeder's `wipe` and
   the backup export never touch `demo_mode`.
8. *Budget and readiness:* a second refresh within 10 minutes is 409 `demo_busy` naming the time; the daily row budget refuses
   with the time of the next UTC day; enable on an empty store seeds; enable on a 13-hour-old store re-seeds; a stale schema
   hash re-seeds on read or answers `demo_outdated`.
9. *Same answers:* `devseed-everything`'s widget walk passes when its reads go through the demo path (the demo shows every
   widget filled).
10. *Caching:* the lab topology cache key includes the source (`demo:` / `real:`); a demo env never reads a real entry.
11. *Dev picker lock:* `GET /demo` has `devSeed: null` without the bypass or off localhost; `/__dev/seed` answers 404 there,
    and 403 to a cross-site browser POST on localhost.

**App** (`web/src/**`): the banner shows and hides with `on`; Turn off calls `PUT /demo`; a real answer arriving after the
switch to demo is never shown (fetch mock returns `X-WG-Data: real`; the view never renders it; the cache is cleared); every
mutation hook in `mutations.ts` while in demo throws `demo_mode` **without calling fetch**, except simulate; the listed buttons
are disabled with the tooltip; the Demo section's switch, Refresh (disabled until `nextRefreshAt`), and last-refreshed text;
the Dev data section absent with `devSeed: null` and present with scenarios; Seed confirms, posts, toasts and invalidates.

## 10. Safety review focus

1. **Demo writes real data:** the demo env has no real binding (tripwire, §9.1); refusals happen in the gate before any
   handler (§9.3); the only real write is `demo_mode` (§9.4).
2. **Real data served as demo, or demo as real:** the gate reads the switch per request from D1 and fails closed (§9.6); the
   DemoStore never sees a real binding; the app drops answers from the other source (§8.2).
3. **Triggers infrastructure:** no secrets in the demo env; `can*()` false; fetch guard; outbound log empty for every GET
   (§9.2); mutations refused; cron and token routes untouched (§9.7).
4. **Switch leaks across people:** keyed by Access email (§9.5); DemoStore answers carry no per-person data beyond the caller's
   own ui_prefs rows.
5. **Caches:** server: topology cache keyed by source (§9.10), no other module-level data cache (inventory in the plan's facts);
   app: whole cache cleared on every source change, mismatched answers dropped; SW caches nothing; `no-store` everywhere.
6. **Budget:** demo refreshes cannot exhaust the Durable Object write allowance RunLock depends on (ruling 8).

## 11. Deploy and rollback

- `npm run deploy-worker` (unchanged entry point; the builder never reads `.env`, the script loads it through
  `scripts/lib/env.mjs` as today). Steps: `demo-schema --check`, build, bundle-size, deployments status (rollback id), `d1
  migrations apply wg-admin --remote` (adds `demo_mode`), `wrangler deploy` (adds the `DemoStore` class, migration `v2`).
  **No `wrangler d1 create` / `kv namespace create`; nothing to create by hand.**
- **Rollback:** `wrangler rollback` may refuse to cross a Durable Object migration **(V)**. The integrator prepares, before
  deploying, a branch `revert/demo-mode` = `main` before the merge plus an inert `export class DemoStore extends DurableObject
  {}` and the same `v2` migration lines, so a fix-forward deploy is one command away. The `demo_mode` table is harmless to old
  code.

## 12. Risks

| Risk | Answer |
|---|---|
| Durable Object CPU on the account's plan is lower than 30 s (V) | The live check refreshes once; if it fails with a CPU error, stop and report (Appendix B option). |
| D1 vs Durable Object SQLite differences | Facade tests over `node:sqlite`; the live check reads every page in demo; `demo_unavailable` never falls back to real. |
| The running story looks stale after hours | Re-seed on enable after 12 h; "Last refreshed" shown; Refresh button. |
| A new GET route makes an outside call | §9.2's meta-test forces it into the table; the fetch guard turns it into a 500 in demo, never a call. |
| A new write route | Refused by default (ruling 4). |
| Notification taps open demo views | Banner; "Not found" for real ids; ruling 17. |
| Public config (DNS name, region, server public key) appears in demo | Accepted: configuration, not data; the server key is public by design. |

## Appendix A: the brief (as relayed on 2026-10-08)

Steven approved "Both" (demo mode on the live site AND a scenario picker on the dev server). Approved direction:
- Demo store: a separate Cloudflare D1 database and KV namespace bound as `DEMO_DB` / `DEMO_KV` (and a separate R2 prefix or
  bucket if the views need R2 objects, never the production prefixes); migrations to both DBs in deploy-worker; resources
  created with wrangler using the local `.env` token through `scripts/lib/env.mjs` without printing secrets. *(Changed by
  ruling 1 to a Durable Object; nothing to create by hand.)*
- Seeding: reuse the `everything` story, writing to the demo store only (seeder takes its target bindings as parameters;
  prove by test it cannot write the real store). Trigger: Settings "Refresh demo data" (POST, Access-authenticated, demo store
  only), and automatically on first enable if empty. Dates relative to now at seed time.
- Per-user switch, stored in the real store (the only real-store write). Reads for that user from the demo store; every
  mutating route refuses with 409 "Demo mode is on: actions are off" (except turning demo off and refreshing demo data). No
  Azure/GitHub/WireGuard/Graph calls while serving demo reads; enumerate routes and prove by tests (fetch spy). Cron,
  watchman, lab watch and insights never touch the demo store. Other users unaffected.
- UI: Settings "Demo mode" section (switch, explanation, Refresh demo data, last refreshed); app-wide amber banner "Demo data
  — nothing here is real. Actions are off." with Turn off; actions visibly disabled where 409s are handled, or a global client
  guard; light and dark tokens.
- Dev scenario picker: dev server only (same double lock as `/__dev/seed`), a Settings section listing the 11 scenarios with
  Seed calling `/__dev/seed`; hidden (not rendered, endpoint 404s) on the live site.
- Safety review focus: no path where demo writes real data, serves real as demo or demo as real to another user, triggers
  infrastructure, or leaks the switch across users; caches keyed by data source; service worker and app cache.

## Appendix B: the D1 + KV option, for the record

Viable only where one Worker invocation may run ~830 D1 calls and ~300 ms of CPU (Workers Paid), and where ~5k rows per
refresh from the shared D1 daily allowance are acceptable. It would need `wrangler d1 create wg-admin-demo`, `wrangler kv
namespace create WG_DEMO_KV`, an R2 bucket or prefix for the seeded backups, a migrations step for the second database, and a
RunLock instance name prefix for the demo snapshot. Everything above the storage layer (gate, classification, demo env
allow-list, guard, app) would be the same, so switching later is a storage change only.
