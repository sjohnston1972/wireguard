# Demo mode and the dev seed-scenario picker: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. The integrator lands **E** (engine: shared contract, demo store, facades, seeder targeting)
> first. Then **W** (Worker routing, refusals, control API, outbound proofs, cron isolation) and **U** (app: source tracking,
> client guard, banner, Settings sections, dev picker, disabled actions) run **in parallel**, each in its own git worktree with
> one implementer under superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a person can switch their own view of wg-admin to the seeded `everything` story ("demo mode"), served from a
separate store, with every action refused and no outside call; and the dev server's Settings can seed any story. Real data,
other people, cron and infrastructure are untouched.

**Architecture:** a SQLite-backed Durable Object `DemoStore` (binding `DEMO_STORE`) holds the demo data and serves demo reads
by running the same `/api/v1` code against a demo environment built from an allow-list (facades over its own SQLite for `DB`,
`STATUS`, `STATE`, `RUN_LOCK`; no secrets). A gate in the Worker reads the caller's switch (`demo_mode`, real D1) per request:
off → real routes; on → reads forwarded to the DemoStore, writes refused 409, before any handler. Every answer carries
`X-WG-Data: real|demo`; the app drops answers from the other source and clears its cache on every switch, and a client guard
stops writes before they are sent.

**Tech stack:** unchanged (Hono, D1, Durable Objects (SQLite), React 19, TanStack Query, Radix, Vitest, node:test). No new
dependency.

**Spec:** `docs/superpowers/specs/2026-10-08-demo-mode-design.md` (binding; its §3 rulings 1–21, §5 gate, §9 proofs, Appendix
A brief). **(V)** marks a fact to check during the build; each area's report records the answer.

**Facts established before planning** (2026-10-08, from `main` at a525546, no Azure calls):
- `seedScenario(env, "everything")` measured in the harness: 563 single D1 statements, 264 `batch()` calls (3,800 statements),
  ~4,600 table rows (peers 8, runs 14, alerts 27, audit 25, cost_days 40, hist_vm 258, hist_client 803, hist_drops 339, …),
  10 KV puts, 18 R2 puts, 274 ms in Node. It writes only through `env.DB`, `env.STATUS`, `env.STATE` and (snapshot)
  `env.RUN_LOCK` (`state.ts` `store(env)` = `RUN_LOCK.idFromName("singleton")`). Hence spec ruling 1 (Durable Object store).
- Routes: `/api/v1` has **31 GET** and **54 non-GET** (37 POST, 10 PUT, 7 DELETE); `POST /firewall/simulate` writes nothing.
  Access-protected outside `/api/v1`: `GET /captures/:id`, `GET /health`. Token routes and `/__dev/seed` are before the login.
- Dev stand-ins: `devmarks.ts devSeeded` (used by `insights/read.ts insightsShown`, `backup.ts backupRoot`) and
  `labs/topology.ts` (`env.AUTH_DEV_BYPASS === "1" ? devRows(...)`). Outside calls go through global `fetch` (`azure.ts`,
  `github.ts`, `dns.ts` incl. the token-less DoH resolver, `notify.ts`, `webpush.ts`, `labs/net.ts`, `insights/runner.ts`
  ctx.fetch) and DO stubs. `cron.ts` already swaps `globalThis.fetch` for a meter using AsyncLocalStorage and restores the
  previous value, so a guard installed at module load is preserved.
- Module-level data caches in `worker/src`: only `labs/topology.ts` (`cache`, `lastGood`, `inflight`, keyed
  `${labId}:${s.id}`, used only when `canAzure`). Others are not data (`auth.ts` JWKS, `index.ts` fail buckets, `cron.ts`
  counters, `devclock.ts`, `labs/catalogue.ts` test override).
- App: no persistent query cache; `sw.js` caches nothing (offline page for navigations, push); `/api/v1` is `no-store`.
  `web/vite.config.ts` proxies only `/api` and `/captures`. `SETTINGS_SECTIONS` (8, in `shell/CommandPalette.tsx`) drives the
  Settings tabs, phone list and palette. `useApiMutation` toasts `err.message` on failure.
- `ui_prefs.page` has a CHECK constraint and the dev seeder wipes `ui_prefs`, so the switch gets its own table.
- Deploy: `scripts/lib/deploy.mjs deploySteps()` = build:web, bundle-size, deployments status, d1 migrations apply wg-admin
  --remote, deploy; pinned by `scripts/test/deploy.test.mjs`. `wrangler.toml` has DO migration `v1` (RunLock, SQLite).
- Worktrees have no `node_modules`; `npm ci` (or a junction to the main checkout's, read-only) is needed before tests.
- **E1 baseline** (2026-10-08, `feat/demo-mode-engine` = a525546 + the docs): entry **312.7 kB**, all JS **435.6 kB**, CSS
  **39.8 kB** gzip. U's entry ceiling is therefore 314.2 kB.
- **E2 route census, corrected:** `buildApi()` registers **31 GET** and **59 non-GET** (42 POST, 10 PUT, 7 DELETE). The 54
  above counted `api/labs.ts`'s loop of six `POST /labs/:id/<action>` routes as one. `worker/test/demo-shared.test.ts` pins
  the figures (demo control routes excluded) and classifies every route.
- **E5 rows per `everything` refresh** (harness, facades over node:sqlite, 2026-10-08): **6,812 rows written** into an empty
  store (schema creation adds ~0), 656 ms in Node. This is SQLite's change count; a Durable Object's `rowsWritten` also
  counts index rows, so the live figure will be higher (record it in the live check). Against `DEMO_DAILY_ROWS = 30_000`
  with the `rowsToday + 2 × lastRows` rule this allows about three refreshes a day at the harness figure, one or two if the
  live figure is 10–15k.

## E names (to be confirmed as built, E8)

Branches from E's head use these names exactly; a change goes through the integrator, who updates this section and the spec.

**Shared:** `shared/demo.ts`: `DEMO_CONTROL: { method, path }[]`, `DEMO_READ_POSTS = ["/firewall/simulate"]`,
`demoRouteKind(method, subPath) → "control" | "read" | "refuse"` (subPath is the path after `/api/v1`, query stripped),
`DEMO_REFUSED_MESSAGE = "Demo mode is on: actions are off."`, `DEMO_DATA_HEADER = "X-WG-Data"`, `DEMO_STORY = "everything"`.
`shared/api.ts`: `DemoStatusResponse`, `DemoSetBody` (spec §7).
**Worker:** `worker/migrations/0022_demo_mode.sql`; `worker/src/demo/schema.gen.ts` (`DEMO_SCHEMA: { name, sql }[]`,
`DEMO_SCHEMA_HASH`); `worker/src/demo/sql.ts` (`SqlLike`, `WriteMeter`, `d1Over`, `kvOver`, `r2Over`, `doStorageOver`);
`worker/src/demo/env.ts` (`DEMO_MARK`, `isDemoEnv`, `DEMO_VARS`, `makeDemoEnv`); `worker/src/demo/guard.ts` (`demoScope`,
`installDemoFetchGuard`, `DemoOutboundError`); `worker/src/demo/store.ts` (`DemoStore` RPC `status`, `ensureReady`, `refresh`,
`serve`; `DEMO_DAILY_ROWS = 30_000`, `DEMO_MIN_INTERVAL_MS = 600_000`, `DEMO_STALE_MS = 43_200_000`, `DEMO_ACTOR =
"demo@example.com"`; error class `DemoBudget { nextAt }`); `lock.ts lockFetch(storage, request, now)`; `devmarks.ts
standInsAllowed(env)`; `devseed.ts seedScenario(env, scenario, now, { actor })`; `env.ts DEMO_STORE`.
**Test harness:** `worker/test/harness.ts` gains `sqliteLike()` (node:sqlite `SqlLike`), `makeEnv` gains `DEMO_STORE` (an
in-process `DemoStore`), `tripwire(name)` (a Proxy that throws on any access) and `fingerprint(env)` (every D1 table's rows,
KV keys and values, R2 keys, the RunLock snapshot) for W's journey test.
**Web fixtures:** `web/src/test/fixtures.ts` `demoStatusFixture(overrides)`.

## Global Constraints

- **Inherited:** commit trailer `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV` and push after every
  commit; **never read `.env`** (worktrees `cp .env.example .env`; deploy loads `.env` itself through `scripts/lib/env.mjs`);
  kill processes by PID only; one `.css` per component; tokens only (no hex colour in new or changed CSS); status colours
  always with a word; Vitest + RTL behaviour tests; fixtures use TEST-NET addresses and `example.com`/`example.invalid`.
- **Branches:** E `feat/demo-mode-engine` from `main`; W `feat/demo-mode-worker` and U `feat/demo-mode-app` from E's head
  **after E8**; integration `feat/demo-mode` from E's head; the PR into `main`.
- **No Azure, no spend, no infrastructure.** Nothing calls Azure or GitHub, nothing deploys a VM or a lab, at any step. Live
  probes of the refusal use only `POST /api/v1/notes/ack` (harmless if it ever got through), **never** deploy, destroy,
  hibernate, resume or any lab route.
- **Frozen files** (E or the integrator only): `shared/**`; `wrangler.toml`; `worker/migrations/**`; `worker/src/env.ts`,
  `lock.ts`, `devmarks.ts`, `devseed*.ts` (W may touch only the `devSeed` route handler in `devseed.ts`),
  `worker/src/demo/{sql,env,guard,store,schema.gen}.ts`; `worker/test/harness.ts`; `scripts/**`; `package.json`,
  `package-lock.json`; `.github/**`; `web/src/test/fixtures.ts`.
  **W owns:** `worker/src/demo/{gate,switch}.ts`, `worker/src/api/demo.ts`, `worker/src/api/index.ts` (registration),
  `worker/src/index.ts`, `worker/src/devseed.ts` `devSeed` handler, `worker/src/labs/topology.ts` (cache key), the capability
  shaping lines in `worker/src/api/{overview,labs,session,settings}.ts`, any short-circuit W3 finds, `worker/test/demo-*.test.ts`.
  **U owns:** `web/src/**` except fixtures; `web/vite.config.ts`; `web/public/sw.js` (only if needed, comment-level).
- **Speed rules (builders):** targeted tests while working (`npx vitest run <file>`, `node --test <file>`); **one** full area
  gate at the end of each area; skip `labs-tf`, `labs-topology` and `labs-check` (no lab folder changes).
- **Area gate:** `npm test`, `npm run typecheck`, `npm run build:web`, `npm run bundle-size`, `npm run demo-schema -- --check`.
- **Budgets:** entry ≤ 320 kB, all JS ≤ 450 kB, CSS ≤ 50 kB gzip; the entry grows by at most 1.5 kB over E1's figure
  (`DevDataSection` is lazy: `lazyPart`).
- **STOPs:** **S1** before the PR merge and the production deploy: confirm Steven's go (his standing approvals cover other
  features; this one changes request routing for real data), unless the launching session already has it in writing. **S2** if
  the live refresh fails with a CPU or storage-limit error (spec risk 1): stop, switch demo mode off (banner Turn off; Access allows one
  identity, so that is everyone), leave the code deployed (demo mode stays usable only after a fix), report. Pre-approved, no stop: every area merge, the draft PR,
  CI, dev-server checks, the revert branch.
- **Decisions recorded 2026-10-08 (Steven, relayed by the launching session):**
  - The Cloudflare account is on **Workers Paid**. The SQLite Durable Object `DemoStore` (binding `DEMO_STORE`) stands as
    designed. **S2's CPU concern is resolved:** the Paid plan's default CPU limit per request is far above the ~300 ms seed,
    so no `limits.cpu_ms` is set (the plan never asks for one). S2 still applies to a storage-limit error.
  - The **Refresh demo data** button runs **in the Worker** (`POST /api/v1/demo/refresh` → `DemoStore.refresh`).
  - **S1 approved in writing:** merge and deploy when clean; no stop before the production deploy.
  - The revert-branch preparation for the Durable Object migration (integration step 7) is kept.

## Review Focus

1. **Demo writes real data.** E: `a DemoStore built with tripwire real bindings refreshes and serves every GET`
   (spec §9.1), `makeDemoEnv copies only DEMO_VARS and DEMO_VARS equals wrangler.toml [vars]`, `no secret, ASSETS,
   DEMO_STORE or AUTH_DEV_BYPASS in a demo env`. W: `every non-GET route is 409 demo_mode for a person in demo mode`, `the real
   fingerprint is unchanged by the whole journey except the demo_mode row`.
2. **Real served as demo, demo as real.** W: `D1 error reading the switch is 503 demo_unknown`, `DemoStore error is 503
   demo_unavailable, never real`, `X-WG-Data on every /api/v1 answer`, `the gate never calls next() for a demo person except
   control routes`. U: `a real answer arriving after the switch to demo is never rendered or cached`.
3. **Triggers infrastructure.** W: `every GET route (table covers all 31) plus simulate and /health make no outbound call in
   demo` (harness outbound log empty), `fetch inside demoScope throws DemoOutboundError`, `the guard survives cron's meter`.
4. **Switch leaks across people.** W: `someone@example.com in demo does not change dev@localhost's answers`, `PUT /demo writes
   only the caller's row`.
5. **Background.** W: `runCron with a DEMO_STORE tripwire never touches it`, `DEMO_STORE appears only in the four allowed
   places`, `the dev seeder's wipe and the backup export never touch demo_mode`.
6. **Caches.** W: `topology cache keys start with the source`; U: `PUT /demo success clears every query`, `SourceChangedError is
   retried and never cached`.
7. **Budget.** E: `second refresh within 10 min is DemoBudget with nextAt`, `daily budget uses rowsToday + 2 × lastRows`,
   `rowsToday survives the wipe`, `a new UTC day resets it`; E5 records rows per refresh.
8. **Dev picker never on live.** W: `devSeed null without the bypass or off localhost`, `/__dev/seed 404 there, 403 to a
   cross-site browser POST`; U: `Dev data section, palette entry and phone row absent with devSeed null`.
9. **Usability of the escape hatch.** U: `the banner's Turn off works while /settings fails`, `the Demo section renders
   without /settings data`.

---

## E: Engine (integrator, first)

**Branch:** `feat/demo-mode-engine`. **Owns:** every frozen file; the names section. **Why it exists:** one demo store whose
code cannot reach a real binding, one shared route classification, and a contract so W and U can build in parallel.

- [x] **E1 Baseline.** Worktree, `cp .env.example .env`, `npm ci`, `npm run build:web`, `npm run bundle-size`. Record entry,
  all JS and CSS here. **Done when** the figures are recorded in this plan's facts and pushed.
- [x] **E2 Shared contract, switch table, binding.** Tests first (`worker/test/demo-shared.test.ts`): `demoRouteKind` row by
  row: `GET /overview → read`, `HEAD /clients → read`, `POST /firewall/simulate → read`, `GET /demo`, `PUT /demo`, `POST
  /demo/refresh → control`, `POST /deploy → refuse`, `PUT /prefs/overview → refuse`, `DELETE /clients/3 → refuse`, `POST
  /demo → refuse`, `PATCH /anything → refuse`, query strings ignored, trailing slash not special. Add `shared/demo.ts`,
  `shared/api.ts` types, `0022_demo_mode.sql`, `wrangler.toml` binding + `v2` migration, `env.ts DEMO_STORE`. **Done when**
  the test passes and `npm run typecheck` passes.
- [x] **E3 Schema bundle.** Tests first (`scripts/test/demo-schema.test.mjs`): `writes every migration in name order with its
  SHA-256`, `--check exits 1 after a migration is added and 0 after regenerating`; Worker test `schema.gen.ts matches
  worker/migrations`. Add `scripts/demo-schema.mjs`, npm script `demo-schema`, generated file; `deploySteps()` gains `["npm",
  "run", "demo-schema", "--", "--check"]` first (update `scripts/test/deploy.test.mjs`). **Done when** `node --test
  scripts/test/demo-schema.test.mjs scripts/test/deploy.test.mjs` passes.
- [x] **E4 lockFetch.** Move `RunLock.fetch`'s body into `lockFetch(storage, request, now)` (storage: `get`, `put`, `delete`,
  `list({ prefix })`); `RunLock.fetch` calls it. No behaviour change. **Done when** `npx vitest run worker/test/state.test.ts
  worker/test/races.test.ts worker/test/lifecycle.test.ts` passes unchanged.
- [x] **E5 Facades.** Tests first (`worker/test/demo-facades.test.ts`, over the harness's `sqliteLike()`): D1: `first`,
  `first(col)`, `all().results`, `run().meta.changes` (0 for a no-op UPDATE), `last_row_id`, `undefined → null`, `true → 1`,
  `batch` all-or-nothing, an error statement rejects; KV: `get` text/json/`{type:"json"}`, `put` with `expirationTtl` expires,
  `delete`, `list({ prefix })`; R2: `put` string/ArrayBuffer with `httpMetadata`, `get` → `text()`/`json()`/`body`, `head`,
  `delete([keys])`, `list({ prefix, cursor })`, > 1 MiB refused; DO storage: two instance names never see each other's keys;
  every write adds to the `WriteMeter`. Implement `worker/src/demo/sql.ts`. Then run `seedScenario` over the facades (a scratch
  measurement test, not committed) and record **rows written per everything refresh** in the facts. **Done when** the test
  passes and the figure is recorded.
- [ ] **E6 Demo env, stand-ins, seeder actor.** Tests first (`worker/test/demo-env.test.ts`): `DEMO_VARS equals the keys of
  wrangler.toml [vars]` (parse the file), `makeDemoEnv has no key of SECRET_GROUPS, no CF_ACCESS_*, NOTIFY_*, VAPID_PRIVATE_KEY,
  AUTH_DEV_BYPASS, ASSETS or DEMO_STORE`, `isDemoEnv survives { ...env }`, `isDemoEnv is false for a real env and for one with a
  string "DEMO_MARK" key`, `canAzure/canDispatch/canDns are false in a demo env`, `missingSecrets is {} in a demo env and
  unchanged for a real one`, `standInsAllowed: bypass "1" or demo env`; existing devseed tests: `seedScenario(..., { actor })
  writes runs.requested_by and audit.user as the actor; default still dev@localhost`. Implement `demo/env.ts`, `devmarks.ts`
  (`standInsAllowed`; `devSeeded` uses it), the three stand-in sites, `env.ts missingSecrets`, `devseed.ts` actor option.
  **Done when** the new test, `worker/test/devseed.test.ts`, `devseed-everything.test.ts`, `api-azure.test.ts`,
  `api-backup.test.ts` and `labs-topology-route.test.ts` pass.
- [ ] **E7 DemoStore and guard.** Tests first (`worker/test/demo-store.test.ts`): spec §9.1 tripwire; §9.8 budget and
  readiness (inject `now`); `serve answers GET /api/v1/overview with the running story`; `serve with an empty store seeds
  first`; `a stale DEMO_SCHEMA_HASH re-seeds, or answers 503 demo_outdated when over budget`; `refresh runs inside
  blockConcurrencyWhile`; `status never seeds`; guard: `fetch inside demoScope throws DemoOutboundError; outside it passes
  through`, `installDemoFetchGuard is idempotent`, `cron's counted() restores the guard, not the raw fetch`; §9.9 the
  `devseed-everything` widget walk with every read sent through `DemoStore.serve` (reuse its `Seen` collection with a
  pluggable `get`). Implement `demo/guard.ts`, `demo/store.ts` (`installDemoFetchGuard()` at module load), harness
  `DEMO_STORE`, `tripwire`, `fingerprint`; export `DemoStore` from `index.ts` (export only; W mounts the gate).
  **Done when** the test file and `worker/test/devseed-everything.test.ts` pass.
- [ ] **E8 Contract and gate.** `web/src/test/fixtures.ts demoStatusFixture`; update the names section as built. Run the area
  gate. **Done when** the gate passes and the head is pushed (W and U branch from it).

## W: Worker routing, refusals, proofs (after E8)

**Branch:** `feat/demo-mode-worker`. **Why:** the only path from a request to data goes through one per-request decision that
fails closed, and the tests prove every route.

- [ ] **W1 Switch and control API.** Tests first (`worker/test/demo-control.test.ts`): `GET /demo is off by default with
  refreshedAt null`; `PUT { on: true } seeds an empty store before writing the row` (row absent if `ensureReady` throws);
  `PUT { on: true } with an empty store over budget is 409 demo_busy and the switch stays off`; `PUT { on: false } deletes
  only the caller's row`; `PUT with a bad body is 400 bad_input`; `POST /demo/refresh works on and off, 409 demo_busy within
  10 min naming the time`; `X-WG-Data reflects the mode after the call`; `cross-site PUT is 403` (existing same-origin check).
  Implement `demo/switch.ts`, `api/demo.ts`, registration. **Done when** the file passes.
- [ ] **W2 The gate.** Tests first (`worker/test/demo-gate.test.ts`): spec §5 step by step; §9.3 (enumerate the app's
  registered routes from Hono: every non-GET under Access is 409 `demo_mode` for a demo person, except control and simulate;
  the handler spy for each is never called); `GET /captures/<16 hex>` 404 in demo; `GET /health` from the demo snapshot;
  §9.5; §9.6; `a demo person's GET reaches DemoStore.serve with their email`; `HX requests still get HX-Refresh`. Implement
  `demo/gate.ts`; mount in `index.ts` before `app.route("/api/v1", …)`. **Done when** the file passes.
- [ ] **W3 No outbound, every GET.** Tests first (`worker/test/demo-outbound.test.ts`): §9.2 with the route table (concrete
  paths using seeded ids: a peer id, a run id, a lab id, a day with a config backup, every documented query variant such as
  `azure/metrics?resource=vm|pip|vitals`) and the meta-test that every registered GET pattern is in the table. FAIL where a
  GET reaches for `fetch` in demo (expect at least the DNS resolver path and the capacity/boot log on-demand paths **(V)**);
  fix each with an `isDemoEnv` short-circuit that reads stored data only; list each fix in the report. Add the capability
  shaping of spec ruling 15 (`actions.canDispatch`, `autoCleanup`). **Done when** the file passes with an empty outbound log
  for every row and the fixes are listed.
- [ ] **W4 Background and caches.** Tests first (`worker/test/demo-isolation.test.ts`): §9.7 (`runCron` and the
  `scheduled` handler with `DEMO_STORE: tripwire`; the source scan for `DEMO_STORE`; dev `wipe` and `buildExport`/restore
  never mention `demo_mode`), §9.10 (topology cache key prefixed with `demo:`/`real:`). Implement the key change.
  **Done when** the file passes.
- [ ] **W5 Dev seed lock.** Tests first (extend `worker/test/devseed.test.ts` and `demo-control.test.ts`): §9.11 (`GET /demo`
  `devSeed` with scenarios only with the bypass on localhost; `/__dev/seed` 404 elsewhere; 403 for `Sec-Fetch-Site:
  cross-site` on localhost; the script's header-less POST still seeds). Implement in `devSeed` and `api/demo.ts`.
  **Done when** both files pass.
- [ ] **W6 Journey and gate.** Test (`worker/test/demo-journey.test.ts`): §9.4 with `fingerprint`. Then the area gate.
  **Done when** the gate passes and the branch is pushed with the W3 fix list in the last commit message.

## U: The app (after E8)

**Branch:** `feat/demo-mode-app`. **Why:** the person always knows which data they see, can always get out, and cannot send a
write by accident.

- [ ] **U1 Source tracking and the guard.** Tests first (`web/src/api/demo-client.test.ts`): spec §8.2 (`X-WG-Data`
  mismatch throws `SourceChangedError`, calls `onSourceChange`, updates `currentSource`; matching answers pass; `shouldRetry`
  retries `SourceChangedError`); `while demo, every mutation hook in mutations.ts rejects with demo_mode and fetch is never
  called` (iterate the hooks' configs or a table of them), `except simulate and the control routes`; `the toast says Demo mode
  is on: actions are off.` Implement in `client.ts`, `queryClient.ts` (retry), `App.tsx` (`onSourceChange` → `removeQueries`,
  refetch `["demo"]`). **Done when** the file passes and `web/src/api/client.test.ts`, `mutations.test.tsx` still pass.
- [ ] **U2 Demo hooks.** Tests first (`web/src/api/demo.test.tsx`): `useDemo` reads `/demo`; `useSetDemo` PUTs, sets the
  source, clears every query and toasts the message; `useRefreshDemo` POSTs and invalidates everything; `useDevSeed` POSTs
  `/__dev/seed?scenario=` and invalidates everything; `useDemoOn`. Implement `web/src/api/demo.ts`. **Done when** it passes.
- [ ] **U3 Banner.** Tests first (`web/src/shell/demoBanner.test.tsx`): spec §8.1 (shown only when on; exact words; Turn off
  PUTs `{ on: false }`; still works when `/settings` fails; `role="status"`); contrast test gains the banner pair (both
  themes). Implement `DemoBanner.tsx/.css`, mount in `AppShell`. **Done when** the tests and `web/src/styles/contrast.test.ts`
  pass.
- [ ] **U4 Settings → Demo mode.** Tests first (`web/src/views/settings/demo.test.tsx`): spec §8.3 (text, switch states and
  pending words, Refresh disabled until `nextRefreshAt` with the reason, "Never" / relative time, server error inline, renders
  at `/settings/demo` while `/settings` errors); `sections.test.tsx` updated for the ninth section (tab, phone blurb, palette).
  Implement `DemoSection.tsx`, registration in `SETTINGS_SECTIONS`, `ICONS` (a lucide icon that exists in 1.50.0 **(V)**),
  `BLURB`, `index.tsx` (the demo slug does not wait for `/settings`). **Done when** both files pass.
- [ ] **U5 Settings → Dev data.** Tests first (`web/src/views/settings/devdata.test.tsx`): spec §8.4 (absent with `devSeed:
  null` in tabs, phone list and palette; 11 rows with descriptions; Seed → confirm → POST → toast with counts → invalidate;
  a 404 answer says "The seeder only exists on the local dev server."). Implement `DevDataSection.tsx` (lazy), dynamic
  section list, `web/vite.config.ts` proxy `/__dev`. **Done when** the file passes.
- [ ] **U6 Disabled actions.** Tests first (extend the views' tests): spec ruling 18's buttons are disabled with the tooltip
  "Actions are off in demo mode" when `useDemoOn()`, enabled otherwise. Implement in the Overview action bar, the lab dialog's
  Deploy form, Clients' Add client, Firewall's Apply draft, the Settings save bar. **Done when** the extended tests pass.
- [ ] **U7 Gate.** Area gate; record entry, all JS, CSS. **Done when** the gate passes within budget and the branch is pushed.

## Integration

1. **Merge** onto `feat/demo-mode` (from E's head) in the order W, U (`--no-ff`), the gate after each. A conflict means an
   area touched a frozen file or another area's file: reject that change or fold it into E's files. **Done when** the gate
   passes after the second merge.
2. **Full gate and CI:** area gate (record bundle figures) and a draft PR with CI green. **Done when** all exit 0 and CI is
   green.
3. **Dev check (pre-approved).** `cp .env.example .env`, `npm run dev` (record its PID); in Chrome on `http://localhost:8787`:
   Settings → Dev data seeds `running` (Overview shows it) and `empty`; Settings → Demo mode on ("Preparing demo data…", then
   the banner); every tab populated (Overview, Clients, Firewall, Activity, Cost, Labs, Settings) at 1366×768 and 390×844, light
   and dark; `X-WG-Data: demo` on `/api/v1` answers (network panel); Deploy disabled with the tooltip; in the console
   `fetch("/api/v1/notes/ack",{method:"POST"})` answers 409 `demo_mode`; Refresh twice → second is refused with a time; Turn
   off from the banner → the empty dev data is back, banner gone. Stop the server by PID. **Done when** each item is seen and
   listed in the PR.
4. **Screens.** `npm run shots:diff` against a `main` baseline for `/`, `/clients`, `/firewall`, `/activity`, `/cost`,
   `/settings/overview` with demo off: zero differing pixels. Chrome screenshots of the banner and both sections in both themes
   at 1366 and 390 attached to the PR. **Done when** the diffs are zero and the pictures are read and attached.
5. **Whole-branch review.** A fresh opus reviewer gets this plan, the spec and the diff. Ask about: the Review Focus list; the
   gate against spec §5 line by line; every place a real binding or secret could reach code running for a demo person; the
   W3 fix list; caches; the client's source handling under races; the budget. **Done when** the findings are listed in the PR.
6. **One fix pass,** test-first, then step 2 again. **Done when** step 2 passes again.
7. **Revert branch.** Push `revert/demo-mode` = `main` + an inert `export class DemoStore extends DurableObject {}` + the same
   `v2` migration lines and binding (spec §11); `npm run typecheck` passes on it. **Done when** pushed.
8. **S1: Steven's go** for merge and deploy (skip only if already given in writing for this plan). **Done when** recorded.
9. **Merge and deploy.** PR → `main`, CI green, merge; `npm run deploy-worker` (prints the version it replaces: record it as
   the rollback point). **Done when** the deploy exits 0 and both version ids are recorded in the outcome.
10. **Live check** (signed-in Chrome, `https://wg-admin.clydeford.net`). Before: note the real Overview state, the newest
    Activity entry and the unread notes count. Then: `GET /api/v1/demo` → `on: false`, `devSeed: null`; Settings has no Dev
    data section; `fetch("/__dev/seed?scenario=empty",{method:"POST"})` → 404. Settings → Demo mode on → banner; every tab
    populated; `X-WG-Data: demo`; Deploy disabled; `POST /api/v1/notes/ack` → 409 `demo_mode`; record the refresh's
    `rowsToday` (S2 if it failed). Refresh again → 409 `demo_busy`. Wait for one cron tick (5 min) with demo on; turn off from
    the banner → real data back with `X-WG-Data: real`, the Overview state as noted, notes count unchanged, the newest Activity
    entry unchanged except the cron's own, the watchman's last run newer than before. No console errors in either mode.
    **Done when** every item is seen and recorded in the outcome; demo mode is left **off**.
11. **Outcome.** Write the outcome below (bundle figures, every (V) answer, rows per refresh, W3 fixes, review findings and
    fixes, versions and rollback id, live-check notes). **Done when** committed and pushed.

## Final review checklist

- **Separation:** the demo env is built from `DEMO_VARS` and facades only; tripwire test green; the only real write is the
  `demo_mode` row; journey fingerprint equal.
- **Routing:** per-request switch from D1, fail closed; reads to the DemoStore, everything else 409 before any handler; control
  routes work in both modes; `X-WG-Data` on every answer.
- **No outside calls:** no secrets in the demo env; every GET in the table with an empty outbound log; fetch guard active in
  `demoScope`; cron, watchman, lab watch, insights and token routes untouched.
- **People:** keyed by Access email; nobody else's view changes.
- **Caches:** topology key by source; app cache cleared on every switch; mismatched answers dropped; SW caches nothing.
- **UI:** banner with Turn off on every page; Demo mode section works even when demo reads fail; primary actions disabled;
  client guard toasts; Dev data only on the dev server; light and dark tokens; no sideways scroll at 390.
- **Budgets:** entry ≤ 320 kB (delta ≤ 1.5 kB), JS ≤ 450 kB, CSS ≤ 50 kB; demo refresh ≤ `DEMO_DAILY_ROWS` per day; no
  Azure call; `.env` never read by a builder.

## Outcome

To be written by the integrator after integration step 11.
