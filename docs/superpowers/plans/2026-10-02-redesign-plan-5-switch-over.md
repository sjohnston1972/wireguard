# Redesign plan 5: switch-over (remove the old dashboard, serve the app, go live)

> **For agentic workers:** three areas (A removal, B serving and headers, C watchman and alert links) run **in parallel**, each in its own git worktree branched from `redesign`, each built by one implementer under superpowers:test-driven-development. File ownership is disjoint (below). The integrator merges them into `feat/switch-over`, reviews, and opens the PR into `redesign`. **Everything after that (merge into `main`, deploy, rollback) is Steven's call: see "Go-live".** Steps use checkbox (`- [ ]`) syntax.

**Goal:** the Worker serves the React app from `web/dist` at every page URL (deep links included), the old server-rendered dashboard (views, htmx, `app.js`, `app.css`, form routes, `/api/peers*`, `/api/push/*`) is gone, the VM, GitHub and phone-button endpoints are untouched, and the live checklist of spec §12.4 passes on `wg-admin.clydeford.net`, with a rehearsed way back.

**Architecture:** Workers static assets serve `web/dist` with `not_found_handling = "single-page-application"`, so any navigation that is not a file gets `index.html`; `run_worker_first` sends `/api/*`, `/captures/*`, `/manifest.webmanifest`, `/health` and `/__dev/*` to the Worker. Static files the app needs at fixed URLs (`sw.js`, `icons/`, `icon.svg`, `_headers`) move to `web/public/`, which Vite copies into `web/dist/`. Security and cache headers for asset responses come from `web/public/_headers` (the Worker's middleware never sees them); Worker responses keep the existing middleware.

**Tech stack:** as plans 2-4 (Hono, D1, Vitest harness; React/Vite app). Scripts: Node `.mjs` with pure helpers in `scripts/lib/` tested by `node:test` in `scripts/test/` (the `shots.mjs` pattern). Deploys use `npx wrangler` (a devDependency) with the token from `.env`, through `npm run deploy-worker`; Steven has no global wrangler.

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md`. Sections 1 (success), 3 (serving), 4 (old routes removed at switch-over), 9 (installed app, deep links), 11 (security), 12.4 (live checklist) and 14 item 5 govern this plan.

## Rulings (spec gaps and conflicts, decided here)

1. **Assets come from `web/dist`, not `worker/public`.** Spec §3 says Vite outputs to `worker/public/`; plan 3 chose `web/dist` and promised switch-over would point the Worker there. `worker/public/` is deleted; its keepers move to `web/public/`. The build script stays `npm run build:web`; `deploy-worker` runs it first (spec §3's order: build, migrations, deploy).
2. **CSP:** scripts strictly `'self'` (no inline, no eval). `style-src 'self' 'unsafe-inline'` stays as on the live site today, because Radix's scroll lock injects a `<style>` element (`with-scroll-bars-hidden` is in the bundle) and a static `index.html` cannot carry a nonce. Google Fonts hosts are dropped (fonts are self-hosted).
3. **The watchman false alarm belongs here.** "No heartbeat from the VM for 2 minutes" fires ~30 s after every deploy because `monitor.ts` counts from `last_agent_at`, which is null until the booting VM (~1 min) sends its first heartbeat. The first live check is a deploy; a false "VM unreachable" push during it would muddle the deploy, push and Activity "watchman problems" checks. Fixed in area C with a boot grace, through the one shared `heartbeatStale` (so the Overview no longer greys out during boot either).
4. **Notification deep links (spec §9) land here:** `dashboardButton` takes a path; `sw.js` focuses an open window **and navigates it** to the alert's URL.
5. **Old URLs:** `/peers` redirects to `/clients` in the app; every other old page path (`/`, `/firewall`, `/activity`, `/cost`, `/settings`) is already an app route. An old page still open in a tab (htmx polling `/partials/live`, boosted links) is told to reload: any request with `HX-Request` gets `200` + `HX-Refresh: true`. The shim is removed in a later release.
6. **Seeded `github_run_url`s** use `https://ci.example.invalid/actions/runs/<id>` (RFC 2606 reserved), never the real repo with fake ids.
7. **The dev seeder stays in the production bundle behind its guard** (plan 3 ruling); this plan re-proves the guard.
8. **Bundle budget:** today's build is one JS chunk, 899 KB raw / 279 KB gzip, CSS 38 KB gzip. Budget: JS ≤ 320 KB gzip in total, CSS ≤ 50 KB gzip, no source maps, no `__gallery` in `web/dist`. No code-splitting work (one user, desktop first).

## Global Constraints

- **Inherited:** plan 3/4 constraints (TDD, behaviour tests, no personal data in fixtures, commit trailer `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`, push your branch, no PR from areas).
- **Untouchable:** `/api/agent`, `/api/agent/capture/:id`, `/api/callback`, `/api/callback/secrets`, `/api/act/:token` (handlers, paths, auth, fail buckets), `wg.yml`, Terraform, cloud-init, the agent scripts, the D1 schema (no new migration), push subscription storage, the VAPID keys in `wrangler.toml`, the manifest `id` (`"/"`), `scope` and `start_url`, and the paths `/sw.js`, `/icons/*`, `/manifest.webmanifest` (Access bypass apps point at the last two).
- **Never read, copy or print `.env`.** Scripts load it with `scripts/lib/env.mjs` and pass the token to wrangler only.
- **No deploy, no merge into `main`, no `wrangler` command that changes production** without Steven's explicit go in the conversation (see Go-live).
- **Gate (every area):** `npm test`, `npm run typecheck`, `npm run build:web`, and, once B is merged, `node scripts/bundle-size.mjs`.

## Review Focus

1. **Deep links behind Access.** With a session, a cold load of `/clients/3`, `/firewall/rules/1`, `/activity/runs/<id>`, `/settings/mobile` must serve `index.html` (with the CSP) and the app; without a session, Access must redirect to its login and back to the same deep link; a request for a missing `/assets/*.js` must never get `index.html` back as JavaScript. Tests: B `deep link is index.html with CSP and no long cache`, B `a missing asset is not index.html`, live smoke `deep link without a session goes to Access`.
2. **Push subscriptions survive.** Same `/sw.js` URL and scope `/`, registered by the new app, same VAPID key, untouched `push_subs`; `pushsubscriptionchange` must use `/api/v1/push/*` (the old `/api/push/*` is removed). Tests: B `main registers /sw.js at scope /`, B `pushsubscriptionchange re-subscribes through /api/v1/push`; live check 7 (the phone shows "on", not "stale", without re-enabling).
3. **VM and GitHub endpoints untouched.** Each token route answers exactly as before and runs before the assets layer. Tests: A `kept token routes answer as before`, B `run_worker_first covers /api/* and the other Worker paths`; live check 3 (heartbeat arrives).
4. **A rollback that works under pressure.** The pre-switch version id is recorded before the deploy; `npm run rollback-worker -- <id>` (or the dashboard button) restores the old dashboard; migrations 0013-0015 are additive. Tests: B `rollback args carry the id, a message and --yes`, B `no id lists deployments and changes nothing`.
5. **Stale clients after the deploy.** An old tab or the installed app still showing the old page must reload into the new app, not paint "Not found" fragments; `index.html` and `sw.js` revalidate on every load; hashed assets are immutable; `sw.js` caches nothing. Tests: A `an htmx request from an old page gets HX-Refresh`, B `hashed assets are immutable; index and sw.js are not long-cached`.

---

## Area A: Remove the old dashboard (Worker routes)

**Branch:** `feat/so-remove` from `redesign`. **Owns:** `worker/src/index.ts`, `worker/src/views/**` (deleted), `worker/src/api/index.ts` (the JSON 404 route only), dead exports in `worker/src/db.ts` and `worker/src/notify.ts`, new `worker/test/switchover.test.ts`, and edits to existing tests that only fail because their old route is gone. Does **not** touch `worker/public/` (area B) or `monitor.ts`/`actions.ts`/`devseed.ts` (area C).

**Keeps in `index.ts`:** the CSP/safety middleware, fail buckets, `/api/callback`, `/api/callback/secrets`, `/api/agent/capture/:id`, `/api/agent`, `/api/act/:token`, `/manifest.webmanifest` (colours updated to `background_color: "#08111c"`, `theme_color: "#08111c"`; nothing else changes), `/__dev/seed`, `requireAccess`, `sameOriginOnly`, `/api/v1`, `GET /captures/:id`, `/health`, `notFound`, `onError`, `scheduled`. **Removes:** every other route and the helpers only they use (`jsonBody`, `render`, `where`, `live`, `ip`, `action`, `firewallPage`, `parseEnd`), `/icon.svg` (becomes a static file in B), and all `./views/*` imports.

**Old route → API equivalent** (for retargeting tests in A3):

| Old | Now |
|---|---|
| `POST /actions/<deploy\|move\|hibernate\|resume\|destroy\|cleanup\|cancel\|reconcile\|extend\|speedtest\|allow-ssh>` | `POST /api/v1/<same>` |
| `POST /alerts/ack`, `GET /api/ssh-password` | `POST /api/v1/notes/ack`, `GET /api/v1/ssh-password` |
| `POST /api/peers`, `/api/peers/:id/rekey` | `POST /api/v1/clients`, `/api/v1/clients/:id/rekey` |
| `/api/peers/:id/expiry`, `/peers/:id/<azure\|dns\|homelan\|toggle>`, `/peers/:id/delete` | `PUT /api/v1/clients/:id`, `DELETE /api/v1/clients/:id` |
| `/api/push/<subscribe\|unsubscribe\|status\|test>`, `/settings/push/:id/delete` | `/api/v1/push/<same>`, `DELETE /api/v1/push/:id` |
| `POST /settings`, `/settings/profiles*`, `/settings/schedules*`, `/settings/release-lock` | `PUT /api/v1/settings`, `/api/v1/profiles*`, `/api/v1/schedules*`, `POST /api/v1/lock/release` |
| `/settings/backup/export`, `/config/:day`, `/restore`, `/restore/confirm` | `GET /api/v1/backup/export`, `/backup/config/:day`, `POST /backup/restore/preview`, `/confirm` |
| `/firewall/forwards*`, `/firewall/capture`, `/firewall/clear` | `/api/v1/firewall/forwards*`, `POST /firewall/captures`, `POST /firewall/counters/clear` |
| `/firewall/rules*`, `/firewall/default`, `/firewall/allow-drop` | `/api/v1/firewall/draft/*` then `POST /firewall/draft/apply` |

- [ ] **A1** Write `worker/test/switchover.test.ts` (call `worker.fetch` as `security.test.ts` does; env `AUTH_DEV_BYPASS: "1"` on `http://localhost:8787`):
  - `every removed page and form route answers 404`: GET `/`, `/peers`, `/partials/live`, `/partials/peers-table`, `/activity`, `/cost`, `/settings`, `/firewall`, `/api/ssh-password`, `/api/push/status`, `/icon.svg`; POST each old write path in the table with `Sec-Fetch-Site: same-origin` and a JSON body.
  - `POST /settings with firewall_default changes nothing`: 404; `settings.firewall_default` and `fw_policy.live_version` unchanged.
  - `kept token routes answer as before`: `/api/agent` bad token 401 JSON; `/api/callback` no token 4xx JSON; `/api/callback/secrets` malformed bearer 401; `/api/agent/capture/0123456789abcdef` bad token 401; `/api/act/nope` 410.
  - `manifest, health and captures still answer`: manifest JSON with `id: "/"`, `scope: "/"`, three icons; `/health` 200 JSON; `/captures/xyz` 404.
  - `an unknown /api/v1 path is a JSON 404`: `{error:{code:"not_found"}}`, `Cache-Control: no-store`.
  - `an htmx request from an old page gets HX-Refresh`: GET `/partials/live`, and POST `/actions/deploy` same-origin, each with `HX-Request: true`: 200, `HX-Refresh: true`, empty body, no run started.
  - `the dev seeder is 404 without the bypass and on a non-localhost host`.

  Run `npx vitest run worker/test/switchover.test.ts`: FAIL.
- [ ] **A2** Implement:
  - delete the routes and helpers above and `worker/src/views/`;
  - right after `sameOriginOnly`, middleware answering any `HX-Request: true` request with `c.body(null, 200, { "HX-Refresh": "true" })` (comment: remove one release after switch-over);
  - last in `buildApi()` (`worker/src/api/index.ts`): `api.all("*", (c) => fail(c, 404, "not_found", "No such API route."))` (a mounted sub-app's `notFound` is never called in Hono, so it must be a route);
  - rewrite the file's header comment (the front desk: token routes, the data API, captures, health; the pages are the app's).

  PASS. Commit.
- [ ] **A3** Run `npx vitest run --project worker`. For each failure: if it only tested HTML (redirects, `?saved=1`, page text), delete that test; if it tested behaviour the API keeps (audit entries, expiry validation, `markActed`, backup path-traversal guard, firewall version bumps), retarget it to the equivalent above with `api()` from `api-helpers.ts`, unless an `api-*.test.ts` already pins it (name that test in the commit message). Then `grep -rnw "moveFwRule\|deleteFwRule\|updateFwRule\|ntfyParts" worker/src worker/test`: delete each that has no caller outside its own definition. PASS; gate. Commit.
- [ ] **Done when:** the gate passes and `grep -rn "views/\|htmx\|HX-Request" worker/src` finds only the shim.

---

## Area B: Serve the app (assets, headers, service worker, deploy tools)

**Branch:** `feat/so-serve` from `redesign`. **Owns:** `wrangler.toml` (`[assets]` only), `worker/public/**` (deleted), `web/public/**` (new), `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx` (one redirect route), `scripts/deploy-worker.mjs`, `scripts/dev.mjs`, new `scripts/rollback-worker.mjs`, `scripts/bundle-size.mjs`, `scripts/smoke.mjs`, `scripts/lib/{deploy,bundle,smoke,serveconfig}.mjs`, their tests in `scripts/test/`, `package.json` scripts, `.github/workflows/ci.yml` (one step), `README.md` ("Using the dashboard" intro and "Deploying the dashboard itself").

**Config (exact):**
```toml
# The React app (npm run build:web). Page URLs that are not files get index.html;
# these paths always run the Worker first.
[assets]
directory = "web/dist"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/captures/*", "/manifest.webmanifest", "/health", "/__dev/*"]
```
**`web/public/_headers` (exact):**
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/sw.js
  Cache-Control: no-cache
```
`index.html` keeps Cloudflare's default (`public, max-age=0, must-revalidate`). The Worker's `CSP` constant in `index.ts` gets the same value minus Google Fonts in the integration step (area A owns that file).

- [ ] **B1 Static files.**
  - `git mv worker/public/sw.js worker/public/icons worker/public/_headers web/public/`, then replace `_headers` with the exact text above.
  - Add `web/public/icon.svg` (the SVG `index.ts` served at `/icon.svg`).
  - `git rm worker/public/app.js worker/public/app.css worker/public/htmx.min.js worker/public/qrcode.js`; `worker/public/` is gone.
  - `web/index.html` head gains `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">`, `<link rel="icon" href="/icon.svg" type="image/svg+xml">`, `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`, `<meta name="theme-color" content="#08111c">` and the `apple-mobile-web-app-*` / `mobile-web-app-capable` metas from the old `layout.ts`. No inline script or style.
- [ ] **B2 Config tests.** `scripts/lib/serveconfig.mjs` exports `readAssetsConfig(tomlText)` (regex read of the `[assets]` table) and `parseHeaders(text)` (`_headers` → `{pattern: {name: value}}`). `scripts/test/serveconfig.test.mjs`:
  - `assets come from web/dist as a single-page app`;
  - `run_worker_first covers /api/* and the other Worker paths` (exactly the five above);
  - `CSP: scripts self only, no unsafe-eval, no outside hosts, frame-ancestors none`;
  - `hashed assets are immutable; index and sw.js are not long-cached` (no `/*` Cache-Control, `/assets/*` immutable, `/sw.js` no-cache).

  FAIL; edit `wrangler.toml`; PASS. Commit.
- [ ] **B3 Service worker and app registration.**
  - `web/src/registerSw.ts` exports `registerSw(nav = navigator)`: if `"serviceWorker" in nav`, `nav.serviceWorker.register("/sw.js", { scope: "/" })`, errors swallowed. `main.tsx` calls it when `import.meta.env.PROD`. Tests (`web/src/registerSw.test.ts`): `main registers /sw.js at scope /`; `a browser without service workers is left alone`.
  - `web/public/sw.js`: `/api/push/status`, `/api/push/subscribe`, `/api/push/unsubscribe` become `/api/v1/push/...`; `notificationclick` focuses the first window client and calls `client.navigate(data.url)` when it is elsewhere (no window: `openWindow(data.url)`); the "caches nothing" header comment stays true.
  - `scripts/test/sw.test.mjs` loads `sw.js` with `node:vm` into a fake `self` (listener map, `registration`, `clients`, stubbed `fetch`): `pushsubscriptionchange re-subscribes through /api/v1/push`; `a notification tap navigates an open window to its url`; `the fetch handler only touches navigations`.

  FAIL first; implement; PASS. Commit.
- [ ] **B4 Old path.** `App.tsx`: `<Route path="peers" element={<Navigate to="/clients" replace />} />`. Test in `web/src/routes.test.tsx` (or the existing shell test file): `/peers lands on Clients`. FAIL; add; PASS. Commit.
- [ ] **B5 Bundle budget.** `scripts/lib/bundle.mjs` `judgeBundle(files: {name, bytes, gzip}[], limits)` → `{ok, lines}`; `scripts/bundle-size.mjs` reads `web/dist/assets`, gzips each file (`node:zlib`), prints a table, exits 1 over budget (Ruling 8), on any `.map` file, or if any `web/dist` file contains `__gallery`. Tests: `under budget passes`, `over the JS budget fails and names the files`, `a source map fails`. Add `"bundle-size": "node scripts/bundle-size.mjs"` and a CI step after `npm run build:web`. Commit.
- [ ] **B6 Deploy and rollback tools.**
  - `scripts/lib/deploy.mjs` exports `deploySteps()` → `[["npm","run","build:web"], ["npm","run","bundle-size"], ["wrangler","deployments","status"], ["wrangler","d1","migrations","apply","wg-admin","--remote"], ["wrangler","deploy"]]` and `rollbackArgs(id, message)`. Check the flags with `npx wrangler rollback --help` (no token needed) and pin what it prints; expected `["wrangler","rollback",id,"--message",message,"--yes"]`.
  - `deploy-worker.mjs` keeps its build stamp, runs the steps in order, stops at the first failure, and after the status step prints "The version above is the one this deploy replaces: keep its id for a rollback."
  - `rollback-worker.mjs`: no id → `wrangler deployments list` only; with an id → `rollbackArgs(id, "switch-over rollback")`. Both scripts load `.env` with `loadEnv()` exactly as `deploy-worker.mjs` does today.
  - `dev.mjs` runs `npm run build:web` first when `web/dist/index.html` is missing.
  - Tests (`scripts/test/deploy.test.mjs`): `deploy builds and checks the bundle before migrations and deploy`; `rollback args carry the id, a message and --yes`; `no id lists deployments and changes nothing`.

  Add `"rollback-worker": "node scripts/rollback-worker.mjs"`. FAIL first; PASS. Commit.
- [ ] **B7 Smoke script.** `scripts/lib/smoke.mjs` holds the checks as data plus a pure `judge(check, response)`; `scripts/smoke.mjs --local <base>` / `--live <base>` runs them with `fetch(url, {redirect: "manual"})`. Unit-test `judge` in `scripts/test/smoke.test.mjs` with a canned passing and failing response per check.
  - **Local** (against `npm run dev:api`, login bypassed; plain `npm run dev` gets 401 because wrangler rewrites the host): `deep link is index.html with CSP and no long cache` (`/clients/3`, `/firewall/rules/1`, `/settings/mobile`: 200 `text/html`, CSP present, no `immutable`); `a hashed asset is JavaScript and immutable` (the `/assets/*.js` named in `/`'s HTML); `a missing asset is not index.html` (`/assets/nope.js`: 404, never `text/html` 200); `/sw.js` JavaScript with `no-cache`; `/manifest.webmanifest` JSON; `/api/v1/session` JSON; `/api/v1/nope` JSON 404; old `/api/push/status` 404.
  - **Live** (no session): `deep link without a session goes to Access` (`/clients/3` 302 to `*.cloudflareaccess.com`); `/manifest.webmanifest` and `/icons/icon-192.png` 200 (their bypass apps); `POST /api/agent` with a junk bearer reaches the Worker (401 JSON); `POST /api/act/nope` 410.
  - Run `npm run dev:api` and `node scripts/smoke.mjs --local http://localhost:8787`: all pass. Then load each top-level route in headless Edge (the `shots.mjs` CDP setup, listening to `Log.entryAdded` and `Runtime.consoleAPICalled`): zero CSP violations.

  Commit.
- [ ] **B8 README.** "Deploying the dashboard itself": `npm run deploy-worker` now builds the app, checks its size, prints the version it replaces, migrates, deploys; "Going back": `npm run rollback-worker` (lists versions) then `npm run rollback-worker -- <version id>`, or Cloudflare dashboard > Workers & Pages > wg-admin > Deployments > Rollback. `npm run dev:api` serves the built app on 8787 with login off (it builds `web/` first if `web/dist` is missing); `npm run dev:web` alongside it for live reload on 5173. Commit.
- [ ] **Done when:** the gate (including `node scripts/bundle-size.mjs`) passes and the local smoke run passes.

---

## Area C: Watchman boot grace, alert deep links, seed URLs

**Branch:** `feat/so-alerts` from `redesign`. **Owns:** `worker/src/overview.ts` (`heartbeatStale`), `worker/src/monitor.ts` (watchdog), `worker/src/actions.ts` (`dashboardButton`), the `notify` call sites in `monitor.ts`, `runs.ts`, `standby.ts`, `budget.ts`, `schedule.ts`, `pushsubs.ts`, `worker/src/devseed.ts` (URLs only), tests `worker/test/watchman.test.ts`, `worker/test/devseed.test.ts`, new `worker/test/alertlinks.test.ts`.

- [ ] **C1 Boot grace.** In `watchman.test.ts`:
  - `no unreachable alert while a fresh VM boots` (running since 30 s, and since 4 min, `last_agent_at` null: no alert, no push);
  - `unreachable after the boot grace with no heartbeat` (running since 6 min, null: one alert, one push);
  - `unreachable 2 minutes after the last heartbeat` (today's behaviour, kept);
  - `a resumed VM gets the same boot grace` (`since` = resume time, `last_agent_at` null);
  - `heartbeatStale: a heartbeat from before this session counts as none`.

  FAIL. In `overview.ts`: `export const BOOT_GRACE_MS = 5 * 60_000;` and `heartbeatStale(s, now)`: false unless running; `start = Date.parse(s.running_since ?? s.since ?? "")`; `last = s.last_agent_at ? Date.parse(s.last_agent_at) : NaN`; if `!(last >= start)` (no heartbeat this session) return `Number.isFinite(start) && now - start > BOOT_GRACE_MS`; else return `now - last > 120_000`. `monitor.ts` step 5 calls `heartbeatStale(snap, now.getTime())` instead of its own test. PASS. Commit.
- [ ] **C2 Alert links.** `alertlinks.test.ts`: `dashboardButton defaults to the dashboard root`; `a path becomes publicUrl + path`; `a failed run's alert opens its run`; `budget alerts open /cost`; `unreachable and drift open /`; `the test alert opens /settings/mobile`; `the push payload url is the view button's url` (through `notify` with a fake push sender). FAIL. Then:
  - `dashboardButton(env, label = "Open dashboard", path = "/")` returns `{ label, url: publicUrl + path, kind: "view" }`;
  - the "action failed" alert in `runs.ts` (button-less today) gains `buttons: [dashboardButton(env, "Open the run", "/activity/runs/" + run.id)]`;
  - paths elsewhere: self-test and health-check alerts `/`; `budget.ts` `/cost`; `schedule.ts` `/`; `standby.ts` `/`; `pushsubs.ts` `/settings/mobile`; `monitor.ts` unreachable and drift `/`, failed-run cleanup `/activity`.

  PASS. Commit.
- [ ] **C3** `devseed.test.ts`: `no seeded URL points at github.com` (every scenario: runs and snapshot `github_run_url` match `^https://ci\.example\.invalid/actions/runs/\d+$`). FAIL; replace the six URLs in `devseed.ts`. PASS; gate. Commit.
- [ ] **Done when:** the gate passes.

---

## Integration (integrator; standing OK, no stop)

1. `feat/switch-over` from `redesign`; merge A, then B, then C; gate after each. Hot spots: `worker/src/index.ts` (A only; the integrator then sets its `CSP` constant to the `_headers` value), `package.json` (B only), `worker/test/*` (A's retargeted tests vs C's files: C's three files win).
2. Full gate + `node scripts/bundle-size.mjs` + `npm run dev:api` with `node scripts/smoke.mjs --local http://localhost:8787` + `npm run shots -- --scenario running` (every route exits 0: the served app still fits one screen).
3. Whole-branch review: one fresh reviewer on the most capable model, given this plan and the spec, asked about the Review Focus list and about anything in `worker/src` still reachable only from deleted routes. One fix pass, failing test first.
4. PR `feat/switch-over` → `redesign`, CI green, merge.

---

## Go-live (each STOP is Steven's decision; do not proceed without his explicit go in the conversation)

- [ ] **G0 Steven, before G1 and G2:** close every wg-admin browser tab and swipe-close the installed phone app. After the deploy, if a page is blank or a button does nothing, press Ctrl+F5 (phone: close and reopen the app). Why: the old pages use `hx-boost`, so an old page left open keeps sending its old requests and the new site answers them with the new app, which the old page cannot use; a fresh load fixes it.
- [ ] **G1 STOP: ask Steven before running.** "Plan 5 is merged into `redesign`. May I open the PR `redesign` → `main` and merge it when CI is green?" On yes: `gh pr create --base main --head redesign`, wait for CI, merge (merge commit, not squash: the plans reference branch commits). **G1 and G2 run back to back:** once this is on `main`, any new VM picks up the changed agent scripts while the old Worker is still live. So start G2 right after G1, only at a moment with no VM running and no scheduled start in the next hour (check the Overview and Schedules before merging).
- [ ] **G2 STOP: ask Steven before running.** "Deploy now? About 2 minutes; nothing is running in Azure" (or "a VM is running"; check the Overview first). Run straight after G1, with no VM running and no scheduled start in the next hour. Steven has no wrangler setup of his own and the deploy uses the local `.env` in `C:\cloudflare_projects\wireguard`, so **Claude runs these steps, only on Steven's explicit go, with Steven watching.** Exact steps, in that checkout:
  1. `git switch main && git pull` (the checkout must be on `main`).
  2. `npm ci`.
  3. `npm run deploy-worker`.
  4. **Copy the `Version(s): (100%) <uuid>` line printed BEFORE the deploy into the run notes: that uuid is the rollback id.**
  5. The remote D1 migration step (0013-0015) asks "Ok to proceed?": answer `y`.
  6. Afterwards run `git checkout worker/src/build.ts`: the deploy rewrites that file's build stamp, and it must not be left modified.
- [ ] **G3 Claude:** `node scripts/smoke.mjs --live https://wg-admin.clydeford.net`: all pass, else roll back (below) and report.
- [ ] **G3b Claude: rollback rehearsal, right after G3 passes and while no VM is running** (about 2 minutes). Prove the way back works before it is needed:
  1. `npm run rollback-worker -- <old id from G2>`; confirm the old dashboard is back: `curl -s https://wg-admin.clydeford.net/manifest.webmanifest` shows theme colour `#0f1620`, and Steven sees the old Overview page.
  2. `npm run rollback-worker -- <new id>` (the id of the switch-over version; `npm run rollback-worker` with no id lists versions, newest first) to roll forward.
  3. Re-run `node scripts/smoke.mjs --live https://wg-admin.clydeford.net`: all pass.
  If the roll-forward fails: retry once; if it still fails, use Cloudflare dashboard > Workers & Pages > wg-admin > Deployments > the switch-over version > Rollback (works from the phone), and if that also fails run `npm run deploy-worker` again from `main`. Do not start a VM until the new version is confirmed live.
- [ ] **G3c Claude: re-check in production** (the integrator only verified these in local wrangler): `curl -s -o /dev/null -w "%{http_code}" https://wg-admin.clydeford.net/assets/nope.js` is `404`, and an HX request to `/partials/live` (header `HX-Request: true`) gets `HX-Refresh: true`. Note: with no session Access answers first (302), so run these with Steven's signed-in session (he checks in DevTools: Network, or the console `fetch('/partials/live', {headers: {'HX-Request': 'true'}}).then(r => r.headers.get('hx-refresh'))` returns `"true"`).

## Live checklist (spec §12.4; after G3, in this order)

| # | Check | Who | Pass when |
|---|---|---|---|
| 1 | Sign in on the PC; open each tab and the deep links `/clients/<id>`, `/settings/mobile` by typing them; DevTools console | Steven (PC) | every view renders; no CSP or 404 errors in the console |
| 2 | Theme: account menu → light, then dark; reload keeps the choice | Steven (PC) | both themes readable; choice survives reload |
| 3 | Deploy a VM (UK profile, 1 h) from Overview | Steven (PC) | steps and log stream; state reaches Running; heartbeat age < 1 min; **no "VM unreachable" note or push during boot** |
| 4 | Add a client "plan5-test" by QR: scan with the WireGuard app on the phone, connect off Wi-Fi | Steven (PC + phone) | Clients shows it online with a handshake under 3 min old; delete it afterwards (typed confirmation) |
| 5 | Firewall: add a draft rule "plan5 test" deny from `203.0.113.7/32` to any; Review & apply | Steven (PC) | header shows "waiting for VM", then "applied" within ~1 min; then delete the rule and apply again: "applied" |
| 6 | Settings > Backup & Recovery: Download export; choose that file under Restore | Steven (PC) | the preview shows counts; press Cancel (do not confirm) |
| 7 | Settings > Mobile on the installed app (open it once so the new `sw.js` registers): alerts state; Send test notification; tap it | Steven (phone) | state "on" without re-enabling; the test alert arrives; the tap opens `/settings/mobile` |
| 8 | Phone layout: each of the six tabs in the installed app; open a sheet on Clients and Firewall | Steven (phone) | bottom tab bar, one screen per tab, sheets slide up and close |
| 9 | Tear down from Overview (type `destroy`) | Steven (PC or phone) | state reaches Destroyed; the session appears in Activity and Cost |
| 10 | Claude records results in the run notes and memory | Claude | every row has a pass or a filed issue |

**Decision rule (made now):** a failure in rows 1, 3, 4, 7 or 9 that blocks the action (cannot deploy, tear down, add a client or get alerts) means **roll back at once**, then fix forward on `redesign`. Anything else (layout, wording, a slow refresh) is a GitHub issue and a fix-forward deploy. If row 3 fails mid-deploy, finish or cancel the run from the old dashboard after rolling back.

## Rollback plan

1. **Restore the old Worker (about 30 s):** in `C:\cloudflare_projects\wireguard`, `npm run rollback-worker -- <version id from G2>`. No tools at hand (phone): Cloudflare dashboard > Workers & Pages > wg-admin > Deployments > the version before the switch-over > Rollback. Without the id, `npm run rollback-worker` lists versions: the one before the switch-over deploy, dated before it. A Worker version carries its static assets, so the old pages, `app.js` and the old `sw.js` come back with it.
2. **Data:** nothing to undo. Migrations 0013-0015 only add tables; the old code ignores them. The VM, GitHub workflow, Access apps and push subscriptions never changed.
3. **Phones:** the old `sw.js` returns at the same URL; the phone picks it up on its next open. Subscriptions stay valid (same VAPID key, same scope).
4. **Firewall after a round trip:** the old firewall page changes rules without bumping `fw_policy.live_version`. After re-switching, discard any firewall draft that was started before the rollback (Firewall > Discard) before making new changes.
5. **Confirm:** `curl -s https://wg-admin.clydeford.net/manifest.webmanifest` shows the old colours (`#0f1620`); Steven opens the dashboard and sees the old Overview.
6. **Git stays as it is** (`main` = switch-over). The fix lands on `redesign`, goes through Integration again, and is redeployed with G1-G3.

## Final review checklist

- `grep -rn "htmx\|app\.js\|app\.css\|/api/peers\|/api/push/" worker web scripts README.md` finds nothing but this plan's shim comment and the README's history notes.
- Every capability in spec §13 has a working control in the served app (`npm run dev:api`, `npm run seed -- running`).
- The five Review Focus tests exist and pass; the local smoke passes; the bundle is within budget.
- No secrets, personal data or the real repo URL in seeds, tests or screenshots.
