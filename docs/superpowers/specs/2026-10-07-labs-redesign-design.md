# wg-admin Labs: catalogue redesign (design)

Date: 2026-10-07. Status: design **approved by Steven end to end on 2026-10-07** (his brief and decisions, Appendix A); the
details below are decided here under that approval (§3 lists every decision made while writing, as rulings). Builds on
`docs/superpowers/specs/2026-10-04-labs-design.md` (the labs spec, binding; its §10 is the Labs tab this replaces),
`docs/superpowers/specs/2026-10-06-lab-topology-design.md` (planned graphs, the Diagram tab, the icon sprite) and the six-view
redesign spec `docs/superpowers/specs/2026-10-02-observability-redesign-design.md` (§7 design system, §10 states), as on `main`
at 69073e6 (43 lab folders, 43 planned graphs). The plan is `docs/superpowers/plans/2026-10-07-labs-redesign-plan.md`.
**(V)** marks a fact to check during the build; the area reports record the answer.

## 1. Intent

Make **choosing a lab, understanding whether it can run, and starting it** obvious. The Labs catalogue becomes a header with
Catalogue / Your labs, one compact summary strip, at most one consolidated setup banner (plus any distinct notices), a
horizontal search-and-filter toolbar, and a responsive grid of lab cards beside a **selected-lab detail panel**. Every card
has one obvious next action; selecting a card never deploys anything.

Kept exactly: the lab definitions, every API and its semantics, the permission checks, prerequisites (advisory), session
limits, the deploy confirmation (the lab dialog's Deploy form), the running strip, leftovers clean-up, the history page,
coverage map, the Readme and Diagram tabs, the full-screen diagram, all existing filters and every deep link to `/labs/:id`.

Non-goals (Steven, Appendix A): **no learning-completion feature** (no "Completed" badge, progress bar or "View results");
no new Azure permission or call; no change to any lab folder, lab version, `lab.yml`, `wg.yml` or the gateway.

## 2. Decisions (approved by Steven, 2026-10-07)

| Topic | Decision |
|---|---|
| Design system | Labs is an extension of the existing dashboard design system: AppShell, PageHeader, Panel, StatusPill, Button, SegmentedControl, Select, Switch, SearchInput, Drawer, Skeleton/Empty/Error/StaleBanner, spacing and radius tokens; light and dark through the semantic tokens; never the mockup's literal palette. |
| Completion | Not built. The summary strip shows real counts (labs run, labs running) and cleanup status. |
| Learning content | For all 43 labs: `objective` (one sentence), exactly 3 "What you will learn" bullets, `learning_min` (learning time, distinct from deploy time and session length), written from each lab's readme and exam outline, checked by tests, stored **outside** the lab folders and merged by the catalogue build, so no lab version bump or release test is needed. |
| Exams | Exam selector All / AZ-104 / AZ-305 / AZ-700; a lab tagged for several exams appears under each (labs spec ruling 39). |
| Topics and resources | Topic chips and "Resources deployed" come from each lab's planned topology (`shared/topology/planned/<id>.json`). |
| Autonomy | Spec, plan, build, review, screenshots, merge and deploy without stopping. |

## 3. Decisions made while writing this spec (rulings)

1. **Selection lives in `?lab=<id>`; `/labs/:id` keeps its meaning** (the lab dialog: readme and Diagram tabs, cost table,
   Deploy form or the running session). The command palette, Overview, Cost and history all link to `/labs/:id`; they keep
   working unchanged. `?lab` is a selection, never a dialog.
2. **The detail panel is a summary; the lab dialog stays the "full details" surface.** The panel (400 px) has the objective,
   what you will learn, resources, times, cost, prerequisites, cleanup, the primary action and two secondary links: **Lab
   guide** (`/labs/:id`, Readme tab) and **Diagram** (`/labs/:id?view=diagram`). Why: a 400 px column is too narrow for the React
   Flow canvas and the long readmes; the dialog already hosts both, the Deploy confirmation and the running controls, and keeps
   the diagram chunk lazy (loaded only when asked for).
3. **Start lab opens the existing confirmation.** "Start lab" navigates to `/labs/:id`, whose idle view is today's Deploy
   form (session length, peering, region = deployment destination, priced items, warnings, Deploy / Deploy anyway). Nothing
   new can deploy; the panel and cards only navigate.
4. **Readiness comes from one new structured field, `LabCard.blockers`**, computed by the Worker from exactly the checks
   `deployLab` makes (§6.1). The client never re-derives permissions from raw flags. `LabCard.unavailable` is kept, unchanged.
5. **"prerequisite-required" exists in the type but is never produced today**: `LabDef.prerequisites` "never blocks Deploy"
   (`shared/labs.ts`), so every prerequisite is *recommended*. The panel lists them as "Recommended first". A test pins that a
   lab with prerequisites is still `ready`.
6. **"checking" means "not known yet"**: the labs query has no data, or the selected id has no card yet. A permission never
   checked (`checkedAt: null`) or a failed check is not "checking": the Worker already reports it as a blocker, so it maps to
   `setup-required`. Unknown or failed permission checks are never `ready` (fail-closed in `availability()`: a KV read failure is
   `NO_PERMISSIONS`, all null).
7. **"Auto-cleanup on" shows only when `LabsResponse.autoCleanup` is true**, which the Worker sets to `canDispatch(env)`
   (§6.3): the 5-minute cron (`wrangler.toml` `*/5 * * * *`) runs the labs watchman, which tears a lab down at its timer or hard
   stop by dispatching the lab workflow, which needs GitHub. Otherwise the item is omitted (never "off" guessed from the client).
8. **The catalogue page scrolls** (the brief: no fixed page heights, no giant enclosing panel, a sticky detail panel). `/labs`
   (with any query) is exempt from the six-view one-screen rule for vertical scroll only; sideways scroll is still a failure
   at every size including the phone. `/labs/history` keeps the one-screen rule. *Update 2026-10-10:* the lab dialog
   route `/labs/<id>` (with any query) is exempt the same way, since the catalogue behind it scrolls; the full-screen diagram
   `/labs/<id>/diagram` keeps the rule. *Update 2026-10-10 (later; supersedes the above for desktop and tablet):* Steven:
   "labs page should be a single page with no scrolling, scrolling only within the lab tiles area." On a desktop or tablet
   (641 px and up) the catalogue is one screen: the header, summary strip, notices, running strip and filter toolbar take
   their natural height, the workspace fills the rest of the page area (a flex column filling `#main`, which the shell sizes
   to the window less the app bar and any shell banners: no fixed heights), and only the tile grid scrolls. The wide
   details panel scrolls inside its own column; a tall running strip or list of leftovers scrolls inside itself past about a
   quarter of the page. The phone (640 px and below) keeps ordinary page scrolling. The shots harness therefore applies the
   full one-screen rule to `/labs`, `/labs?…` and `/labs/<id>` at every non-phone size (1024 x 768 included), and judges the
   phone for sideways scroll only (`LABS_CATALOGUE_ROUTES` in `scripts/lib/shots.mjs`). `/labs/history` is unchanged.
9. **Layouts by viewport width** (§9): wide ≥ 1200 px inline sticky panel; tablet 641–1199 px a right slide-over drawer;
   phone ≤ 640 px one column, a filter sheet and a full-width detail view. One hook decides (`useLabsLayout`).
10. **Tablet drawer = a new `Drawer side="right"`** (modal, focus-trapped, ~440 px). The six-view spec §7 always described the
    Drawer as "right, ~420 px; becomes a sheet on the phone"; this adds that variant without changing `auto` or `inline`.
11. **Cards are a list of articles, not an ARIA listbox**: a running card has two controls (select and Open session), and
    listbox options may not contain interactive content. Each card's title is a button with `aria-current="true"` when selected
    and a stretched hit area; selection is also announced in a polite live region (§10).
12. **Difficulty becomes single-select** (the brief's dropdown). `?level=a,b` from an old link keeps its first valid value.
    Type (Explore / Break-fix, multi) and Not run yet move into **More filters**.
13. **Grid order is lab number** (1–44 run AZ-104, then AZ-305, then AZ-700), one flat grid with no exam headings; each card
    names its exam and any other exam it belongs to.
14. **Learning content lives in `labs/_learning/<id>.yaml`.** `labFolders()` skips any name starting with `_`, so
    `labs-check --base` (versions), `labs-tf`, `labs-topology` and the lint never see it (§5.3).
15. **A missing learning file is tolerated by `labs-build` (card `learning: null`) and refused by `labs-check`** (CI). A
    malformed file is refused by both. So the app and tests keep building while content is authored, and nothing reaches `main`
    without content for every lab.
16. **Resources are counted at build time** from the planned graph into the catalogue (kind → count); words, icons and topics
    are derived in the app from `KINDS` (§7). The app never fetches 43 planned graphs.
17. **Budget and leftovers become blockers too** (the two other refusals `deployLab` makes before confirmation). A budget read
    failure adds no blocker (the deploy route re-checks and refuses with its message); a permission read failure does (rule 6).
18. **Card topic icon is a monochrome lucide icon by topic family** (themes with `currentColor`); the panel's resource list
    uses the official Azure sprite icons, the same as the Diagram.
19. **Duplicate launches are stopped three times**: a synchronous ref latch in the Deploy form, the button disabled while
    pending and until the new session appears, and the Worker's lab lock (409).

## 4. Page structure

`/labs` (Catalogue), top to bottom, inside the existing AppShell (global navigation unchanged):

1. **LabsHeader**: `PageHeader title="Azure Labs"`, subtitle "Hands-on AZ-104, AZ-305 and AZ-700 environments: pick a lab,
   deploy it, learn by doing.", `env={<EnvironmentField/>}`, right: **Catalogue | Your labs** as a `<nav aria-label="Labs
   pages">` of two `NavLink`s styled as the SegmentedControl (`aria-current="page"` on the current one). Used by `/labs` and
   `/labs/history`.
2. **LabsSummaryStrip** (§8.1).
3. **Notices**, each its own block, in this order, never merged: `Orphans` (existing leftovers notice, `id="labs-orphans"`),
   GitHub notice, budget notice, **LabsSetupBanner** (§8.2). Distinct deploy failures stay in their own places (toasts, the
   dialog's inline error, a failed session's badge).
4. `RunningStrip` (existing, unchanged; only when a session is live).
5. **LabsFilterToolbar** (§8.3) with the result count and Clear filters.
6. **`.labs-workspace`**: **LabCatalogueGrid** (§8.4) and, on wide screens, **LabDetailsPanel** (§8.5).

`/labs/history` (Your labs): LabsHeader + the existing sessions table and coverage map (unchanged). `/labs/:id` and
`/labs/:id/diagram`: unchanged, over the new page.

Removed: the Filters sidebar (`Filters.tsx`), the Catalogue panel (`Catalogue.tsx`), the phone-only composition
(`PhoneLabs.tsx`), the header's capacity text (moved to the strip), the per-card unavailable paragraph, exam group headings.

## 5. Learning content

### 5.1 File

One file per lab, `labs/_learning/<lab id>.yaml`:

```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Apply a deny policy and a resource lock, then watch both refuse changes.
learn:
  - Assign a custom deny policy and the Allowed locations policy to a resource group
  - Read compliance results and start an on-demand evaluation scan
  - Use CanNotDelete and ReadOnly locks to stop changes, even by an Owner
learning_min: 45
```

### 5.2 Rules (`scripts/lib/labs.mjs`, `readLearning`)

- A YAML 1.1 mapping with exactly `objective`, `learn`, `learning_min` (an unknown key names itself).
- `objective`: one line, 30–140 characters, one sentence (starts with a capital, ends with `.`, no other `. `, `!` or `?`),
  no markdown (`*`, `` ` ``, `[`, `#`).
- `learn`: exactly 3 strings; each one line, 15–90 characters, starts with a capital letter, no trailing full stop, no
  markdown; the three distinct (case-insensitive).
- `learning_min`: a whole number, a multiple of 5, from 15 to `min(240, max_h × 60)` of that lab.
- A file whose name is not a catalogue lab id is a problem ("no lab <id>").
- Missing file: a problem only with `{ requireLearning: true }` (labs-check); labs-build leaves `learning` out for that lab.
- Problems use the existing shape: `{ lab: <id>, file: "_learning/<id>.yaml", field, message }`.

### 5.3 Why no version bump (proof the build relies on)

`labFolders(root)` returns directories **not starting with `_`**, not `setup`, not hidden. `versionProblems`, `labs-tf`,
`labs-topology` and `buildCatalogue`'s lab loop all iterate `labFolders`; labs-check lints `_template` by name only. So a
change under `labs/_learning/` never touches a lab folder's diff. A node test pins it (plan E2): in a temp git repo, editing
`labs/_learning/az104-05-storage.yaml` makes `versionProblems(labs, base)` return `[]`, and `labFolders` excludes `_learning`.
`released` (current version has a passing release test) is untouched.

### 5.4 Authoring (all 43)

Written from the lab's `readme.md` (its intro names the exam-outline items, "What it deploys", "Things to try") and the skill
area names in `labs/skill-areas.yaml`. The objective is the outcome in the learner's words; each bullet starts with a verb and
maps to something the readme actually has you do; nothing the lab does not deploy. `learning_min`: about 10 minutes of
reading plus 8–10 minutes per "Things to try" item, rounded to 5, within the rule's range. A fresh reviewer checks every file
against its readme (plan A3).

## 6. Data contract

### 6.1 Blockers (Worker, `worker/src/labs/availability.ts`, `cards.ts`)

```ts
// shared/api.ts
export type LabBlockerKind = "github" | "role" | "graph" | "slots" | "max_running" | "leftovers" | "budget";
export interface LabBlocker { kind: LabBlockerKind; message: string }
```

`blockersOf(def, a: Availability): LabBlocker[]`, in `unavailableReason`'s order and with its exact sentences: `github` (GitHub
not connected), `role` (needs the governance role and it is not `true`), `graph` (needs Graph and users or groups is not
`true`), `slots` (all 32 in use), `max_running` (live ≥ labs_max_running). `unavailableReason(def, a)` becomes
`blockersOf(def, a)[0]?.message ?? null` (same output for every existing test).

`labCard` adds, after those: `leftovers` when the lab has an `ended_dirty` session holding a slot or an orphan entry (the
check and sentence `deployLab` uses), then `budget` when `budget > 0 && total >= budget` (the sentence `labWarnings` uses for
its non-overridable budget warning, moved into one exported helper `budgetFullMessage(b)` both call). `cardContext` reads, once
per request: the dirty lab ids (`SELECT DISTINCT lab_id FROM lab_sessions WHERE state='ended_dirty' AND slot IS NOT NULL`), the
orphans (KV `labs:orphans`), and `budgetStatus(env, cfg, snap)` (D1 and KV only; a throw adds no budget blocker, ruling 17).

Overridable warnings (budget for this session, capacity) and information (pricey, slow) stay deploy-time warnings in
`LabDetail.warnings`; they never change readiness.

### 6.2 Card fields

```ts
// shared/labs.ts
export interface LabLearningDef { objective: string; learn: [string, string, string]; learning_min: number }
export interface LabCatalogue {
  schema: 2;                                        // was 1
  skillAreas: SkillArea[]; labs: LabDef[]; readmes: Record<string, ReadmeBlock[]>;
  learning: Record<string, LabLearningDef>;          // lab id -> content (absent: no file yet)
  resources: Record<string, Record<string, number>>; // lab id -> planned TopoKind -> count (absent: no planned file)
}
// shared/api.ts, LabCard gains
blockers: LabBlocker[];                                // [] when it can deploy now
learning: { objective: string; learn: [string, string, string]; learningMin: number } | null;
resources: Record<string, number> | null;              // planned kind -> count
// LabsResponse gains
autoCleanup: boolean;                                  // canDispatch(env)
```

`resources` (labs-build): for each lab, `shared/topology/planned/<id>.json` if present; count `nodes[].kind` excluding `lane`
and `gateway`; folded entries are not counted; `scope: "outside"` nodes count (lab 44's flow log is the lab's). Keys sorted.

### 6.3 Readiness and session status (app, `web/src/views/labs/status.ts`, pure)

```ts
export type LabReadiness = "checking" | "ready" | "setup-required" | "prerequisite-required" | "unavailable";
export type LabSessionStatus = "none" | "deploying" | "running" | "destroying" | "failed"; // the brief's LabSessionState
```

`labReadiness(card | undefined, loaded)`:

| Condition (first match) | Readiness |
|---|---|
| labs query has no data, or no card | `checking` |
| a blocker of kind `role` or `graph` | `setup-required` |
| any other blocker (`github`, `slots`, `max_running`, `leftovers`, `budget`) | `unavailable` |
| otherwise (prerequisites never block, ruling 5) | `ready` |

`labSessionStatus(card.running)`: `null` → `none`; `deploying` → `deploying`; `running` → `running`; `tearing_down` →
`destroying`; `failed` → `failed`; `ended` / `ended_dirty` (never live) → `none`.

The two are kept separate everywhere: the badge and actions look at the session first, then readiness.

| Session / readiness | Badge (StatusPill, word + tone) | Card action | Panel primary action |
|---|---|---|---|
| deploying | "Deploying 3/16" amber (`stateWord`) | View progress → `/labs/:id` | View progress |
| running | "Running" green (`stateWord`, e.g. "Running, peer 2/5") | Open session → `/labs/:id` | Open session |
| destroying | "Tearing down" amber | View progress | View progress |
| failed | "Failed" red | Review failure → `/labs/:id` | Review failure |
| none + checking | "Checking…" grey | (skeleton; no action) | Start lab, disabled, "Checking…" |
| none + ready | "Ready to run" green | **View lab** (select) | **Start lab** → `/labs/:id` (confirmation) |
| none + setup-required | "Setup required" amber | Review setup (select) | **Complete setup** → `/settings/labs` |
| none + prerequisite-required | "Prerequisite first" amber | View lab (select) | View prerequisite (select it) |
| none + unavailable | by first blocker: github "Unavailable" grey, slots / max_running "At capacity" amber, leftovers "Clean-up needed" red, budget "Budget reached" red | View lab (select) | Start lab disabled, the blocker's sentence, and its fix (below) |

Fixes (`blockerFix(kind)`): role, graph → "Complete setup" `/settings/labs` (Settings → Labs → Permissions → Check
permissions, the existing setup workflow); github → "Open the setup checklist" `/settings/overview`; budget → "Review the budget"
`/settings/automation`; max_running → "Change the limit" `/settings/labs`; leftovers → "Clean up" (focuses the Orphans notice's
button for that lab when listed, else none); slots → none (the sentence explains).

"Ready to run only" keeps cards with readiness `ready` and session `none`.

## 7. Topics and resources (`web/src/views/labs/topics.ts`, pure)

`TOPICS`: an ordered table, kind → topic word and family. Order is priority (specific services first, VMs and VNets last):

| Kinds | Topic | Family |
|---|---|---|
| entraPrincipal | Entra ID | identity |
| role | RBAC | identity |
| managedIdentity | Managed identities | identity |
| policy | Azure Policy | governance |
| managementGroup | Management groups | governance |
| keyVault | Key Vault | security |
| firewall, firewallPolicy | Azure Firewall | security |
| wafPolicy | WAF | security |
| bastion | Bastion | security |
| vpnGateway, localNetworkGateway | VPN | networking |
| virtualWan, virtualHub | Virtual WAN | networking |
| routeServer | Route Server | networking |
| networkManager | Network Manager | networking |
| natGateway | NAT gateway | networking |
| loadBalancer | Load Balancer | networking |
| appGateway | Application Gateway | networking |
| frontDoor | Front Door | networking |
| trafficManager | Traffic Manager | networking |
| privateEndpoint, privateLinkService | Private Link | networking |
| dnsZone, privateDnsZone, dnsResolver, dnsRuleset | DNS | networking |
| routeTable | Routing | networking |
| publicIp, publicIpPrefix | Public IPs | networking |
| nsg | NSGs | networking |
| flowLog | Flow logs | monitoring |
| monitor | Azure Monitor | monitoring |
| logAnalytics | Log Analytics | monitoring |
| recoveryVault | Backup and recovery | continuity |
| storage | Storage | storage |
| sqlServer, sqlDatabase | Azure SQL | data |
| cosmos | Cosmos DB | data |
| serviceBus | Service Bus | messaging |
| eventGrid | Event Grid | messaging |
| aks | AKS | containers |
| containerApp, containerAppEnv, containerAppJob | Container Apps | containers |
| containerGroup | Container Instances | containers |
| registry | Container Registry | containers |
| appServicePlan | App Service | compute |
| vmss | Scale sets | compute |
| vm | Virtual machines | compute |
| vnet | Virtual networks | networking |
| resourceGroup, subnet, lane, gateway, generic | (no topic) | |

- `labTopics(resources)`: the distinct topics of the lab's kinds, in table order. Cards show the first 3 and a "+N" chip
  (`aria-label="N more topics"`); the panel shows all. `null` resources → no chips.
- Card icon: lucide icon of the first topic's family: identity `UserRound`, governance `ScrollText`, security `ShieldCheck`,
  networking `Network`, monitoring `Activity`, continuity `ArchiveRestore`, storage `HardDrive`, data `Database`, messaging
  `MessagesSquare`, containers `Container`, compute `Server`; no topic `FlaskConical` (V: each exists in lucide-react 1.50.0).
  Decorative (`aria-hidden`), `color: var(--blue-bright)`.
- `resourceSummary(resources)`: `{ kind, label, count, icon }[]`, asset kinds by `KINDS.order`, then group kinds (`vnet`,
  `subnet`, `virtualHub`, `resourceGroup`) by order; `generic` last as "Other resources"; `label` is `KINDS[k].word` for 1,
  `plural` otherwise; `icon` is `KINDS[k].icon`. The panel shows the first **6** as tiles (sprite icon, label, "×N" when N > 1)
  and "+N more: see the diagram" (link to `/labs/:id?view=diagram`) when there are more. `null` → "Resource list unavailable".
- Every one of the 43 planned graphs gives at least one topic and one resource (test on the real catalogue).
- Search matches topic words.

## 8. Components

All new files in `web/src/views/labs/` with one `.css` per component; tokens only.

### 8.1 LabsSummaryStrip

One row (`<section aria-label="Labs summary">`, a list), `--bg-panel`, 1 px `--border`, `--radius-panel`, items split by
dividers; wraps on narrow screens:

- **Learning path**: the exam filter, else "All exams"; "N of M labs run": M = labs in that exam (tagged ones included), N =
  those with `runs > 0` (sessions of 15 minutes or more, the coverage rule). Title "A lab counts once it has run for 15
  minutes or more". Link "Coverage" → `/labs/history`. No progress bar (Appendix A).
- **Running**: "{running.length} of {maxRunning} running" (live sessions: deploying, running, failed, tearing down), amber
  with "limit reached" when equal; muted "· {slots.used} of {slots.total} address slots" at ≥ 1200 px.
- **Auto-cleanup on** (icon `Recycle`) only when `autoCleanup` (ruling 7); title "Checked every 5 minutes: each lab is torn
  down at its timer or hard stop."
- Loading: three Skeleton text pills; never a placeholder number.

### 8.2 Notices and LabsSetupBanner

- **LabsSetupBanner** when `setupAffected(cards)` (blockers role or graph) is non-empty: amber-accented surface
  (`color-mix(in srgb, var(--amber) 12%, var(--bg-panel))`, border 45 %, text `--text-primary`, icon `--amber`), heading "Some
  labs need additional Azure permissions.", "{N} of {total} labs are affected." (N counts the whole catalogue, never the
  filtered view), "Last checked {fmtWhen(checkedAt)}" or "Permissions have never been checked.", `permissions.message` when
  present, **Complete setup** (secondary button link to `/settings/labs`) and a **Hide** icon button (hides it for this page
  visit; no storage).
- **GitHub notice** when any card has a `github` blocker: "Labs can't be deployed: GitHub is not connected." + "Open the setup
  checklist" (`/settings/overview`).
- **Budget notice** when any card has a `budget` blocker: the blocker's sentence + "Review the budget".
- Cards never repeat these paragraphs: affected cards show only their badge; the panel explains (§8.5).

### 8.3 LabsFilterToolbar

`<form role="search" aria-label="Filter labs">`, one wrapping row: SearchInput "Find a lab" (title, id, "Lab N", summary,
objective, topics; case-insensitive; trimmed); exam SegmentedControl (All, AZ-104, AZ-305, AZ-700); Select "All skill areas"
(areas of the labs the exam keeps, official names from coverage, as today); Select "All difficulties" / Foundation / Associate
/ Expert; Switch "Ready to run only"; **More filters** (Radix Popover; trigger shows a count when active): Type chips (Explore,
Break-fix, multi) and Switch "Not run yet". Below: "Showing N of M labs" (`aria-live="polite"`) and **Clear filters** when any
filter or search is active.

Phone: SearchInput + **Filters (n)** button opening a `Sheet` with every control, "Clear" and "Show N labs".

URL (all `replace`, other params kept): `q`, `exam`, `area`, `level` (single), `type` (comma list), `notrun=1`, `ready=1`.
Search writes after 250 ms idle; the input keeps local text and only re-syncs from the URL when the URL changes to a value it
did not write (Back, Clear filters), so typing never jumps.

Empty result: EmptyState "No labs match these filters" + Clear filters; with "Ready to run only" on, the description adds "{K}
labs are hidden because they aren't ready to run."

### 8.4 LabCatalogueGrid and LabCard

Grid: `<ul class="lab-grid" aria-label="Labs">`, lab number order (ruling 13), all filters combined (AND). Columns by
container query on `.labs-workspace__main` (`container-type: inline-size`): 3 at ≥ 872 px (3 × 280 + 2 × 16), 2 at ≥ 576 px,
else 1; `gap: 16px`.

Card (`<li><article class="lab-card" data-lab-card={id}>`), `display: flex; flex-direction: column`, padding 20 px, radius
12 px, 1 px `--border`, `--bg-panel`, shadow at most `0 1px 2px color-mix(in srgb, var(--text-primary) 6%, transparent)`:

1. Eyebrow row: "Lab {number} · {exam}" (+ "also AZ-700" when tagged) and the status badge (§6.3).
2. Topic icon (28 px, §7).
3. Title `<h3>` containing the **select button** (full title text, never truncated; `::after` stretched over the card for the
   pointer; `aria-current="true"` when selected; accessible name "{title}, View lab").
4. Objective (`learning.objective`, else the first sentence of `summary`); never clamped.
5. Topic chips (≤ 3 + "+N").
6. Meta: clock + learning time ("45 min", `aria-label="Learning time 45 minutes"`; omitted when `learning` is null), coins + cost
   (§11 short form; tooltip with the precise rate, and "Pricey: {item}, about £x/h" when `pricey`).
7. `.lab-card__footer { margin-top: auto; padding-top: 16px }`: the card action (§6.3), full width. For ready / setup /
   unavailable cards it is the visual twin of the select button (`aria-hidden`, `tabIndex -1`, the stretched title button
   takes the click), so the card has one tab stop; session actions are real buttons (links) above the stretched area.

Selected: border `--blue-bright` plus `box-shadow: inset 0 0 0 1px var(--blue-bright)` (no size change), and visually hidden
"Selected". Hover: border `--border-strong`. Focus: the shared focus ring on the button, `:focus-within` ring on the card.
Equal heights per row (grid stretch); skeleton cards have the same min-height (V: measured from a real card, about 250 px).
`LabCard` is `memo` and receives only the card, its derived view (readiness, status, topics) and `selected`.

### 8.5 LabDetailsPanel (and LabPrerequisites, LabResourceSummary, LabLaunchAction)

Wide: `<aside class="labs-details" aria-labelledby>`, `position: sticky; top: 0; max-height: calc(100dvh - var(--bar-height) -
28px); overflow-y: auto` inside `#main`. Content:

1. "Lab {number} · {exams}" and the id in mono; title `<h2>`; status badge.
2. **LabLaunchAction**: the primary action (§6.3, full width, primary) and, for setup-required / unavailable, the blocker
   sentences (one per blocker, each with its fix link); then secondary links **Lab guide** and **Diagram**.
3. **Objective**; **What you will learn** (3 items, check icon `--green`, text `--text-primary`). Without learning content:
   the summary paragraph, and the section is left out (never placeholder text).
4. **Resources deployed** (LabResourceSummary, §7) and all topic chips.
5. Facts (KeyValue-style, three columns on wide): Learning time · Deploy time ("about {deployMin} min"; "measured {m} min {s}
   s" from `lastReleaseTest.deploySeconds` when it tested the current version) · Estimated cost (precise, §11). Then: Session
   ("{sessionH} h, extendable to {maxH} h"), Destination (the region from `LabDetail.defaults.region`, Skeleton text until it
   loads), Level, Type, Peering (Off / Optional / Required), Release test ("Untested v{version}" when not released).
6. **LabPrerequisites**: "Recommended first:" each prerequisite by "Lab {n}: {title}", a link that selects it
   (`?lab=<id>`); "None". Ruling 5.
7. History: "Run {runs}×, last {fmtWhen(lastSession.endedAt)}" or "Not run yet".
8. **Session and cleanup**: "Ends by itself after {sessionH} h unless you extend it (never past {maxH} h). Then everything in
   `rg-lab-<id>` is torn down and a clean check looks for leftovers; anything found is flagged on this page. Azure can take a
   day to bill the last hour." Without `autoCleanup`: "Automatic tear-down needs GitHub connected: tear the lab down yourself."
   Never "£0 guaranteed".
9. Deploy checks from `useLab(id)` once loaded: `Warnings` (budget, capacity, pricey, slow) compact. Loading: Skeleton lines;
   error: a small inline ErrorState "Couldn't load the deploy checks" with Retry; the card-based content stays.

Tablet: the same content in `Drawer side="right"` (title, subtitle, footer = LabLaunchAction). Phone: the same content as a
full-width view replacing the grid, with "Back to labs" at the top (focus moves to its heading on entry).

## 9. Layout and URL state

| Width | Catalogue | Details |
|---|---|---|
| ≥ 1200 px (wide) | `.labs-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 20px; align-items: start }`; 3 columns at 1366 and 1600, 2 at 1200–1279 | inline sticky panel, always showing a lab |
| 641–1199 px (tablet) | full-width grid, 3 columns at 1024, 2 at 820 | `?lab` opens `Drawer side="right"` |
| ≤ 640 px (phone) | 1 column, filter sheet | `?lab` shows the full-width detail view |

`useLabsLayout()` (`web/src/views/labs/layout.ts`): `"wide" | "tablet" | "phone"` from `matchMedia("(min-width: 1200px)")` and
`useIsPhone()`, `useSyncExternalStore`, server snapshot `"wide"`.

Selection (`selectedLab(visibleIds, urlLab, layout, knownIds)`, pure):

- Wide: `urlLab` when it is visible; otherwise the **first visible** lab (implicit, never written to the URL). When `urlLab`
  names a known lab that the filters hide, one effect removes `lab` (`replace`) so the URL matches what is shown; it only
  ever removes, so it cannot loop. Selecting a card writes `lab` with `replace`.
- Tablet / phone: no implicit selection. Activating a card writes `lab` with **push** (Back closes the drawer or view); the
  drawer and view show `urlLab` regardless of filters.
- An unknown `urlLab` (old link): removed with `replace` and one toast "Lab {id} isn't in the catalogue."
- `/labs/:id` (the dialog) implies selection on wide. Opening it from the panel keeps `lab` (wide) and drops it on tablet and
  phone, so closing the dialog returns to the catalogue with that lab's card focused (§10).

## 10. Accessibility

- Status always word + colour (StatusPill). Buttons and links say what they do ("Start lab", "Complete setup").
- Keyboard: Tab order header → strip links → notices → toolbar → cards (one stop each, two for session cards) → panel. A
  "Skip to lab details" link (visible on focus) precedes the grid on wide. Selecting by keyboard leaves focus on the card;
  a polite live region says "Showing Lab {n}, {title}".
- Drawer (tablet): Radix focus trap; it stays mounted with `open` driven by the URL, so closing by Escape, X, backdrop or Back
  all run Radix's close path and focus returns to the card that opened it.
- Dialog (`/labs/:id`) close: wide → focus returns to the panel's action (default); tablet / phone → focus the lab's card
  select button (`[data-lab-card=<id>]`), via `onCloseAutoFocus`.
- Phone detail view: heading focused on entry; Back focuses the card.
- Visible focus everywhere (`--focus-ring`); no hover-only information (tooltips also on focus).
- Reduced motion: no card hover transition, no drawer slide, no skeleton shimmer (existing base rule).

## 11. Cost and time words (`web/src/views/labs/money.ts`, pure)

- `fmtHourlyShort(x)` (cards): not a finite number ≥ 0 → "Estimate unavailable"; x < 0.01 (0 included) → "< £0.01/hour"
  (`aria-label` "under 1p an hour"); else `£x.toFixed(2)/hour`. Never "£0.00/hour".
- `fmtHourlyPrecise(x)` (panel, tooltip): invalid → "Estimate unavailable"; 0 → "No hourly charge at list price"; 0 < x <
  0.00005 → "< £0.0001/hour"; else `fmtGbp(x)/hour` (£0.0082, £0.042, £0.42). Never a nonzero rounded to zero.
- `fmtSessionCost(x, hours)`: "about £0.05 for 2 h"; under 1p and nonzero → "under £0.01 for 2 h"; invalid → "Estimate
  unavailable".
- `fmtMinutes(n)`: "45 min", "1 h 15 min", "2 h".
- Learning time, deploy time, session length and hourly cost are always labelled as such; never one figure for two.

## 12. States

- **Loading** (no data): header, strip skeleton, toolbar (usable), 6 skeleton cards (3 on the phone), panel skeleton.
  `aria-busy` on the workspace.
- **Error** (no data): ErrorState "Couldn't load the labs" with the API message and Retry; header stays.
- **Stale** (data and a failed refetch): StaleBanner above the toolbar "Couldn't refresh the labs; showing them as of
  {time}." Badges stay (they are real, old data).
- **Empty catalogue**: EmptyState "No labs in the catalogue yet".
- **No matches**: §8.3.
- **Unavailable**: per-card blockers (badge + panel), page notices (§8.2).
- **Deploy checks loading or failed**: §8.5 item 9.

## 13. Launch flow

1. Start lab (panel / drawer / phone view) → `/labs/:id` → today's idle dialog: readme and Diagram tabs, cost table, session
   length, peering, region, warnings, Deploy or Deploy anyway. This is the existing confirmation; it shows session duration,
   cost and deployment destination.
2. `useDeployForm.submit`: a `useRef` latch set before `mutate`, cleared on settle; the button is disabled and loading while
   pending **and** after success until `LabDetail.session` appears ("Starting the deploy…" status), so a second submit is
   impossible; the Worker's lab lock still answers 409 to anything else.
3. Progress at once: on success the dialog switches to the running view (deploy steps, live log) as soon as the lab refetches;
   the card and strip show "Deploying" from the same refetch.
4. Errors stay actionable: the toast (as today) plus an inline `role="alert"` line in the form with the server's sentence;
   `useDeployLab` gains `invalidateOnError: ["labs"]` so the blockers and warnings refresh, and the form then shows the
   structured reason with its fix link (permissions → Complete setup; capacity / slots / limit → its words and link; budget →
   Review the budget; GitHub → setup checklist; 422 confirm_required → the warnings with Deploy anyway).

## 14. Testing

- Scripts (node:test): learning rules (each rule's refusal; a good file; missing tolerated by build, refused with
  `requireLearning`; unknown id); resources counted from a planned graph (lanes, gateway and folded not counted; outside
  counted; missing file → absent); schema 2; `_learning` invisible to `versionProblems` and `labFolders`; shots route flag.
- Content (node:test on the real repo): every catalogue lab has a valid learning file; exactly 3 bullets; lengths; no file
  without a lab.
- Worker (vitest): `blockersOf` order and sentences; `unavailableReason` unchanged; leftovers and budget blockers; budget read
  failure adds none; never-checked and failed permissions are blockers; `autoCleanup` follows `canDispatch`; cards carry
  learning and resources; GET /labs shape.
- App (vitest + RTL): readiness and session tables row by row; badges and actions; banner count across the whole catalogue
  with a filter on; GitHub and budget notices separate from the banner; selecting a card never calls the deploy API; filters
  and URL round-trip; search; first-visible selection and its removal effect (no loop: a bounded navigate count); unknown
  `?lab`; layouts at 1600, 1024 and 390 (matchMedia mocked); drawer focus trap and restore; dialog close focus; duplicate
  submit (two synchronous clicks, one POST); errors inline; money words (0, 0.00004, 0.0001, 0.0099, 0.01, NaN); topics and
  resources for all 43 real planned graphs; skeleton / empty / error / stale; reduced motion class.
- Shots (§15).

## 15. Screens

`npm run shots` against the dev server, scenarios `labs` and `labs-setup` (new: the labs story with role, users and groups
failed, so the 9 labs that need them show Setup required), routes `/labs`, `/labs?lab=az104-02-policy`,
`/labs?exam=AZ-305&ready=1`, `/labs/history`, sizes 1600×900, 1366×768, 1280×800, 1024×768, 820×1180, 390×844, dark and
light. A dev `.env` copy sets a placeholder `GITHUB_TOKEN` (not `REPLACE_ME`) so labs are deployable in the pictures; one run
without it shows the GitHub notice. Nothing is ever deployed. Other pages: `shots:diff` against `main` shows zero differing
pixels.

## 16. Bundle and performance

All new UI is in the lazy labs chunk; the entry gains only the Drawer `right` variant and one mutation option. Budgets
unchanged: entry ≤ 320 kB, all JS ≤ 450 kB (500 kB since 2026-10-10, approved by Steven), CSS ≤ 50 kB gzip. 43 labs: derived views (`readiness`, `status`, `topics`,
search text) computed once per data change (`useMemo`), filtering is a linear pass, cards memoised so a selection change
re-renders two cards. The panel's deploy checks are one `GET /labs/:id` per selected lab (cached by TanStack Query).

## 17. Risks

- A blocker kind the app does not know (a later Worker): treated as `unavailable` with the server's sentence.
- Readiness drifting from `deployLab`: both read `blockersOf`; a worker test asserts that a lab with any blocker is refused by
  `deployLab` with the same first sentence.
- Learning content inaccurate: fresh review against each readme (plan A3); content is outside lab folders, so fixing it is a
  plain commit.

---

## Appendix A: Steven's brief and decisions (verbatim, 2026-10-07)

# Steven's brief: Labs catalogue redesign (2026-10-07)

Mockup image: C:\Users\steven\AppData\Local\Temp\claude\C--cloudflare-projects-wireguard\5333bc59-803f-40f1-b29e-87c3f9af6150\images\2.png

Steven's own guidance (verbatim intent):
"Implement Labs as an extension of the existing dashboard design system. Reuse the shared AppShell, PageHeader, Panel, StatusBadge, buttons, filters, drawers and spacing tokens. Support the application's existing light and dark themes through semantic colour tokens; do not hard-code the light mockup palette. Express the catalogue and detail-panel layout within the existing responsive grid system. Keep typography, radii, focus states, notifications and deployment-progress behaviour consistent with the other views."

## Decisions Steven made (override the brief where they conflict)
- NO learning-completion feature: no "Completed" badge, no progress bar, no "View results". The summary strip shows real counts from history/sessions instead (e.g. labs run, running now) and cleanup status.
- AUTHOR for all 43 labs: an `objective` (one sentence), exactly 3 "What you will learn" bullets, and `learning_min` (learning time, distinct from deploy time and session length) — written from each lab's readme and exam outline, checked by tests. Store OUTSIDE the lab folders (e.g. labs/learning/<id>.yaml or one labs/learning.yaml) so no lab version bumps / re-release-tests are needed; catalogue build merges it in.
- Exam selector: All / AZ-104 / AZ-305 / AZ-700 (multi-exam tagged labs appear under each of their exams).
- Topic chips and "Resources deployed" come from each lab's planned topology (shared/topology/planned/<id>.json) — real data.
- Autonomy: spec, plan, build, review, screenshots, merge and deploy without stopping.

## The brief (Steven-supplied)
Redesign the existing Labs catalogue to match the supplied mockup. Preserve the existing lab definitions, deployment APIs, permission checks, prerequisites, session limits and cleanup behaviour. Use the existing frontend stack and shared design-system components. The goal is to make choosing a lab, understanding its readiness and starting it immediately obvious.

1. Page structure — replace the full-height filters sidebar and oversized enclosing catalogue panel with: page heading and Catalogue / Your labs tabs; compact learning-progress and operational-status strip; one consolidated permissions banner when required; horizontal search and filter toolbar; responsive catalogue grid with a selected-lab detail panel. Keep the existing global navigation. Light theme per mockup (pale grey page, white surfaces, navy text, blue primary, green readiness, amber setup) — BUT via semantic tokens supporting light and dark.

2. Responsive layout — wide desktop two-part workspace: `.labs-workspace { display:grid; grid-template-columns: minmax(0,1fr) 400px; gap:20px; align-items:start }`, `.lab-grid { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:16px }` as starting values; reduce to two columns when cards would be < ~280px. Tablet: details in a slide-over drawer. Mobile: one card column, a filter sheet, full-width detail view. Detail panel may be sticky below the app header. Avoid fixed page heights and large blank enclosing panels.

3. Header and summary strip — Header: "Azure Labs", brief description, Catalogue / Your labs segmented navigation. Summary strip: selected learning path (e.g. AZ-104), [completion — NOT built per Steven], running lab count, cleanup status. Display "Auto-cleanup enabled" only when confirmed by backend configuration.

4. Consolidated setup banner — remove repeated red permission paragraphs from cards. When permissions block one or more labs, one amber banner "Some labs require additional Azure permissions." with the affected lab count and a "Complete setup" action linking to the existing setup workflow. Affected cards show a compact "Setup required" badge; their detail panel explains the exact missing permission and the setup action. Do not suppress distinct deployment failures or other errors inside this generic banner.

5. Search and filters — compact toolbar above the catalogue: search by lab name, description or topic; exam selector; skill-area dropdown; difficulty dropdown; "Ready to run only" toggle; "More filters" menu for existing filters that don't fit (preserve Explore / Break-fix and Not run yet). Combine filters consistently; result count and "Clear filters" when active; useful empty state.

6. Catalogue cards — anatomy: actual lab identifier and status badge; topic icon; strong title; concise learning objective; small topic chips; duration and estimated cost; clearly labelled footer action. ~20px padding, 12px radius, subtle border, minimal shadow; readable titles; don't truncate every description to a fragment. `.lab-card{display:flex;flex-direction:column}` `.lab-card__footer{margin-top:auto;padding-top:16px}`. Actions: Ready → View lab; Setup required → Review setup; Running → Open session; Deploying → View progress. (Previously completed / View results — not built.) View lab selects the card and opens details; it must NOT start deployment. Selected card: subtle blue border + accessible selected state.

7. Readiness vs session states — keep separate. `type LabReadiness = "checking"|"ready"|"setup-required"|"prerequisite-required"|"unavailable"`; `type LabSessionState = "none"|"deploying"|"running"|"destroying"|"failed"`. Map to existing domain models; don't replace backend semantics. Every status needs text as well as colour. Unknown or failed permission checks must not appear as Ready.

8. Selected-lab details — without navigating away: lab identifier and title; readiness badge; primary action; objective; what you will learn; resources deployed; learning duration; estimated deployment time; estimated cost; prerequisites; session expiry and cleanup explanation. Primary action: Start lab when ready; Complete setup when permissions missing; View prerequisite when a prerequisite blocks starting; Open session when running; View progress while deploying. Prerequisites by meaningful title with a link to that lab; preserve mandatory vs recommended. Before starting, present session duration, estimated cost and deployment destination; reuse existing launch confirmation. Disable duplicate launch submissions, display progress immediately, preserve actionable errors.

9. Cost and duration — distinguish learning time, deployment time, session lifetime, estimated hourly cost. Small positive costs < £0.01/hour show "< £0.01/hour" on cards; precise estimate in details or tooltip. Never round nonzero to "£0.00/hour". Missing estimates: "Estimate unavailable". Don't promise zero residual cost unless cleanup guarantees it.

10. Interaction and accessibility — search/filter changes preserve the selected lab where possible; on desktop select the first visible lab initially, and if filtering removes it select the first remaining result; filters and selected lab in URL state; keyboard navigation for cards and actions; visible focus; accessible labels; drawer focus management and restore; skeletons on initial load; separate loading/empty/error/unavailable states; respect reduced motion; never use placeholder values as live status.

11. Mockup corrections — "Lab 01" labels become real identifiers; banner count matches actual affected labs; topics, resource lists, durations and estimates from each lab definition; no unsupported features just to match the screenshot.

12. Suggested components — LabsPage, LabsHeader, LabsSummaryStrip, LabsSetupBanner, LabsFilterToolbar, LabCatalogueGrid, LabCard, LabStatusBadge, LabDetailsPanel, LabPrerequisites, LabResourceSummary, LabLaunchAction. Reuse existing components where possible.

Acceptance criteria: no full-height filters sidebar or giant wrapper; cards readable at wide desktop, laptop, tablet, mobile; every lab has an obvious next action; repeated permission warnings replaced by one banner; selecting a lab reveals details without deploying; readiness, completion and session state distinct; existing filters and operational capabilities preserved; launch failures, missing permissions and capacity limits get useful feedback; all counts, costs and statuses real; keyboard navigation and responsive detail panel work throughout.

Earlier guidance alignment (Steven's note): Labs follows the six-view redesign principles (clear hierarchy, reusable components, progressive disclosure, contextual details, responsive layouts, real operational state); details drawers preserve page context; explicit loading/error/stale/unknown states; selecting a card never launches a lab; compose existing primitives; shared theme tokens.
