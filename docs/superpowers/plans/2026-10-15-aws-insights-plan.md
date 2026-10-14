# AWS insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the VPN server runs in AWS, every insight panel shows AWS's figures (collected into D1 on the insights cron) instead of "AWS insights are coming soon"; plus the two #129 cost fixes.

**Architecture:** New AWS feed modules in `worker/src/insights/aws/` run beside the Azure feeds in `runInsights`, under the same call budget, writing new `aws_*` tables (migration 0024). `read.ts` gains a cloud switch so the existing `/api/v1/azure/*` routes answer the same response types from the AWS tables, tagged `cloud: "aws"`. The web panels lose the "coming soon" branch and label their source.

**Tech Stack:** Cloudflare Worker (TypeScript, Hono, D1, KV), `aws4fetch` SigV4 via `worker/src/cloud/awsApi.ts`, React web app (Vite, vitest + Testing Library), Terraform (`infra/aws-bootstrap`), node:test for `scripts/test`.

**Spec:** `docs/superpowers/specs/2026-10-15-aws-insights-design.md` — the binding authority. Read the sections each task names.

## Global Constraints

- Steven approved building, merging, deploying and one live AWS test without stops (memory aws-insights-autonomy); live spend stays under the £3 combined ceiling.
- Azure behaviour must not change: every existing test stays green unchanged, except tests that assert the "AWS insights are coming soon" text or an "Azure …" panel title renamed by spec §2.7.
- API paths stay `/api/v1/azure/*`; widget ids stay unchanged; all `shared/api.ts` changes are additive.
- Files start with the house header comment: `// path/file.ts` then a `// Plain English: …` paragraph. Match the surrounding comment density and naming.
- Every outside call goes through the feed ctx helpers (they take from the budget and time out after 8 s). Errors never quote a URL, a key or a signature.
- New tables: `WITHOUT ROWID`, ISO UTC times, integer binds `CAST(? AS INTEGER)`, not in the R2 backup, wiped by the dev seeder, present in the demo schema (`npm run demo-schema`).
- Never print `.env` secrets. Subagents copy `.env.example`, never the real `.env`. Kill processes only by PID. Don't use `python3`.
- Tests while building: run only the targeted test files (`npx vitest run <files>`, `node --test scripts/test/<file>`), plus `npm run typecheck`. The full `npm test` gate runs once at the end (Task 8).
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`.

## Review Focus

1. A destroyed server whose last cloud was AWS: summary/changes must read the AWS tables and not crash on a missing headend — Task 5 test.
2. AWS not configured (no Worker keys) while the server is in Azure: no AWS fetch at all, every AWS feed `not_configured`, Azure untouched — Task 1 runner test.
3. CloudTrail events from other projects in the same account must never appear in the change log — Task 3 fixture "someone else's instance".
4. CloudWatch returning fewer points than slots, or points out of order (it returns newest first): rows must land in the right slots, nulls stay null — Task 2 test.
5. RSS feed with an HTML error page or empty channel: feed records error/ok without wiping stored events — Task 3 test.

---

### Task 1: Foundation (contract, migration, runner wiring, IAM)

Freezes every interface the parallel tasks use. One implementer, on branch `feat/aws-insights`.

**Files:**
- Create: `worker/migrations/0024_aws_insights.sql` (spec §5, exactly those tables and columns; header comment in the style of 0019)
- Create: `worker/src/insights/aws/types.ts` — the AWS feed contract
- Create: `worker/src/insights/aws/ctx.ts` — `makeAwsCtx` (helpers that take from the budget)
- Create: `worker/src/insights/aws/runner.ts` — `runAwsInsights`
- Create: stub feed modules `worker/src/insights/aws/feeds/{health,metrics,activity,serviceHealth,capacity,prices,bootLog,housekeeping}.ts`, each exporting a default `AwsFeed` with the spec §4 table's id, title, cadence, when and calls, whose `run` returns `{ status: "error", error: "Not built yet." }` (housekeeping: real, it is tiny — prune per spec §5 last line). The stubs also export, with exact signatures and bodies that throw `new Error("Not built yet.")`: `fetchAwsBootLogNow(env: Env, now: Date): Promise<{ ok: true; doc: BootLogResponse } | { ok: false; why: "slow_down" | "error"; message: string }>` in bootLog.ts (same shape as Azure `fetchBootLogNow`), `awsCapacityCheck(doc: CapacityDoc | null, region: string, size: string, needTestVm: boolean, fetchedAt: string | null): CapacityCheck` in capacity.ts, `awsPriceInfo(rows: PriceRow[], cfg: Config, region: string, size: string, now: Date): PriceInfo` in prices.ts (PriceRow = the az_prices row type `readPrices` returns in insights/price.ts)
- Create: `worker/src/insights/aws/feeds/index.ts` — `AWS_FEED_MODULES` in priority order: health, metrics, activity, serviceHealth, capacity, prices, bootLog, housekeeping
- Modify: `worker/src/insights/runner.ts` — call `runAwsInsights` after the Azure feeds with the same parent budget; when the server is in AWS, Azure **server** feeds (`when` ≠ "always") record skipped "The server runs in AWS." while Azure cloud-wide feeds (`when: "always"`) still run if Azure is configured (today the AWS branch skips all Azure feeds; change it). Remove `AWS_SKIP`'s "coming soon" wording.
- Modify: `worker/src/cloud/aws.ts` — export `findHeadend` and `taggedArns` (no behaviour change)
- Modify: `shared/api.ts` — additive fields from spec §6: `cloud` on the five responses, `FeedStatus.source?: string`, `PriceInfo.source` gains `"aws"`, `SettingsResponse.awsPrice?: PriceInfo | null`, `OverviewResponse.awsCapacity?: CapacityCheck | null`. (Optional `?` so Azure code compiles untouched; Task 5 fills them.)
- Modify: `shared/azureMetrics.ts` — `AWS_METRICS` (spec §4.1 table: `{ name, stat, column, title, unit }`), `AWS_VM_COLUMNS` (hist_aws_vm value columns in table order), `AWS_RESOURCE_KINDS` (spec §4.3.1, `{ value, label, awsTypes: string[] }`), `awsRegionName(id)` ("eu-west-2" → "London", "eu-west-1" → "Ireland", "us-east-1" → "N. Virginia", else the id)
- Modify: `infra/aws-bootstrap/main.tf` — statements `Insights` and `ConsoleOfOurServer` (spec §8)
- Modify: `scripts/test/aws-infra.test.mjs` — pin the IAM statements
- Modify: `worker/src/demo/schema.gen.ts` via `npm run demo-schema`; the dev seeder's table wipe list includes `AWS_TABLES`
- Test: `worker/test/insights-aws-runner.test.ts`

**Interfaces (produces — later tasks rely on these exact names):**

```ts
// worker/src/insights/aws/types.ts
export type AwsFeedId = "aws.health" | "aws.metrics" | "aws.activity" | "aws.serviceHealth" | "aws.capacity" | "aws.prices" | "aws.bootLog" | "aws.housekeeping";
/** Which Azure FeedIds each AWS feed stands in for on screen (metrics → vmMetrics and pipMetrics). */
export const AWS_STANDS_IN: Record<Exclude<AwsFeedId, "aws.housekeeping">, FeedId[]>;
/** The footer's source label per AWS feed: "AWS EC2", "AWS CloudWatch", "AWS CloudTrail", "AWS public status feed", "AWS Service Quotas", "AWS Price List", "AWS console output". */
export const AWS_SOURCES: Record<Exclude<AwsFeedId, "aws.housekeeping">, string>;
export type AwsFeedWhen = "always" | "server" | "running"; // server = the AWS headend exists; running = running, or ≤15 min after it stopped
export interface AwsHeadend { id: string; state: string; launchTime: string | null; instanceType: string | null }
export interface AwsFeedCtx {
  env: Env; db: D1Database; now: Date; snap: Snapshot; cfg: Config; budget: Budget;
  region: string;                                  // config(env).aws.region
  ec2(action: string, params?: Record<string, string>): Promise<string>;          // XML, 1 call
  query(service: "monitoring", action: string, params: Record<string, string>, version: string): Promise<string>; // CloudWatch Query API XML, 1 call
  json<T>(o: { service: string; region: string; host: string; target: string; body: unknown }): Promise<T>;    // JSON 1.1, 1 call
  fetch(url: string, init?: RequestInit): Promise<Response>;                      // unsigned (RSS), 1 call
  headend(): Promise<AwsHeadend | null>;           // memoised per run; 1 call the first time
  taggedIds(): Promise<Set<string>>;               // ids (last ARN segment) of wg-admin=vpn resources, memoised; 1 call the first time
  row?: { last_try_at: string | null; last_ok_at: string | null; next_due_at: string | null } | null;
}
export interface AwsFeed { id: AwsFeedId; title: string; cadenceMin: number | null; when: AwsFeedWhen; calls: number; run(ctx: AwsFeedCtx): Promise<FeedResult> }
export function awsConfigured(env: Env): boolean;  // spec §3 last bullet
export const AWS_TABLES = ["hist_aws_vm", "aws_feed", "aws_latest", "aws_activity", "aws_service_events", "aws_capacity", "aws_prices"] as const;
/** aws_latest['health'] */
export interface AwsHealthDoc { instanceId: string; health: Omit<AzureHealth, "annotations">; maintenance: ScheduledEvent[] }
/** aws_latest['bootlog'] is a BootLogDoc plus the launch time it was read for */
export type AwsBootLogDoc = BootLogResponse & { launchTime: string | null };
// aws_capacity.json is the existing CapacityDoc (insights/types.ts): sizes[{name, available, reason, vcpus, family:"standard"}], usages[{family:"standard", used, limit}], cores {used, limit}
// aws_prices rows: item = instance type | "disk:gp3" | "ip:v4"; unit "1 Hour" | "GB-Mo"; gbp per unit; meter = AWS usagetype
// worker/src/insights/aws/common.ts (create in Task 1): getAwsLatest/putAwsLatest(db, key, doc), readAwsFeedRows(db), awsPlainError(e): string
//   awsPlainError maps AwsError codes: AccessDenied*/UnauthorizedOperation → "AWS refused <action>: the Worker's AWS user needs <permission>." ; Throttling*/RequestLimitExceeded → thrown as a SkipFeed (runner records skipped)
export class AwsThrottled extends Error {}
```

```ts
// worker/src/insights/aws/runner.ts
export async function runAwsInsights(env: Env, now: Date, feeds: readonly AwsFeed[], opts: { budget: Budget; late: () => boolean; snap: Snapshot; cfg: Config }): Promise<string[]>;
```

Runner rules (spec §2.4, §3, §9): not configured → every AWS feed `not_configured`, zero fetches. `server`/`running` feeds only when `cloudOf(snap) === "aws"` and the state is not destroyed (else they record nothing new: keep their row, status `idle` if never run). Due-ness, cadence, `calls` vs remaining budget, soft deadline, and the `aws_feed` write follow the Azure runner's logic (reuse its helpers where they are generic; do not modify Azure's behaviour). `AwsThrottled` → `skipped`.

- [ ] **Step 1:** Write `worker/test/insights-aws-runner.test.ts` covering: (a) AWS not configured, server in Azure → no fetch, every aws feed row `not_configured`; (b) server in AWS → Azure server feeds `skipped` with "The server runs in AWS.", Azure `always` feeds still due/run, AWS stub feeds run (status error "Not built yet."); (c) AWS configured, server in Azure → only AWS `always` feeds run; (d) budget of 1 left → AWS feed needing 3 calls is `skipped` with the out-of-calls words; (e) a feed throwing `AwsThrottled` → `skipped`. Use the existing `worker/test/insights-helpers.ts` harness style.
- [ ] **Step 2:** Run `npx vitest run worker/test/insights-aws-runner.test.ts` — expect FAIL (modules missing).
- [ ] **Step 3:** Implement the files above. Migration per spec §5. IAM per spec §8.
- [ ] **Step 4:** Extend `scripts/test/aws-infra.test.mjs`: statement `Insights` has the six actions with the region condition and no Delete/Create/Modify; `pricing:GetProducts` present; statement `ConsoleOfOurServer` has only `ec2:GetConsoleOutput`, Resource `instance/*`, condition `aws:ResourceTag/wg-admin = vpn`.
- [ ] **Step 5:** Run `npx vitest run worker/test/insights-aws-runner.test.ts worker/test/insights-runner.test.ts worker/test/demo-schema.test.ts worker/test/devseed.test.ts` and `node --test scripts/test/aws-infra.test.mjs` and `npm run typecheck` — all PASS. (An existing runner test asserting that every Azure feed is skipped on AWS is updated to the new rule: only server feeds skip.)
- [ ] **Step 6:** Commit `feat(insights): AWS feed contract, tables, runner wiring and IAM (spec §3, §5, §8)`.

---

Tasks 2, 3, 4, 5, 6 and 7 run **in parallel** after Task 1, each in its own worktree branched from `feat/aws-insights` at Task 1's commit. Each replaces only its own stub files and adds its own tests; shared files they must touch are listed explicitly so merges stay clean.

### Task 2: Server feeds — health, metrics, boot log

**Files:** `worker/src/insights/aws/feeds/{health,metrics,bootLog}.ts`; tests `worker/test/insights-aws-server.test.ts`; fixtures `worker/test/fixtures/aws-insights/{status-ok,status-impaired,status-stopped,status-events}.xml`, `metrics.xml`, `console.json`; may add one exported helper to `worker/src/cloud/awsApi.ts` only if needed for the Query API (keep `ec2` untouched).

Spec: §4.1, §4.2, §4.7, §2.8 (scheduled-event note + push — reuse the function Azure's heartbeat path uses for a new scheduled event; find it with `grep -rn "scheduled" worker/src/monitor.ts worker/src/api/*.ts`; dedupe by event id in `aws_latest` so each event notes once).

Each module exports `fetch*`, `normalise*` and `store*` separately (house rule) and a default `AwsFeed`.
- metrics: `GetMetricData` Query API params `MetricDataQueries.member.N.Id/MetricStat.Metric.Namespace/MetricName/Dimensions.member.1.Name=InstanceId/Value/MetricStat.Period=300/MetricStat.Stat`, `StartTime`, `EndTime`, `ScanBy=TimestampAscending`. Parse `<MetricDataResults><member><Id>…<Timestamps><member>…<Values><member>…`. Divide Sums per spec table. Upsert one row per slot (`INSERT … ON CONFLICT(res,t) DO UPDATE SET` only non-null columns). `when: "running"`, cadence 15, calls 1 (+ headend lookup counted by ctx).
- health: as spec §4.2. `when: "server"`, cadence 5.
- bootLog: due when `headend().launchTime` differs from the stored doc's, or never fetched; `when: "server"`, cadence null; also export `fetchAwsBootLogNow(env, now)` for Task 5's POST route (same one-a-minute rule as Azure's `fetchBootLogNow` in `insights/ondemand.ts`).

- [ ] Write failing tests (every bullet of spec §11's fixture list for these three feeds, plus Review Focus 4), run them (FAIL), implement, run targeted tests + typecheck (PASS), commit `feat(insights): AWS health, metrics and boot log feeds`.

### Task 3: Account feeds — change log and service health

**Files:** `worker/src/insights/aws/feeds/{activity,serviceHealth}.ts`; tests `worker/test/insights-aws-activity.test.ts`; fixtures `lookup-events.json` (ours by Worker user, ours by deploy role, a person changing our SG, an AWS service event, a failed call, someone else's instance), `rss-empty.xml`, `rss-active.xml`, `rss-resolved.xml`, `rss-html-error.html`.

Spec: §4.3, §4.3.1, §4.4, §2.8 (outside-change note — reuse the helper Azure's activity feed uses to write "Changed in Azure outside wg-admin"; find it in `worker/src/insights/feeds/activity.ts`; words "Changed in AWS outside cloudlabs: <operation> on <resource> by <caller>", once per event id).

- activity: `when: "always"`, cadence 5, calls 4 (3 pages + taggedIds). Only call `taggedIds()` when there are events not obviously cloudlabs'.
- serviceHealth: `when: "always"`, cadence 15, calls 2. Region display name from `awsRegionName`.

- [ ] Failing tests (spec §11 items for these feeds + Review Focus 3 and 5), FAIL, implement, targeted tests + typecheck PASS, commit `feat(insights): AWS change log and service health feeds`.

### Task 4: Region feeds — capacity and prices

**Files:** `worker/src/insights/aws/feeds/{capacity,prices}.ts`; tests `worker/test/insights-aws-region.test.ts`; fixtures `offerings.xml`, `instance-types.xml`, `quota.json`, `instances-running.xml`, `price-instance.json`, `price-gp3.json`, `price-ip.json` (PriceList entries are JSON strings inside `PriceList[]` — parse twice).

Spec: §4.5, §4.6. Sizes: `cfg.aws.instanceType` and `"t4g.nano"`. `CapacityDoc` from `worker/src/insights/types.ts`. Also fill in `awsCapacityCheck` (Task 1 signature) (needed = size vCPUs + test VM's when on; message words like Azure's capacity check) and `awsPriceInfo` (Task 1 signature; `totalGbpPerHour` = instance + gp3×8/730 + ip; `standbyGbpPerHour` = gp3×8/730 + ip; `stale` after 7 days; `source: "aws"`) for Task 5.

- [ ] Failing tests (offered/not offered, quota near full → ok false with message, price parse and GBP conversion with `usdToGbp`), FAIL, implement, targeted tests + typecheck PASS, commit `feat(insights): AWS capacity and price feeds`.

### Task 5: Read layer, routes, overview/settings, dev seed

**Files:** `worker/src/insights/read.ts`, `worker/src/insights/aws/read.ts` (create: the AWS readers), `worker/src/api/azure.ts`, `worker/src/api/overview.ts`, `worker/src/api/settings.ts`, `worker/src/insights/ondemand.ts` (bootlog POST/GET and capacity cache-miss route to AWS when the cloud is aws), `worker/src/devseed.ts` + `scripts/seed-scenarios.mjs` (`insights-aws` story); tests `worker/test/insights-aws-read.test.ts`.

Spec: §6, §7 last bullet (seed). Interfaces from Task 1 only — Tasks 2 and 4's `fetchAwsBootLogNow`, `awsCapacityCheck`, `awsPriceInfo` are imported by name from `./aws/feeds/bootLog`, `./aws/feeds/capacity`, `./aws/feeds/prices` (Task 1 created them as stubs with the exact signatures; Tasks 2 and 4 fill them in). Cloud choice: `cloudOf(snap)`; the snapshot keeps `cloud` after destroy, so a destroyed AWS server still reads AWS tables. FeedStatus for AWS per `AWS_STANDS_IN`, `source` from `AWS_SOURCES`; `metricDefs` reads ok/`source: "AWS CloudWatch"`. Azure responses gain `cloud: "azure"` and `source: "Azure"` and are otherwise byte-identical.

- [ ] Failing tests: every `/azure/*` route with an AWS snapshot and seeded `aws_*` rows (summary latest/health/maintenance/serviceIssues, metrics vm and pip mapping incl. nulls, changes who-filter, service-health, capacity, price, diagnostics, bootlog GET); a destroyed-AWS snapshot (Review Focus 1); Azure snapshot unchanged (existing `insights-routes.test.ts`, `api-azure.test.ts` pass). FAIL, implement, targeted tests + typecheck PASS, commit `feat(insights): serve AWS insights through the existing routes`.

### Task 6: Web

**Files:** `web/src/views/overview/Insights.tsx`, `web/src/views/overview/cloud.ts`, `web/src/views/activity/{AzureChanges,PhoneAzure,ServiceHealth}.tsx`, `web/src/views/firewall/PublicIp.tsx`, `web/src/views/overview/BootLog.tsx`, `web/src/views/overview/actions.tsx` (AWS capacity warning), the Settings → Deployment view (AWS price line; find with `grep -rn "rateSource\|price\." web/src/views/settings`), `shared/verdict.ts` (cloud wording), the Service Health pill (find with `grep -rn "serviceIssues" web/src`), and their tests (`web/src/views/overview/insights.test.tsx` and siblings).

Spec: §7, §2.7, §1 footers. Build against Task 1's types (`cloud`, `FeedStatus.source`, `awsCapacity`, `awsPrice`, `AWS_METRICS`, `AWS_RESOURCE_KINDS`, `awsRegionName`); with `cloud` absent treat as "azure".

- [ ] Failing tests: each panel on an AWS overview with AWS data shows figures (not the coming-soon text), its source footer, AWS metric names in small print, Azure-only figures hidden; Public IP DDoS note; change-log delay note; neutral titles; deploy-form AWS capacity warning; Settings AWS list price; verdict and pill say AWS/London. Update existing tests that asserted `AWS_SOON_TEXT` or old titles. FAIL, implement, targeted tests + `npm run typecheck` PASS, commit `feat(web): AWS insight panels`.

### Task 7: Issue #129

**Files:** `worker/src/budget.ts` (`readBudget` ~line 170), `worker/src/api/cost.ts` (~line 30 and wherever `cost:aws_fetched_day` is written: `grep -rn "aws_fetched_day" worker/src`), web cost tiles/panels (`grep -rn "Azure actual" web/src`); tests in `worker/test/budget.test.ts`, `worker/test/api-cost.test.ts` and the web cost tests.

Spec: §10. The estimate when AWS days can't be read: what `budgetFigures` would add for the current AWS run (`ratesFor(cfg, "aws").hourlyRateGbp` × hours running this month, same as the existing estimate path) — follow the existing estimate code, don't invent a new formula. KV write gets `{ expirationTtl: 36 * 3600 }`.

- [ ] Failing tests, FAIL, implement, targeted tests + typecheck PASS, commit `fix(cost): #129 — AWS cost read failure uses the estimate; last-pulled date expires; neutral labels`.

---

### Task 8: Integrate, full gate, review

- [ ] Merge the six worktree branches into `feat/aws-insights` (resolve any conflict in favour of the spec).
- [ ] `npm run typecheck` and `npm test` — all PASS. Fix anything red.
- [ ] Dev check: `npm run seed -- insights-aws` against a local dev server (`.env.example` copy), fetch `/api/v1/azure/summary`, `/metrics?resource=vm&range=24h`, `/changes` and confirm `cloud: "aws"` with figures.
- [ ] Whole-branch review on the most capable model against the spec; fix findings; re-run the gate.
- [ ] Commit, push, open PR "AWS insights (+ #129)" with the spec and plan linked, `gh pr checks --watch` green.

### Task 9: Ship and live test

- [ ] Apply IAM: `node scripts/aws-bootstrap.mjs` (local admin keys; read its usage first). Verify with `aws iam get-user-policy --user-name wg-admin-worker --policy-name wg-admin-worker` that the new statements are present.
- [ ] `gh pr merge N --merge`; `git switch main && git pull && npm run migrate` (if migrations are applied separately — check `scripts/deploy-worker.mjs` first) `&& npm run deploy-worker`; `git checkout -- worker/src/build.ts`; record the Worker version in memory `golive-versions.md`.
- [ ] Live: deploy on AWS (test VM off) from the dashboard API; wait ≤ 20 min; check `/api/v1/azure/summary` (cloud aws, health Available, feeds ok), `/metrics?resource=vm&range=1h` has points, `/changes` shows the deploy's events by cloudlabs, `/service-health` ok, `/diagnostics` all AWS feeds ok, POST `/bootlog` returns text; then destroy; confirm safety net "AWS clean". Record spend.
- [ ] Close #129; update memories `aws-support.md`, `wg-admin-project.md`.
