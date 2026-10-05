# Labs batch 1 (engine + labs 1–7): implementation plan

## L0 names as built

The contract on `feat/labs-contract`. Every area branches from its head and uses these names exactly; a change goes through
the integrator. Paths are from the repo root.

**Shared, `shared/labs.ts`** (values and pure functions; the scripts' copies in `scripts/lib/labs.mjs` are kept equal by a test)
- Constants: `LAB_ID_RE` (`/^az(104|305)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/`), `LAB_ID_MAX` 40, `LAB_POOL` `"10.64.0.0/13"`,
  `LAB_SLOTS` 32, `LAB_SLOT_BITS` 18, `GATEWAY_RANGES`, `GOVERNANCE_LABS` (the five ids: `az104-01-identity`,
  `az104-02-policy`, `az104-03-mgmt-groups`, `az305-20-landing-zone`, `az305-21-monitoring-scale`), `LAB_TF_VARS` (§3.4),
  `ALLOWED_ROLES` `{ builtIn: {name,id}[], custom: {lab,name,id}[], principalTypes }` (from `labs/setup/allowed-roles.json`),
  `HOURS_PER_MONTH` 730, `LAB_GRACE_MIN` 15, `LAB_COVERAGE_MIN` 15, `LAB_NOTE_MAX` 2000, `LAB_HOURS_MAX` 12,
  `LABS_MAX_RUNNING_DEFAULT` 3.
- Lists: `LAB_SESSION_STATES`, `LAB_LIVE_STATES` (deploying, running, failed, tearing_down), `LAB_PEERINGS`,
  `LAB_END_REASONS`, `LAB_ACTIONS`, `LAB_WARNING_KINDS` (budget, capacity, pricey, slow, unavailable), and `LAB_STEPS`: the 16
  §5 steps `{ n, name, on: LabAction[] }`. **lab.yml's step names are `LAB_STEPS[].name` exactly.**
- Types: `LabExam`, `LabLevel`, `LabType`, `PeeringMode`, `LabRoleScope` (resource_group | resource | management_group),
  `LabCostItem`, `LabDef` (lab.yaml keys in snake_case, plus `number`), `SkillArea { key, exam, name }`, `ReadmeInline`
  (`t: text | b | code | a`), `ReadmeBlock` (`t: h | p | ul | code | details`; details `{ summary, blocks }`), `LabCatalogue
  { schema: 1, skillAreas, labs, readmes: Record<id, ReadmeBlock[]> }`, `AllowedRoles`.
- Functions: `slotCidr(n)`, `cidrOverlaps(a, b)`, `labRg(id)`, `labLockName(id)`, `labIdFromName(name, ids)` (longest id, else
  null), `ownsName(id, name, ids?)`, `isGovernanceLab(id)`, `labNeeds(def)` → `{ role, graph }`, `estimateGbpH(items, priceOf?)`
  (6 dp), `costMarker(gbpH, deployMin)` (£ < 0.05/h ≤ ££ < 0.50/h ≤ £££, or deploy ≥ 30 min), `sessionTimeoutMin(timing)`,
  `labsSettingsFrom(stored)` → `{ labsMaxRunning, labsDefaultPeering }`.

**lab.yaml** (read as YAML 1.1: quote `"off"`). Keys, all required unless marked: `id, version, title, summary, exam,
skill_areas, level, type, prerequisites, cost: { items: [{ name, gbp_h, qty?, retail?: { meter?, unit?, sku? } }], pricey },
timing: { deploy_min, destroy_min, session_h, max_h }, capacity: { vm_sizes }, regions: { secondary }, connectivity: {
peering, dns_link, subnets_used }, identity: { creates, roles: [{ role, scope }], governance }`. Unknown keys are refused.
Extra rules: exam matches the id; `identity.governance` equals `isGovernanceLab(id)`; roles come from `allowed-roles.json`
(a custom role only for its own lab), never at `subscription`; `subnets_used` 0–4, 0 only with peering `"off"`; a
`retail.sku` is also listed in `capacity.vm_sizes`; whole hours and minutes; ids unique, not a prefix of another, numbers unique.
**Readmes:** `##` headings What it deploys, Things to try (3–6 bullets), Learn more; break-fix adds Symptom and a closed
`<details>` + `<summary>What was broken</summary>`; the footer `readmeFooter(id)` verbatim. Allowed: `#`–`###`, paragraphs,
`-` bullets (no nesting), fenced code, `**bold**`, `` `code` ``, `[text](https://...)`, `<details>`. Names such as `<id>` go in
backticks. **Terraform outputs:** `private_ips` (map), `connect` (list), optional `peer_vnet_id`, optional `users` (name → UPN).

**Scripts:** `scripts/lib/labs.mjs` (types in `labs.d.mts`): `parseLabYaml(text)`, `validateLab(raw, { folder, skillAreas })`,
`parseReadme(md, type, id|null)` → `{ blocks, problems }`, `readmeFooter(id)`, `buildCatalogue(labsDir)` → `{ catalogue,
problems: { lab, file, field, message }[] }`, `labFolders(labsDir)`, `checkPool(ranges?)`, `lintTfText({ file: text })` →
`{ file, line, rule: literal-cidr | provisioner | provider | gateway, message }[]`, `variablesProblems(tf)`,
`versionProblems(labsDir, gitRef)`. `npm run labs-build` writes `shared/labs.generated.json` (gitignored; `test`, `typecheck`,
`build:web`, `dev`, `dev:api` run it first); `npm run labs-check [-- --base origin/main]` (a lab without `terraform/` is a note,
not a failure, until L5/L6 add it). `.gitignore` also covers `labs/setup/*.local.*`. Dev dependency `yaml` 2.9.1 (exact).
**Seeds:** `labs/skill-areas.yaml` (list of `{ key, exam, name }`), `labs/_template/{versions,variables,outputs,main}.tf`,
`labs/setup/allowed-roles.json` (lab 1's `lab-az104-01-identity-vm-operator` is `7331dcae-09d3-477e-8da7-2895697f0fc0`),
labs 1–7 `lab.yaml` v1 and stub readmes (no `terraform/` yet).

**API, `shared/api.ts`** (routes under `/api/v1`, errors `{ error: { code, message, field? } }`; an unknown body key is 400
`bad_input` with `field` = that key)
- Types: `LabSessionState`, `LabPeering`, `LabEndReason`, `LabAction`, `LabWarningKind`, `LabWarning`, `LabRunRow` (with
  `step: { done, of, name }`), `LabSession` (camelCase; `costGbp`, `costBasis`, `outputs { privateIps, connect, users }`,
  `activeRun`), `LabReleaseTest` (`result: pass | fail`, `clean`), `LabCard` (`estGbpH`, `marker`, `pricey { item, gbpH }`,
  `running`, `lastSession`, `runs`, `lastReleaseTest`, `released`, `unavailable`), `LabPermissions`, `LabOrphan`,
  `LabsResponse`, `LabCostLine` (`gbpH`, `source: azure | authored`, `priceAge` seconds), `LabDetail` (`card, readme, cost,
  connectivity, identity, warnings, defaults { region, peer, hours }, gatewayUp, session, runs, resources, portalUrl`),
  `LabDeployBody`, `LabExtendBody` (`{ hours }` or `{ toMax: true }`), `LabDestroyBody`, `LabNoteBody`, `LabOrphanCleanupBody`
  (`lab_id`), `LabSessionsResponse`, `LabCoverage`, `LabCoverageResponse`, `LabSecretResponse { adminPassword, users }`,
  `LabPermissionsCheckResponse`, `LabCostRow`, `LabsSummary { running: LabSession[], gbpH, rePeer }`.
- New fields: `OverviewResponse.labs: LabsSummary`, `CostResponse.labs: LabCostRow[]`, `SettingsValues.labsMaxRunning /
  labsDefaultPeering`, `RunRow.lab?: { id, title, action: LabAction } | null` (a lab row's `action` is `apply` for deploy,
  peer and test, `destroy` for destroy and unpeer), `ClientView.labsConfigDue`, `Peer.labs_config_due`.
- Routes (`worker/src/api/labs.ts`, `registerLabs`): `GET /labs`, `GET /labs/sessions?lab=&limit=` (1–200, default 50),
  `GET /labs/coverage`, `GET /labs/:id`, `GET /labs/:id/secret` (409 `not_running`), `POST /labs/:id/{deploy,extend,destroy,
  peer,unpeer,test,cancel}`, `PUT /labs/sessions/:sid/note`, `POST /labs/repeer`, `POST /labs/permissions/check`,
  `POST /labs/orphans/cleanup`. Stubs answer 501 `not_implemented` where the engine must act; input checks, shapes and 404s are
  final.

**Widgets, `shared/widgets.ts`:** `overview.runningLabs` (r4, weight 32, settings `costSoFar`, `peering`) and `cost.labs` (r3,
weight 4, settings `order: largest | lab`, `estimates`), both `defaultOff`, icon `FlaskConical`, replacing `overview.costImpact`
and `cost.insights`; cost r3 `max: 3`; the simulator's zones gain `labs` (before `internet`).

**Worker**
- Migration `worker/migrations/0020_labs.sql`: `lab_sessions`, `lab_runs`, `lab_slots`, `lab_cost_days`, `lab_release_tests`
  (§7.1 columns exactly; extra indexes `lab_sessions_state`, `lab_runs_session`, `lab_runs_requested`), 32 slots, and
  `peers.labs_config_due` (set for `azure_vnet = 1`, `full_tunnel = 0`, no routes). Bind integers with `CAST(? AS INTEGER)`.
- `worker/src/labs/catalogue.ts`: `catalogue()`, `labDef(id)`, `labReadme(id)`, `labIds()`, `setCatalogueForTest(cat | null)`.
- `worker/src/lock.ts`: `acquireLock(env, runId, { name?, ttlMs? })`, `releaseLock(env, runId?, force?, name?)`,
  `lockStatus(env, name?)`, `GATEWAY_LOCK` `"singleton"`, `labLock(id)` `"lab:<id>"`.
- `worker/src/actions.ts`: `QuickAction` adds `LabQuickAction` (`lab-extend-1h:<sid>`, `lab-destroy:<sid>`), `isLabAction()`;
  `/api/act` sends those to `runLabAction(env, action)` in `labs/act.ts`.
- `worker/src/labs/callbacks.ts` (index.ts mounts them; each `(env, token | null, body) → { status, body }`; 401/403/404 count
  against the brake): `handleLabCallback` (`/api/callback/lab`), `handleLabSecrets` (`lab-secrets`, the OIDC token),
  `handleLabPeer` (`lab-peer`), `handleLabPeeringsRemoved` (`lab-peerings-removed`).
- `worker/src/labs/watch.ts`: `runLabWatch(env, now) → string[]`; `scheduled()` runs watchman → lab watch → insights, each
  caught alone.
- `worker/src/labs/summary.ts`: `labsSummary(env, now)` (OverviewResponse.labs), `labCostRows(env, now)` (CostResponse.labs).
- KV: `labs:permissions` (`LabPermissions`), `labs:orphans` (`LabOrphan[]`). Lab notes use alert kind `cost_guard` or `info`.
- Firewall: `Zone` gains `"labs"` (label "Labs", v4 `[LAB_POOL]`, no v6); `LAB_POOL` joins `privateV4`.
- Harness: `World.dispatches[] { workflow, action, payload }` (lab.yml titles `lab <action> <lab_id> <run_id>`; each
  workflow lists only its own runs), `world.labAzure { groups, managementGroups, roleDefinitions, policyDefinitions,
  policyAssignments, resources, roleAssignments, costRows }`, `world.graph { users, groups, fail? }`, `world.calls[] { method,
  host, path }`; one RunLock instance per name.
- Dev seed: scenario `labs` (`worker/src/devseed-labs.ts`: `seedLabs`, `wipeLabs`, `LABS_KV`, `LAB_TABLES`); every story wipes
  the lab tables, frees the slots and deletes both KV keys. Listed in `scripts/seed-scenarios.mjs`.

**App**
- `TABS`: Labs (`/labs`, icon `FlaskConical`) after Cost. Routes `/labs`, `/labs/history`, `/labs/:id` → `LabsPage` in
  `views/pages.tsx` (`React.lazy(() => import("./labs"))`); `views/labs/index.tsx`'s **default export** is the whole tab.
  Phone labels are `.tabbar__label`.
- `SETTINGS_SECTIONS` gains `{ slug: "labs", label: "Labs" }` (before Maintenance); its body is a placeholder in
  `views/settings/index.tsx` (`case "labs"`) for L4's `LabsSection`.
- Queries (`web/src/api/queries.ts`): `INTERVALS.labs` 15 s, `INTERVALS.labsHistory` 60 s, `labsInterval(data)`,
  `labDetailInterval(data)` (5 s while a session deploys, tears down or has an `activeRun`), `useLabs()` key `["labs"]`,
  `useLab(id)` `["labs", id]`, `useLabSessions(lab?, limit = 50)` `["labs", "sessions", lab ?? "", limit]`, `useLabCoverage()`
  `["labs", "coverage"]`.
- Mutations (`web/src/api/mutations.ts`; each invalidates `["labs"]`, `["overview"]`, `["activity"]`): `useDeployLab({ id,
  ...LabDeployBody })`, `useExtendLab({ id, ...LabExtendBody })`, `useDestroyLab(id)`, `usePeerLab(id)`, `useUnpeerLab(id)`,
  `useTestLab(id)`, `useCancelLab(id)`, `useRePeerLabs()`, `useSaveLabNote({ sid, note })`, `useCleanupLabOrphans({ lab_id })`,
  `useCheckLabPermissions()` (also `["settings"]`), `useLabSecret()` (a GET on demand: `mutateAsync(id)`, no toast, no cache).
- Fixtures (`web/src/test/fixtures.ts`): `labsFixture(over)`, `labDetailFixture(over)`, `labSessionFixture(over)`,
  `labCoverageFixture()`, `labsEmpty(method, url)`; `mockFetch` answers GET `/api/v1/labs*` with an empty catalogue (one lab:
  404); `overviewFixture().labs`, `costFixture().labs`, `settingsFixture().values` and `clientView` carry the new fields.
- `widgets/WidgetLibrary.tsx` knows `FlaskConical`; `views/firewall/EndCell.tsx` gives the labs zone `FlaskConical`.

**L0 rulings** (also in the spec, §16): inline `code` is allowed in readmes (the footer needs it); lab ids take single hyphens
only; lab.yaml is YAML 1.1; `labs_default_peering` defaults on; custom-role GUIDs are fixed in `allowed-roles.json`;
`overview.labs.running` is the session list (count = length); a lab row in `RunRow` keeps a gateway `action`; permissions and
orphans live in KV; `costMarker` thresholds as above; deploy and extend take whole hours.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. The integrator lands the contract (L0) first. Then seven areas run **in parallel**, each in its
> own git worktree and each built by one implementer under superpowers:test-driven-development: **L1** pipeline, **L2** Worker
> engine, **L3** Labs tab, **L4** integrations, **L5** labs 1–4, **L6** labs 5–7, **LG** gateway PR (from `main`). Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** on-demand AZ-104 lab environments, deployed and destroyed like the gateway (Worker → `lab.yml` → Terraform, state in R2
→ live log → timer). Each lab shows its cost up front and always gets back to £0. Labs 1–7 are released only after each passes a
real-Azure test with `clean: true`.

**Architecture:**
- **Catalogue:** each lab is a folder, `labs/<id>/{lab.yaml,readme.md,terraform/}`. `npm run labs-build` writes
  `shared/labs.generated.json`, which only the Worker imports. The file is gitignored; the `test`, `typecheck`, `build:web`, `dev`
  and `dev:api` scripts run `labs-build` first.
- **Pipeline:** `.github/workflows/lab.yml` runs deploy, destroy, peer, unpeer and test. Before apply, `infra/ci/lab-scope.mjs`
  checks the plan's scope; the clean-up scripts run even when Terraform fails.
- **Worker:** `worker/src/labs/**`, `api/labs.ts` and migration `0020_labs.sql`. Each lab has its own `RunLock` instance,
  `lab:<id>`; the lab watch runs in `scheduled()`, after the watchman and before insights.
- **App:** a lazy Labs tab (`/labs`, `/labs/:id`, `/labs/history`), plus small integrations on existing pages.

**Tech stack:** unchanged (Hono, D1, Vitest with `worker/test/harness.ts`; React 19, TanStack Query, Radix, plain CSS). Terraform
1.14.6 with azurerm `~> 4.0` and azuread `~> 3.0` (V: newest 3.x); bash, az and jq on ubuntu-24.04. One new devDependency,
`yaml`, pinned with `-E` and used by scripts only.

**Spec:** `docs/superpowers/specs/2026-10-04-labs-design.md` is binding. Steven approved §15 as written. **(V)** items are checked
live or against the official page during the build, and the report records the answers.

**Rulings on points the spec leaves open** (L0 copies them into the spec):
1. **The app never imports the generated catalogue.** It reads `GET /labs`, which keeps the readmes out of the entry chunk.
2. **Readmes are parsed at build time.** `labs-build` turns each readme into `ReadmeBlock[]`, and the app renders those blocks as
  React elements: no `dangerouslySetInnerHTML`, no markdown dependency.
   - Allowed markdown: headings, paragraphs, bullets, code, links, bold and `<details>`. Anything else is refused.
3. **Custom roles get fixed GUIDs.** ABAC conditions match role ids, not names, so each lab custom role sets a fixed
  `role_definition_id`. Those GUIDs and the allowed built-in GUIDs live in `labs/setup/allowed-roles.json`, which both the scope
  check and the setup condition read.
4. **Timers:** `max_until` = `requested_at + max_h`; `auto_destroy_at` = `ready_at + hours`, never later than `max_until`; the
  estimate = `est_gbp_h × (ended_at − requested_at)`.
5. **The Cost "Labs" panel is widget `cost.labs`.** It is off by default (`defaultOff`), lives in `r3` (which gets `max: 3`) and
  replaces `cost.insights`. Existing screens stay as they are; the Overview additions show only while a lab runs.
6. **New flag `peers.labs_config_due`.** It is set on split-tunnel `azure_vnet` clients and clears when that client's config is
  fetched or edited. `needs_config` is not reused: it clears on handshake.
7. **Extra routes:** `GET /labs/:id/secret`, `POST /labs/repeer` and `POST /labs/permissions/check`.
8. **Inert `lab.yml` lands on `main` first.** GitHub dispatches only workflows that exist on the default branch, so `lab.yml` goes
  to `main` as PR 0 (a STOP). Branch tests then run with `gh workflow run lab.yml --ref feat/labs`. Without `secrets_url`, a run
  makes its own masked password and skips peering.

## Global Constraints

- **Inherited** from the widgets and insights plans: one `.css` per component, and tokens; a status colour always comes with a
  word; accessibility; "no data" is never 0; Vitest + RTL tests; commit trailer `Claude-Session:
  https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`, and push after every commit.
- **Branches:** contract `feat/labs-contract` from `main`, and every area branches from its head. Integration `feat/labs` becomes
  PR 2; LG's `feat/labs-gateway` becomes PR 3; PR 0 is `lab.yml` and `infra/ci/lab-*` only.
- **STOP: ask Steven** before any merge to `main`, any real-Azure run, and any deploy.
- **Frozen files.** Only L0 or the integrator edits these. An area that needs a change asks the integrator, who updates the file
  and the spec together.
  - **Shared:** `shared/{api,widgets,labs}.ts`, `labs/setup/allowed-roles.json`, `labs/skill-areas.yaml`, `labs/_template/**`.
  - **Worker:** `worker/migrations/**`, `worker/src/{index,lock,actions}.ts`, `api/index.ts`, `labs/catalogue.ts`, `devseed*.ts`;
    `firewall.ts`: the zone type and addresses only; `worker/test/{harness,api-helpers}.ts`, `worker/test/fixtures/labs/**`.
  - **Web:** `web/src/{api,test,components,widgets}/**`, `routes.ts`, `App.tsx`, `views/pages.tsx`, `shell/AppShell.*`.
  - **Scripts and config:** `scripts/labs-*.mjs`, `scripts/lib/labs.mjs`, `seed-scenarios.mjs`, `shots.mjs`, `package.json`,
    `.gitignore`, `wrangler.toml`.
- **The gateway is never touched.** No lab code path dispatches `wg.yml` or tears the gateway down; the only time a lab takes the
  `singleton` lock is the 10-minute peering lock (§7.6); lab Terraform never names `rg-wg-ondemand`.
- **£0 always.** Every destroy path runs the safety net and the clean check, even when Terraform fails or there is no state; a
  session leaves `deploying` or `running` only with a recorded end reason.
- **Secrets:** never read the real `.env`: worktrees `cp .env.example .env`; the admin password is masked in the workflow,
  redacted from the live log, and cleared from D1 when the session ends; `LAB_RESULT` carries no addresses; fixtures use TEST-NET,
  `wg.example.net`, `contoso.onmicrosoft.com` and fake GUIDs.
- **Pages never call Azure or GitHub.** A lab watch run makes at most 20 subrequests (`makeBudget(20)`), asserted in tests.
- **Bundle:** the Labs route, the lab modal, `overview.runningLabs` and `cost.labs` all load lazily. The entry is about 308 kB of
  the 320 kB gzip budget, so it may grow by at most 6 kB.
- **One screen:** at 1100×600 or larger, `/labs`, the modal and `/labs/history` never scroll the page; long lists scroll inside
  their panel. Phone layout at ≤ 640 px.
- **Windows:** tests that need bash, Python+PyYAML, terraform or `hcl2json` skip with a reason when the tool is missing (CI has
  all four); baselines use short paths (`C:/wgb/labs`); one free `PORT` per worktree; stop only your own processes, by PID, never
  `taskkill /IM`.
- **Shots:** builders shoot only their own scenario, and only when the dev server is free; they never wait for the dev lock. The
  integrator runs the full pixel gate and the one-screen shots once.
- **Gate (every area):** `npm test`, `npm run typecheck`, `npm run build:web` and `npm run labs-check`. L1, L5 and L6 also run
  `npm run labs-tf`.

## Review Focus

1. **A lab that never gets back to £0.**
   - L1: `safety net deletes rg-lab-<id> and rg-lab-<id>-* and lab-<id>- Entra objects when terraform destroy failed and state is
     missing`; `unblock removes locks, legal holds, unlocked immutability, backup protection and replication in that order`.
   - L2: `a failed session older than 15 minutes is destroyed with end_reason failed`; `still running 15 minutes past its deadline
     destroys again and writes one watchman note`; `a destroy that reports clean false ends ended_dirty and keeps the slot until a
     clean sweep`.
2. **Escaping the lab's scope.** L1: `lab-scope refuses each evil plan naming its rule`; `governance types pass only for the five
  governance labs and never at subscription scope`; L0: `ownsName refuses another lab's names even when ids share a prefix`; L2:
  `orphan sweep ignores NetworkWatcherRG and non-lab names and waits 30 minutes`.
3. **Races** (all L2): `two deploys of different labs at once get different slots`; `the 33rd concurrent session gets no slot and
  nothing is dispatched`; `a second deploy of the same lab while its lock is held is 409 and reserves nothing`; `labs_max_running
  refuses the fourth`.
4. **The gateway stays independent.** L2: `budget at 100% destroys running labs, cancels deploying ones and never dispatches
  wg.yml`; `peer begin says wait while the gateway lock is held and go when it is free, then end releases it`; L0: `a lab watch
  that throws still lets the watchman and insights run`.
5. **The hard stop.** L2: `extend never moves auto_destroy_at past max_until and the refusal says until when`; `max_until destroys
  with end_reason max even after extensions`; L3: `Extend to max is the only extend offered under an hour from max`.
6. **A stale dashboard, and secrets.** L1: `Parse payload refuses a version that differs from lab.yaml`; L2: `lab live log redacts
  the admin password and the callback token`; `lab-secrets refuses a wg.yml token and /callback/secrets refuses a lab.yml token`;
  `the admin password is cleared when the session ends`.

---

## L0: Contract (integrator, first)

**Branch:** `feat/labs-contract`. **Owns:** every frozen file. **Produces:**

- **`shared/labs.ts`**
  - Constants: `LAB_ID_RE`, `LAB_ID_MAX = 40`; `LAB_POOL = "10.64.0.0/13"`, `LAB_SLOTS = 32`; `GOVERNANCE_LABS` (labs 1, 2, 3, 20
    and 21); `ALLOWED_ROLES`.
  - Types: `LabExam`, `LabLevel`, `LabType`, `PeeringMode`; `LabCostItem { name, gbp_h, qty?, retail?: { meter?, unit?, sku? } }`;
    `LabDef` (all of §3.2, plus `number`), `SkillArea`; `ReadmeBlock` (`h | p | ul | code | details`; inline `text | b | a`),
    `LabCatalogue`.
  - Helpers: `slotCidr(n)`, `labRg(id)`, `ownsName(id, name)`; `labIdFromName(name)`: the longest catalogue id;
    `isGovernanceLab(id)`, `estimateGbpH(items, priceOf?)`; `sessionTimeoutMin(t)` = `min(150, 2 × (deploy + destroy) + 20)`;
    `labNeeds(def)` → `{ role, graph }`.
- **`scripts/lib/labs.mjs`** (the script-side twin): `parseLabYaml`, `validateLab`, `parseReadme(md, type)` → `{ blocks, problems
  }`, `buildCatalogue`, `checkPool()`, `variablesProblems(tf)` (only §3.4 variables), and `lintTfText(files)`, which refuses
  literal CIDRs except `0.0.0.0/0`, provisioners, forbidden providers and `rg-wg`/`vnet-wg`. Scripts: `npm run labs-build`, `npm
  run labs-check [-- --base origin/main]`.
- **`shared/api.ts`**
  - New types: `LabSessionState`, `LabPeering`, `LabEndReason`, `LabAction`; `LabWarning { kind, message, overridable }`;
    `LabCard`, `LabSession`, `LabDeployBody`, `LabCoverage`, `LabPermissions`, `LabOrphan`, `LabReleaseTest`, `LabSecretResponse`,
    `LabCostRow`; `LabDetail`: readme, cost items with `source` and `priceAge`, warnings, session, runs, `resources`;
    `LabsResponse { labs, running, slots, maxRunning, permissions, orphans }`; `LabsSummary { running, gbpH, rePeer }`.
  - New fields on existing types: `OverviewResponse.labs`, `CostResponse.labs`, `RunRow.lab?: { id, title } | null`,
    `ClientView.labsConfigDue`, `SettingsValues.labsMaxRunning / labsDefaultPeering`.
- **`shared/widgets.ts`:** `overview.runningLabs`: `defaultOff`, home `r4`, weight 32, replaces `overview.costImpact`;
  `cost.labs`: `defaultOff`, home `r3`, replaces `cost.insights`; cost `r3` gets `max: 3`; the simulator's options gain `labs`.
- **Worker**
  - Migration `0020_labs.sql`: the §7.1 tables, 32 slots (seeded with a recursive CTE), and `peers.labs_config_due`.
  - `labs/catalogue.ts`: `catalogue()`, `labDef(id)`, `setCatalogueForTest(cat)`.
  - Firewall: zone `labs` (v4 = the pool), which also joins `privateV4`.
  - Locks: `acquireLock(env, runId, { name?, ttlMs? })`. `releaseLock` and `lockStatus` take a `name` that defaults to
    `"singleton"`.
  - `QuickAction` gains `lab-extend-1h:<sid>` and `lab-destroy:<sid>`.
  - `index.ts`: Mounts `/api/callback/{lab,lab-secrets,lab-peer,lab-peerings-removed}` on stubs in `labs/callbacks.ts` (501);
    Sends lab `/api/act` links to `labs/act.ts`; `scheduled()` runs the watchman, then a no-op `runLabWatch` (`labs/watch.ts`),
    then insights, each caught on its own.
  - `api/labs.ts`: stubs for every §7.2 route and ruling 7. They validate input (400 `bad_input` with `field`) and return the
    right shapes.
- **App**
  - `TABS` gets Labs after Cost (seven phone icons). `/labs`, `/labs/:id` and `/labs/history` show a `React.lazy` placeholder.
  - `SETTINGS_SECTIONS` gets `labs`, with a placeholder body in `views/settings/index.tsx`.
  - Queries: `useLabs()` polls every 15 s, or every 5 s while a lab is busy; `useLab(id)`, `useLabSessions(lab?, limit)`,
    `useLabCoverage()`.
  - Mutations: `useDeployLab`, `useExtendLab`, `useDestroyLab`, `usePeerLab`, `useUnpeerLab`, `useTestLab`, `useCancelLab`,
    `useRePeerLabs`, `useSaveLabNote`, `useCleanupLabOrphans`, `useCheckLabPermissions`, `useLabSecret`.
  - Fixtures: `labsFixture`, `labDetailFixture`, `labSessionFixture`, `labCoverageFixture`; `mockFetch` answers `/api/v1/labs*`
    with an empty catalogue; `overviewFixture` has empty `labs`.
- **Test harness:** `World.dispatches[].workflow`; `world.labAzure`: groups, management groups, role and policy definitions,
  policy assignments, resources and cost rows; `world.graph`: users and groups; fake ARM, Graph, Cost Management and token
  answers.
- **Dev seed:** scenario `labs`, also listed in `seed-scenarios.mjs` and `shots.mjs`. It has lab 6 running and peered, lab 5 at
  step 7/16, 8 ended sessions with notes and costs, one `ended_dirty` session with its orphan note, release tests for labs 4–7 and
  `lab_cost_days`. Every scenario wipes the lab tables.
- **Lab seeds** (L5 and L6 own the lab folders after L0): `labs/skill-areas.yaml` (§12.1); `labs/_template/` (`versions.tf`,
  `variables.tf` with all of §3.4, `outputs.tf`, and a `main.tf` that makes only `rg-lab-<id>`); for labs 1–7, `lab.yaml` (v1,
  from §12.2) and a stub readme.

- [ ] **L0.1 Baseline.** Tag `main` as `labs-baseline` and push it. `git archive labs-baseline | tar -x -C C:/wgb/labs`; there `cp
  .env.example .env`, `npm ci`, `npm run build:web`, `PORT=8799 node scripts/dev.mjs --api`, and wait for `/api/v1/overview`. For
  each of `running deploying busy-month destroyed empty failed standby insights`: `node scripts/shots.mjs --scenario <s>
  --freeze-time --widget-chrome off --base http://localhost:8799 --api http://localhost:8799 --out C:/wgb/shots/<s>`. **Done
  when:** two runs of `running` diff to zero.
- [ ] **L0.2 Shared schema.** `worker/test/labs-shared.test.ts`: `slotCidr gives 10.64.0.0/18 for 0, 10.64.64.0/18 for 1 and
  10.71.192.0/18 for 31`; `the pool overlaps no gateway range, Docker or 168.63.129.16`; `ownsName refuses another lab's names
  even when ids share a prefix`; `labIdFromName takes the longest catalogue id`; `estimateGbpH sums gbp_h times qty and uses a
  fresh retail price when given`; `sessionTimeoutMin caps at 150`; `LAB_ID_RE, LAB_POOL and GOVERNANCE_LABS equal the scripts'
  copies`. `scripts/test/labs-lib.test.mjs`: `each §3.2 rule refused with its field`, table-driven. The table covers: id vs
  folder; id prefixes; skill areas; unknown or cyclic prerequisites; `max_h` and `session_h`; empty cost; a `pricey` that names no
  item; `subnets_used` outside 0–4, or 0 with peering; readmes: `readme without a required heading is refused`; `break-fix readme
  needs Symptom and a closed details`; `markdown outside the subset is refused`; `parseReadme gives blocks for each supported
  element`; Terraform and versions: `a literal CIDR outside cidrsubnet is refused, 0.0.0.0/0 allowed`; `a variables.tf declaring a
  non-contract variable is refused`; `--base flags a changed lab folder whose version did not rise`. FAIL, implement, PASS,
  commit.
- [ ] **L0.3 Storage, locks, stubs.** `worker/test/labs-contract.test.ts`: `migration 0020 creates the lab tables and seeds 32 slots`;
  `labs_config_due is set for split-tunnel azure_vnet clients only`; `RunLock lab:<id> and singleton are independent`; `every
  /api/v1/labs route answers its shape with an empty catalogue`; `deploy body refuses unknown keys and hours outside 1–12 with
  field`; `callback stubs need a token`; `a lab watch that throws still lets the watchman and insights run`; `the Labs zone is in
  zoneAddrs and internet no longer matches 10.64.1.1`; `devseed labs fills the lab tables and every story wipes them`. FAIL,
  implement, PASS, commit.
- [ ] **L0.4 Widgets and app.** Widget tests: `runningLabs and cost.labs are defaultOff in their homes with their replaces`; `cost r3
  max is 3`; `with no prefs no layout changes`; `simulator offers labs`. App tests: `Labs tab sits after Cost and before
  Settings`; `/labs, /labs/:id and /labs/history load the lazy page`; `useLabs polls 5 s while a session deploys, else 15 s`;
  `each lab mutation posts its route and invalidates labs and overview`; `the phone bar shows seven icons without overflow at 390
  px`; `the entry graph never imports views/labs`. FAIL, implement, PASS, commit.
- [ ] **L0.5 Contract check.** The gate and `bundle-size` pass (record the entry size). Shots differ from the baseline only in the
  nav, the tab bar and the Firewall zones panel (record the boxes). Push, then send the areas the commit and this surface.

---

## L1: Pipeline, scope check, clean-up, release harness, setup

**Branch:** `feat/labs-pipeline`. **Owns:** `.github/workflows/lab.yml`;
`infra/ci/lab-{scope.mjs,parse.sh,ready.sh,peer.sh,unblock.sh,safety-net.sh}`; `scripts/{labs-tf,lab-release-test,labs-setup}.mjs`;
`scripts/lib/secrets-map.mjs` (adds `LAB_UPN_DOMAIN`); `.env.example`; `ci.yml`; the README section "Labs: one-time setup";
`docs/labs/release-tests.md`; `labs/setup/governance-{role.json,condition.txt}`; `scripts/test/lab-*.test.mjs` and
`scripts/test/fixtures/labs/**`.

**Consumes:** the template, `allowed-roles.json`, `scripts/lib/labs.mjs` and the §5 payload.

**Produces:** the run name `lab <action> <lab_id> <run_id>`; peer calls `{ run_id, phase: "begin" }` → `{ go }` and
`{ run_id, phase: "end", ok }`; the §5 step 16 result body; `lab-scope.mjs --plan|--hcl <json> --lab <id>` (exit 1, one
`rule: address` line per refusal).

- [ ] **L1.1 Scope check.** `lab-scope.test.mjs`: `a clean plan for the template passes`; `lab-scope refuses each evil plan naming its
  rule`. There is one fixture per §8.4 rule: the resource group's name; a `resource_group_name` or scope outside the lab; azuread
  names, UPNs or mail nicknames without the `lab-<id>-` prefix; an Owner or User Access Administrator assignment; a subscription
  or management-group association; a `Locked` immutability policy; the null, external, http or local provider; `vnet-wg` used
  anywhere other than through `var.gateway_vnet_id`; an AKS `node_resource_group` outside `rg-lab-<id>-*`. `governance types pass
  only for the five governance labs and never at subscription scope`; `HCL mode gives the same verdicts on the HCL fixtures`.
  FAIL, implement, PASS, commit.
- [ ] **L1.2 Clean-up scripts** (a fake `az` on `PATH` records calls; skip without bash): `unblock removes locks, legal holds,
  unlocked immutability, backup protection and replication in that order`; `safety net deletes rg-lab-<id> and rg-lab-<id>-* and
  lab-<id>- Entra objects when terraform destroy failed and state is missing`; `safety net never touches rg-lab-<id>x, another lab
  or NetworkWatcherRG`; `governance safety net deletes custom roles, policy assignments and definitions, then management groups
  children first`; `verify clean prints clean=false and the leftovers`; `peer creates both sides with the §7.6 flags and links
  private DNS zones only with dns_link`; `unpeer deletes the vnet-wg side first`; `ready check polls until every provisioningState
  is Succeeded or deploy_min passes`. FAIL, implement, PASS, commit.
- [ ] **L1.3 Workflow.** `lab-workflow.test.mjs`, in the style of `wg-workflow.test.mjs`. Structure: `lab.yml has no tabs and every §5
  step is named`; `lab.yml parses as YAML`; `run-name carries action, lab id and run id`; `concurrency group is per lab and
  action, never cancels`; `timeout-minutes reads timeout_min from the payload`. (V) If GitHub refuses that expression, use a fixed
  150 and change this test to match. Secrets: `no step sees the Cloudflare DNS token or the WireGuard key`; `ARM secrets only in
  steps 5–14`; `the OIDC audience is wg-admin and secrets go to secrets_url`; `without secrets_url the run makes its own masked
  admin password and skips peering`. Payload and step order: `Parse payload refuses a bad lab id, a missing folder and a version
  that differs from lab.yaml`; `safety net, verify clean, backup and report run with always()`; `the live log starts after secrets
  and finishes before the result`. Results and state: `LAB_RESULT carries clean, leftovers and seconds and never an address`;
  `bicep files are built before init`; `state key is labs/<id>/terraform.tfstate and backups keep 5`. FAIL, implement, PASS,
  commit.
- [ ] **L1.4 CI.** A new `labs` job in `ci.yml`: checkout with `fetch-depth: 0`, `labs-check -- --base origin/main`, then per lab `fmt
  -check`, `init -backend=false`, `validate`, and `hcl2json` (pinned, checksum verified) into `lab-scope.mjs --hcl`. `npm run
  labs-tf` does the same locally. Tests: `labs-tf lists each lab and the template`; `ci labs job pins hcl2json by checksum`. FAIL,
  implement, PASS, commit.
- [ ] **L1.5 Release harness.** `scripts/lab-release-test.mjs <id…> [--ref feat/labs] [--slot 31] [--check]` dispatches `gh workflow
  run lab.yml --ref <ref> -f action=test -f payload=…` (peering off, no callback), waits with `gh run watch`, reads `LAB_RESULT`
  from `gh run view --log`, and appends date, lab, version, result, clean, leftovers, durations and estimated £ to
  `docs/labs/release-tests.md`. `--check` uses the local `az` (signed in as the pipeline service principal): the `wg-admin labs
  governance` assignment, `az rest` GET `/users?$top=1` and `/groups?$top=1`, and creating and deleting management group
  `lab-perm-check`. Tests: `builds the payload with the slot CIDR and timeout`; `parses LAB_RESULT`; `refuses an unknown lab id`;
  `writes one row per lab`; `--check reports each permission from fake az output`. FAIL, implement, PASS, commit.
- [ ] **L1.6 Setup files and README.** `governance-role.json`: the §8.1 actions. `governance-condition.txt`: built from the
  `allowed-roles.json` GUIDs. (V) Check the syntax in the portal's code view. `npm run labs-setup` writes the gitignored
  `labs/setup/*.local.*` with the subscription id filled in. It prints only file names. The README section is §8.2 verbatim, plus:
  Cloud Shell alternatives; the Graph app-role ids, from `az ad sp show --id 00000003-0000-0000-c000-000000000000 --query
  "appRoles[?value=='User.ReadWrite.All'].id"`; the management-group hierarchy setting (V). Test: `labs-setup substitutes the
  subscription id and never prints it`. Commit.
- **Done when:** the gate passes, `labs-tf` passes, and CI's `labs` job is green on a draft PR.

## L2: Worker engine

**Branch:** `feat/labs-engine`. **Owns:**
- New files: `worker/src/labs/**` (except `catalogue.ts`) and `api/labs.ts`.
- Edits: `oidc.ts` (an allowed-workflow argument), `livelog.ts` (lab tokens); `api/activity.ts` (lab runs and `/runs/:id`),
  `api/overview.ts`, `api/cost.ts`; `budget.ts`, `monitor.ts` (the 80% note), `runs.ts` (the re-peer push); `peers.ts`,
  `clients.ts` (AllowedIPs and `labs_config_due`); `firewall.ts` (rule 25 and a one-time draft proposal), `simulate.ts`;
  `settings.ts`: `labs_max_running` (1–5, default 3) and `labs_default_peering`; `insights/feeds/{prices,capacity}.ts`.
- Tests: `worker/test/labs-*.test.ts`.

**Produces:** `startLabRun(env, sid, action, by, reason)`, `handleLabCallback`, `issueLabSecrets`, `labPeerBegin`/`labPeerEnd`,
`runLabWatch`, `sweepOrphans`, `fetchLabCostDays`, `labWarnings`, `checkLabPermissions`.

- [ ] **L2.1 Sessions and slots:** `deploy reserves the lowest free slot in one statement`; `two deploys of different labs at once get
  different slots`; `the 33rd concurrent session gets no slot and nothing is dispatched`; `a second deploy of the same lab while
  its lock is held is 409 and reserves nothing`; `labs_max_running refuses the fourth`; `ids are ls- and lab-<action>- stamps`;
  `name_prefix is l + lab number + 5 lowercase`; `deploy dispatches lab.yml with the §5 payload, catalogue version and timeout`;
  `a lab needing permissions is unavailable until the check passes`; `the lab lock TTL is timeout_min + 15 minutes`.
- [ ] **L2.2 Callbacks and secrets:** Results: `deploy success sets running, ready_at, auto_destroy_at capped at max_until, and
  outputs`; `deploy failure sets failed`; `destroy clean ends the session, frees the slot and clears the admin password`; `a
  destroy that reports clean false ends ended_dirty and keeps the slot until a clean sweep`; `cancel stops the GitHub run, then
  dispatches destroy`. Secrets and logs: `lab-secrets refuses a wg.yml token and /callback/secrets refuses a lab.yml token`;
  `secrets are handed out once per run`; `lab live log redacts the admin password and the callback token`; `the admin password is
  cleared when the session ends`. Runs: `GET /runs/lab-… reads lab_runs`; `activity lists lab runs with the lab title`; `test runs
  record lab_release_tests and end with reason test`.
- [ ] **L2.3 Watch and timers:** Warnings: `a missed callback heals from GitHub`; `15 minutes before the timer one push with Extend 1h
  and Tear down`; `Extend is left out under an hour from max_until`. Teardown: `the timer destroys with reason timer`; `max_until
  destroys with end_reason max even after extensions`; `still running 15 minutes past its deadline destroys again and writes one
  watchman note`; `a failed session older than 15 minutes is destroyed with end_reason failed`. Extend: `extend never moves
  auto_destroy_at past max_until and the refusal says until when`; `the lab-extend-1h and lab-destroy links act once`. Calls: `a
  watch run makes at most 20 subrequests`.
- [ ] **L2.4 Budget and cost:** Budget: `budgetFigures adds each running lab's est_gbp_h to its timer`; `budget at 100% destroys
  running labs, cancels deploying ones and never dispatches wg.yml`; `the 80% note names lab spend`. Actual spend: `the daily
  unfiltered query keeps rg-lab- rows in lab_cost_days`; `a session shows estimate until the day after it ends, then actual split
  by duration`; `cost labs rows: this month actual plus running estimates`. Prices and warnings: `lab prices: retail meters stored
  as lab:<meter>, authored gbp_h after 7 days stale`; `warnings: budget, capacity per vm size plus the gateway, pricey, slow;
  unavailable has no override`; `deploy needs confirm_required overrides for budget and capacity`.
- [ ] **L2.5 Orphans and permissions:** `orphan sweep lists groups, Entra, management groups, roles and policies in 6 calls hourly`;
  `orphan sweep ignores NetworkWatcherRG and non-lab names and waits 30 minutes`; `owned by a live session is not an orphan`; `one
  note per lab, with names`; `cleanup dispatches a destroy for a lab gone from the catalogue`; `a clean sweep releases ended_dirty
  slots`; `permissions check reads the role assignment for the token's oid and makes two Graph reads`.
- [ ] **L2.6 Peering, firewall and clients:** Peering: `peer begin says wait while the gateway lock is held and go when it is free,
  then end releases it`; `begin says wait unless the gateway is running or in Standby`; `peerings-removed marks peered sessions
  disconnected`; `repeer dispatches one peer run per waiting or disconnected session`; `peer and unpeer routes take the lab lock
  and dispatch their run`; `the gateway reaching Running pushes Re-peer N labs once`. Clients: `clientAllowedIps adds 10.64.0.0/13
  with azure_vnet only`; `fetching a client's config clears labs_config_due`. Firewall: `a fresh install has Clients to labs at
  25`; `an existing install gets it once as a draft proposal, never applied`; `the simulator matches the labs zone`.
- [ ] **L2.7 Read routes:** `GET /labs cards carry estimate, running session, last session, last release test and Untested`; `GET
  /labs/:id has readme blocks, priced items with source and age, warnings, resources from ARM while running`; `sessions history
  and coverage count sessions of 15 minutes or more`; `note is at most 2000 characters`; `secret answers only while running`;
  `overview labs summary`.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate passes, and the report lists each (V) item with the fixture shape it was built against.

## L3: Labs tab

**Branch:** `feat/labs-ui`. **Owns:**
- `web/src/views/labs/**`: `LabsPage`, `RunningStrip`, `Filters`, `Catalogue`, `LabCard`; `LabModal`, `DeployForm`, `Warnings`,
  `ReadmeView`, `RunningLab`; `HistoryPage`, `CoverageMap`, `PhoneLabs`; `labs.css`.
- `scripts/shots-prefs/labs.*.json`

**Consumes:** the lab hooks; `RunDetails` and `LiveOutput` from `@/views/activity/RunPanels` (import only).

- [ ] **L3.1 Catalogue:** `cards grouped AZ-104 then AZ-305 by number`; `a card shows title, two-line summary, level, £/h, deploy
  time, session, pricey marker with the resource on hover, run before, Ran 2× and Untested v2`; `filters exam, skill area, level,
  type and not run yet`; `the catalogue scrolls inside its panel at 1100×600`.
- [ ] **L3.2 Running strip:** `hidden when nothing runs`; `a chip per session with state, step 3/16, time left, cost so far and
  peering word`; `Extend offers 1h, 2h and to max`; `Extend to max is the only extend offered under an hour from max`; `Tear down
  asks in a confirm dialog`.
- [ ] **L3.3 Lab modal, not running:** Content: `readme blocks render without HTML injection`; `cost items, per hour and per session
  for the chosen hours`; `/labs/:id opens the modal`; Form: `session defaults to session_h and stops at max_h`; `peer tick
  optional, forced for required, hidden for off, and says will peer later when the gateway is down`; `region defaults to
  Settings`; Warnings: `each warning shown; Deploy anyway sends the override`; `unavailable disables Deploy with the reason`.
- [ ] **L3.4 Lab modal, running:** What it shows: `steps and live log from the lab run`; `resources with a portal link to
  rg-lab-<id>`; `private IPs and connect lines`; Controls: `Show reveals the password and user names and hides them on close`;
  `note saves`; `break-fix What was broken stays closed`; `Tear down cancels a deploy in progress first`.
- [ ] **L3.5 History:** `sessions table: date, lab, duration, estimate or actual, end reason, note`; `coverage rows per skill area
  with run over available and a filled box per run lab`; `/labs/history fits 1100×600`.
- [ ] **L3.6 Phone and screens.** Test `phone: running labs with lights, time left, Extend and Tear down; Catalogue and Your labs open
  sheets; a lab opens as a sheet with Deploy`. Shots `--scenario labs --routes /labs,/labs/az104-06-blob-security,/labs/history`
  exit 0 at 1600×900, 1100×600 and 390×844, dark and light.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate and `bundle-size` pass, and the entry grows by under 1 kB.

## L4: Integrations

**Branch:** `feat/labs-integrations`. **Owns:** `web/src/views/{overview,activity,cost,firewall,clients}/**`, `views/settings/**`
(`LabsSection` and its wiring), `shell/CommandPalette.tsx`, `scripts/shots-prefs/{overview,cost}.labs.json`. **Consumes:**
`OverviewResponse.labs`, `CostResponse.labs`, `RunRow.lab`, `ClientView.labsConfigDue`, the `labs` zone, the lab hooks.

- [ ] **L4.1 Overview:** `with no labs overview renders exactly as before`; `running labs appear as boxes beside the Azure VNet, solid
  when peered, dashed when waiting or disconnected`; `banner adds · 2 labs running (£0.12/h)`; `Re-peer 2 labs shows on Running
  when sessions wait and posts repeer`; `runningLabs widget lists time left, cost so far and Tear down, loads lazily, and is off
  by default`.
- [ ] **L4.2 Activity and Cost:** `lab runs show the lab title and open the run drawer`; `the Labs chip filters to lab runs`;
  `watchman lab notes use existing kinds`; `cost.labs lists this month per lab, actual plus running estimate, off by default`.
- [ ] **L4.3 Firewall, Clients, Settings:** Firewall: `Labs zone in the zone list, rule pickers and simulator`; `the proposed Clients
  to labs draft rule shows in the draft bar`; Clients: `a client with labsConfigDue says config out of date: get config`;
  Settings: `max running and default peering save`; `Check permissions ticks role, users and groups`; `slots in use`; `release
  tests list with a Test button per lab that confirms first`.
- [ ] **L4.4 Palette:** `Deploy lab… opens a lab's modal`; `Tear down lab… lists only running labs`; `each lab title is a jump`; `lab
  entries come from useLabs only while the palette is open`.
- [ ] **L4.5 Screens.** Shots `--scenario labs --prefs scripts/shots-prefs/overview.labs.json,scripts/shots-prefs/cost.labs.json` exit
  0 at 1600×900 and 1100×600, dark and light. Existing scenarios differ only where L0.5 allows.
- **Each step:** FAIL, implement, PASS, commit.
- **Done when:** the gate, `bundle-size` and the shots pass.

## L5: Labs 1–4 · L6: Labs 5–7

**Branches:** `feat/labs-content-identity` (L5) and `feat/labs-content-storage` (L6).
**Owns:** `labs/az104-0{1..4}-*/**` (L5) and `labs/az104-0{5..7}-*/**` (L6).
**Consumes:** the template, `allowed-roles.json`, §3.3 and §3.4. Each lab: `lab.yaml` with `retail` wherever Azure has a meter or
SKU, `capacity.vm_sizes` and identity; Terraform with every address from `cidrsubnet(var.address_space, 2, n)` and `var.tags`; a
readme with a text diagram, 3–6 Things to try, Learn links (V: each answers 200) and the footer. Checks: `terraform fmt -check`,
`terraform init -backend=false && terraform validate`, `npm run labs-check`.

What each lab builds:
- **Lab 1:** users `lab-<id>-ann` and `lab-<id>-ben` (UPN `@var.upn_domain`, password `var.admin_password`); group
  `lab-<id>-helpdesk` with ann; custom role `lab-<id>-vm-operator` with its fixed GUID; at the RG, Reader for the group and the
  custom role for ben. The readme warns that sign-in may ask for MFA registration (V).
- **Lab 2:** policy `lab-<id>-require-costcentre-tag` and built-in Allowed locations, both assigned at the RG; a storage account
  with a CanNotDelete lock, which proves the unblock step.
- **Lab 3:** management groups `lab-<id>-root` > `-prod`, `-dev`; an audit policy defined and assigned at `-root`; the
  subscription is never moved.
- **Lab 4:** an RG budget of £5 a month, starting on the 1st, with `ignore_changes`; and an action group with no receivers.
- **Lab 5:** storage accounts LRS hot and GRS cool (V: price); a lifecycle policy (cool at 30 days, delete at 365); one blob; no
  VNet (`subnets_used: 0`, peering off).
- **Lab 6** (§3.2): a private container with a stored access policy (V: if azurerm cannot make one, it becomes a Things-to-try
  item); a /20 VNet with a private endpoint and `privatelink.blob.core.windows.net`; group `lab-<id>-readers` with Storage Blob
  Data Reader; output `peer_vnet_id`.
- **Lab 7:** an SMB share behind a subnet service endpoint, and a B1s Linux VM with no public IP whose cloud-init mounts the
  share; outputs `private_ips` and `connect`.

- [ ] **One step per lab** (L5.1–L5.4, L6.1–L6.3): write it, run the checks, commit. Run `lab-scope.mjs --hcl` once L1 exists; the
  integrator reruns it.
- **Done when:** labs-check, fmt and validate pass for every owned lab. The real-Azure tests happen at Integration.

## LG: Gateway PR

**Branch:** `feat/labs-gateway`, from `main`. **Owns:**
- `wg.yml`: a new first destroy step, "Remove lab peerings". It deletes the peerings and DNS links on `vnet-wg`, then POSTs
  `/api/callback/lab-peerings-removed`.
- `infra/cloud-init.yaml.tftpl`: the dnsmasq forwards from §6; `scripts/test/wg-workflow.test.mjs`.

- [ ] **LG.1 Gateway changes.** Tests: `Remove lab peerings is the first destroy step after secrets, and a failure never stops the
  destroy`; `cloud-init forwards the seven Azure domains to 168.63.129.16`. FAIL, implement, PASS, commit.
- **Done when:** CI is green on a draft PR, including the cloud-init render.

---

## Integration

1. **Merge** onto `feat/labs` in order: L1, L2, L5, L6, L3, L4. Run the gate after each merge. A conflict means an area edited a
  frozen file: reject that change, or fold it into the contract.
2. **Full gate.** Run `labs-check -- --base origin/main`, `labs-tf` and `bundle-size`. Report the entry and the Labs chunk sizes.
  CI's `labs` job passes on a draft PR.
3. **Pixel gate** (integrator only, once). Compare every existing scenario against `labs-baseline`. Differences are allowed only in
  the nav, the tab bar, the Firewall zones and pickers, and the Settings section list.
4. **One screen.** Run the L3.6 and L4.5 shots, and `/` and `/cost` on `labs` with both prefs files. Every run must exit 0. Check
  the 1100×600 dark shots by eye.
5. **Live-ish check** on the `labs` scenario. Walk through: deploy (the budget confirm appears); extend to max; tear down; clean up
  an orphan; re-peer; the Labs zone in the simulator.
6. **Whole-branch review.** A fresh opus reviewer gets the plan, the spec and the shots. Ask about: the Review Focus list;
  `lab-scope.mjs`, the safety net and unblock; the slot SQL, locks and OIDC; the budget teardown; secrets in logs.
7. **One fix pass.** Fix test-first, then repeat steps 2–4.
8. **STOP A: ask Steven to do three things.**
   - **(a) Merge PR 0.** It holds only `lab.yml` and `infra/ci/lab-*`. It is inert, because nothing live dispatches it.
   - **(b) OK the release-test spend** (pennies per lab), and choose a study budget (§15.1).
   - **(c) Run the identity setup in the README.** Labs 1–3 and 6 need it.
     1. Run `npm run labs-setup`.
     2. Portal → Subscriptions → IAM → Add custom role → JSON. Paste `governance-role.local.json`, then Create.
     3. Add role assignment → `wg-admin labs governance` → the wg-admin app → Conditions. Paste the condition, or allow only the
       §8.1 roles to User, Group and Service principal.
     4. Entra → App registrations → wg-admin → API permissions → Graph → Application. Add `User.ReadWrite.All`,
       `User.DeleteRestore.All` and `Group.ReadWrite.All`, then **Grant admin consent**.
     5. Management groups → Settings → turn off "Require write permissions for creating new management groups" (or give the app
       Management Group Contributor at the tenant root) (V).
     6. Put the primary `…onmicrosoft.com` domain in `.env` as `LAB_UPN_DOMAIN`, then run `npm run secrets`.
9. **Release tests on real Azure.** Run labs 4, 5 and 7 first (`lab-release-test.mjs --ref feat/labs …`), then labs 1–3 and 6 once
  `--check` passes. Every lab must report `clean: true`. If one fails, fix it test-first, bump its version, and test again. Commit
  `docs/labs/release-tests.md`.
10. **Open PR 2 (`feat/labs`) and PR 3 (`feat/labs-gateway`).**
    - **STOP B: ask Steven** before merging either and before deploying.
    - On his go: `npm run deploy-worker` (runs `labs-build`, applies 0020); Settings → Labs → Check permissions, all green;
      **Test** labs 1–7 from the dashboard one at a time (records `lab_release_tests`, marks them released); then merge PR 3.

## Final review checklist

- **Labs 1–7:** each matches §12.2 and passed a real-Azure test with `clean: true`.
- **The gateway:** no lab path touches the gateway or `wg.yml`, or holds the singleton lock except to peer. At 100% of budget,
  only labs are torn down.
- **Teardown:** every end path reaches the safety net. A clean end frees the slot; a dirty one holds it.
- **Scope:** every §8.4 rule is refused before apply. Entra and governance objects are named `lab-<id>-*`, and nothing is assigned
  at subscription scope.
- **App:** the entry stays under 320 kB, and the Labs tab is lazy-loaded. The Labs pages fit 1100×600, and the phone has 7 icons.
- **Secrets:** none in logs, fixtures or committed files, none left in D1 after a session ends, and `.env` was never read.
