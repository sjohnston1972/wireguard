# Redesign plan 3: app foundation (project, design system, shell, data layer, dev tools)

> **For agentic workers:** step P1 (the scaffold) is built first, by one implementer. Then three areas (P2 components, P3 data layer and shell behaviour, P4 dev seeder and screenshot harness) run in parallel worktrees branched from P1's result. Each follows superpowers:test-driven-development. The visual target is binding: look at the mockups before writing UI code (see below).

**Goal:** a React + TypeScript app in `web/`, styled exactly like Steven's mockups, with the app shell (top bar, navigation, command palette, phone tab bar), a tested shared component library, a typed data layer over `/api/v1`, and the local tools to see and screenshot it with realistic data. Plan 4 then builds the six views on top.

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md`. Sections 2 ("Visual target"), 3, 7, 9 and 10 govern this plan.

**Visual target (binding):** `C:\cloudflare_projects\wireguard\redesign\screenshots\ChatGPT Image Oct 2, 2026, *.png`, six files: Overview, Clients, Firewall, Activity, Cost, Settings. They are local only (not in git); open them by that absolute path with the Read tool. The six `image(2026...).png` files beside them are the OLD dashboard: do not copy them.

## Global Constraints

- **Stack:** React 19, TypeScript, Vite, React Router, TanStack Query, Radix UI primitives (Dialog, DropdownMenu, Tabs, Tooltip, Popover, Switch, Toast), cmdk, uPlot, lucide-react, `@fontsource-variable/inter`, `@fontsource/jetbrains-mono`. Use plain CSS with custom properties: one `.css` file per component, imported by it. No CSS framework, no CSS-in-JS.
- **Location:** everything new lives in `web/`. The Worker and its old pages are not touched in this plan, except the dev seeder in P4.
- **Build output:** `web/dist/`. It is not served by the Worker yet; switch-over (plan 5) points the Worker's assets there.
- **Dev:**
  - `npm run dev:web` starts Vite on port 5173, proxying `/api` and `/captures` to `http://127.0.0.1:8787`.
  - `npm run dev:api` starts `wrangler dev --port 8787 --local-upstream localhost:9`. The flag is needed so the localhost login bypass works.
  - Both read the existing `.dev.vars` flow (see `scripts/dev.mjs`).
- **Scripts:**
  - `npm test` runs the Worker tests (node) **and** the web tests (jsdom) through Vitest projects.
  - `npm run typecheck` checks the Worker (`tsconfig.json`) **and** the app (`web/tsconfig.json`).
  - `npm run build:web` builds the app.
  - Gate for every area: all three pass.
- **Design tokens:** the measured mockup values, defined once in `web/src/styles/tokens.css` as custom properties. The light theme redefines the same names; the theme follows the OS, with a manual override stored in `localStorage` (wrapped in try/catch).
  ```css
  --bg-app: #08111c; --bg-bar: #091524; --bg-panel: #0c1b29; --bg-tile: #112033; --bg-elevated: #13243a;
  --border: #162639; --border-strong: #22364d;
  --text-primary: #f2f6fb; --text-secondary: #a9b8cc; --text-muted: #6b7c93;
  --blue: #3776fb; --blue-bright: #4f8cff; --green: #34cf89; --amber: #f59e0b; --red: #ef4444; --purple: #9263f8;
  --radius-control: 8px; --radius-panel: 14px; --gap: 12px;
  ```
  - Check every text-on-background pair you use for WCAG AA. `--text-muted` is for non-essential text only.
  - Fonts: Inter (UI), JetBrains Mono (addresses, keys, logs).
- **Status:** green healthy, amber busy or degraded, red failed or down, grey unknown. Always paired with a word or an icon.
- **Accessibility:**
  - every control works by keyboard, with a visible focus ring;
  - Radix handles focus trapping and restoring;
  - reduced motion is respected;
  - every chart has an accessible name and a text summary.
- **Data:** never invent numbers. Missing data renders as "no data". Every panel that shows live data shows its age.
- **Tests:** Vitest + React Testing Library + jsdom for components and hooks; jsdom `fetch` is mocked through a small helper. Component tests assert behaviour (roles, labels, keyboard), not CSS.
- **Commits** end with `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`. Push your branch. No PR, no merge, no deploy.

---

## P1: Scaffold (first, one implementer)

**Branch:** `feat/web-scaffold` from `redesign`.

**Builds:**
- `web/` with `index.html`, `src/main.tsx` and `src/App.tsx`. Router routes for `/`, `/clients`, `/clients/:id`, `/firewall`, `/firewall/rules/:id`, `/activity`, `/activity/runs/:id`, `/cost` and `/settings/:section?`.
- Each view is a placeholder page showing its title and the text "Built in plan 4", inside the shell layout.
- `web/tsconfig.json` (DOM, `react-jsx`, strict), `web/vite.config.ts` (React plugin, the proxy above, `build.outDir = "dist"`) and `web/vitest.config.ts` (jsdom).
- Root `vitest.config.ts` turned into Vitest projects (worker = node, as today; web = jsdom). The root `package.json` gets the scripts above and the dependencies.
- `web/src/styles/tokens.css`, `base.css` (reset, body, focus ring, scrollbars) and `themes.css` (light theme and the `data-theme` override).
- Fonts imported in `main.tsx`.
- **A minimal shell:**
  - `AppShell`: the top bar with the wordmark and its status dot, the six tabs with the active underline (as in the mockups), and placeholder slots for search, the region chip, the theme toggle and the account menu.
  - The page area.
  - A phone bottom tab bar below 640 px.
  - The shell's styling matches the mockups' top bar.
- **Tests:** the shell renders the six tabs with the right one marked current for each route, and a keyboard user can reach them.

**CI:** the repo's CI workflow under `.github/workflows/` (the job named "typecheck + tests") also runs `npm run build:web`. Its `npm test` and `npm run typecheck` steps pick up the web tests and the app typecheck automatically through the scripts above.

**Done when:** `npm test`, `npm run typecheck` and `npm run build:web` pass, and `npm run dev:web` shows the shell with a placeholder for each route.

---

## P2: Component library (parallel, after P1)

**Branch:** `feat/web-components` from `feat/web-scaffold`. **Owns:** `web/src/components/**` and its tests.

**Builds:** each component gets its own `.tsx`, `.css` and test file, following the mockups closely. Open each mockup and match spacing, sizes, corner radii, icon placement and typography.

- **Layout:**
  - `Panel`: a title row with an optional status pill and right-hand actions, then the body; variants for padded and flush.
  - `PageHeader`: title, subtitle, and context on the right.
  - `Grid`: the 12 columns.
  - `Drawer`: right side, about 420 px; becomes a bottom `Sheet` below 640 px; focus-managed.
  - `Modal`.
  - `Tabs`: the underline tabs and the pill tabs from the mockups.
- **Data display:**
  - `MetricTile`: icon, label, value, sub-text, optional delta (▲/▼ with colour), optional sparkline, progress bar or ring; status colour.
  - `StatusPill`: online, offline, running, success, failure, allow, deny and similar, each with a dot.
  - `DataTable`: sticky header, sortable columns, row click, keyboard row focus, empty/loading/error slots, optional row actions menu.
  - `Sparkline`: an inline SVG.
  - `TimeSeriesChart`: uPlot; in/out series, area fill, hover readout, a range prop.
  - `BarChart`: daily bars with a budget line and a dashed forecast.
  - `StackedBars`: the activity timeline, with a brush selection callback.
  - `Donut` and `Ring`: SVG.
  - `ProgressBar`.
  - `StepList`: the deployment pipeline (done/running/pending/failed/skipped icons, durations, times).
  - `LogView`: monospace, a severity tag per line, search, auto-scroll toggle with a "new lines" marker, copy line.
  - `KeyValue` list with `CopyButton`.
  - `Diff`: before/after lines.
  - `DataAge`: "updated 8 s ago", stale styling.
- **Forms:** `Button` (primary, secondary, danger, ghost; sizes), `IconButton`, `Select` (Radix), `Switch`, `Chips` (day pills, duration chips), `SegmentedControl` (Live/1h/24h/7d/30d), `SearchInput` (with a shortcut hint), `Field` (label, hint, error), `ConfirmByTyping`.
- **Feedback:** `Toast` (Radix), `Skeleton` (shape-matched), `EmptyState`, `ErrorState` (with Retry), `StaleBanner`.
- **Gallery:** `web/src/gallery.tsx`, a dev-only route `/__gallery` (registered only in development) showing every component in every state. Used by P4's screenshots and by the reviewer.

**Tests:** every interactive component is tested for keyboard use and accessible names; `Drawer` and `Modal` for focus trapping and restoring; `LogView` for auto-scroll pausing when scrolled up and the "new lines" marker; `DataTable` for sort and keyboard row selection; charts for rendering their accessible summary with data and "no data" without.

---

## P3: Data layer and shell behaviour (parallel, after P1)

**Branch:** `feat/web-data` from `feat/web-scaffold`. **Owns:** `web/src/api/**`, `web/src/shell/**` (the shell's behaviour; P2 owns the generic components), and their tests.

**Builds:**
- **`web/src/api/client.ts`:** `apiGet<T>(path)` and `apiSend<T>(method, path, body?)`.
  - Requests are same-origin with credentials and `redirect: "manual"`.
  - Bodies are JSON with `Content-Type: application/json`; an absent body sends nothing.
  - `ApiError` carries status, code, message and field from the API's error shape.
  - **Session expired:** `SessionExpiredError` is raised on an opaque redirect (Access redirecting at its edge, before the Worker runs), on a 401, or on a non-JSON answer to an API call.
  - **Disconnected:** `NetworkError` is raised on a fetch failure.
  - Types come from `shared/api.ts`, through a path alias `@shared/*` to the repo's `shared/`, in `web/tsconfig.json` and the Vite config.
- **`web/src/api/queries.ts`:** TanStack Query hooks for every read endpoint in `shared/api.ts` (session, overview, history, clients, client, firewall, activity, run, run log, cost, settings, push status).
  - **Refresh intervals, per spec section 10:** overview, clients and firewall every 15 s, and every 5 s while the overview shows a run or power operation in progress; activity every 30 s; cost and settings every 60 s; history on range change and every 60 s.
  - Polling pauses while the tab is hidden. Retries use backoff, never for 4xx errors.
- **`web/src/api/mutations.ts`:**
  - a hook per write endpoint;
  - toasts for success, failure and `warning`;
  - invalidation of the affected queries;
  - submit disabled while pending;
  - a field-level error mapped from `field`.
- **`web/src/shell/`:**
  - the connection indicator (live / stale / disconnected, driven by query states) and a disconnected banner;
  - a "Session expired, sign in again" screen;
  - the account menu (email from `/session`, theme toggle, sign out via Access's `/cdn-cgi/access/logout`);
  - the state chip in the top bar ("Running · UK South · tears down in 3h 12m" / "Destroyed · £0"), from `/overview`;
  - the read-only "Production" environment label;
  - the unread watchman notes indicator.
- **Command palette (cmdk):**
  - **Opening:** Ctrl/Cmd+K, plus the search icon on the phone.
  - **Navigation:** tabs, Settings sections, clients by name or IP (from `/clients`), firewall rules by name (from `/firewall`), latest run.
  - **Actions:** they only navigate to the view with an action parameter (for example `/?action=deploy`, `/clients?action=add`). Plan 4's views open the reviewed form from it. Nothing runs from the palette.

**Tests:**
- the client's error mapping (`ApiError` fields, the session-expired cases including an opaque redirect, network errors);
- polling intervals switch to 5 s when a run is in progress;
- a mutation shows its toast and invalidates its queries;
- a `warning` shows as a warning toast;
- the palette is keyboard driven, lists clients from mocked data, and never calls a write endpoint on select;
- the connection indicator states.

---

## P4: Dev seeder and screenshot harness (parallel, after P1)

**Branch:** `feat/web-devtools` from `feat/web-scaffold`. **Owns:** `worker/src/devseed.ts` (new), its mount in `worker/src/index.ts` (one guarded route), `scripts/seed-scenarios.mjs` (new), `scripts/shots.mjs` (new), `worker/test/devseed.test.ts` (new).

**Builds:**
- **`worker/src/devseed.ts`:** `POST /__dev/seed?scenario=<name>`. It is served **only** when `env.AUTH_DEV_BYPASS === "1"` and the request host is localhost, the same guard as the login bypass in `auth.ts`; anywhere else it answers 404, as if it did not exist.
- **Scenarios**, each replacing D1 data and the snapshot with realistic values that match the mockups' data style:
  - **`empty`:** no clients, destroyed.
  - **`destroyed`:** 4 clients including the home site, with 7 days of history from earlier sessions.
  - **`deploying`:** a run in progress with steps and a log tail.
  - **`running`:** clients online and offline, latency and traffic history for 7 days, firewall counters and drops, captures, a speed test, budget at 40 %.
  - **`failed`.**
  - **`standby`.**
  - **`busy-month`:** 30 days of runs, notes, changes and cost days.

  Data is generated deterministically from a fixed seed. Use the real tables and the real write functions where they exist (for example `recordHeartbeat` for history), so the seeded data has exactly the shape production writes.
- **`scripts/seed-scenarios.mjs <scenario>`:** calls the endpoint on the local dev server.
- **`scripts/shots.mjs`:**
  - **Setup:** launches headless Edge (or Chrome) with `--remote-debugging-port`, then drives it over the Chrome DevTools Protocol using Node's built-in `WebSocket`. Use `Emulation.setDeviceMetricsOverride` for the phone width, because headless windows will not go below about 500 px.
  - **What it shoots:** every route (and `/__gallery`) at 1600 × 900, 1100 × 700 and 390 × 844, in dark and light, into `.superpowers/shots/<date>/` (git-ignored).
  - **What it reports:** for each desktop shot, `document.documentElement.scrollHeight - innerHeight`. The one-screen rule is that this must be 0 at 1100 × 600 and larger, and the script exits non-zero when it is not.
  - **Options:** a `--scenario` flag that seeds first.

**Tests:**
- the seed route is 404 without the bypass, 404 on a non-localhost host, and 200 with both;
- each scenario leaves the API answering with consistent data (for example `running` gives `/api/v1/overview` the state `running` with clients online; `busy-month` gives `/api/v1/activity?range=30d` a non-empty timeline);
- `scripts/shots.mjs` has a `--dry-run` that lists the shots it would take, which is tested.

---

## Integration

1. Merge P2, P3 and P4 into `feat/web-scaffold`, giving `feat/web-foundation`.
2. Run the gate: `npm test`, `npm run typecheck`, `npm run build:web`.
3. Run the screenshot harness on the `running` scenario and compare the shell and gallery against the mockups.
4. A fresh whole-branch review on the most capable model, given the mockups, then one fix pass with failing tests first.
5. A PR into `redesign` with CI green (CI must also run the web tests and `build:web`), then merge.

## Review Focus

1. **Fidelity to the mockups:** palette, density, type sizes, the top bar, tiles and tables should look like the mockups, not like a generic dashboard kit.
2. **Session expiry and disconnection:** an expired Access session (an opaque redirect) must show "Session expired, sign in again", never a blank page or a raw error.
3. **The dev seeder must be unreachable in production:** host and bypass guard, with tests.
4. **Accessibility:** keyboard paths through the shell, palette, drawer and modal; focus restored; contrast in both themes.
5. **No invented numbers:** components given no data show "no data", never 0.
