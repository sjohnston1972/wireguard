# Labs catalogue redesign: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. The integrator lands **E** (engine and data) first; **A** (learning content) runs **from the
> start, alongside E** (it needs only the spec's §5 rules, no code) and is merged by E's last step. Then **B** (page shell) and
> **C** (details and launch) run **in parallel**, each in its own git worktree with one implementer under
> superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the Labs catalogue becomes header + summary strip + one setup banner + toolbar + responsive card grid with a
selected-lab detail panel (drawer on tablets, full-width view on phones), with real readiness, session state, learning
content, topics, resources, costs and times, and nothing that can deploy without the existing confirmation.

**Architecture:** the Worker adds structured `blockers`, `learning` and `resources` to each `LabCard` and `autoCleanup` to
`GET /labs` (same checks `deployLab` makes; no new Azure call). `labs-build` merges `labs/_learning/<id>.yaml` and counts each
lab's planned-graph kinds into the catalogue (schema 2). The app adds pure modules (readiness/session mapping, money words,
topics, layout, filters and selection) and new components in the lazy labs chunk; the lab dialog at `/labs/:id` stays the full
details and Deploy confirmation surface; `Drawer` gains `side="right"`.

**Tech stack:** unchanged (React 19, TypeScript, Vite 8, TanStack Query, Radix, lucide-react 1.50.0, Hono, D1, Vitest, node:test).
No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-07-labs-redesign-design.md` (binding; its §3 rulings 1–19 and Appendix A, Steven's
brief). The labs spec (`2026-10-04-labs-design.md`) and the lab topology spec (`2026-10-06-lab-topology-design.md`) still hold.
**(V)** marks a fact to check during the build; each area's report records the answer.

**Facts established before planning** (2026-10-07, from `main` at 69073e6, no Azure calls):
- 43 lab folders; 43 planned graphs (`shared/topology/planned/`, 328 kB on disk). `labFolders()` skips `_*`, `setup` and dot
  names; `versionProblems`, `labs-tf`, `labs-topology` and `buildCatalogue` all iterate it; labs-check lints `_template` by
  name only. So `labs/_learning/` is invisible to versions and Terraform.
- `LabCard.unavailable` is the single string from `unavailableReason` (order: GitHub, governance role, Graph users and groups,
  32 slots, labs_max_running). `deployLab` also refuses a live session, leftovers (`ended_dirty` with a slot, or an orphan
  entry) and a budget already at 100 %. Prerequisites "never block Deploy".
- Labs needing the governance role (8): 01, 02, 03, 06, 20, 21, 22, 29; needing Graph (3): 01, 06, 37; either: **9**.
- The labs watchman runs from the 5-minute cron (`wrangler.toml`) and tears down at the timer / `max_until` by dispatching the
  lab workflow, which needs `canDispatch(env)` (GitHub token and repo). No cron heartbeat record exists.
- Shots: `scripts/lib/shots.mjs` judges the one-screen rule at ≥ 1100×600 for every route not `exemptFromOneScreen`; `--sizes
  WxH` marks width < 640 as mobile; scenario `labs` seeds lab 6 running, lab 5 deploying, history, one dirty session, orphans
  for lab 7 and passed permissions. `.env.example` has an empty `GITHUB_TOKEN` (so `canDispatch` is false in dev).
- Labs authored at £0/h: 01, 03, 04, 20 (cost words must handle exact zero).
- Bundle at the topology plan's T0: entry 311.3 kB of 320, all JS 347.1 kB of 450, CSS 33.3 kB of 50 (E1 re-measures).
- External links to `/labs/:id`: command palette, Overview (running labs, topology), Cost labs panel, history table.

## E names (planned; E updates this section as built, E9)

Branches from E's head use these names exactly; a change goes through the integrator, who updates this section and the spec.

**Shared** (`shared/api.ts`, `shared/labs.ts`): `LabBlockerKind`, `LabBlocker`; `LabCard.blockers`, `LabCard.learning`
(`{ objective, learn: [string, string, string], learningMin }` or null), `LabCard.resources` (`Record<kind, count>` or null);
`LabsResponse.autoCleanup`; `LabLearningDef` (`{ objective, learn, learning_min }`); `LabCatalogue.schema: 2`,
`.learning`, `.resources`.

**Scripts:** `scripts/lib/labs.mjs`: `LEARNING_DIR = "_learning"`, `readLearning(root, ids, defs, { requireLearning })` →
`{ learning, problems }`, `validateLearning(raw, def)` → problems, `countPlanned(graph)` → `Record<kind, count>`,
`buildCatalogue(root, { requireLearning = false, plannedDir })` (default `plannedDir` = `<root>/../shared/topology/planned`);
`labs-check` passes `{ requireLearning: true }`. `scripts/lib/shots.mjs`: `SCROLLING_ROUTES` (`/^\/labs(?:\?.*)?$/`), shot
field `checkOverflow: "all" | "x" | false`. `seed-scenarios.mjs` `SCENARIOS` gains `labs-setup`.

**Worker:** `availability.ts`: `blockersOf(def, a)`; `unavailableReason` = first blocker's message. `budget.ts` (or
`labs/warnings.ts`): `budgetFullMessage(b)`. `cards.ts`: `CardContext` gains `dirty: Set<string>`, `orphanIds: Set<string>`,
`budgetFull: string | null`; `labCard` fills `blockers`, `learning`, `resources`. `api/labs.ts`: `autoCleanup:
canDispatch(env)`. `devseed-labs.ts`: `seedLabs(env, { setup: true })` for `labs-setup` (role, users, groups false, message set).

**App (lazy labs chunk, `web/src/views/labs/`):**
- `status.ts`: `LabReadiness`, `LabSessionStatus`, `labReadiness(card, loaded)`, `labSessionStatus(session)`,
  `statusBadge(readiness, status, card) → { label, tone }`, `cardAction(...)`, `panelAction(...)` → `{ kind: "select" | "open"
  | "start" | "setup" | "prerequisite" | "disabled", label, href?, variant }`, `blockerFix(kind, ctx) → { label, href } | null`,
  `setupAffected(cards)`, `SETUP_KINDS = ["role", "graph"]`.
- `money.ts`: `fmtHourlyShort`, `fmtHourlyPrecise`, `fmtSessionCost`, `fmtMinutes`, `hourlyAria`.
- `topics.ts`: `TOPICS`, `TopicFamily`, `FAMILY_ICON`, `labTopics(resources)`, `labFamily(resources)`,
  `resourceSummary(resources)`.
- `layout.ts`: `LabsLayout = "wide" | "tablet" | "phone"`, `WIDE_QUERY = "(min-width: 1200px)"`, `useLabsLayout()`.
- `model.ts` (extended): `Filters = { q, exam, area, level: LabLevel | null, type, notRun, ready }`, `readFilters`,
  `writeFilters`, `NO_FILTERS`, `anyFilter`, `applyFilters(views, f)`, `searchText(card)`, `selectedLab(visibleIds, urlLab,
  layout, knownIds) → { shown: string | null; drop: boolean }`, `readSelection(params)`, `withSelection(params, id | null)`,
  `labHref(id, search, layout, view?)` (keeps `lab` on wide, drops it otherwise).
- `contract.ts`: `LabView = { card, readiness, status, badge, topics, family, search }`, `useLabViews(q) → { views, byId,
  loaded }`, `DetailsProps = { view: LabView | null; data: LabsResponse | undefined; layout: LabsLayout; onSelect(id) }`.
- `LabStatusBadge.tsx` (StatusPill from `badge`), used by B and C.
- `LabDetailsPanel.tsx` **stub** exporting `LabDetailsPanel(DetailsProps)`, `LabDetailsDrawer(DetailsProps & { open,
  onOpenChange })`, `LabDetailsView(DetailsProps & { onBack })` (title and badge only): C replaces the bodies, B renders them.

**Components:** `Drawer` `side?: "auto" | "bottom" | "right"` (`data-side="right"`, width `min(440px, 100vw - 32px)`, full
height, slide from the right, none under reduced motion; still the bottom sheet at ≤ 640 px). **API:** `useDeployLab` gains
`invalidateOnError: () => [["labs"]]`.

## Global Constraints

- **Inherited:** commit trailer `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV` and push after every
  commit; never read `.env` (worktrees `cp .env.example .env`); kill processes by PID only; one `.css` per component; tokens
  only (no hex colour in any new or changed labs CSS); status colours always with a word; "no data" never 0; Vitest + RTL
  behaviour tests; fixtures use TEST-NET, fake GUIDs and `contoso.onmicrosoft.com`.
- **Branches:** E `feat/labs-redesign-engine` from `main`; A `feat/labs-redesign-content` from `main`; B
  `feat/labs-redesign-shell` and C `feat/labs-redesign-details` from E's head **after E9**; integration `feat/labs-redesign`
  from E's head; the PR into `main`.
- **No Azure, no spend.** Nothing calls Azure, nothing deploys a lab, at any step (dev and production). Shots never click
  Deploy. The dev `.env` copy may set a placeholder `GITHUB_TOKEN=shots-placeholder` only for screenshots.
- **No lab folder changes:** nothing under `labs/az*`; `npm run labs-check -- --base origin/main` must pass with no version
  bump. Only `labs/_learning/**` is new.
- **STOPs:** none expected. **Pre-approved, no stop:** every merge, the PR into `main`, `npm run deploy-worker` (no migration
  in this plan). If the production deploy breaks the site, roll back with `npm run rollback-worker` to the recorded version and
  record it (that too is pre-approved).
- **Frozen files** (E or the integrator only): `shared/**`; `worker/**`; `scripts/**`; `labs/**` (A owns only
  `labs/_learning/**` until E9); `package.json`, `package-lock.json`; `.github/**`; `web/src/{api,components,shell,test,widgets}/**`;
  `web/src/App.tsx`, `web/src/views/pages.tsx`; `web/src/views/labs/{status,money,topics,layout,model,contract}.ts`,
  `LabStatusBadge.tsx`; `web/src/views/labs/topology/**`. **B owns:** `index.tsx`, `LabsPage.tsx`, `LabsHeader.tsx`,
  `LabsSummaryStrip.tsx`, `LabsNotices.tsx` (LabsSetupBanner, GitHub and budget notices), `LabsFilterToolbar.tsx`,
  `LabCatalogueGrid.tsx`, `LabCard.tsx`, `HistoryPage.tsx` (header only), `labs.css`, deleting `Filters.tsx`, `Catalogue.tsx`,
  `PhoneLabs.tsx`, `catalogue.test.tsx`, `phone.test.tsx`, `strip.test.tsx`, `history.test.tsx`, its new tests and CSS.
  **C owns:** `LabDetailsPanel.tsx` (bodies), `LabLaunchAction.tsx`, `LabPrerequisites.tsx`, `LabResourceSummary.tsx`,
  `DeployForm.tsx`, `LabModal.tsx`, `RunningLab.tsx` (only if needed), `modal.test.tsx`, `running.test.tsx`, its new tests
  and CSS. `labs.css` keeps the dialog, running, strip, orphans and history rules (B deletes only rules of removed parts).
- **Speed rules (builders):** targeted tests while working (`npx vitest run <file>`, `node --test <file>`); **one** full area
  gate at the end; skip `labs-tf` and `labs-topology` (no lab folder changes); `labs-check` only in E3, E9 and integration.
- **Area gate:** `npm test`, `npm run typecheck`, `npm run build:web`, `npm run bundle-size`.
- **Budgets:** entry ≤ 320 kB, all JS ≤ 450 kB, CSS ≤ 50 kB gzip; the entry grows by at most 1 kB over E1's figure.
- **Scrolling:** `/labs` may scroll vertically (spec ruling 8); never sideways at any size; `/labs/history` keeps the
  one-screen rule.

## Review Focus

1. **Readiness wrongly "Ready".** E: `a never-checked permission is a role blocker`, `a failed Graph check is a graph blocker`,
   `a KV read failure of labs:permissions blocks every lab that needs permissions`, `a lab with any blocker is refused by
   deployLab with the blocker's first sentence`, `budget at 100 % is a budget blocker; a budget read failure adds none`; app:
   `no data is checking, never ready`, `setup kinds win over other kinds`, `an unknown blocker kind is unavailable`, `a lab with
   prerequisites and no blockers is ready`.
2. **Banner count mismatch.** B: `the banner counts all 9 affected labs while the exam filter shows 3`, `GitHub not connected
   shows its own notice and the banner still counts only role and Graph labs`, `the budget notice is separate`, `no card
   repeats a permission paragraph`.
3. **Accidental deploy on card click.** B/C (fetch spy on `POST …/deploy`): `clicking a card, View lab, Review setup, Start
   lab, Lab guide or Diagram never posts deploy`, `Start lab navigates to /labs/:id`, `Enter and Space on a card select only`.
4. **URL state loops.** E/B: `a filter that hides the selected lab drops ?lab once (one navigate)`, `the implicit first-visible
   selection never writes the URL`, `search writes once after 250 ms and keeps the caret`, `Back restores filters and selection`,
   `an unknown ?lab is dropped with one toast`, `/labs/:id keeps working from the palette, Overview and Cost links`.
5. **Dark-mode contrast.** E/B: `new labs CSS has no hex colours`, `banner and badge text use --text-primary or a toned pill`
   (contrast test extended with the banner tint pairs, both themes); integration: every shot in dark and light read by eye.
6. **Card height jank.** B: `selected state uses an inset shadow, not a thicker border`, `a skeleton card is as tall as a real
   card` (V: measured), `cards in a row share a height and footers align`; shots at 1600, 1366, 1280.
7. **Tablet drawer focus traps.** C: `the drawer traps focus`, `Escape, X and Back close it and focus returns to the card`,
   `Start lab from the drawer opens the dialog and closing the dialog focuses the card`, `the phone view focuses its heading,
   and Back focuses the card`.
8. **43-lab performance.** B: `selecting another lab re-renders two cards` (a test Profiler count), `derived views are
   computed once per data change`; no per-card query.
9. **Bundle entry budget 320 kB.** Integration: `bundle-size` within budget, entry delta ≤ 1 kB, the labs code only in the
   lazy chunk (E: `nothing in the entry imports views/labs`).
10. **Learning content.** E/A: `every catalogue lab has a learning file with exactly 3 bullets within the lengths`, `labs-build
    tolerates a missing file; labs-check refuses it`, `a change under labs/_learning needs no version bump`; A3's fresh accuracy
    review against every readme.
11. **Cleanup claim.** E: `autoCleanup follows canDispatch`; B: `Auto-cleanup on is shown only when autoCleanup is true`; C:
    `the cleanup text never promises zero cost`.
12. **Cost words.** E: `0 → "< £0.01/hour" (card) and "No hourly charge at list price" (panel)`, `0.00004 → "< £0.0001/hour"`,
    `0.0099 → "< £0.01/hour"`, `0.01 → "£0.01/hour"`, `NaN → "Estimate unavailable"`, `no nonzero ever prints £0.00`.

---

## E: Engine and data (integrator, first)

**Branch:** `feat/labs-redesign-engine`. **Owns:** every frozen file; the names section. **Why it exists:** one source of truth
for readiness (the Worker's own checks), the content and topology data the cards need, and a contract so B and C can build in
parallel without touching each other's files.

- [ ] **E1 Baseline.** Worktree, `cp .env.example .env`, `npm ci`, `npm run build:web`, `npm run bundle-size`. Record entry,
  all JS, CSS and the labs chunk in this plan's facts. **Done when** the four figures are recorded and pushed.
- [ ] **E2 Shared types and fixtures.** Add the names section's shared types; update `web/src/test/fixtures.ts`
  (`labsFixture`, `labDetailFixture`: `blockers: []`, `learning`, `resources`, `autoCleanup: true`), `web/src/views/labs/testData.ts`
  defaults, `worker/test/labs-helpers.ts` (`TEST_CATALOGUE` schema 2 with `learning`, `resources`) and the literal schema-1
  catalogues in `labs-contract.test.ts` and `labs-orphans.test.ts`. **Done when** `npm run typecheck` passes.
- [ ] **E3 Learning loader, resources, schema 2.** Tests first (`scripts/test/labs-learning.test.mjs`): one refusal per spec
  §5.2 rule (unknown key, two sentences, 141 characters, markdown, 2 bullets, 4 bullets, a 91-character bullet, a trailing full
  stop, duplicate bullets, `learning_min` 12 / 17 / over `max_h × 60`); `a good file is merged as learning[id]`; `a missing file
  is tolerated by buildCatalogue and refused with requireLearning`; `a file for an unknown id is a problem`; `countPlanned skips
  lanes, the gateway and folded entries and counts outside nodes`; `a lab with no planned file has no resources entry`;
  `labFolders excludes _learning`; `editing labs/_learning/<id>.yaml makes versionProblems return []` (temp git repo, as the
  existing `--base` test). Update `labs-lib.test.mjs` (`schema` 2; `makeRoot` writes a valid learning file per lab unless told
  not to). FAIL; implement in `scripts/lib/labs.mjs`, `labs.d.mts`, `labs-check.mjs`; PASS; commit. **Done when** `node --test
  scripts/test/labs-learning.test.mjs scripts/test/labs-lib.test.mjs` passes except the real-repo labs-check test, which waits
  for E9 (note it in the commit).
- [ ] **E4 Worker: blockers, cards, autoCleanup.** Tests first (`worker/test/labs-blockers.test.ts`): Review Focus 1's E names;
  `blockersOf lists github, role, graph, slots, max_running in order with unavailableReason's sentences`; `unavailableReason is
  the first blocker's message` (every existing case still passes); `a dirty session holding a slot or an orphan entry is a
  leftovers blocker with deployLab's sentence`; `cards carry learning (camelCase) and resources from the catalogue, null when
  absent`; `GET /labs answers autoCleanup = canDispatch`. FAIL; implement (`availability.ts`, `cards.ts`, `budget.ts` or
  `warnings.ts` helper, `api/labs.ts`); PASS; commit. **Done when** `npx vitest run worker/test/labs-blockers.test.ts
  worker/test/labs-read.test.ts worker/test/labs-contract.test.ts` passes.
- [ ] **E5 App pure modules.** Tests first (`web/src/views/labs/status.test.ts`, `money.test.ts`, `topics.test.ts`,
  `filters.test.ts`): spec §6.3's two tables row by row (readiness, session, badge, card action, panel action, fixes);
  Review Focus 12; `every one of the 43 planned graphs gives at least one topic and one resource` (reads
  `shared/topology/planned/*.json`); `topics follow TOPICS order and the card shows 3 plus "+N"`; `resourceSummary puts assets
  before groups and plural words for counts over 1`; filters: `old ?level=a,b keeps the first valid level`, `ready=1 keeps
  ready labs with no live session`, `search matches title, id, "lab 6", summary, objective and topic words`, `a tagged lab is
  kept by each of its exams`; selection: `wide shows the URL lab when visible, else the first visible, and asks to drop a hidden
  known lab`, `tablet and phone never select implicitly`, `labHref keeps lab on wide and drops it otherwise`. FAIL; implement
  `status.ts`, `money.ts`, `topics.ts`, `layout.ts`, `model.ts`; PASS; commit. **Done when** the four test files pass.
- [ ] **E6 Drawer right, deploy invalidation.** Tests first (`web/src/components/layout/layout.test.tsx`): `side="right" is a
  modal dialog on the right with a focus trap, Escape closes and focus returns`, `at 640 px it is the bottom sheet`, `no slide
  under reduced motion`; `web/src/labs-contract.test.tsx`: `a refused deploy invalidates ["labs"]`. FAIL; implement `Drawer.tsx`,
  `Drawer.css`, `mutations.ts`; PASS; commit. **Done when** both files pass.
- [ ] **E7 Shots and the labs-setup scenario.** Tests first: `scripts/test/shots.test.mjs`: `/labs and /labs?… are judged for
  sideways scroll only, at every size including the phone`, `/labs/history keeps the one-screen rule`; `worker/test`
  (seed): `labs-setup seeds the labs story with role, users and groups false, so 9 cards have setup blockers`. FAIL; implement
  `scripts/lib/shots.mjs`, `scripts/shots.mjs` (if the judge call changes), `scripts/seed-scenarios.mjs`, `worker/src/devseed*.ts`;
  PASS; commit. **Done when** both tests pass.
- [ ] **E8 Contract for B and C.** `contract.ts` (`LabView`, `useLabViews`, `DetailsProps`), `LabStatusBadge.tsx` (+ test:
  word and tone from `badge`), `LabDetailsPanel.tsx` stub with the three exports. **Done when** `npm run typecheck` passes and
  the badge test passes.
- [ ] **E9 Merge A, gate, names.** Merge `feat/labs-redesign-content` (`--no-ff`). Add `scripts/test/labs-learning-content.test.mjs`
  (real repo: every catalogue lab has a valid file; no file without a lab; `labs-check` passes). Run the area gate plus `npm
  run labs-check` and `npm run labs-check -- --base origin/main`. Update the names section as built. **Done when** all pass,
  `git diff --stat origin/main -- 'labs/az*'` is empty, and the head is pushed (B and C branch from it).

## A: Learning content for all 43 labs (from the start, alongside E)

**Branch:** `feat/labs-redesign-content` from `main`. **Owns:** `labs/_learning/*.yaml` only. **Why:** the cards and panel need
an objective, three learning points and a learning time per lab; they must be accurate to what each lab actually builds.

- [ ] **A1 Author.** For each of the 43 lab folders read `lab.yaml`, `readme.md` (intro with its exam-outline items, "What it
  deploys", "Things to try") and the lab's skill-area names in `labs/skill-areas.yaml`; write `labs/_learning/<id>.yaml` per
  spec §5.1–§5.4 (the header comment line, `objective`, three `learn` bullets starting with a verb, `learning_min` = about 10
  minutes plus 8–10 per "Things to try" item, rounded to 5, within 15 and `min(240, max_h × 60)`). Up to three helpers in
  parallel, by exam (AZ-104 18, AZ-305 11, AZ-700 14). **Done when** 43 files exist and a scratch checker (in the scratchpad, not
  committed) applying §5.2's rules reports none broken.
- [ ] **A2 Self-check.** Every bullet names something the readme has the learner do; nothing the lab does not deploy; break-fix
  labs (17, 35) do not give the fault away in the objective or bullets (the readme keeps "What was broken" closed). **Done when**
  each file is ticked in the area report.
- [ ] **A3 Fresh accuracy review.** A fresh opus reviewer gets spec §5 and, per lab, the readme, lab.yaml and the learning file;
  it lists any inaccurate, vague or spoiler line. One fix pass. **Done when** the reviewer's list is empty or every item is fixed,
  committed and pushed; the integrator is told the head (E9 merges it).

## B: Page shell (after E9)

**Branch:** `feat/labs-redesign-shell` from E's head. **Owns:** the B files in Global Constraints. **Why:** the catalogue's
structure, filters, cards and URL state; it renders C's components through the E8 contract.

- [ ] **B1 Header.** Tests first (`header.test.tsx`): `the page is titled Azure Labs with the description`, `Catalogue and Your
  labs are links with aria-current on the current one`, `/labs/history uses the same header`. FAIL; implement `LabsHeader.tsx`,
  `HistoryPage.tsx` header; PASS; commit. **Done when** the file passes.
- [ ] **B2 Summary strip.** Tests first (`summary.test.tsx`): `All exams: 2 of 43 labs run` (fixture runs), `AZ-305 counts AZ-305
  and tagged labs`, `1 of 3 running; limit reached at 3 of 3`, `Auto-cleanup on only when autoCleanup`, `skeleton pills while
  loading, never a number`. FAIL; implement `LabsSummaryStrip.tsx` + CSS; PASS; commit. **Done when** the file passes.
- [ ] **B3 Notices.** Tests first (`notices.test.tsx`): Review Focus 2's B names; `Complete setup links to /settings/labs`,
  `Hide hides the banner for the visit`, `last checked time or never checked`, `the permissions message is shown`. FAIL; implement
  `LabsNotices.tsx` + CSS; PASS; commit. **Done when** the file passes.
- [ ] **B4 Toolbar and URL.** Tests first (`toolbar.test.tsx`): `each control writes its parameter with replace and keeps the
  others`, `More filters holds Type and Not run yet and shows its count`, `Showing N of M labs and Clear filters when active`,
  `the phone shows search and a Filters sheet with Show N labs`, Review Focus 4's search names, `the empty result says how many
  labs Ready to run only hides`. FAIL; implement `LabsFilterToolbar.tsx` + CSS; PASS; commit. **Done when** the file passes.
- [ ] **B5 Grid and cards.** Tests first (`cards.test.tsx`): `a card shows Lab n · exam, badge, icon, title, objective, at most
  3 topic chips plus +N, learning time and short cost`, `a card without learning shows the summary's first sentence and no
  learning time`, `each state's card action and label` (spec §6.3), Review Focus 3, 6 and 8's B names, `the selected card has
  aria-current and the live region names it`, `a session card's action is a link to /labs/:id`, `the skip link moves focus to
  the panel`. FAIL; implement `LabCatalogueGrid.tsx`, `LabCard.tsx` + CSS; PASS; commit. **Done when** the file passes.
- [ ] **B6 Page, routing and states.** Tests first (`page.test.tsx`, matchMedia mocked at 1600, 1024 and 390): `wide shows the
  grid and the panel with the first visible lab`, `tablet opens the drawer on activate (push) and Back closes it`, `phone shows
  one column and the full-width view`, `loading shows 6 skeleton cards and a panel skeleton`, `error shows Retry`, `stale shows
  the StaleBanner and keeps badges`, `empty catalogue`, `/labs/:id opens the dialog over the page with the lab selected`,
  `/labs/:id/diagram unchanged`, Review Focus 4's selection names. FAIL; implement `LabsPage.tsx`, `index.tsx`; delete
  `Filters.tsx`, `Catalogue.tsx`, `PhoneLabs.tsx` and their tests; trim `labs.css`; PASS; commit. **Done when** the file passes and
  no import of the deleted files remains.
- [ ] **B7 Area gate and a look.** Area gate; shots of `/labs` at 1600×900, 1024×768, 390×844, dark and light, with the stub
  panel, read by eye (no sideways scroll, readable cards). **Done when** the gate passes and the area report lists the shots.

## C: Details panel and launch (after E9)

**Branch:** `feat/labs-redesign-details` from E's head. **Owns:** the C files in Global Constraints. **Why:** the selected
lab's details, its one primary action and the launch flow, in three responsive containers, with focus handled.

- [ ] **C1 Panel content.** Tests first (`details.test.tsx`): spec §8.5 items 1–8 for a ready, a setup-required, an unavailable
  (each first-blocker kind), a running and a deploying lab; `no learning: summary shown, What you will learn left out`; `6
  resource tiles then +N more linking to the diagram`, `resources null says Resource list unavailable`; `prerequisites are
  Recommended first, each a link selecting that lab`; `deploy time adds the measured time from the current version's release
  test`; `untested version says Untested vN`; Review Focus 11's C name. FAIL; implement `LabDetailsPanel.tsx` (panel body),
  `LabResourceSummary.tsx` (sprite via `ensureSprite`, `TopoIcon`), `LabPrerequisites.tsx` + CSS; PASS; commit. **Done when** the
  file passes.
- [ ] **C2 Launch action.** Tests first (`launch.test.tsx`): the panel action per spec §6.3 row by row; `setup-required shows
  each blocker's sentence and Complete setup to /settings/labs`; `each other blocker shows its fix link`; `Start lab navigates
  to /labs/:id (keeping lab on wide)`; `Lab guide and Diagram links`; Review Focus 3's C names. FAIL; implement
  `LabLaunchAction.tsx`; PASS; commit. **Done when** the file passes.
- [ ] **C3 Drawer and phone view.** Tests first (`details-containers.test.tsx`): Review Focus 7; `the drawer stays mounted and
  its open state follows ?lab`, `the phone view's Back returns to /labs with the filters`. FAIL; implement `LabDetailsDrawer`,
  `LabDetailsView`; PASS; commit. **Done when** the file passes.
- [ ] **C4 Launch flow in the dialog.** Tests first (`modal.test.tsx` additions): `two synchronous Deploy clicks send one POST`,
  `after success the button stays disabled with Starting the deploy… until the session appears`, `a 409 shows an inline alert
  with the server sentence and the fix link`, `a 422 confirm_required shows the warnings with Deploy anyway`, `on tablet and
  phone closing the dialog focuses the lab's card`, existing modal tests still pass. FAIL; implement `DeployForm.tsx`,
  `LabModal.tsx`; PASS; commit. **Done when** `modal.test.tsx` and `running.test.tsx` pass.
- [ ] **C5 Deploy checks in the panel.** Tests first: `the destination region and warnings appear when the lab loads`,
  `Skeleton lines while loading`, `an inline Retry when it fails while the card content stays`. FAIL; implement; PASS; commit.
  **Done when** the file passes.
- [ ] **C6 Area gate.** **Done when** the area gate passes and the report lists the (V) answers.

## Integration

1. **Merge** onto `feat/labs-redesign` (from E's head) in the order C, B (`--no-ff`), the gate after each. A conflict means an
   area touched a frozen file or another area's file: reject that change or fold it into E's files. **Done when** the gate
   passes after the second merge.
2. **Full gate:** area gate (record entry, all JS, CSS and the labs chunk), `npm run labs-check`, `npm run labs-check -- --base
   origin/main`; `git diff --stat origin/main -- 'labs/az*'` empty (so labs-tf and labs-topology are not needed); CI green on a
   draft PR. **Done when** all exit 0, the budgets hold (entry delta ≤ 1 kB) and CI is green.
3. **Whole-branch review.** A fresh opus reviewer gets this plan, the spec and the diff. Ask about: the Review Focus list; the
   readiness table against `deployLab`; the URL effects; focus paths in the three layouts; tokens and contrast in both themes;
   memoisation; anything that could deploy without the dialog. **Done when** the findings are listed in the PR.
4. **One fix pass,** test-first, then step 2 again. **Done when** step 2 passes again.
5. **Screens.** Dev server from the branch (`cp .env.example .env`, plus `GITHUB_TOKEN=shots-placeholder`), `npm run shots --
   --scenario labs` and `--scenario labs-setup`, routes `/labs,/labs?lab=az104-02-policy,/labs?exam=AZ-305&ready=1,/labs/history`,
   sizes `1600x900,1366x768,1280x800,1024x768,820x1180,390x844`, themes dark and light; one more `labs-setup` run with the
   placeholder removed (GitHub notice). Read every picture: no sideways scroll; 3 / 3 / 2 / 3 / 2 / 1 columns at the six widths;
   the panel sticky at 1600, 1366 and 1280; the drawer at 1024 and 820 (`?lab`); the phone view at 390; the banner says 9 of 43;
   badges and actions per state; selected styling; dark contrast; no "£0.00"; no placeholder figures. `shots:diff` against a
   `main` baseline for `/`, `/clients`, `/firewall`, `/activity`, `/cost`, `/settings`: zero differing pixels. **Done when** every
   shot exits 0, the diffs are zero and the PR lists the pictures checked.
6. **Merge and deploy (pre-approved).** PR → `main`, CI green, merge; record the current production Worker version (rollback
   id); `npm run deploy-worker`. **Done when** in the signed-in browser `https://wg-admin.clydeford.net/labs` shows 43 cards with
   objectives, topic chips and badges, the strip with real counts, the panel for the first lab, the drawer at tablet width, and
   no console errors; nothing is deployed; the new version and rollback id are recorded in the outcome.
7. **Outcome.** Write the outcome below (bundle figures, every (V) answer, review findings and fixes, shots checked, versions).
   **Done when** it is committed and pushed.

## Final review checklist

- **Structure:** no filters sidebar or enclosing catalogue panel; header, strip, notices, toolbar, grid and panel as spec §4.
- **Every lab** (43) has an objective, three learning points and a learning time from `labs/_learning/`; no lab folder or
  version changed; labs-check enforces completeness.
- **Real data only:** readiness from `blockers` (fail-closed for permissions); session from the live session; counts from
  cards; Auto-cleanup only with `autoCleanup`; topics and resources from planned graphs; costs never "£0.00/hour" for a nonzero
  rate; "Estimate unavailable" when missing.
- **Safety:** selecting, View lab, Review setup and Start lab never deploy; the dialog's Deploy is the only way; duplicate
  submits impossible; errors actionable.
- **Layouts:** wide sticky panel, tablet drawer, phone view; keyboard and focus paths; reduced motion; light and dark.
- **Kept:** every filter, the running strip, leftovers clean-up, history, coverage, Readme and Diagram tabs, full-screen
  diagram, `/labs/:id` links.
- **Budgets:** entry ≤ 320 kB (delta ≤ 1 kB), JS ≤ 450 kB, CSS ≤ 50 kB; no Azure call; `.env` never read.

## Outcome

To be written by the integrator after integration step 7.
