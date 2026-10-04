# Azure insights widgets: implementation plan

> **For agentic workers:** the integrator first lands the contract branch (X0). Then five areas run **in parallel**, each in its
> own git worktree and each built by one implementer under superpowers:test-driven-development:
> - X1: Azure collectors
> - X2: agent and infra
> - X3: Overview, Firewall and Settings widgets, plus the verdict
> - X4: Activity and Service Health
> - X5: the widget library UI
>
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** collect free Azure and VM insights into D1 and show them in new widgets, all off by default. Steven turns them on
from a per-page widget library that keeps the one-screen rule. With no saved preferences, every screen is pixel-identical to
today.

**Architecture:**
- **Collector:** a second cron line (`2-59/5`) runs `worker/src/insights/runner.ts`. Each feed module fetches, normalises and
  stores into D1 (migration `0019_azure_insights.sql`), under a 25-subrequest budget, with each feed isolated from the others.
- **Agent:** the VM agent gains `vitals` (background jobs in `wg-vitals.sh`, cached, never slowing the heartbeat).
- **API:** read-only `/api/v1/azure/*` routes serve the app.
- **Widgets:** `shared/widgets.ts` gains `description`, `defaultOff`, row `max`, `layout.shown` and `PrefsPutBody.schema: 2`.
  The Layout menu gains **Add widgets…** with Replace for full rows. Six new widgets, a verdict in the Health summary head, a
  top-bar Service Health pill and a deploy-form capacity warning.

**Tech stack:** unchanged. Hono, D1 and Vitest on the Worker (`worker/test/harness.ts`, `api-helpers.ts`). React 19, TanStack
Query, Radix and plain CSS in the app. Bash, jq and systemd on the VM. Terraform azurerm in GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-04-azure-insights-design.md`.
- Binding: §4 (feeds, API versions), §6 (tables), §8 (routes and types), §9 (library), §10.1 (catalogue rows: ids, settings,
  defaults, thresholds), §10.3 (verdict order) and §11 (boot log security).
- §2 lists the rulings. **(V)** items are confirmed live after deploy (Integration step 9).

## Global Constraints

- **Inherited:** the widgets plan's Global Constraints apply:
  - one `.css` per component, tokens, a status colour always paired with a word or icon, accessibility
  - "no data" is never 0
  - Vitest + RTL behaviour tests
  - commit trailer `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`, and push after every commit
  - no deploy
- **Base and branches:**
  - X0 branches `feat/azure-insights-contract` from `main` (live production). Every area branches from it after X0 is pushed.
  - Integration branch: `feat/azure-insights`. It becomes **PR 1** into `main`, with no `infra/**` changes.
  - The `infra/**` commits go to `feat/azure-insights-infra`, a branch from `main` that becomes **PR 2**.
  - **STOP before merging either PR and before any deploy: ask Steven.** Deploy order (Steven's call): `npm run migrate` (0019),
    then `npm run deploy-worker`, then PR 2.
- **Defaults are today.** New widgets are `defaultOff`. Existing scenarios (`running deploying busy-month destroyed empty failed
  standby`) get no Azure or vitals data, so the pixel diff against tag `insights-baseline` stays zero. Only the new `insights`
  scenario has that data.
- **Shared files are frozen for areas.** Only X0 or the integrator edits:
  - `shared/api.ts`, `shared/widgets.ts`, `shared/azureMetrics.ts`
  - `worker/migrations/**`, `worker/src/index.ts`, `worker/src/api/index.ts`, `worker/src/state.ts`, `worker/src/prefs.ts`,
    `worker/src/devseed.ts`, `wrangler.toml`
  - `web/src/widgets/{layout,usePrefs,useWidget,store}.ts*`, `web/src/api/**`, `web/src/shell/AppShell.tsx`, `web/src/test/**`,
    `web/src/components/**`, `scripts/**` (except the areas' prefs fixtures and X2's agent tests), `package.json`
  - Each area's owned files are listed in its section. A contract change an area needs goes to the integrator, who changes the
    shared file and the spec table in the same commit.
- **One-screen rule:**
  - At 1100×600 and larger, no desktop page scrolls with any mix of enabled, replaced, hidden and reordered widgets.
  - Rows keep their heights, and a row never shows more than `max` items.
  - 641–1099 px stacks; ≤ 640 px is the phone composition, where enabled Azure widgets append as cards.
- **Pages never call Azure.** Only the Worker does: the collector, POST boot log and a capacity cache miss. Thresholds colour
  this dashboard only.
- **Secrets:** never read or print `.env`. SAS URLs never leave the Worker. Fixtures use TEST-NET addresses, `wg.example.net`,
  fake GUIDs and no real subscription id.
- **Platform limits:** at most 25 subrequests per insights run (asserted in tests). No KV writes from insights. Everything the
  collector parses is trimmed or sliced (spec §7).
- **Gate (every area):** `npm test`, `npm run typecheck` and `npm run build:web` all pass. The infra side also needs CI's
  `terraform fmt -check` and validate (`npm run tf-validate` locally if Terraform is installed).

## Review Focus

1. **Defaults unchanged.** With no prefs, every scenario's shots diff to zero against `insights-baseline`.
   Tests: X0 `with no prefs every new widget is off and no layout changes`; each UI area
   `with no prefs <page> renders exactly as before`; X3 `verdict with no new data gives today's head byte for byte`.
2. **Library and full rows.** Tests:
   - X0 `a stored page from before this project normalises to the same visibility with every new widget off`
   - X0 `validate refuses a row over max with field layout.shown`
   - X5 `On places a default-off widget in its home row and saves shown`
   - X5 `a full row opens Replace with the suggestion preselected`
   - X5 `Replace saves hidden, shown and order in one PUT and the row's grid template is unchanged`
   - X5 `Cancel changes nothing`
3. **Feed isolation.** Tests:
   - X1 `a feed that throws is recorded as error and the next feed still runs`
   - X1 `sign-in failure marks ARM feeds error and still runs prices`
   - X2 `a vitals parse failure still answers the heartbeat with peers`
   - X0 `scheduled() sends 2-59/5 to runInsights and */5 to the watchman`
4. **Budget.** Tests: X1 `a feed whose calls would pass the budget is skipped and stays due`; X1 `worst-case run makes at most 25
   fetches` (counting fake fetch).
5. **Boot log security.** Tests:
   - X1 `no SAS URL in any stored row, response or error message`
   - X1 `each redaction pattern`
   - X1 `fetches at most the last 64 KB`
   - X1 `POST is limited to one per 60 s`
   - X3 `boot log modal never renders a URL`
6. **Old agents.** Tests: X2 `an agent_version 6 body stores vitals null`; X1 `summary says needsDeploy when a running VM's agent
   is older than 7`; X3 `agent widgets say Needs the next deploy`.
7. **Warnings only when wrong.** Tests: X4 `the pill renders nothing without an active regional issue`; X3 `the deploy form
   shows the capacity warning only when ok is false, and the button reads Deploy anyway`.
8. **Old tabs cannot wipe `shown`.** Test: X0 `PUT without schema 2 is 409 outdated`.

---

## X0: Contract and framework core (integrator, first)

**Branch:** `feat/azure-insights-contract` from `main`. **Owns:** every frozen file above. **Produces:**
- **`@shared/api`:** the spec §8 types.
- **`@shared/widgets`:** the new `WidgetDef` fields, row/stack `max`, `layout.shown`, the 6 new defs from spec §10.1 and the two
  new settings on existing widgets, `isVisible(prefs, def)`, `rowCapacity(page, row, prefs)` → `{max, visible, full, candidates,
  suggestion}`.
- **`@shared/azureMetrics`:** the metric catalogue.
- **`worker/src/insights/types.ts`:** `Feed`, `FeedCtx`, `FeedResult`, `BudgetExceeded`, `AZ_RUN_BUDGET`, plus empty route stubs.
- **`@/widgets`:**
  - `useWidget(id)` gains `enable()` → `{ok} | {full: true, candidates, suggestion}`, `disable()` and
    `replace(oldId)`.
  - `usePagePrefs` exposes `shown`.
  - The store sends `schema: 2`.
- **`@/api`:** `useAzureSummary()` (30 s), `useAzureMetrics(resource, range)`, `useAzureChanges(range, who)`,
  `useAzureServiceHealth(range)`, `useCapacity(region, size)`, `usePrice(region, size)`, `useBootLog()`, `useFetchBootLog()`.
- **Test fixtures:** `azureSummaryFixture(over)`, `vitalsFixture(over)`, and `mockFetch` defaults that answer every
  `/api/v1/azure/*` route with not-configured shapes, so existing tests pass.
- **Shell:** `<ServiceHealthIndicator />` is mounted in the top bar, returning null (X4 fills it).

- [ ] **X0.1 Baseline.** Tag `main` as `insights-baseline` and push the tag. Take shots per the widgets plan's W0.2 commands
  (scenarios `running deploying busy-month destroyed empty failed standby`, `--freeze-time --widget-chrome off`).
  **Done when:** two runs of `running` diff to zero.
- [ ] **X0.2 Schema.** `worker/test/widgets-schema.test.ts` adds:
  - `every widget has a one-line description`; `the six new widgets are defaultOff and declared in their home row or stack after the
    existing items`; `every row's max defaults to its item count before this project`; `with no prefs every new widget is off and no
    layout changes`.
  - `a stored page from before this project normalises to the same visibility with every new widget off` (fixtures: a real
    saved shape of each page, with hidden and reordered items)
  - `shown may name only default-off widgets and hidden may not name one`; `validate refuses a row over max with field
    layout.shown`; `normalise drops the newest shown entries from an over-full row`; `rowCapacity lists visible non-pinned
    candidates and the suggestion`; `catalogue rows match spec 10.1` (table-driven: id, home, settings keys, defaults, threshold
    defaults); `overview.health verdict defaults to true and activity.changeLog azure to false, both still version 1`.
  - FAIL. Implement in `shared/widgets.ts` and `shared/api.ts`. PASS. Commit.
- [ ] **X0.3 Prefs schema 2.** `worker/test/api-prefs.test.ts` adds:
  - `PUT without schema 2 is 409 outdated and changes nothing`; `PUT with shown round-trips sparse`; `PUT that overfills a row is
    400 naming layout.shown`.
  - FAIL. Implement in `worker/src/prefs.ts` and `worker/src/api/prefs.ts`. PASS. Commit.
- [ ] **X0.4 Storage, cron and stubs.** `worker/test/insights-contract.test.ts`:
  - `migration 0019 creates the az tables, hist_az_vm, hist_az_pip and the hist_vm vitals columns`; `scheduled() sends 2-59/5 to
    runInsights and */5 to the watchman`; `wrangler.toml declares both crons`; `every /api/v1/azure route answers its spec 8 shape
    with configured false and no fetch`; `routes refuse cross-site requests`; `devseed wipes the az tables in every scenario and the
    insights scenario fills them`.
  - FAIL.
  - Implement: the migration; `wrangler.toml` `crons = ["*/5 * * * *", "2-59/5 * * * *"]`; the `scheduled()` dispatch on
    `event.cron` (a no-op `runInsights` export from `worker/src/insights/runner.ts`, which X1 replaces); `AgentReport` gains
    `agent_version?` and `vitals?`, and `Snapshot` gains `sched_events_seen?`; `worker/src/api/azure.ts` stubs and one mount
    line; the devseed `insights` scenario (running, every feed ok, a credits dip, one outside NSG change, one active regional
    ServiceIssue, one scheduled Reboot, an agent with `vitals`); `insights` added to `scripts/seed-scenarios.mjs` and `shots.mjs`
    scenario lists.
  - PASS. Commit.
- [ ] **X0.5 App framework.** `web/src/widgets/layout.test.tsx` and `prefs.test.tsx` add:
  - `a default-off widget renders nothing until shown`; `enable adds it to shown at its declared index and saves`; `enable into a
    full row returns full with candidates and saves nothing`; `replace hides the old widget and shows the new one in its place in
    one PUT`; `disable of a default-off widget removes it from shown`; `Reset this page clears shown`; `the store sends schema 2`;
    `a 409 outdated from a missing schema says reload`.
  - FAIL. Implement in `layout.ts`, `useWidget.ts` and `usePrefs.ts`. PASS. Commit.
- [ ] **X0.6 Query hooks and fixtures.** `web/src/api/queries.test.ts` adds:
  - `useAzureSummary polls every 30 s and keeps the last answer on error`; `useCapacity is disabled without a region`;
    `useFetchBootLog posts and updates the bootlog cache`.
  - FAIL. Implement. PASS. Commit.
- [ ] **X0.7 Contract check.**
  - The gate passes.
  - Shots of every scenario with `--freeze-time --widget-chrome off` diff to zero against `insights-baseline`.
  - Push and tell the areas the commit and the surface above.
  - **Done when:** gate, zero diff and push.

---

## X1: Azure collectors and API

**Branch:** `feat/azure-insights-collectors`. **Owns:**
- `worker/src/insights/**` (except `types.ts`)
- `worker/src/azure.ts`: export `arm`, add nothing else
- `worker/src/api/azure.ts`
- `worker/src/settings.ts`, `worker/src/api/settings.ts`: `rate_source`, price
- `worker/src/api/overview.ts`: the `capacity` field
- `worker/test/insights-*.test.ts`, `worker/test/api-azure.test.ts`
- `worker/test/fixtures/azure/*.json`: trimmed reply shapes, fake ids, TEST-NET addresses

- [ ] **X1.1 Runner and budget.** Tests:
  - `runner runs due feeds in priority order and records last_ok_at`; `a feed that throws is recorded as error and the next feed
    still runs`; `a feed whose calls would pass the budget is skipped and stays due`; `budget.take throws BudgetExceeded past 25`;
    `worst-case run makes at most 25 fetches`; `sign-in failure marks ARM feeds error and still runs prices`; `without credentials
    every feed is not_configured and nothing is fetched`; `a fetch that hangs is aborted at 8 s and ends that feed only`; `when
    conditions: rg, vm, running, always`.
- [ ] **X1.2 Health.** Tests:
  - `normalise reads availabilityState, title, summary, reasonType and occurredTime`; `instance view gives power, provisioning, VM
    agent status and version, and boot diagnostics on or off`; `runs only while the resource group exists`.
- [ ] **X1.3 Metrics.** Tests:
  - `metricDefs limits metricnames to what the resource emits`; `vm metrics normalise into one wide row per 5-minute slot`; `byte
    totals become per-second rates`; `the last three complete slots are upserted (3 rows)`; `pip metrics normalise`; `a 400 for an
    unknown metric marks metricDefs due and records the error`; `vmMetrics runs while running and for 15 minutes after`; `pipMetrics
    runs while the IP exists`.
- [ ] **X1.4 Activity.** Tests:
  - `groups by correlationId and keeps the final status`; `caller kinds wgadmin, person, azure`; `resource types get plain names`;
    `ResourceHealth rows become health annotations`; `an outside change to the NSG writes one watchman note once per correlationId`;
    `wg-admin's own changes write no note`; `cadence: 5 min while the RG exists or within 2 h of a run, else 60 min`; `at most 2
    pages`.
- [ ] **X1.5 Service Health.** Tests:
  - `keeps ServiceIssue and PlannedMaintenance for VM and network services in the configured region` (region display names
    from `REGIONS`)
  - `serviceIssues lists only active issues`; `resolved events are kept 90 days`; `runs every 15 minutes`.
- [ ] **X1.6 Capacity.** Tests:
  - `skuRestrictions slices only the wanted sizes from a large reply`; `NotAvailableForSubscription makes available false with the
    reason`; `quota adds 1 vCPU for the test VM`; `message wording matches spec 10.2`; `a cache miss fetches once per region per 10
    minutes`; `overview carries capacity for the deploy target`.
- [ ] **X1.7 Prices and rate.** Tests:
  - `Linux pay-as-you-go only: Windows, Spot and Low Priority skipped`; `total is VM plus E4 over 730 plus IPv4; standby is disk
    plus IP; test VM is B1ls plus S4`; `GBP only, stale after 7 days`; `rate_source defaults to fixed when an hourly override is
    stored, else azure`; `effectiveConfig uses the Azure price for the deployed region and size`; `no fresh GBP price falls back to
    fixed with a reason`; `settings PUT accepts rate_source`.
- [ ] **X1.8 Boot log.** Tests:
  - `each redaction pattern` (table-driven); `no SAS URL in any stored row, response or error message`; `fetches at most the last 64
    KB and sets truncated`; `POST is limited to one per 60 s with 429 slow_down`; `fetched automatically once per stale-heartbeat
    episode`; `boot diagnostics off gives the next-deploy reason`.
- [ ] **X1.9 Routes and housekeeping.** Tests:
  - `summary: needsDeploy when a running VM's agent is older than 7`; `summary latest values come from the newest slot`; `metrics
    ranges and vitals columns`; `changes who filter`; `service-health range`; `GET /api/v1/azure/diagnostics lists feed status,
    emitted metric names and last errors without secrets`; `housekeeping prunes per spec 6`.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate passes, and the report lists every (V) item with the fixture shape it was built against.

## X2: Agent, infra and heartbeat ingestion

**Branch:** `feat/azure-insights-agent`. Keep `infra/**` changes in commits that touch only `infra/**`; the integrator
cherry-picks those onto PR 2. **Owns:**
- `infra/agent/wg-agent.sh`, `infra/agent/wg-vitals.sh` (new), `infra/cloud-init.yaml.tftpl`, `infra/main.tf`
- `worker/src/vitals.ts` (new); `worker/src/runs.ts` (`handleAgent` and `AgentBody` only); `worker/src/history.ts`
- `worker/test/vitals.test.ts`; additions to `worker/test/history.test.ts` and `api-healthcheck.test.ts` (bash -n)
- `scripts/test/agent-vitals.test.mjs`, `scripts/test/fixtures/agent/**`

- [ ] **X2.1 Background jobs.** `scripts/test/agent-vitals.test.mjs`, run with `WG_ROOT` pointing at fixtures and fake
  `apt-check`, `curl`, `ping` and `systemd-run` on `PATH`. It skips when bash or jq is missing. Tests:
  - `wg-vitals.sh passes bash -n`; `job updates writes pending and security`; `job events keeps at most 10, caps descriptions at 200
    and marks self`; `job events never POSTs`; `job net reports rtt and loss per target`; `job net falls back to tcp when ping loses
    everything`; `a second start while a job runs exits at once`.
- [ ] **X2.2 Heartbeat payload.** A tiny local HTTP server captures the body. Tests:
  - `wg-agent.sh sends agent_version 7 and vitals from fixture /proc`; `steal percent comes from two /proc/stat readings`;
    `conntrack is null when the files are absent`; `stale caches start their jobs through systemd-run --no-block`; `a job that
    sleeps 30 s leaves the heartbeat under 2 s`; `a broken cache file sends null for that field and the heartbeat still posts`.
- [ ] **X2.3 Ingestion.** `worker/test/vitals.test.ts` and `history.test.ts`:
  - `parseVitals never throws on fuzzed input`; `clamps percentages, caps strings, drops wrong types`; `an agent_version 6 body
    stores vitals null`; `handleAgent stores agent_version and vitals on the snapshot`; `hist_vm gets mem, disk, steal, conntrack
    and net columns`; `rollUp averages them and keeps the max steal and loss`; `a new scheduled event writes one note and one push,
    and the same id again writes nothing`; `a vitals parse failure still answers the heartbeat with peers`.
- [ ] **X2.4 Terraform and cloud-init.** Tests (Worker string checks, like the existing bash -n test):
  - `vm-wg declares boot_diagnostics with managed storage`; `cloud-init writes /usr/local/sbin/wg-vitals.sh 0755`; `main.tf passes
    wg-vitals.sh into the template`.
  - Implement. `terraform fmt -check -recursive` passes locally if Terraform is installed; otherwise CI's job is the check.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate passes, CI's terraform job is green on the branch, and the report confirms the heartbeat timing test.

## X3: Overview, Firewall and Settings widgets, plus the verdict

**Branch:** `feat/azure-insights-overview`. **Owns:**
- `web/src/views/overview/**`, `web/src/views/firewall/**`, `web/src/views/settings/**`
- `shared/verdict.ts` (new; the one shared file an area owns) and `worker/test/verdict.test.ts`
- `scripts/shots-prefs/{overview,firewall}.insights.json` (every new widget on, each replacing its suggestion)

- [ ] **X3.1 Verdict.** Tests:
  - `verdict rule 1` … `verdict rule 13` (table-driven, spec §10.3, each just past its threshold)
  - `verdict with no new data gives today's head byte for byte`
  - `uses vitals and vmPerformance thresholds from prefs, and defaults when those widgets are off`
  - Then wire it into `HealthSummary`: `verdict off shows today's head`; `rule 1 sub-line has a Boot log link`.
- [ ] **X3.2 Overview widgets.**
  - `with no prefs overview renders exactly as before`
  - `vmPerformance`: `range fetches that range`, `charts setting`, `thresholds colour with a word`,
    `Azure metric names in small print`, `peaks`
  - `azureHealth`: `health, power, agent, annotations shown`, `maintenance and service issues toggles`, `feed ages`
  - `vitals`: `rows setting`, `each threshold`, `bars off`
  - `each widget's states: not configured, waiting, stale, needs the next deploy, nothing running, error`
- [ ] **X3.3 Boot log modal.** Tests:
  - `opens from azureHealth and from the verdict`; `Fetch now posts and shows the redacted text`; `429 says try again in a minute`;
    `boot log modal never renders a URL`; `next-deploy reason shown`.
- [ ] **X3.4 Deploy form and Settings.** Tests:
  - `the deploy form shows the capacity warning only when ok is false, and the button reads Deploy anyway`; `Settings → Deployment
    shows the capacity line and the price line`; `rate_source control saves`; `stale or missing price explains the fixed fallback`.
- [ ] **X3.5 Firewall.** Tests:
  - `with no prefs firewall renders exactly as before`; `publicIp: range, series, availability and dropped thresholds, Azure names,
    states`; `narrow tabs include publicIp only when shown`.
- [ ] **X3.6 Phone and screens.**
  - `phone: an enabled Azure widget appears as a card after the existing blocks`
  - Shots `--scenario insights --prefs scripts/shots-prefs/overview.insights.json,scripts/shots-prefs/firewall.insights.json`
    exit 0 at 1600×900 and 1100×600, dark and light.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate passes, the default diff is zero for every scenario, and the prefs shots exit 0.

## X4: Activity change log and Service Health

**Branch:** `feat/azure-insights-activity`. **Owns:**
- `web/src/views/activity/**`
- `web/src/shell/ServiceHealthIndicator.tsx` (+ `.css`, `.test.tsx`)
- `scripts/shots-prefs/activity.insights.json`

- [ ] **X4.1 Azure change log widget.** Tests:
  - `with no prefs activity renders exactly as before`; `range, who and types filter the query and rows`; `failed only`; `status and
    caller columns`; `wg-admin rows are labelled wg-admin and portal changes show the person`; `states`.
- [ ] **X4.2 Change log opt-in.** Tests:
  - `Include Azure changes merges Azure rows tagged Azure in time order`
  - `off by default leaves the change log unchanged`
- [ ] **X4.3 Service health widget.** Tests:
  - `range and types`; `active first, then resolved`; `summaries toggle`; `region named in plain words`.
- [ ] **X4.4 Top-bar pill.** Tests:
  - `the pill renders nothing without an active regional issue`; `amber for an issue, red at level Error`; `planned maintenance does
    not light it`; `popover lists title, services, start, last update and summary, and links to Activity`; `keyboard and
    screen-reader name`.
- [ ] **X4.5 Phone and screens.**
  - `phone: enabled widgets append as cards; the pill shows on the phone top bar`
  - Shots `--scenario insights --prefs scripts/shots-prefs/activity.insights.json` exit 0 at 1600×900 and 1100×600 (including
    ≤ 720 px tall, where r3 is not rendered).
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate passes, the default diff is zero, and the prefs shots exit 0.

## X5: Widget library UI

**Branch:** `feat/azure-insights-library`. **Owns:**
- `web/src/widgets/LayoutMenu.tsx`, `WidgetLibrary.tsx` (new), `ReplaceModal.tsx` (new)
- `web/src/widgets/widgets.css`
- `web/src/widgets/library.test.tsx`

- [ ] **X5.1 Library.** Tests:
  - `Add widgets lists every widget of the page by row with icon, description and a switch`; `pinned widgets read Always on`; `On
    places a default-off widget in its home row and saves shown`; `Off on an existing widget hides it`; `turning a hidden existing
    widget back on into a full row asks to replace`; `read-only when prefs failed to load`; `phone opens the library as a Sheet`.
- [ ] **X5.2 Replace.** Tests:
  - `a full row opens Replace with the suggestion preselected`; `Replace saves hidden, shown and order in one PUT and the row's grid
    template is unchanged`; `a stack home lists the stack's members`; `Cancel changes nothing`; `focus returns to the switch after
    closing`; `a failed save reverts both widgets with the toast`.
- [ ] **X5.3 Screens.** On a test page and on Overview (with the `insights` scenario), replace in every row and confirm one
  screen at 1100×600.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate passes, and the default diff is zero (the menu's label changes only inside the open menu).

---

## Integration

1. **Merge onto `feat/azure-insights`,** in this order: X1, X2 (without its `infra/**` commits), X5, X3, X4. Run the gate after
   each merge. A conflict means an area edited a frozen file: reject that diff or fold it into the contract.
2. **Split the infra work.** Create `feat/azure-insights-infra` from `main` and cherry-pick X2's `infra/**` commits onto it.
   Check that CI's terraform job and the cloud-init render are green there.
3. **Full gate:** `npm test`, `npm run typecheck`, `npm run build:web` and `npm run bundle-size`. Report the growth.
4. **Pixel diff:** for every existing scenario, shots with `--freeze-time --widget-chrome off` diff to zero against
   `insights-baseline`.
5. **One screen with every new widget on:** `--scenario insights` with all three `*.insights.json` fixtures, and with each
   page's widgets `hidden.json` combined. Every run exits 0. Check the 1100×600 dark shots by eye.
6. **Live-ish check** in `npm run dev:api` + `npm run dev:web` on `insights`:
   - Turn on each new widget from the library, replacing the suggestion.
   - Open the boot log.
   - See the pill.
   - Change the deploy target to a seeded restricted size and see the warning.
7. **Whole-branch review:** one fresh reviewer on the most capable model (opus), given this plan, the spec and the shots.
   Ask specifically about:
   - the Review Focus list
   - boot log redaction and SAS handling
   - the budget and isolation in `runner.ts`
   - `validatePagePrefs` capacity and the schema 2 check
   - whether any default differs from today
8. **One fix pass:** fix each finding failing-test-first (or with a shot for a visual finding). Then rerun the gate, the pixel
   diff and the prefs shots.
9. **PR 1** (`feat/azure-insights` → `main`, CI green, shots summary in the description) and **PR 2**
   (`feat/azure-insights-infra` → `main`, noting that it takes effect at the next deploy).
   **STOP: ask Steven before merging either and before deploying.**
   - The deploy sequence, Steven's call: merge PR 1, `npm run migrate` (0019), `npm run deploy-worker`.
   - After 10 minutes, read `/api/v1/azure/diagnostics`: every feed should be `ok`, and the emitted metric names confirm the
     (V) items.
   - Then merge PR 2. Its effect shows from the next deploy (vitals, boot log).

## Final review checklist

- The 6 new widgets exist with spec §10.1's ids, homes, settings, ranges, defaults and thresholds. All are off by default, and
  all appear in Add widgets with a description.
- No saved prefs → every existing scenario's shots are pixel-identical to `insights-baseline`.
- Turning a widget on in a full row always goes through Replace. No desktop page scrolls at 1100×600 or larger with every new
  widget on.
- One failing feed never stops another, the watchman or the heartbeat. A worst-case run makes ≤ 25 fetches. There are no
  insights KV writes.
- SAS URLs never reach the browser, D1 or logs. The boot log is redacted and capped at 64 KB.
- Old agents → "Needs the next deploy". Old tabs → 409 outdated, never a wiped `shown`.
- Warnings (pill, capacity) appear only when something is wrong. The verdict matches today's head when there is no new data.
- Prices are Linux pay-as-you-go in GBP, with the fixed rate as fallback. `rate_source` respects an existing override.
- No Log Analytics, AMA, flow logs or paid Network Watcher features. No personal data or real ids in fixtures.
