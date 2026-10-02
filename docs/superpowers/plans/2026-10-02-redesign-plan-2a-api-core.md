# Redesign plan 2a: JSON API core (foundation, overview, lifecycle, history, clients)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Worker a JSON API under `/api/v1` covering the session, the Overview (state, facts, SSH password), every lifecycle action, history read-back and the Clients screen (read and write), behind the existing login, with today's pages untouched.

**Architecture:** A Hono sub-app (`worker/src/api/`) mounted at `/api/v1` after the existing `requireAccess` and `sameOriginOnly` middleware. Each area registers its routes from its own file. Handlers call the existing domain modules; logic that today lives inside page routes moves into domain functions that both the old routes and the API call (`seen.ts`, `overview.ts`, `clients.ts`, `resolveDeployTarget`, `clientAllowedIps`). Errors are always `{ error: { code, message, field? } }`. Response shapes live in `shared/api.ts` for the future app.

**Tech Stack:** Cloudflare Worker (TypeScript, Hono 4), D1, Vitest on Node 24 with `worker/test/harness.ts`; API tests call `worker.fetch` with `AUTH_DEV_BYPASS=1` on `http://localhost:8787`.

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md` (sections 3, 4, 5, 10, 11; section 14 step 2). Plan 2b will cover Firewall (published ports, captures, counters), Activity and runs, Cost, Settings and backups, and push.

## Global Constraints

- No change in behaviour for any existing page or route; the old routes may only change to call a function extracted in this plan.
- Every `/api/v1` response is JSON with `Cache-Control: no-store`. Errors are `{ "error": { "code": string, "message": string, "field"?: string } }`.
- Status codes: 400 bad input (with `field`), 401 signed out, 403 forbidden or cross-site, 404 not found, 409 conflicts with the current state, 422 needs a confirmation, 500 crash (message carries a reference only), 503 not configured.
- `RunError` codes map to status: `bad_input` → 400, `not_found` → 404, `over_budget` and `confirm_required` → 422, anything else (default `refused`) → 409.
- Mutations require the same-origin check (existing middleware); bodies are read only when labelled `application/json`.
- No secret ever appears in an API response: no SSH password except from `GET /ssh-password`, no token hashes, no private keys, no `payload_json`.
- `hours` inputs: `null`/absent/`0` = no limit; otherwise a finite number above 0 and at most 168; anything else is 400 with `field: "hours"`.
- All new files start with the house header comment (file name, then a "Plain English:" paragraph).
- Tests: `npm test` and `npm run typecheck` pass at the end of every task. Never pipe a check's output in a way that hides its exit code.
- Branch `feat/api-core` from `redesign`; PR into `redesign` (Task 8). Nothing is deployed. Every commit message ends with `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`.

## Review Focus

1. A signed-out or cross-site call to `/api/v1`: the app must get JSON (401/403/503 with a code), never HTML text or a redirect it cannot read. (Task 1)
2. An action that conflicts with the current state (deploy while deploying, a held run lock, a missing profile): 409/404 with the domain's own message, never a 500. (Task 4)
3. Untrusted inputs (hours as text, negative or huge; non-numeric ids; expiry days not on the list; booleans as strings): 400 with the field named, and nothing written. (Tasks 4 and 7)
4. A history range with no samples: empty points and availability `null`, never 0 % or 100 %. (Task 5)
5. Secrets in responses: the Overview and Clients JSON must not contain the SSH password, token hashes or the run payload. (Tasks 3 and 6)

---

### Task 1: API foundation

**Files:**
- Create: `shared/api.ts`, `worker/src/api/app.ts`, `worker/src/api/index.ts`, `worker/test/api-helpers.ts`, `worker/test/api-foundation.test.ts`
- Modify: `tsconfig.json` (include `shared`), `worker/src/runs.ts:32` (`RunError`), `worker/src/budget.ts:119` (`requireBudgetOk`), `worker/src/auth.ts` (JSON refusals for `/api/v1`), `worker/src/index.ts` (mount)

**Interfaces:**
- Produces:
  - `class RunError extends Error { constructor(message: string, readonly code: string = "refused") }`
  - `shared/api.ts`: `interface ApiError { error: { code: string; message: string; field?: string } }`, `interface ApiOk { ok: true; message: string }`
  - `worker/src/api/app.ts`: `type ApiEnv`, `createApi(): Hono<ApiEnv>`, `fail(c, status, code, message, field?)`, `body<T>(c): Promise<T | null>`, `statusFor(code: string): 400 | 404 | 409 | 422`
  - `worker/src/api/index.ts`: `buildApi(): Hono<ApiEnv>` (later tasks add `register*` calls before the catch-all)
  - `worker/test/api-helpers.ts`: `apiEnv(overrides?)`, `api(env, method, path, body?, headers?)` returning `{ status, json, headers }`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/api-helpers.ts`:

```ts
// api-helpers.ts
//
// Plain English: calling the dashboard's data API (/api/v1) in tests, the
// way the new app will: through the Worker's front door, signed in (the
// localhost login bypass), from the dashboard's own origin.
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";

export const base = "http://localhost:8787";
const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

export function apiEnv(overrides: Partial<Env> = {}): { env: Env; world: World } {
  return makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base, ...overrides });
}

export async function api(
  env: Env,
  method: string,
  path: string,
  json?: unknown,
  headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" },
): Promise<{ status: number; json: any; headers: Headers; text: string }> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const r = await worker.fetch(new Request(`${base}/api/v1${path}`, init), env, ctx);
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: r.status, json: parsed, headers: r.headers, text };
}
```

Create `worker/test/api-foundation.test.ts`:

```ts
// api-foundation.test.ts
//
// Plain English: the data API's front door: JSON for every answer,
// including refusals, never cached, and the dashboard's own errors turned
// into the right status.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { api, apiEnv } from "./api-helpers";
import { makeEnv } from "./harness";
import { createApi, statusFor } from "../src/api/app";
import { RunError } from "../src/runs";

afterEach(() => vi.unstubAllGlobals());

describe("API front door", () => {
  it("answers an unknown API path with JSON 404", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: { code: "not_found", message: "No such API route." } });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses a cross-site change with JSON 403", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/nope", {}, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("cross_site");
  });

  it("answers JSON 503 when login is not configured", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    const r = await api(env, "GET", "/nope");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("not_configured");
  });

  it("answers JSON 401 when there is no login token", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787", CF_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", CF_ACCESS_AUD: "aud", CF_ACCESS_ALLOWED_EMAIL: "a@b.c" });
    const r = await api(env, "GET", "/nope");
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthenticated");
  });

  it("still answers today's pages with text, not JSON", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    const r = await (await import("../src/index")).default.fetch(new Request("http://localhost:8787/"), env, { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext);
    expect(r.status).toBe(503);
    expect(r.headers.get("Content-Type") ?? "").toMatch(/^text\/plain/);
  });
});

describe("dashboard errors", () => {
  it("maps RunError codes to statuses", () => {
    expect(statusFor("bad_input")).toBe(400);
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("over_budget")).toBe(422);
    expect(statusFor("confirm_required")).toBe(422);
    expect(statusFor("refused")).toBe(409);
    expect(statusFor("anything else")).toBe(409);
  });

  it("turns a thrown RunError into its status and code, and a crash into 500 with only a reference", async () => {
    const sub = createApi();
    sub.get("/conflict", () => {
      throw new RunError("A run is already in progress.");
    });
    sub.get("/budget", () => {
      throw new RunError("Over budget.", "over_budget");
    });
    sub.get("/crash", () => {
      throw new Error("secret detail");
    });
    const parent = new Hono();
    parent.route("/api/v1", sub);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const conflict = await parent.request("/api/v1/conflict");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "refused", message: "A run is already in progress." } });
    const budget = await parent.request("/api/v1/budget");
    expect(budget.status).toBe(422);
    const crash = await parent.request("/api/v1/crash");
    expect(crash.status).toBe(500);
    const text = JSON.stringify(await crash.json());
    expect(text).not.toContain("secret detail");
    expect(text).toMatch(/reference [0-9a-f]{8}/);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-foundation.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api/app"`.

- [ ] **Step 3a: `RunError` gets a code; the budget refusal uses one**

In `worker/src/runs.ts`, replace `export class RunError extends Error {}` with:

```ts
/**
 * A refusal fit for the screen. The code says what kind, so the data API
 * can answer with the right status (api/app.ts): "bad_input", "not_found",
 * "over_budget", "confirm_required", or the default "refused" (the action
 * conflicts with what is happening now).
 */
export class RunError extends Error {
  constructor(
    message: string,
    readonly code: string = "refused",
  ) {
    super(message);
  }
}
```

In `worker/src/budget.ts`, in `requireBudgetOk`, change the throw to:

```ts
  throw new RunError(`This month is at ${Math.round(b.pct)}% of the ${money(b.budget)} budget. Tick "Deploy anyway" to go ahead.`, "over_budget");
```

- [ ] **Step 3b: Login and same-origin refusals answer the API in JSON**

In `worker/src/auth.ts`, add this helper above `requireAccess`:

```ts
/**
 * A refusal: plain text for the pages, JSON for the data API (/api/v1), so
 * the app can tell "signed out" from "broken" instead of reading an HTML
 * or text answer it cannot use.
 */
function refuse(c: Context, status: 401 | 403 | 503, code: string, message: string) {
  if (new URL(c.req.url).pathname.startsWith("/api/v1/")) return c.json({ error: { code, message } }, status);
  return c.text(message, status);
}
```

In `requireAccess`, replace each `return c.text(...)` as follows (keep the messages exactly):
- the not-configured line → `return refuse(c, 503, "not_configured", "wg-admin is not configured for login yet (CF_ACCESS_* secrets missing). Refusing to serve.");`
- no token → `return refuse(c, 401, "unauthenticated", "No Cloudflare Access token. Open this page through wg-admin.clydeford.net.");`
- wrong email → ``return refuse(c, 403, "forbidden", `Signed in as ${email}, which is not allowed here.`);``
- token rejected → `return refuse(c, 401, "unauthenticated", "Access token rejected. Sign in again through wg-admin.clydeford.net.");`

In `sameOriginOnly`, replace its `return c.text("Refused: that request did not come from the wg-admin pages.", 403);` with:

```ts
    return refuse(c, 403, "cross_site", "Refused: that request did not come from the wg-admin pages.");
```

- [ ] **Step 3c: Shared types, the sub-app and the mount**

Create `shared/api.ts`:

```ts
// shared/api.ts
//
// Plain English: the shapes of the dashboard's data API (/api/v1), shared by
// the Worker that answers and the app (web/) that asks, so both sides agree
// on every field. Types only: nothing here runs.

/** Every refusal or failure. `field` names the input at fault, for a form. */
export interface ApiError {
  error: { code: string; message: string; field?: string };
}

/** Every action that worked. `message` is fit to show as-is. */
export interface ApiOk {
  ok: true;
  message: string;
}
```

In `tsconfig.json`, change `"include"` to `["worker/src/**/*.ts", "worker/test/**/*.ts", "shared/**/*.ts"]`.

Create `worker/src/api/app.ts`:

```ts
// api/app.ts
//
// Plain English: the dashboard's data API (/api/v1). The new app (web/)
// talks only to these routes; each returns JSON and nothing else, never
// cached. They sit behind the same login and same-origin check as every
// page. A refused action comes back as { error: { code, message, field? } }
// with a status that says why: 400 bad input, 401 signed out, 404 not
// found, 409 conflicts with what is happening now, 422 needs a
// confirmation, 500 a crash (with only a reference; the details go to the
// Worker's log).

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import type { AuthedVars } from "../auth";
import { RunError } from "../runs";
import type { ApiError } from "../../../shared/api";

export type ApiEnv = { Bindings: Env; Variables: AuthedVars };
type Status = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503;

/** The status for a RunError's code. */
export function statusFor(code: string): 400 | 404 | 409 | 422 {
  if (code === "bad_input") return 400;
  if (code === "not_found") return 404;
  if (code === "over_budget" || code === "confirm_required") return 422;
  return 409;
}

/** A refusal in the API's one error shape. */
export function fail(c: Context<ApiEnv>, status: Status, code: string, message: string, field?: string) {
  const out: ApiError = { error: field ? { code, message, field } : { code, message } };
  return c.json(out, status);
}

/** The JSON body, or null when it is not labelled JSON or does not parse. */
export async function body<T>(c: Context<ApiEnv>): Promise<T | null> {
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return null;
  return (await c.req.json().catch(() => null)) as T | null;
}

/** The sub-app every area registers its routes on. */
export function createApi(): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();
  api.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });
  api.onError((err, c) => {
    if (err instanceof RunError) return fail(c, statusFor(err.code), err.code, err.message);
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`api error ${ref} on ${c.req.method} ${new URL(c.req.url).pathname}:`, err);
    return fail(c, 500, "internal", `Something broke (reference ${ref}). The details are in the Worker's log.`);
  });
  return api;
}
```

Create `worker/src/api/index.ts`:

```ts
// api/index.ts
//
// Plain English: the data API's route list. Each area registers its own
// routes; the catch-all at the end answers anything else with a JSON 404.

import { createApi, fail, type ApiEnv } from "./app";
import type { Hono } from "hono";

export function buildApi(): Hono<ApiEnv> {
  const api = createApi();
  // Area routes are registered here (later tasks), before the catch-all.
  api.all("*", (c) => fail(c, 404, "not_found", "No such API route."));
  return api;
}
```

In `worker/src/index.ts`, add `import { buildApi } from "./api";` to the imports, and directly after `app.use("*", sameOriginOnly);` add:

```ts

// The data API for the new app (api/): JSON only, behind the same checks.
app.route("/api/v1", buildApi());
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-foundation.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass (the existing security tests prove the pages still refuse with text).

- [ ] **Step 5: Commit**

```bash
git add shared tsconfig.json worker/src/api worker/src/runs.ts worker/src/budget.ts worker/src/auth.ts worker/src/index.ts worker/test/api-helpers.ts worker/test/api-foundation.test.ts
git commit -m "API: /api/v1 front door with JSON errors and status codes

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 2: Session and notes

**Files:**
- Create: `worker/src/seen.ts`, `worker/src/api/session.ts`, `worker/test/api-session.test.ts`
- Modify: `worker/src/index.ts` (move `LAST_ACTION_KEY`, `SEEN_WINDOW_MS`, `markActed`, `ackWatchedNotes` out; import them), `worker/src/api/index.ts`, `shared/api.ts`

**Interfaces:**
- Consumes: Task 1's `createApi` routes and `ApiOk`; `db.unacknowledgedAlerts`, `db.acknowledgeAlerts`, `db.acknowledgeRoutineBetween`, `missingSecrets`, `BUILD`.
- Produces: `markActed(env): Promise<void>`, `ackWatchedNotes(env): Promise<void>` in `worker/src/seen.ts`; `registerSession(api)`; `SessionResponse` in `shared/api.ts`.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/api-session.test.ts`:

```ts
// api-session.test.ts
//
// Plain English: who is signed in, which build is running, what setup is
// missing and the watchman notes nobody has read; and marking them read.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { BUILD } from "../src/build";

afterEach(() => vi.unstubAllGlobals());

describe("GET /session", () => {
  it("says who is signed in, the build, the setup gaps and the unread notes", async () => {
    const { env } = apiEnv();
    await db.addAlert(env, "drift", "Azure still has resource group rg-wg-ondemand.");
    const r = await api(env, "GET", "/session");
    expect(r.status).toBe(200);
    expect(r.json.user).toBe("dev@localhost");
    expect(r.json.build).toBe(BUILD);
    expect(typeof r.json.now).toBe("string");
    expect(r.json.setupMissing).toEqual(expect.any(Object));
    expect(r.json.notes.map((n: { message: string }) => n.message)).toEqual(["Azure still has resource group rg-wg-ondemand."]);
  });
});

describe("POST /notes/ack", () => {
  it("marks every note read", async () => {
    const { env } = apiEnv();
    await db.addAlert(env, "info", "Old note");
    const r = await api(env, "POST", "/notes/ack");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, message: "Notes marked as read." });
    expect(await db.unacknowledgedAlerts(env)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-session.test.ts`
Expected: FAIL, status 404 instead of 200.

- [ ] **Step 3a: Move "seen" bookkeeping out of `index.ts`**

Create `worker/src/seen.ts`:

```ts
// seen.ts
//
// Plain English: "While you were away" should mean exactly that. Pressing
// any button on the dashboard counts as having read the notes so far, and
// the routine notes that follow in the next 15 minutes (Deployed at...,
// Self-test passed, Torn down, the session summary) are ones Steven watched
// happen. Shared by the pages (index.ts) and the data API (api/).

import type { Env } from "./env";
import * as db from "./db";

const LAST_ACTION_KEY = "ui:last_action_at";
const SEEN_WINDOW_MS = 15 * 60_000;

/** A button was pressed: the notes so far are read, and the clock starts for routine ones. */
export async function markActed(env: Env): Promise<void> {
  await db.acknowledgeAlerts(env);
  await env.STATUS.put(LAST_ACTION_KEY, new Date().toISOString(), { expirationTtl: 86_400 });
}

/** Mark the routine notes from just after the last button press as read. */
export async function ackWatchedNotes(env: Env): Promise<void> {
  const last = await env.STATUS.get(LAST_ACTION_KEY);
  if (!last || Number.isNaN(Date.parse(last))) return;
  await db.acknowledgeRoutineBetween(env, last, new Date(Date.parse(last) + SEEN_WINDOW_MS).toISOString());
}
```

In `worker/src/index.ts`, delete the block from the comment `/**\n * "While you were away" should mean exactly that.` through the end of `ackWatchedNotes` (the constants `LAST_ACTION_KEY`, `SEEN_WINDOW_MS` and both functions), and add `import { markActed, ackWatchedNotes } from "./seen";` to the imports. Every existing call keeps working unchanged.

- [ ] **Step 3b: The session routes**

Append to `shared/api.ts`:

```ts
import type { Alert } from "../worker/src/db";

/** GET /api/v1/session */
export interface SessionResponse {
  user: string;
  build: string;
  now: string;
  /** Secret groups with something missing, and which names (presence only, never values). */
  setupMissing: Record<string, string[]>;
  /** Watchman notes nobody has read yet, newest first. */
  notes: Alert[];
}
```

(Move the new `import type` line to the top of `shared/api.ts`, under the header comment.)

Create `worker/src/api/session.ts`:

```ts
// api/session.ts
//
// Plain English: who is signed in, which build of the dashboard is
// running, which secrets are missing (names only), and the watchman notes
// nobody has read; plus "mark them read".

import type { Hono } from "hono";
import type { ApiEnv } from "./app";
import * as db from "../db";
import { missingSecrets } from "../env";
import { BUILD } from "../build";
import { ackWatchedNotes } from "../seen";
import type { ApiOk, SessionResponse } from "../../../shared/api";

export function registerSession(api: Hono<ApiEnv>): void {
  api.get("/session", async (c) => {
    await ackWatchedNotes(c.env).catch((e) => console.error("ack watched notes:", e));
    const out: SessionResponse = {
      user: c.get("user"),
      build: BUILD,
      now: new Date().toISOString(),
      setupMissing: missingSecrets(c.env),
      notes: await db.unacknowledgedAlerts(c.env),
    };
    return c.json(out);
  });

  api.post("/notes/ack", async (c) => {
    await db.acknowledgeAlerts(c.env);
    const out: ApiOk = { ok: true, message: "Notes marked as read." };
    return c.json(out);
  });
}
```

In `worker/src/api/index.ts`, add `import { registerSession } from "./session";` and replace the comment line `// Area routes are registered here (later tasks), before the catch-all.` with:

```ts
  // Area routes, before the catch-all.
  registerSession(api);
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-session.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass (`away.test.ts` proves the moved bookkeeping still behaves).

- [ ] **Step 5: Commit**

```bash
git add shared/api.ts worker/src/seen.ts worker/src/api worker/src/index.ts worker/test/api-session.test.ts
git commit -m "API: session and notes

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 3: Overview and the SSH password

**Files:**
- Create: `worker/src/overview.ts`, `worker/src/api/overview.ts`, `worker/test/api-overview.test.ts`
- Modify: `worker/src/views/dashboard.ts` (use `isVerifying` and `publicIp6` from `overview.ts`), `worker/src/region.ts` (add `whereFrom`), `worker/src/index.ts` (`where` uses `whereFrom`), `worker/src/api/index.ts`, `shared/api.ts`

**Interfaces:**
- Consumes: `getSnapshot`, `effectiveConfig`, `db.listPeers`, `lockStatus`, `db.currentDeployment`, `db.listProfiles`, `db.listSpeedTests`, `db.listSchedules`, `db.listRuns`, `backupStatus`, `budgetStatus`, `nextStart`, `canDispatch`, `peerOnline`, `selfTestFailures`, `refreshActiveRun`, `refreshPower`, `nearestRegion`.
- Produces:
  - `worker/src/overview.ts`: `isVerifying(s: Snapshot, now?: number): boolean`, `publicIp6(s: Snapshot): string | null`, `heartbeatStale(s: Snapshot, now?: number): boolean`, `sshAllowedFrom(s: Snapshot, payloadJson: string | null): string | null`, `typicalSeconds(runs: Run[], action: "apply" | "destroy"): number | null`
  - `worker/src/region.ts`: `whereFrom(req: Request): { country: string | null; region: string | null }`
  - `registerOverview(api)`; `OverviewResponse` in `shared/api.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/api-overview.test.ts`:

```ts
// api-overview.test.ts
//
// Plain English: the Overview's data: the stored state plus the facts
// worked out from it, what can be pressed, and the SSH password on its own
// route only.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { typicalSeconds, isVerifying, heartbeatStale } from "../src/overview";
import type { Env } from "../src/env";
import type { Snapshot } from "../src/state";

afterEach(() => vi.unstubAllGlobals());

const PHONE = "P".repeat(43) + "=";
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");

async function toRunning(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  await handleAgent(env, sec.body.agent_token as string, { dump: DUMP([`${PHONE}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${Math.floor(Date.now() / 1000) - 5}\t10\t20\t0`]) });
  return { run, callbackToken: sec.body.callback_token as string, agentToken: sec.body.agent_token as string };
}

describe("GET /overview", () => {
  it("describes a destroyed environment", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/overview");
    expect(r.status).toBe(200);
    expect(r.json.snapshot.state).toBe("destroyed");
    expect(r.json.derived).toEqual({ verifying: false, heartbeatStale: false, selftestFailures: [], clientsOnline: 0, clientsEnabled: 0, publicIp6: null, dnsParked: false });
    expect(r.json.config).toMatchObject({ dnsName: "wg.clydeford.net", port: 51820, subnet: "10.13.13.0/24", region: "uksouth", vmSize: "Standard_B1s" });
    expect(r.json.actions).toEqual({ canDispatch: true, lockHolder: null });
    expect(r.json.deployment).toBeNull();
    expect(r.json.typicalSeconds).toEqual({ deploy: null, destroy: null });
    expect(r.json.budget).toMatchObject({ budget: 10 });
  });

  it("describes a running environment, with nothing secret in it", async () => {
    const { env, world } = apiEnv();
    const { run, callbackToken, agentToken } = await toRunning(env, world);
    const r = await api(env, "GET", "/overview");
    expect(r.json.snapshot.state).toBe("running");
    expect(r.json.derived).toMatchObject({ verifying: true, heartbeatStale: false, clientsOnline: 1, clientsEnabled: 1 });
    expect(r.json.deployment).toMatchObject({ id: run.id, hasSshPassword: true, peersLoaded: 1 });
    const text = JSON.stringify(r.json);
    const stored = (await db.getRun(env, run.id))!;
    for (const secret of [stored.ssh_password!, stored.agent_token_hash!, stored.callback_token_hash!, callbackToken, agentToken]) expect(text).not.toContain(secret);
    expect(text).not.toContain("payload_json");
  });
});

describe("GET /ssh-password", () => {
  it("gives the password only while running", async () => {
    const { env, world } = apiEnv();
    const none = await api(env, "GET", "/ssh-password");
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe("none");
    const { run } = await toRunning(env, world);
    const r = await api(env, "GET", "/ssh-password");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ password: (await db.getRun(env, run.id))!.ssh_password });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("overview facts", () => {
  const run = (action: "apply" | "destroy", status: string, secs: number | null, i: number) =>
    ({ id: `r${i}`, action, status, requested_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00Z`, started_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00Z`, finished_at: secs === null ? null : new Date(Date.parse(`2026-10-01T10:${String(i).padStart(2, "0")}:00Z`) + secs * 1000).toISOString() }) as db.Run;

  it("takes the median of the last 10 successful runs of that kind", () => {
    const runs = [run("apply", "success", 140, 1), run("apply", "success", 150, 2), run("apply", "failure", 60, 3), run("apply", "success", 900, 4), run("destroy", "success", 130, 5), run("apply", "running", null, 6)];
    expect(typicalSeconds(runs, "apply")).toBe(150);
    expect(typicalSeconds(runs, "destroy")).toBe(130);
    expect(typicalSeconds([], "apply")).toBeNull();
  });

  it("is verifying for 5 minutes after coming up without a self-test, and stale after 2 minutes without a heartbeat", () => {
    const now = Date.parse("2026-10-02T10:10:00Z");
    const s = { state: "running", running_since: "2026-10-02T10:06:00Z", since: null, selftest: null, last_agent_at: "2026-10-02T10:07:30Z" } as unknown as Snapshot;
    expect(isVerifying(s, now)).toBe(true);
    expect(isVerifying({ ...s, running_since: "2026-10-02T10:04:00Z" }, now)).toBe(false);
    expect(heartbeatStale(s, now)).toBe(true);
    expect(heartbeatStale({ ...s, last_agent_at: "2026-10-02T10:09:00Z" }, now)).toBe(false);
    expect(heartbeatStale({ ...s, state: "destroyed" } as Snapshot, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-overview.test.ts`
Expected: FAIL, `Failed to resolve import "../src/overview"`.

- [ ] **Step 3a: Facts worked out from the snapshot**

Create `worker/src/overview.ts`:

```ts
// overview.ts
//
// Plain English: the Overview facts that are worked out rather than
// stored: "verifying" (up, but the boot self-test has not reported), a
// stale heartbeat, the public IPv6 address, who may SSH in, and how long a
// deploy or tear-down usually takes. Shared by the page and the data API.

import type { Snapshot } from "./state";
import type { Run } from "./db";

/**
 * Running, but the VM's boot self-test has not reported yet: show
 * "Verifying" rather than a green "Running". Builds from before the
 * self-test never report one, so after 5 minutes it stops waiting.
 */
export function isVerifying(s: Snapshot, now = Date.now()): boolean {
  if (s.state !== "running" || s.selftest) return false;
  const since = Date.parse(s.running_since ?? s.since ?? "");
  return Number.isFinite(since) && now - since < 5 * 60_000;
}

/** Running, and no heartbeat for over 2 minutes. */
export function heartbeatStale(s: Snapshot, now = Date.now()): boolean {
  return s.state === "running" && (!s.last_agent_at || now - Date.parse(s.last_agent_at) > 120_000);
}

/**
 * The VM's public IPv6 address, from Azure's inventory. The address the VM
 * itself reports (agent.wan6) is its private one: Azure translates IPv6 at
 * the edge as it does IPv4. Shown only when the VM also reports IPv6
 * working inside, so a half-built stack is not advertised.
 */
export function publicIp6(s: Snapshot): string | null {
  if (!s.agent?.wan6) return null;
  const a = s.azure?.resources.find((r) => r.kind === "Public IPv6")?.detail.split(",")[0]?.trim();
  return a && a.includes(":") ? a : null;
}

/** The address allowed to SSH in: Azure's live NSG rule if known, else what the deploy asked for. */
export function sshAllowedFrom(s: Snapshot, payloadJson: string | null): string | null {
  const live = s.azure?.resources.find((r) => r.kind === "Network security group")?.detail.match(/allow tcp 22 from ([^;]+)/)?.[1];
  if (live) return live;
  try {
    const p = JSON.parse(payloadJson ?? "{}") as { ssh_allowed_cidr?: unknown };
    return p.ssh_allowed_cidr ? String(p.ssh_allowed_cidr) : null;
  } catch {
    return null;
  }
}

/** Median seconds of the last 10 successful runs of this kind, or null with none to go on. */
export function typicalSeconds(runs: Run[], action: "apply" | "destroy"): number | null {
  const secs = runs
    .filter((r) => r.action === action && r.status === "success" && r.finished_at)
    .slice(0, 10)
    .map((r) => (Date.parse(r.finished_at!) - Date.parse(r.started_at ?? r.requested_at)) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);
  if (!secs.length) return null;
  const mid = Math.floor(secs.length / 2);
  return Math.round(secs.length % 2 ? secs[mid] : (secs[mid - 1] + secs[mid]) / 2);
}
```

Note: `db.listRuns` returns newest first, so `.slice(0, 10)` after filtering takes the 10 most recent.

In `worker/src/views/dashboard.ts`:
- delete the local `function verifying(s: Snapshot): boolean { ... }` (with its doc comment) and `function publicIp6(s: Snapshot): string | null { ... }` (with its doc comment);
- add `import { isVerifying, publicIp6 } from "../overview";`;
- replace every call `verifying(s)` with `isVerifying(s)` (three places).

- [ ] **Step 3b: Where the browser is, shared**

In `worker/src/region.ts`, append:

```ts
/** Cloudflare's idea of where a request came from: country code and the nearest Azure region. */
export function whereFrom(req: Request): { country: string | null; region: string | null } {
  const cf = (req as unknown as { cf?: { country?: string; continent?: string; longitude?: string } }).cf;
  return { country: cf?.country ?? null, region: nearestRegion(cf) };
}
```

In `worker/src/index.ts`, replace the body of `function where(c)` with `return whereFrom(c.req.raw);` and add `whereFrom` to the `./region` import.

- [ ] **Step 3c: The overview routes**

Append to `shared/api.ts` (and add `Snapshot` from `../worker/src/state`, `Profile`, `SpeedTest` from `../worker/src/db`, and `BudgetStatus` from `../worker/src/budget` to its type imports at the top):

```ts
/** GET /api/v1/overview */
export interface OverviewResponse {
  now: string;
  /** The stored state, exactly as the watchman and heartbeat left it. Holds no secrets. */
  snapshot: Snapshot;
  derived: {
    verifying: boolean;
    heartbeatStale: boolean;
    selftestFailures: string[];
    clientsOnline: number;
    clientsEnabled: number;
    publicIp6: string | null;
    dnsParked: boolean;
  };
  config: {
    dnsName: string;
    port: number;
    subnet: string;
    subnet6: string;
    loopbackIp: string;
    region: string;
    vmSize: string;
    vnetCidr: string;
    homeLanCidr: string;
    hourlyRateGbp: number;
    standbyRateGbp: number;
    autoDestroyDefaultHours: number;
    expiryAction: "destroy" | "hibernate";
    standbyMaxDays: number;
  };
  actions: { canDispatch: boolean; lockHolder: string | null };
  near: { country: string | null; region: string | null };
  profiles: Profile[];
  speedtests: SpeedTest[];
  site: { id: number; name: string; routes: string } | null;
  nextScheduledStart: string | null;
  budget: BudgetStatus;
  deployment: {
    id: string;
    requestedBy: string | null;
    finishedAt: string | null;
    githubRunUrl: string | null;
    hasSshPassword: boolean;
    sshAllowedFrom: string | null;
    peersLoaded: number | null;
  } | null;
  stateBackups: { count: number; newest: string | null } | null;
  typicalSeconds: { deploy: number | null; destroy: number | null };
}

/** GET /api/v1/ssh-password */
export interface SshPasswordResponse {
  password: string;
}
```

Create `worker/src/api/overview.ts`:

```ts
// api/overview.ts
//
// Plain English: the Overview's data. Before answering it checks on any
// run in progress (GitHub) and any power change (Azure), as the page does,
// so the state is current. The SSH password has its own route and is only
// sent when asked for, never as part of the overview.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot, peerOnline, selfTestFailures } from "../state";
import { effectiveConfig } from "../settings";
import { canDispatch } from "../env";
import { lockStatus } from "../lock";
import { backupStatus } from "../backup";
import { budgetStatus } from "../budget";
import { nextStart } from "../schedule-time";
import { refreshActiveRun } from "../runs";
import { refreshPower } from "../standby";
import { whereFrom } from "../region";
import { isVerifying, heartbeatStale, publicIp6, sshAllowedFrom, typicalSeconds } from "../overview";
import type { OverviewResponse, SshPasswordResponse } from "../../../shared/api";

export function registerOverview(api: Hono<ApiEnv>): void {
  api.get("/overview", async (c) => {
    await refreshActiveRun(c.env).catch(() => {});
    await refreshPower(c.env).catch(() => {});
    const [snap, cfg, peers, lock, dep, profiles, speedtests, schedules, backups, runs] = await Promise.all([
      getSnapshot(c.env),
      effectiveConfig(c.env),
      db.listPeers(c.env),
      lockStatus(c.env),
      db.currentDeployment(c.env),
      db.listProfiles(c.env),
      db.listSpeedTests(c.env, 5),
      db.listSchedules(c.env),
      backupStatus(c.env).catch(() => null),
      db.listRuns(c.env, 60),
    ]);
    const now = Date.now();
    const site = peers.find((p) => p.enabled && p.routes) ?? null;
    let peersLoaded: number | null = null;
    try {
      peersLoaded = JSON.parse(String((JSON.parse(dep?.payload_json ?? "{}") as { peers_json?: unknown }).peers_json ?? "[]")).length;
    } catch {
      peersLoaded = null;
    }
    const out: OverviewResponse = {
      now: new Date(now).toISOString(),
      snapshot: snap,
      derived: {
        verifying: isVerifying(snap, now),
        heartbeatStale: heartbeatStale(snap, now),
        selftestFailures: selfTestFailures(snap.selftest),
        clientsOnline: snap.state === "running" && snap.agent ? snap.agent.peers.filter((p) => peerOnline(p, now)).length : 0,
        clientsEnabled: peers.filter((p) => p.enabled).length,
        publicIp6: snap.state === "running" ? publicIp6(snap) : null,
        dnsParked: snap.dns_ip === "192.0.2.1",
      },
      config: {
        dnsName: cfg.dnsName,
        port: cfg.port,
        subnet: cfg.subnet,
        subnet6: cfg.subnet6,
        loopbackIp: cfg.loopbackIp,
        region: cfg.region,
        vmSize: cfg.vmSize,
        vnetCidr: cfg.vnetCidr,
        homeLanCidr: cfg.homeLanCidr,
        hourlyRateGbp: cfg.hourlyRateGbp,
        standbyRateGbp: cfg.standbyRateGbp,
        autoDestroyDefaultHours: cfg.autoDestroyDefaultHours,
        expiryAction: cfg.expiryAction,
        standbyMaxDays: cfg.standbyMaxDays,
      },
      actions: { canDispatch: canDispatch(c.env), lockHolder: lock.held && !["deploying", "destroying"].includes(snap.state) ? lock.lock?.runId ?? null : null },
      near: whereFrom(c.req.raw),
      profiles,
      speedtests,
      site: site ? { id: site.id, name: site.name, routes: site.routes } : null,
      nextScheduledStart: nextStart(schedules, new Date(now)),
      budget: await budgetStatus(c.env, cfg, snap),
      deployment: dep
        ? { id: dep.id, requestedBy: dep.requested_by, finishedAt: dep.finished_at, githubRunUrl: dep.github_run_url, hasSshPassword: !!dep.ssh_password, sshAllowedFrom: sshAllowedFrom(snap, dep.payload_json), peersLoaded }
        : null,
      stateBackups: backups && !backups.error ? backups.state : null,
      typicalSeconds: { deploy: typicalSeconds(runs, "apply"), destroy: typicalSeconds(runs, "destroy") },
    };
    return c.json(out);
  });

  api.get("/ssh-password", async (c) => {
    const [snap, dep] = await Promise.all([getSnapshot(c.env), db.currentDeployment(c.env)]);
    if (snap.state !== "running" || !dep?.ssh_password) return fail(c, 404, "none", "There is no SSH password for what is running now.");
    const out: SshPasswordResponse = { password: dep.ssh_password };
    return c.json(out);
  });
}
```

In `worker/src/api/index.ts`, add `import { registerOverview } from "./overview";` and `registerOverview(api);` after `registerSession(api);`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-overview.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass (the dashboard tests prove the page still shows "Verifying" and IPv6 the same way).

- [ ] **Step 5: Commit**

```bash
git add shared/api.ts worker/src/overview.ts worker/src/api worker/src/views/dashboard.ts worker/src/region.ts worker/src/index.ts worker/test/api-overview.test.ts
git commit -m "API: overview facts and the SSH password

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 4: Lifecycle actions

**Files:**
- Create: `worker/src/api/lifecycle.ts`, `worker/test/api-lifecycle.test.ts`
- Modify: `worker/src/profiles.ts` (add `resolveDeployTarget`), `worker/src/index.ts` (`/actions/deploy` uses it), `worker/src/api/index.ts`

**Interfaces:**
- Consumes: `startDeploy`, `startDestroy`, `cancelActive`, `reconcile`, `extendAutoDestroy`, `refreshInventory`, `startHibernate`, `startResume`, `startMove`, `startSpeedTest`, `setSshAllowedCidr`, `requireBudgetOk`, `markActed`, `regionName`, `effectiveConfig`, `RunError(message, code)`.
- Produces: `resolveDeployTarget(env, o: { profileId?: number | null; region?: string | null }): Promise<{ region?: string; vmSize?: string; profile: string | null }>`; `parseHours(v: unknown): number | null | "invalid"`; `registerLifecycle(api)`.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/api-lifecycle.test.ts`:

```ts
// api-lifecycle.test.ts
//
// Plain English: deploy, move, hibernate, resume, tear down, clean up,
// cancel, check Azure, extend, speed test and allow SSH, through the data
// API: each answers { ok, message } or a refusal with the right status,
// and counts as Steven having read the notes.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { parseHours } from "../src/api/lifecycle";

afterEach(() => vi.unstubAllGlobals());

describe("POST /deploy", () => {
  it("starts a deploy and marks the notes read", async () => {
    const { env, world } = apiEnv();
    await db.addAlert(env, "info", "Old note");
    const r = await api(env, "POST", "/deploy", { hours: 2 });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toMatch(/^Deploy started in UK South/);
    expect(world.dispatches.map((d) => d.action)).toEqual(["apply"]);
    expect(await db.unacknowledgedAlerts(env)).toHaveLength(0);
  });

  it("deploys a profile", async () => {
    const { env, world } = apiEnv();
    await db.addProfile(env, { name: "Test exit", region: "eastus", vm_size: "Standard_B1s" });
    const p = (await db.listProfiles(env)).find((x) => x.name === "Test exit")!;
    const r = await api(env, "POST", "/deploy", { profileId: p.id });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatch(/^Deploy started: Test exit/);
    expect(world.dispatches[0].payload.region).toBe("eastus");
  });

  it("refuses an unknown region (400), a missing profile (404) and a second deploy (409)", async () => {
    const { env } = apiEnv();
    expect((await api(env, "POST", "/deploy", { region: "constructor" })).json.error).toEqual({ code: "bad_input", message: "Unknown region." });
    expect((await api(env, "POST", "/deploy", { region: "constructor" })).status).toBe(400);
    const missing = await api(env, "POST", "/deploy", { profileId: 999 });
    expect(missing.status).toBe(404);
    await api(env, "POST", "/deploy", {});
    const again = await api(env, "POST", "/deploy", {});
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("refused");
  });

  it("needs confirmation over budget (422), and goes ahead with it", async () => {
    const { env, world } = apiEnv();
    await env.DB.prepare("INSERT INTO cost_days (day, gbp, fetched_at) VALUES (?1, 25, 'x')").bind(new Date().toISOString().slice(0, 8) + "01").run();
    const r = await api(env, "POST", "/deploy", {});
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("over_budget");
    expect(world.dispatches).toHaveLength(0);
    expect((await api(env, "POST", "/deploy", { overBudgetOk: true })).status).toBe(200);
  });

  it("refuses bad hours with the field named, and starts nothing", async () => {
    const { env, world } = apiEnv();
    // (NaN is not tested here: JSON sends it as null, which rightly means "no limit".)
    for (const hours of ["2", -1, 1000, {}]) {
      const r = await api(env, "POST", "/deploy", { hours });
      expect(r.status).toBe(400);
      expect(r.json.error.field).toBe("hours");
    }
    expect(world.dispatches).toHaveLength(0);
  });
});

describe("POST /destroy", () => {
  it("needs the word destroy (422) before it tears down", async () => {
    const { env, world } = apiEnv();
    const r = await api(env, "POST", "/destroy", { confirm: "yes" });
    expect(r.status).toBe(422);
    expect(r.json.error).toEqual({ code: "confirm_required", message: 'Type "destroy" to confirm.', field: "confirm" });
    expect(world.dispatches).toHaveLength(0);
    const ok = await api(env, "POST", "/destroy", { confirm: " Destroy " });
    expect(ok.status).toBe(200);
    expect(ok.json.message).toMatch(/^Tear-down started/);
    expect(world.dispatches.map((d) => d.action)).toEqual(["destroy"]);
  });
});

describe("other actions", () => {
  it("cancel with nothing running says so", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/cancel");
    expect(r.json).toEqual({ ok: true, message: "Nothing to cancel." });
  });

  it("move needs a profile id", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/move", {});
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("profileId");
  });

  it("allow-ssh refuses when nothing is running", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/allow-ssh", undefined, { "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "203.0.113.7" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("Nothing is running.");
  });
});

describe("parseHours", () => {
  it("accepts nothing, 0 and 0-168, and refuses everything else", () => {
    expect(parseHours(undefined)).toBeNull();
    expect(parseHours(null)).toBeNull();
    expect(parseHours(0)).toBeNull();
    expect(parseHours(2.5)).toBe(2.5);
    expect(parseHours(168)).toBe(168);
    expect(parseHours(168.5)).toBe("invalid");
    expect(parseHours(-1)).toBe("invalid");
    expect(parseHours("2")).toBe("invalid");
    expect(parseHours(Number.POSITIVE_INFINITY)).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-lifecycle.test.ts`
Expected: FAIL, `Failed to resolve import "../src/api/lifecycle"`.

- [ ] **Step 3a: One place that turns a choice into a deploy target**

In `worker/src/profiles.ts`, add `import { REGIONS } from "./region";` (merge with the existing `./region` import) and append:

```ts
/**
 * Where a deploy goes: a profile (its region and size), a region on its
 * own, or the usual settings when neither is given. Throws RunError
 * "not_found" for a missing profile and "bad_input" for an unknown region.
 */
export async function resolveDeployTarget(env: Env, o: { profileId?: number | null; region?: string | null }): Promise<{ region?: string; vmSize?: string; profile: string | null }> {
  if (o.profileId !== undefined && o.profileId !== null) {
    const p = await db.getProfile(env, Number(o.profileId));
    if (!p) throw new RunError("No such profile.", "not_found");
    return { region: p.region, vmSize: p.vm_size, profile: p.name };
  }
  if (o.region) {
    // hasOwn, not "in": "in" would also accept built-in names like "constructor".
    if (!Object.hasOwn(REGIONS, o.region)) throw new RunError("Unknown region.", "bad_input");
    return { region: o.region, profile: null };
  }
  return { profile: null };
}
```

In `worker/src/index.ts`, `/actions/deploy`: replace the `let region ... if (choice.startsWith("p:")) { ... } else if (choice.startsWith("r:")) { ... }` block with:

```ts
    const { region, vmSize, profile } = await resolveDeployTarget(c.env, {
      profileId: choice.startsWith("p:") ? Number(choice.slice(2)) : null,
      region: choice.startsWith("r:") ? choice.slice(2) : null,
    });
```

and add `resolveDeployTarget` to the `./profiles` import (the rest of the route is unchanged).

- [ ] **Step 3b: The lifecycle routes**

Create `worker/src/api/lifecycle.ts`:

```ts
// api/lifecycle.ts
//
// Plain English: the buttons: deploy, move, hibernate, resume, tear down,
// clean up, cancel, check Azure, extend the timer, speed test, and allow
// SSH from this browser's address. Each answers { ok, message } or a
// refusal with the right status, and every press counts as Steven having
// read the watchman's notes (seen.ts), as on the pages.

import type { Hono, Context } from "hono";
import { body, fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { startDeploy, startDestroy, cancelActive, reconcile, extendAutoDestroy, refreshInventory, RunError } from "../runs";
import { startHibernate, startResume } from "../standby";
import { startMove, resolveDeployTarget } from "../profiles";
import { startSpeedTest } from "../speedtest";
import { setSshAllowedCidr } from "../azure";
import { requireBudgetOk } from "../budget";
import { regionName } from "../region";
import { markActed } from "../seen";
import type { ApiOk } from "../../../shared/api";

/** Hours for a timer: null for none (absent, null or 0), a number above 0 up to a week, or "invalid". */
export function parseHours(v: unknown): number | null | "invalid" {
  if (v === undefined || v === null || v === 0) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 168) return "invalid";
  return v;
}

const HOURS_PROBLEM = "Hours must be a number from 0 (no limit) to 168.";

/** Run an action, answer its message, and count the press as having read the notes. */
async function act(c: Context<ApiEnv>, fn: () => Promise<string>) {
  try {
    const out: ApiOk = { ok: true, message: await fn() };
    return c.json(out);
  } finally {
    await markActed(c.env).catch((e) => console.error("mark acted:", e));
  }
}

export function registerLifecycle(api: Hono<ApiEnv>): void {
  api.post("/deploy", async (c) => {
    const b = (await body<{ hours?: unknown; profileId?: unknown; region?: unknown; overBudgetOk?: unknown }>(c)) ?? {};
    const hours = parseHours(b.hours);
    if (hours === "invalid") return fail(c, 400, "bad_input", HOURS_PROBLEM, "hours");
    if (b.profileId !== undefined && b.profileId !== null && !Number.isInteger(b.profileId)) return fail(c, 400, "bad_input", "profileId must be a whole number.", "profileId");
    const user = c.get("user");
    return act(c, async () => {
      const t = await resolveDeployTarget(c.env, { profileId: (b.profileId as number | null | undefined) ?? null, region: typeof b.region === "string" ? b.region : null });
      await requireBudgetOk(c.env, b.overBudgetOk === true);
      const run = await startDeploy(c.env, { hours, requesterIp: c.req.header("CF-Connecting-IP") ?? null, requestedBy: user, region: t.region, vmSize: t.vmSize, profile: t.profile });
      return `Deploy started${t.profile ? `: ${t.profile}` : ""} in ${regionName(t.region ?? (await effectiveConfig(c.env)).region)} (${run.id}). About 4 minutes.`;
    });
  });

  api.post("/move", async (c) => {
    const b = (await body<{ profileId?: unknown }>(c)) ?? {};
    if (!Number.isInteger(b.profileId)) return fail(c, 400, "bad_input", "Pick a profile to move to.", "profileId");
    const user = c.get("user");
    return act(c, async () => {
      const cfg = await effectiveConfig(c.env);
      return startMove(c.env, { profileId: b.profileId as number, hours: cfg.autoDestroyDefaultHours > 0 ? cfg.autoDestroyDefaultHours : null, by: user, requesterIp: c.req.header("CF-Connecting-IP") ?? null });
    });
  });

  api.post("/hibernate", async (c) => {
    const user = c.get("user");
    return act(c, () => startHibernate(c.env, user, "dashboard"));
  });

  api.post("/resume", async (c) => {
    const hours = parseHours(((await body<{ hours?: unknown }>(c)) ?? {}).hours);
    if (hours === "invalid") return fail(c, 400, "bad_input", HOURS_PROBLEM, "hours");
    const user = c.get("user");
    return act(c, () => startResume(c.env, user, hours));
  });

  api.post("/destroy", async (c) => {
    const b = (await body<{ confirm?: unknown }>(c)) ?? {};
    if (String(b.confirm ?? "").trim().toLowerCase() !== "destroy") return fail(c, 422, "confirm_required", 'Type "destroy" to confirm.', "confirm");
    const user = c.get("user");
    return act(c, async () => `Tear-down started (${(await startDestroy(c.env, user, "dashboard")).id}).`);
  });

  api.post("/cleanup", async (c) => {
    const user = c.get("user");
    return act(c, async () => `Clean-up started (${(await startDestroy(c.env, user, "clean up after failure")).id}).`);
  });

  api.post("/cancel", (c) => act(c, () => cancelActive(c.env)));

  api.post("/reconcile", async (c) => {
    const user = c.get("user");
    return act(c, () => reconcile(c.env, user));
  });

  api.post("/extend", async (c) => {
    const hours = parseHours(((await body<{ hours?: unknown }>(c)) ?? {}).hours);
    if (hours === "invalid") return fail(c, 400, "bad_input", HOURS_PROBLEM, "hours");
    return act(c, async () => {
      const at = await extendAutoDestroy(c.env, hours);
      return at ? `Auto-destroy set for ${new Date(at).toLocaleString("en-GB", { timeZone: "Europe/London" })}.` : "Auto-destroy cleared. It runs until you tear it down.";
    });
  });

  api.post("/speedtest", (c) => act(c, () => startSpeedTest(c.env)));

  api.post("/allow-ssh", async (c) => {
    const user = c.get("user");
    const addr = c.req.header("CF-Connecting-IP") ?? null;
    return act(c, async () => {
      if (!addr || addr.includes(":")) throw new RunError("Could not read an IPv4 address for this browser.");
      if ((await getSnapshot(c.env)).state !== "running") throw new RunError("Nothing is running.");
      await setSshAllowedCidr(c.env, `${addr}/32`);
      await db.addAlert(c.env, "info", `SSH allowed from ${addr} by ${user} (live NSG change).`);
      await refreshInventory(c.env);
      return `SSH now allowed from ${addr}. Takes effect within a few seconds.`;
    });
  });
}
```

In `worker/src/api/index.ts`, add `import { registerLifecycle } from "./lifecycle";` and `registerLifecycle(api);` after `registerOverview(api);`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-lifecycle.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass (the lifecycle and budget tests prove `/actions/deploy` still behaves).

- [ ] **Step 5: Commit**

```bash
git add worker/src/api worker/src/profiles.ts worker/src/index.ts worker/test/api-lifecycle.test.ts
git commit -m "API: lifecycle actions

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 5: Reading history back

**Files:**
- Modify: `worker/src/history.ts` (add range reading), `worker/src/api/index.ts`, `shared/api.ts`
- Create: `worker/src/api/history.ts`, `worker/test/api-history.test.ts`

**Interfaces:**
- Consumes: plan 1's `hist_vm`, `hist_client` (keys `(res, t)`, `(res, t, peer_id)`), `bucket`, `RAW_RES`, `SUMMARY_RES`; `db.getPeer`.
- Produces in `worker/src/history.ts`:
  - `type HistoryRange = "1h" | "24h" | "7d" | "30d"`, `RANGE_MS`, `RANGE_STEP` (`{ "1h": 60, "24h": 300, "7d": 1800, "30d": 7200 }`)
  - `interface VmPoint { t: string; expected: number; received: number; load1: number | null; rx_rate: number | null; tx_rate: number | null; rx_rate_max: number | null; tx_rate_max: number | null; peers_online: number | null; dns_up: number | null }`
  - `interface ClientPoint { t: string; online: number; latency_avg: number | null; latency_max: number | null; rx: number; tx: number }`
  - `readVmHistory(env, range, now: Date): Promise<VmHistory>` where `VmHistory = { range; step; from; to; points: VmPoint[]; latest: string | null; availability: { expected: number; received: number; pct: number | null } }`
  - `readClientHistory(env, peerId: number, range, now: Date): Promise<ClientHistory>` where `ClientHistory = { range; step; from; to; points: ClientPoint[]; latest: string | null }`
- Produces: `registerHistory(api)`; `VmHistoryResponse`, `ClientHistoryResponse` in `shared/api.ts`.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/api-history.test.ts`:

```ts
// api-history.test.ts
//
// Plain English: reading the history back for a time range: one point per
// step (a minute for the last hour, 5 minutes for a day, 30 minutes for a
// week, 2 hours for 30 days), availability as heartbeats received out of
// those expected, and "no data" as no data, never as 0 or 100 %.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { readVmHistory, readClientHistory } from "../src/history";
import type { Env } from "../src/env";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-10-05T12:00:00Z");
const vm = (env: Env, res: number, t: string, expected: number, received: number, rx: number) =>
  env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received, rx_rate, rx_rate_max, peers_online, dns_up) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, 1)").bind(res, t, expected, received, rx).run();

describe("readVmHistory", () => {
  it("gives one point per minute for the last hour, with availability", async () => {
    const { env } = apiEnv();
    await vm(env, 60, "2026-10-05T11:10:00Z", 1, 1, 100);
    await vm(env, 60, "2026-10-05T11:11:00Z", 1, 0, 0);
    await vm(env, 60, "2026-10-05T10:59:00Z", 1, 1, 5); // before the hour: left out
    const h = await readVmHistory(env, "1h", NOW);
    expect(h.step).toBe(60);
    expect(h.from).toBe("2026-10-05T11:00:00Z");
    expect(h.points.map((p) => [p.t, p.received, p.rx_rate])).toEqual([["2026-10-05T11:10:00Z", 1, 100], ["2026-10-05T11:11:00Z", 0, 0]]);
    expect(h.availability).toEqual({ expected: 2, received: 1, pct: 50 });
    expect(h.latest).toBe("2026-10-05T11:10:00Z");
  });

  it("combines raw minutes and 5-minute summaries over a week, in 30-minute points", async () => {
    const { env } = apiEnv();
    await vm(env, 300, "2026-09-30T08:00:00Z", 5, 5, 10);
    await vm(env, 300, "2026-09-30T08:05:00Z", 5, 4, 30);
    await vm(env, 60, "2026-10-05T11:31:00Z", 1, 1, 50);
    const h = await readVmHistory(env, "7d", NOW);
    expect(h.step).toBe(1800);
    expect(h.points.map((p) => [p.t, p.expected, p.received, p.rx_rate])).toEqual([
      ["2026-09-30T08:00:00Z", 10, 9, 20],
      ["2026-10-05T11:30:00Z", 1, 1, 50],
    ]);
    expect(h.availability.pct).toBe(90.9);
  });

  it("says no data, not 0 % or 100 %, when nothing was recorded", async () => {
    const { env } = apiEnv();
    const h = await readVmHistory(env, "24h", NOW);
    expect(h.points).toEqual([]);
    expect(h.availability).toEqual({ expected: 0, received: 0, pct: null });
    expect(h.latest).toBeNull();
  });

  it("reads by index, never a whole table", async () => {
    const { env } = apiEnv();
    const seen: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return real(sql);
    });
    await readVmHistory(env, "30d", NOW);
    await readClientHistory(env, 7, "30d", NOW);
    vi.mocked(env.DB.prepare).mockRestore();
    for (const sql of seen) {
      const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = await real(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(n).fill(1)).all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).filter((d) => /^SCAN hist_/.test(d)), sql).toEqual([]);
    }
  });
});

describe("readClientHistory", () => {
  it("gives one client's points only", async () => {
    const { env } = apiEnv();
    const row = (peer: number, t: string, online: number, lat: number | null, rx: number) =>
      env.DB.prepare("INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx) VALUES (60, ?1, ?2, ?3, 10, ?4, ?4, ?5, 0)").bind(t, peer, online, lat, rx).run();
    await row(7, "2026-10-05T11:50:00Z", 1, 20, 1000);
    await row(7, "2026-10-05T11:51:00Z", 1, 40, 500);
    await row(9, "2026-10-05T11:50:00Z", 1, 5, 99);
    const h = await readClientHistory(env, 7, "1h", NOW);
    expect(h.points).toEqual([
      { t: "2026-10-05T11:50:00Z", online: 1, latency_avg: 20, latency_max: 20, rx: 1000, tx: 0 },
      { t: "2026-10-05T11:51:00Z", online: 1, latency_avg: 40, latency_max: 40, rx: 500, tx: 0 },
    ]);
    expect(h.latest).toBe("2026-10-05T11:51:00Z");
  });
});

describe("GET /history", () => {
  it("answers the VM's history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { env } = apiEnv();
    await vm(env, 60, "2026-10-05T11:59:00Z", 1, 1, 7);
    const r = await api(env, "GET", "/history?scope=vm&range=1h");
    expect(r.status).toBe(200);
    expect(r.json.points).toHaveLength(1);
    expect(r.json.availability.pct).toBe(100);
  });

  it("refuses a bad range or scope (400) and an unknown client (404)", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/history?scope=vm&range=2y")).json.error.field).toBe("range");
    expect((await api(env, "GET", "/history?scope=disk&range=1h")).json.error.field).toBe("scope");
    expect((await api(env, "GET", "/history?scope=client&range=1h&id=abc")).json.error.field).toBe("id");
    expect((await api(env, "GET", "/history?scope=client&range=1h&id=42")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-history.test.ts`
Expected: FAIL, `readVmHistory is not a function` (import error).

- [ ] **Step 3a: Range reading in `worker/src/history.ts`**

Append:

```ts
export type HistoryRange = "1h" | "24h" | "7d" | "30d";
export const RANGE_MS: Record<HistoryRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
/** Seconds per point for each range: about 60 to 360 points, enough for a chart. */
export const RANGE_STEP: Record<HistoryRange, number> = { "1h": 60, "24h": 300, "7d": 1800, "30d": 7200 };

export interface VmPoint {
  t: string;
  expected: number;
  received: number;
  load1: number | null;
  rx_rate: number | null;
  tx_rate: number | null;
  rx_rate_max: number | null;
  tx_rate_max: number | null;
  peers_online: number | null;
  dns_up: number | null;
}

export interface ClientPoint {
  t: string;
  online: number;
  latency_avg: number | null;
  latency_max: number | null;
  rx: number;
  tx: number;
}

export interface VmHistory {
  range: HistoryRange;
  step: number;
  from: string;
  to: string;
  points: VmPoint[];
  /** The newest point with a heartbeat in it, or null. */
  latest: string | null;
  /** Heartbeat minutes received out of those expected while running; pct null when there is nothing to judge. */
  availability: { expected: number; received: number; pct: number | null };
}

export interface ClientHistory {
  range: HistoryRange;
  step: number;
  from: string;
  to: string;
  points: ClientPoint[];
  latest: string | null;
}

/** The slot of a stored time at `?3` seconds per point, in SQL. */
const POINT = `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', t) AS INTEGER) / ?3) * ?3, 'unixepoch')`;

function window(range: HistoryRange, now: Date) {
  const step = RANGE_STEP[range];
  return { step, from: bucket(now.getTime() - RANGE_MS[range], step), to: bucket(now.getTime(), 1) };
}

/** The VM's history for a range: raw minutes and 5-minute summaries together, one point per step. */
export async function readVmHistory(env: Env, range: HistoryRange, now: Date): Promise<VmHistory> {
  const { step, from, to } = window(range, now);
  const rows = (
    await env.DB.prepare(
      `SELECT ${POINT} AS t, SUM(expected) AS expected, SUM(received) AS received, AVG(load1) AS load1,
              AVG(rx_rate) AS rx_rate, AVG(tx_rate) AS tx_rate, MAX(rx_rate_max) AS rx_rate_max, MAX(tx_rate_max) AS tx_rate_max,
              MAX(peers_online) AS peers_online, MIN(dns_up) AS dns_up
       FROM hist_vm WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 GROUP BY 1 ORDER BY 1`,
    )
      .bind(from, to, step)
      .all<VmPoint>()
  ).results;
  const expected = rows.reduce((n, p) => n + p.expected, 0);
  const received = rows.reduce((n, p) => n + p.received, 0);
  return {
    range,
    step,
    from,
    to,
    points: rows,
    latest: [...rows].reverse().find((p) => p.received > 0)?.t ?? null,
    availability: { expected, received, pct: expected ? Math.round((received / expected) * 1000) / 10 : null },
  };
}

/** One client's history for a range. No point in a step means the client was idle and offline then. */
export async function readClientHistory(env: Env, peerId: number, range: HistoryRange, now: Date): Promise<ClientHistory> {
  const { step, from, to } = window(range, now);
  const rows = (
    await env.DB.prepare(
      `SELECT ${POINT} AS t, MAX(online) AS online, AVG(latency_avg) AS latency_avg, MAX(latency_max) AS latency_max, SUM(rx) AS rx, SUM(tx) AS tx
       FROM hist_client WHERE res IN (${RAW_RES}, ${SUMMARY_RES}) AND t >= ?1 AND t <= ?2 AND peer_id = ?4 GROUP BY 1 ORDER BY 1`,
    )
      .bind(from, to, step, peerId)
      .all<ClientPoint>()
  ).results;
  return { range, step, from, to, points: rows, latest: rows.at(-1)?.t ?? null };
}
```

- [ ] **Step 3b: The route**

Append to `shared/api.ts` (add `VmHistory`, `ClientHistory` to a type import from `../worker/src/history`):

```ts
/** GET /api/v1/history?scope=vm&range= */
export type VmHistoryResponse = VmHistory;
/** GET /api/v1/history?scope=client&id=&range= */
export type ClientHistoryResponse = ClientHistory;
```

Create `worker/src/api/history.ts`:

```ts
// api/history.ts
//
// Plain English: the recorded history for a chart: the VM's (health,
// traffic, availability) or one client's (online, latency, bytes), for the
// last hour, day, week or 30 days.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { readVmHistory, readClientHistory, RANGE_MS, type HistoryRange } from "../history";

export function registerHistory(api: Hono<ApiEnv>): void {
  api.get("/history", async (c) => {
    const range = c.req.query("range") ?? "";
    if (!Object.hasOwn(RANGE_MS, range)) return fail(c, 400, "bad_input", "Range is one of 1h, 24h, 7d or 30d.", "range");
    const scope = c.req.query("scope");
    const now = new Date();
    if (scope === "vm") return c.json(await readVmHistory(c.env, range as HistoryRange, now));
    if (scope !== "client") return fail(c, 400, "bad_input", "Scope is vm or client.", "scope");
    const id = Number(c.req.query("id"));
    if (!Number.isInteger(id) || id < 1) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    if (!(await db.getPeer(c.env, id))) return fail(c, 404, "not_found", "No such client.");
    return c.json(await readClientHistory(c.env, id, range as HistoryRange, now));
  });
}
```

In `worker/src/api/index.ts`, add `import { registerHistory } from "./history";` and `registerHistory(api);` after `registerLifecycle(api);`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-history.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass.

- [ ] **Step 5: Commit**

```bash
git add shared/api.ts worker/src/history.ts worker/src/api worker/test/api-history.test.ts
git commit -m "API: history read-back for the VM and each client

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 6: Reading clients

**Files:**
- Create: `worker/src/clients.ts`, `worker/src/api/clients.ts`, `worker/test/api-clients.test.ts`
- Modify: `worker/src/peers.ts` (extract `clientAllowedIps`), `worker/src/db.ts` (add `auditFor`), `worker/src/api/index.ts`, `shared/api.ts`

**Interfaces:**
- Consumes: `peerOnline`, `peerExpired`, `peerStale`, `peerIp6`, `nextFreeIp`, `serverPublicKey`, `effectiveConfig`, `getSnapshot`, `db.listPeers`, `db.getPeer`.
- Produces:
  - `worker/src/peers.ts`: `clientAllowedIps(cfg: { subnet: string; subnet6: string; loopbackIp: string; vnetCidr: string; homeLanCidr: string }, peer: { full_tunnel: number; azure_vnet?: number; home_lan?: number }): string[]`
  - `worker/src/db.ts`: `auditFor(env, target: string, limit?: number): Promise<AuditEntry[]>`
  - `worker/src/clients.ts`: `type ClientStatus = "disabled" | "expired" | "removing" | "headend_down" | "loading" | "online" | "offline"`, `clientStatus(p: Peer, live: AgentPeer | undefined, running: boolean, now?: number): ClientStatus`, `EXPIRING_SOON_MS`, `interface ClientView`, `clientView(p, snap, cfg, now): ClientView`, `clientKpis(views: ClientView[]): ClientKpis`
  - `registerClients(api)` (read routes); `ClientsResponse`, `ClientDetailResponse` in `shared/api.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/api-clients.test.ts`:

```ts
// api-clients.test.ts
//
// Plain English: the Clients screen's data: every client with what the VM
// says about it, the exact routes its config sends through the tunnel,
// stale and expiry flags, and the counts across the top; one client's
// detail with its top destinations and change history.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { lastGhRun } from "./harness";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { clientAllowedIps } from "../src/peers";
import { clientStatus } from "../src/clients";
import { saveSnapshot } from "../src/state";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const PHONE = "P".repeat(43) + "=";
const LAPTOP = "L".repeat(43) + "=";
const cfg = { subnet: "10.13.13.0/24", subnet6: "fd13:13::/64", loopbackIp: "10.13.255.1", vnetCidr: "10.50.0.0/16", homeLanCidr: "192.168.1.0/24" };
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");
const line = (key: string, ip: string, hs: number) => `${key}\t(none)\t203.0.113.25:4000\t${ip}/32\t${hs}\t1000\t2000\t0`;

async function deployWith(env: Env, world: ReturnType<typeof apiEnv>["world"]) {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

describe("clientAllowedIps", () => {
  it("lists exactly what each kind of config sends through the tunnel", () => {
    expect(clientAllowedIps(cfg, { full_tunnel: 0 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64"]);
    expect(clientAllowedIps(cfg, { full_tunnel: 0, azure_vnet: 1, home_lan: 1 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64", "10.50.0.0/16", "192.168.1.0/24"]);
    expect(clientAllowedIps(cfg, { full_tunnel: 1, azure_vnet: 1 })).toEqual(["0.0.0.0/0", "::/0"]);
    expect(clientAllowedIps({ ...cfg, homeLanCidr: "" }, { full_tunnel: 0, home_lan: 1 })).toEqual(["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64"]);
  });
});

describe("clientStatus", () => {
  const now = Date.parse("2026-10-02T10:00:00Z");
  const peer = (o: Partial<db.Peer> = {}) => ({ id: 1, name: "x", public_key: PHONE, ip: "10.13.13.2", enabled: 1, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: "x", note: null, ...o }) as db.Peer;
  const live = (hsAgo: number) => ({ public_key: PHONE, endpoint: null, allowed_ips: "", latest_handshake: now / 1000 - hsAgo, rx: 0, tx: 0 });
  it("says what the VM reports, not just what the table says", () => {
    expect(clientStatus(peer(), live(10), true, now)).toBe("online");
    expect(clientStatus(peer(), live(600), true, now)).toBe("offline");
    expect(clientStatus(peer(), undefined, true, now)).toBe("loading");
    expect(clientStatus(peer(), undefined, false, now)).toBe("headend_down");
    expect(clientStatus(peer({ enabled: 0 }), live(10), true, now)).toBe("removing");
    expect(clientStatus(peer({ enabled: 0 }), undefined, true, now)).toBe("disabled");
    expect(clientStatus(peer({ enabled: 0, expires_at: "2026-10-01T00:00:00Z" }), undefined, false, now)).toBe("expired");
    expect(clientStatus(peer({ expires_at: "2026-10-01T00:00:00Z" }), undefined, false, now)).toBe("expired");
  });
});

describe("GET /clients", () => {
  it("lists clients with live state, routes, flags and counts", async () => {
    const { env, world } = apiEnv();
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false, azure_vnet: true });
    await db.addPeer(env, { name: "Laptop", public_key: LAPTOP, ip: "10.13.13.3", full_tunnel: true, expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    const token = await deployWith(env, world);
    const s = Math.floor(Date.now() / 1000);
    await handleAgent(env, token, { dump: DUMP([line(PHONE, "10.13.13.2", s - 5), line(LAPTOP, "10.13.13.3", s - 900)]), rtt: { [PHONE]: 20 } });
    const r = await api(env, "GET", "/clients");
    expect(r.status).toBe(200);
    expect(r.json.running).toBe(true);
    const phone = r.json.clients.find((x: { name: string }) => x.name === "Phone");
    expect(phone).toMatchObject({ status: "online", lastLatencyMs: 20, allowedIps: ["10.13.13.0/24", "10.13.255.1/32", "fd13:13::/64", "10.50.0.0/16"], ip6: "fd13:13::2", isSite: false, expiresSoon: false });
    expect(phone.live).toMatchObject({ rx: 1000, tx: 2000 });
    const laptop = r.json.clients.find((x: { name: string }) => x.name === "Laptop");
    expect(laptop).toMatchObject({ status: "offline", allowedIps: ["0.0.0.0/0", "::/0"], expiresSoon: true });
    expect(r.json.kpis).toEqual({ total: 2, online: 1, avgLatencyMs: 20, fullTunnel: 1, stale: 0, expiringSoon: 1 });
    expect(r.json.nextIp).toBe("10.13.13.4");
    expect(r.json.serverPub).toBe("wapbe4SDSmZoefARMVLSAR2KHjjCU3DJ3McGiXQ+3yc=");
  });

  it("shows every client as headend down while nothing runs, with no latency", async () => {
    const { env } = apiEnv();
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "GET", "/clients");
    expect(r.json.running).toBe(false);
    expect(r.json.clients[0]).toMatchObject({ status: "headend_down", live: null, lastLatencyMs: null });
    expect(r.json.kpis.avgLatencyMs).toBeNull();
  });
});

describe("GET /clients/:id", () => {
  it("gives one client with its destinations and changes", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    await db.audit(env, "steven", "client.add", "Phone", null, { name: "Phone" });
    await db.audit(env, "steven", "client.add", "Other", null, { name: "Other" });
    await saveSnapshot(env, { talkers: { "10.13.13.2|1.1.1.1": { c: "10.13.13.2", r: "1.1.1.1", name: "one.one.one.one", up: 10, down: 20, bu: 0, bd: 0, at: "x" }, "10.13.13.9|8.8.8.8": { c: "10.13.13.9", r: "8.8.8.8", name: null, up: 1, down: 1, bu: 0, bd: 0, at: "x" } } });
    const r = await api(env, "GET", `/clients/${p.id}`);
    expect(r.status).toBe(200);
    expect(r.json.client.name).toBe("Phone");
    expect(r.json.talkers.map((t: { r: string }) => t.r)).toEqual(["1.1.1.1"]);
    expect(r.json.changes.map((a: { target: string }) => a.target)).toEqual(["Phone"]);
  });

  it("answers 404 for a client that does not exist and 400 for a bad id", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/clients/99")).status).toBe(404);
    expect((await api(env, "GET", "/clients/abc")).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-clients.test.ts`
Expected: FAIL, `clientAllowedIps is not a function` / `Failed to resolve import "../src/clients"`.

- [ ] **Step 3a: One place that works out a config's routes**

In `worker/src/peers.ts`, add above `clientConfigTemplate`:

```ts
/** What a client's config sends through the tunnel (its AllowedIPs), in order. */
export function clientAllowedIps(
  cfg: { subnet: string; subnet6: string; loopbackIp: string; vnetCidr: string; homeLanCidr: string },
  peer: { full_tunnel: number; azure_vnet?: number; home_lan?: number },
): string[] {
  if (peer.full_tunnel) return ["0.0.0.0/0", "::/0"];
  return [cfg.subnet, `${cfg.loopbackIp}/32`]
    .concat(cfg.subnet6 ? [cfg.subnet6] : [])
    .concat(peer.azure_vnet ? [cfg.vnetCidr] : [])
    .concat(peer.home_lan && cfg.homeLanCidr ? [cfg.homeLanCidr] : []);
}
```

and in `clientConfigTemplate` replace the `const allowed = peer.full_tunnel ? [...] : [...]...;` expression with `const allowed = clientAllowedIps(cfg, peer);`.

- [ ] **Step 3b: One client's change history**

In `worker/src/db.ts`, append after `listAudit`:

```ts
/** The change log entries about one thing (a client's name), newest first. */
export async function auditFor(env: Env, target: string, limit = 50): Promise<AuditEntry[]> {
  return (await env.DB.prepare("SELECT * FROM audit WHERE target = ?1 ORDER BY at DESC, id DESC LIMIT ?2").bind(target, limit).all<AuditEntry>()).results;
}
```

- [ ] **Step 3c: The client view**

Create `worker/src/clients.ts`:

```ts
// clients.ts
//
// Plain English: one client as the Clients screen sees it: what the table
// says, what the VM reports (online is a handshake in the last 3 minutes;
// WireGuard has no session, only handshakes), the exact routes its config
// sends through the tunnel, and the stale and expiry flags; plus the counts
// across the top of the screen. Shared by the data API.

import type { Peer } from "./db";
import type { AgentPeer, Roam, Snapshot } from "./state";
import { peerOnline } from "./state";
import { clientAllowedIps, peerExpired, peerStale, peerIp6 } from "./peers";

export type ClientStatus = "disabled" | "expired" | "removing" | "headend_down" | "loading" | "online" | "offline";

/** "Expiring soon" means within a week. */
export const EXPIRING_SOON_MS = 7 * 86_400_000;

/**
 * What is true of this client right now. "removing" is switched off (or
 * expired) but still on the VM until the next heartbeat; "loading" is
 * switched on but not yet on the VM.
 */
export function clientStatus(p: Peer, live: AgentPeer | undefined, running: boolean, now = Date.now()): ClientStatus {
  const expired = peerExpired(p, now);
  if (!p.enabled || expired) return running && live ? "removing" : expired ? "expired" : "disabled";
  if (!running) return "headend_down";
  if (!live) return "loading";
  return peerOnline(live, now) ? "online" : "offline";
}

export interface ClientView extends Peer {
  status: ClientStatus;
  live: AgentPeer | null;
  /** Recent round-trip times in ms, oldest first (about the last 12 minutes). */
  latency: number[];
  lastLatencyMs: number | null;
  /** What its config sends through the tunnel; empty for the home site (its routes are below). */
  allowedIps: string[];
  /** Networks reached through it (the home site), else empty. */
  siteRoutes: string[];
  ip6: string | null;
  expired: boolean;
  stale: boolean;
  expiresSoon: boolean;
  isSite: boolean;
  roam: Roam | null;
}

export interface ClientKpis {
  total: number;
  online: number;
  avgLatencyMs: number | null;
  fullTunnel: number;
  stale: number;
  expiringSoon: number;
}

export function clientView(p: Peer, snap: Snapshot, cfg: { subnet: string; subnet6: string; loopbackIp: string; vnetCidr: string; homeLanCidr: string }, now = Date.now()): ClientView {
  const running = snap.state === "running";
  const live = running ? snap.agent?.peers.find((x) => x.public_key === p.public_key) : undefined;
  const status = clientStatus(p, live, running, now);
  const latency = snap.latency?.[p.public_key] ?? [];
  const expired = peerExpired(p, now);
  return {
    ...p,
    status,
    live: live ?? null,
    latency,
    lastLatencyMs: status === "online" ? latency.at(-1) ?? null : null,
    allowedIps: p.routes ? [] : clientAllowedIps(cfg, p),
    siteRoutes: p.routes ? p.routes.split(",").map((r) => r.trim()).filter(Boolean) : [],
    ip6: cfg.subnet6 ? peerIp6(cfg.subnet6, p.ip) : null,
    expired,
    stale: !!p.enabled && peerStale(p, now),
    expiresSoon: !!p.expires_at && !expired && Date.parse(p.expires_at) - now <= EXPIRING_SOON_MS,
    isSite: !!p.routes,
    roam: snap.roams?.[p.public_key] ?? null,
  };
}

export function clientKpis(views: ClientView[]): ClientKpis {
  const lat = views.map((v) => v.lastLatencyMs).filter((x): x is number => x !== null);
  return {
    total: views.length,
    online: views.filter((v) => v.status === "online").length,
    avgLatencyMs: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null,
    fullTunnel: views.filter((v) => v.full_tunnel).length,
    stale: views.filter((v) => v.stale).length,
    expiringSoon: views.filter((v) => v.expiresSoon).length,
  };
}
```

- [ ] **Step 3d: The read routes**

Append to `shared/api.ts` (add `AuditEntry` from `../worker/src/db`, `Talker` from `../worker/src/state`, and `ClientView`, `ClientKpis` from `../worker/src/clients` to its type imports):

```ts
/** GET /api/v1/clients */
export interface ClientsResponse {
  now: string;
  running: boolean;
  /** When the VM last reported (the age of the live columns), or null. */
  heartbeatAt: string | null;
  clients: ClientView[];
  kpis: ClientKpis;
  nextIp: string | null;
  nextIp6: string | null;
  serverPub: string | null;
  config: { subnet: string; subnet6: string; loopbackIp: string; vnetCidr: string; homeLanCidr: string; dnsName: string; port: number };
  /** Who talked to what this session, all clients. */
  talkers: Talker[];
  /** Throughput this session, one sample per heartbeat (bytes/s). */
  trafficHist: { t: string; rx: number; tx: number }[];
}

/** GET /api/v1/clients/:id */
export interface ClientDetailResponse {
  client: ClientView;
  talkers: Talker[];
  changes: AuditEntry[];
}
```

Create `worker/src/api/clients.ts`:

```ts
// api/clients.ts
//
// Plain English: the Clients screen's data (this task) and its changes
// (next task): every client with what the VM reports, the counts across
// the top, and one client's detail.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { serverPublicKey, nextFreeIp, peerIp6 } from "../peers";
import { clientView, clientKpis } from "../clients";
import type { ClientsResponse, ClientDetailResponse } from "../../../shared/api";

/** A client id from the address, or null when it is not one. */
export function idParam(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerClients(api: Hono<ApiEnv>): void {
  api.get("/clients", async (c) => {
    const [peers, snap, cfg, serverPub] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env), effectiveConfig(c.env), serverPublicKey(c.env)]);
    const now = Date.now();
    const clients = peers.map((p) => clientView(p, snap, cfg, now));
    const nextIp = nextFreeIp(cfg.subnet, peers.map((p) => p.ip));
    const out: ClientsResponse = {
      now: new Date(now).toISOString(),
      running: snap.state === "running",
      heartbeatAt: snap.last_agent_at,
      clients,
      kpis: clientKpis(clients),
      nextIp,
      nextIp6: nextIp && cfg.subnet6 ? peerIp6(cfg.subnet6, nextIp) : null,
      serverPub,
      config: { subnet: cfg.subnet, subnet6: cfg.subnet6, loopbackIp: cfg.loopbackIp, vnetCidr: cfg.vnetCidr, homeLanCidr: cfg.homeLanCidr, dnsName: cfg.dnsName, port: cfg.port },
      talkers: Object.values(snap.talkers ?? {}),
      trafficHist: snap.traffic_hist ?? [],
    };
    return c.json(out);
  });

  api.get("/clients/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    const [p, snap, cfg] = await Promise.all([db.getPeer(c.env, id), getSnapshot(c.env), effectiveConfig(c.env)]);
    if (!p) return fail(c, 404, "not_found", "No such client.");
    const out: ClientDetailResponse = {
      client: clientView(p, snap, cfg),
      talkers: Object.values(snap.talkers ?? {}).filter((t) => t.c === p.ip),
      changes: await db.auditFor(c.env, p.name),
    };
    return c.json(out);
  });
}
```

In `worker/src/api/index.ts`, add `import { registerClients } from "./clients";` and `registerClients(api);` after `registerHistory(api);`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-clients.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass (the config template tests prove `clientConfigTemplate` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add shared/api.ts worker/src/peers.ts worker/src/db.ts worker/src/clients.ts worker/src/api worker/test/api-clients.test.ts
git commit -m "API: clients with live state, routes, flags and counts

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 7: Changing clients

**Files:**
- Modify: `worker/src/clients.ts` (add the commands), `worker/src/index.ts` (`/api/peers`, `/api/peers/:id/rekey`, `/api/peers/:id/expiry` call them), `worker/src/api/clients.ts` (write routes), `shared/api.ts`
- Test: `worker/test/api-clients.test.ts`

**Interfaces:**
- Consumes: `db.addPeer`, `db.setPeerHomeLan`, `db.setPeerKey`, `db.setPeerAzureVnet`, `db.setPeerTunnelDns`, `db.setPeerEnabled`, `db.setPeerExpiry`, `db.deletePeer`, `db.getPeer`, `db.audit`, `validPeerName`, `isWgKey`, `serverPublicKey`, `nextFreeIp`, `clientConfigTemplate`, `expiryFrom`, `EXPIRY_DAYS`, `effectiveConfig`; Task 6's `idParam`.
- Produces in `worker/src/clients.ts`:
  - `type Refusal = { ok: false; status: 400 | 404 | 409 | 503; code: string; message: string; field?: string }`
  - `type Done<T> = { ok: true; value: T } | Refusal`
  - `addClient(env, user: string, input: { name?: unknown; public_key?: unknown; full_tunnel?: unknown; azure_vnet?: unknown; tunnel_dns?: unknown; home_lan?: unknown; expires_days?: unknown }): Promise<Done<{ peer: Peer; template: string }>>`
  - `rekeyClient(env, user, id: number, publicKey: unknown): Promise<Done<{ peer: Peer; template: string }>>`
  - `editClient(env, user, id: number, change: { home_lan?: unknown; azure_vnet?: unknown; tunnel_dns?: unknown; enabled?: unknown; expires_days?: unknown }): Promise<Done<Peer>>`
  - `deleteClient(env, user, id: number): Promise<Done<null>>`
- Produces: `ClientConfigResponse` in `shared/api.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/api-clients.test.ts`:

```ts
describe("POST /clients", () => {
  it("adds a client and returns its config template, keyed in the browser", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/clients", { name: "Tablet", public_key: PHONE, azure_vnet: true, expires_days: 7 });
    expect(r.status).toBe(200);
    expect(r.json.peer).toMatchObject({ name: "Tablet", ip: "10.13.13.2", azure_vnet: 1 });
    expect(r.json.peer.expires_at).not.toBeNull();
    expect(r.json.template).toContain("PrivateKey = __CLIENT_PRIVATE_KEY__");
    expect(r.json.template).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32, fd13:13::/64, 10.50.0.0/16");
    expect((await db.auditFor(env, "Tablet"))[0].action).toBe("client.add");
  });

  it("names the field at fault and adds nothing", async () => {
    const { env } = apiEnv();
    const bad = async (b: object, field: string) => {
      const r = await api(env, "POST", "/clients", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.field).toBe(field);
    };
    await bad({ name: "", public_key: PHONE }, "name");
    await bad({ name: "x".repeat(40), public_key: PHONE }, "name");
    await bad({ name: "Tablet", public_key: "nope" }, "public_key");
    await bad({ name: "Tablet", public_key: PHONE, full_tunnel: "yes" }, "full_tunnel");
    await bad({ name: "Tablet", public_key: PHONE, expires_days: 3 }, "expires_days");
    expect(await db.listPeers(env)).toEqual([]);
  });

  it("refuses a key that is already registered (409)", async () => {
    const { env } = apiEnv();
    await api(env, "POST", "/clients", { name: "One", public_key: PHONE });
    const r = await api(env, "POST", "/clients", { name: "Two", public_key: PHONE });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("That key is already registered.");
  });

  it("keeps the old page route working the same way", async () => {
    const { env } = apiEnv();
    const r = await (await import("../src/index")).default.fetch(
      new Request("http://localhost:8787/api/peers", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Old", public_key: LAPTOP }) }),
      env,
      { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext,
    );
    expect(r.status).toBe(200);
    expect((await r.json()).peer.name).toBe("Old");
    const bad = await (await import("../src/index")).default.fetch(
      new Request("http://localhost:8787/api/peers", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ name: "", public_key: LAPTOP }) }),
      env,
      { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Name: letters, digits, spaces, dashes; up to 32 characters." });
  });
});

describe("POST /clients/:id/rekey", () => {
  it("swaps the key and returns a new template", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "POST", `/clients/${p.id}/rekey`, { public_key: LAPTOP });
    expect(r.status).toBe(200);
    expect(r.json.peer.public_key).toBe(LAPTOP);
    expect(r.json.template).toContain("Address = 10.13.13.2/32");
    expect((await api(env, "POST", `/clients/${p.id}/rekey`, { public_key: "x" })).json.error.field).toBe("public_key");
    expect((await api(env, "POST", "/clients/999/rekey", { public_key: PHONE })).status).toBe(404);
  });
});

describe("PUT /clients/:id", () => {
  it("changes the switches and expiry, in one change-log entry", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "PUT", `/clients/${p.id}`, { home_lan: true, tunnel_dns: true, expires_days: 30 });
    expect(r.status).toBe(200);
    expect(r.json.peer).toMatchObject({ home_lan: 1, tunnel_dns: 1, azure_vnet: 0 });
    expect(Date.parse(r.json.peer.expires_at) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const log = await db.auditFor(env, "Phone");
    expect(log.map((a) => a.action)).toEqual(["client.edit"]);
  });

  it("logs switching off as client.disable, and expires_days 0 as never", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false, expires_at: "2030-01-01T00:00:00.000Z" });
    const r = await api(env, "PUT", `/clients/${p.id}`, { enabled: false, expires_days: 0 });
    expect(r.json.peer).toMatchObject({ enabled: 0, expires_at: null });
    expect((await db.auditFor(env, "Phone"))[0].action).toBe("client.disable");
  });

  it("refuses bad input and an expiry on the home site, changing nothing", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    expect((await api(env, "PUT", `/clients/${p.id}`, { enabled: "no" })).json.error.field).toBe("enabled");
    expect((await api(env, "PUT", `/clients/${p.id}`, { expires_days: 2 })).json.error.field).toBe("expires_days");
    await env.DB.prepare("INSERT INTO peers (name, public_key, ip, enabled, full_tunnel, routes, created_at) VALUES ('home-site', ?1, '10.13.13.10', 1, 0, '192.168.1.0/24', 'x')").bind(LAPTOP).run();
    const site = (await db.listPeers(env)).find((x) => x.routes)!;
    const r = await api(env, "PUT", `/clients/${site.id}`, { expires_days: 7 });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe("The home site does not expire.");
    expect(await db.auditFor(env, "Phone")).toEqual([]);
    expect((await api(env, "PUT", "/clients/999", { enabled: true })).status).toBe(404);
  });
});

describe("DELETE /clients/:id", () => {
  it("deletes and logs it; a second delete is 404", async () => {
    const { env } = apiEnv();
    const p = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const r = await api(env, "DELETE", `/clients/${p.id}`);
    expect(r.json).toEqual({ ok: true, message: "Deleted Phone. Its config stops working at the next heartbeat." });
    expect(await db.listPeers(env)).toEqual([]);
    expect((await db.auditFor(env, "Phone"))[0].action).toBe("client.delete");
    expect((await api(env, "DELETE", `/clients/${p.id}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/api-clients.test.ts`
Expected: FAIL, the new tests get 404 (no write routes yet); the old-route test passes (it pins today's behaviour before the refactor).

- [ ] **Step 3a: The commands, shared by the old routes and the API**

Append to `worker/src/clients.ts` (add to its imports: `import type { Env } from "./env";`, `import * as db from "./db";`, `import { effectiveConfig } from "./settings";`, and extend the `./peers` import with `validPeerName, isWgKey, serverPublicKey, nextFreeIp, clientConfigTemplate, expiryFrom, EXPIRY_DAYS`):

```ts
/** A refusal fit for the screen, with the status the API answers. */
export type Refusal = { ok: false; status: 400 | 404 | 409 | 503; code: string; message: string; field?: string };
export type Done<T> = { ok: true; value: T } | Refusal;

const no = (status: Refusal["status"], code: string, message: string, field?: string): Refusal => ({ ok: false, status, code, message, ...(field ? { field } : {}) });
const NAME_RULE = "Name: letters, digits, spaces, dashes; up to 32 characters.";
const KEY_RULE = "That is not a valid WireGuard public key.";

/** A switch from the API: absent, or a real true/false (not "yes", not 1). */
function flag(v: unknown): boolean | undefined | "bad" {
  if (v === undefined) return undefined;
  return typeof v === "boolean" ? v : "bad";
}

/** Expiry days from the API: absent, or one of 0 (never), 1, 7, 30. */
function days(v: unknown): number | undefined | "bad" {
  if (v === undefined) return undefined;
  return typeof v === "number" && EXPIRY_DAYS.includes(v) ? v : "bad";
}

/**
 * Add a client. The browser made the keypair and sends only the public
 * half; the answer carries the config with a placeholder where the
 * browser puts the private key.
 */
export async function addClient(
  env: Env,
  user: string,
  input: { name?: unknown; public_key?: unknown; full_tunnel?: unknown; azure_vnet?: unknown; tunnel_dns?: unknown; home_lan?: unknown; expires_days?: unknown },
): Promise<Done<{ peer: Peer; template: string }>> {
  const name = String(input.name ?? "").trim();
  if (!validPeerName(name)) return no(400, "bad_input", NAME_RULE, "name");
  if (!isWgKey(String(input.public_key ?? ""))) return no(400, "bad_input", KEY_RULE, "public_key");
  const f = { full_tunnel: flag(input.full_tunnel), azure_vnet: flag(input.azure_vnet), tunnel_dns: flag(input.tunnel_dns), home_lan: flag(input.home_lan) };
  for (const [k, v] of Object.entries(f)) if (v === "bad") return no(400, "bad_input", `${k} must be true or false.`, k);
  const d = days(input.expires_days);
  if (d === "bad") return no(400, "bad_input", "Expiry is 0 (never), 1, 7 or 30 days.", "expires_days");
  const serverPub = await serverPublicKey(env);
  if (!serverPub) return no(503, "not_configured", "Server key not configured.");
  const cfg = await effectiveConfig(env);
  const ip = nextFreeIp(cfg.subnet, (await db.listPeers(env)).map((p) => p.ip));
  if (!ip) return no(409, "refused", "No free tunnel addresses left.");
  let peer: Peer;
  try {
    peer = await db.addPeer(env, { name, public_key: String(input.public_key), ip, full_tunnel: f.full_tunnel === true, azure_vnet: f.azure_vnet === true, tunnel_dns: f.tunnel_dns === true, expires_at: expiryFrom(d) });
    if (f.home_lan === true && f.full_tunnel !== true) {
      await db.setPeerHomeLan(env, peer.id, true);
      peer = (await db.getPeer(env, peer.id))!;
    }
  } catch (e) {
    return no(409, "refused", /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message);
  }
  await db.audit(env, user, "client.add", peer.name, null, peer);
  return { ok: true, value: { peer, template: clientConfigTemplate(env, peer, serverPub) } };
}

/** New keys for an existing client: the browser sends the new public half. */
export async function rekeyClient(env: Env, user: string, id: number, publicKey: unknown): Promise<Done<{ peer: Peer; template: string }>> {
  if (!isWgKey(String(publicKey ?? ""))) return no(400, "bad_input", KEY_RULE, "public_key");
  const peer = await db.getPeer(env, id);
  if (!peer) return no(404, "not_found", "No such client.");
  const serverPub = await serverPublicKey(env);
  if (!serverPub) return no(503, "not_configured", "Server key not configured.");
  try {
    await db.setPeerKey(env, id, String(publicKey));
  } catch (e) {
    return no(409, "refused", /UNIQUE/.test(String(e)) ? "That key is already registered." : (e as Error).message);
  }
  const updated = (await db.getPeer(env, id))!;
  await db.audit(env, user, "client.rekey", peer.name, peer, updated);
  return { ok: true, value: { peer: updated, template: clientConfigTemplate(env, updated, serverPub) } };
}

/**
 * Change a client's switches and expiry, all checked before anything is
 * written, then one change-log entry. The home site never expires: losing
 * it would cut the home network off.
 */
export async function editClient(
  env: Env,
  user: string,
  id: number,
  change: { home_lan?: unknown; azure_vnet?: unknown; tunnel_dns?: unknown; enabled?: unknown; expires_days?: unknown },
): Promise<Done<Peer>> {
  const f = { home_lan: flag(change.home_lan), azure_vnet: flag(change.azure_vnet), tunnel_dns: flag(change.tunnel_dns), enabled: flag(change.enabled) };
  for (const [k, v] of Object.entries(f)) if (v === "bad") return no(400, "bad_input", `${k} must be true or false.`, k);
  const d = days(change.expires_days);
  if (d === "bad") return no(400, "bad_input", "Expiry is 0 (never), 1, 7 or 30 days.", "expires_days");
  const p = await db.getPeer(env, id);
  if (!p) return no(404, "not_found", "No such client.");
  if (d && p.routes) return no(400, "bad_input", "The home site does not expire.", "expires_days");
  if (f.home_lan !== undefined) await db.setPeerHomeLan(env, id, f.home_lan as boolean);
  if (f.azure_vnet !== undefined) await db.setPeerAzureVnet(env, id, f.azure_vnet as boolean);
  if (f.tunnel_dns !== undefined) await db.setPeerTunnelDns(env, id, f.tunnel_dns as boolean);
  if (f.enabled !== undefined) await db.setPeerEnabled(env, id, f.enabled as boolean);
  if (d !== undefined) await db.setPeerExpiry(env, id, expiryFrom(d));
  const after = (await db.getPeer(env, id))!;
  const onlySwitch = f.enabled !== undefined && f.home_lan === undefined && f.azure_vnet === undefined && f.tunnel_dns === undefined;
  const action = onlySwitch || (f.enabled !== undefined && !!p.enabled !== !!after.enabled) ? (after.enabled ? "client.enable" : "client.disable") : "client.edit";
  await db.audit(env, user, action, p.name, p, after);
  return { ok: true, value: after };
}

/** Delete a client. Its config stops working at the next heartbeat. */
export async function deleteClient(env: Env, user: string, id: number): Promise<Done<null>> {
  const gone = await db.getPeer(env, id);
  if (!gone) return no(404, "not_found", "No such client.");
  await db.deletePeer(env, id);
  await db.audit(env, user, "client.delete", gone.name, gone, null);
  return { ok: true, value: null };
}
```

Note on `editClient`'s audit action: switching `enabled` (alone, or with other switches) logs `client.enable` / `client.disable`; any other change logs `client.edit`, matching today's pages.

- [ ] **Step 3b: The old JSON routes call the commands**

In `worker/src/index.ts`, add `import { addClient, rekeyClient, editClient } from "./clients";` and replace the bodies of three routes (their paths and answers stay the same):

```ts
app.post("/api/peers", async (c) => {
  const body = await jsonBody<Record<string, unknown>>(c);
  if (!body) return c.json({ error: "bad json" }, 400);
  const r = await addClient(c.env, c.get("user"), body);
  return r.ok ? c.json(r.value) : c.json({ error: r.message }, r.status);
});
```

```ts
app.post("/api/peers/:id/rekey", async (c) => {
  const body = await jsonBody<{ public_key?: string }>(c);
  if (!body) return c.json({ error: "That is not a valid WireGuard public key." }, 400);
  const r = await rekeyClient(c.env, c.get("user"), Number(c.req.param("id")), body.public_key);
  return r.ok ? c.json(r.value) : c.json({ error: r.message }, r.status);
});
```

```ts
app.post("/api/peers/:id/expiry", async (c) => {
  const body = await jsonBody<{ days?: number }>(c);
  if (!body) return c.json({ error: "bad json" }, 400);
  const r = await editClient(c.env, c.get("user"), Number(c.req.param("id")), { expires_days: Number(body.days) || 0 });
  return r.ok ? c.json({ ok: true, expires_at: r.value.expires_at ?? null }) : c.json({ error: r.message }, r.status);
});
```

Ruling recorded with this plan: today's `/api/peers/:id/expiry` silently treated a day count not on the list as "never"; it now answers 400, as the API does. The page only ever sends 0, 1, 7 or 30, so nothing a person can do changes.

- [ ] **Step 3c: The write routes**

Append to `shared/api.ts`:

```ts
/** POST /api/v1/clients and POST /api/v1/clients/:id/rekey */
export interface ClientConfigResponse {
  peer: Peer;
  /** The client's config, with __CLIENT_PRIVATE_KEY__ where the browser puts the private key it made. */
  template: string;
}

/** PUT /api/v1/clients/:id */
export interface ClientEditResponse {
  peer: Peer;
}
```

(add `Peer` to the `../worker/src/db` type import.)

Append inside `registerClients` in `worker/src/api/clients.ts` (and extend its imports with `body` from `./app`, `addClient, rekeyClient, editClient, deleteClient, type Refusal` from `../clients`, and `ApiOk, ClientConfigResponse, ClientEditResponse` from the shared types):

```ts
  const refuse = (c: Context<ApiEnv>, r: Refusal) => fail(c, r.status, r.code, r.message, r.field);

  api.post("/clients", async (c) => {
    const r = await addClient(c.env, c.get("user"), (await body<Record<string, unknown>>(c)) ?? {});
    if (!r.ok) return refuse(c, r);
    const out: ClientConfigResponse = r.value;
    return c.json(out);
  });

  api.post("/clients/:id/rekey", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    const r = await rekeyClient(c.env, c.get("user"), id, ((await body<{ public_key?: unknown }>(c)) ?? {}).public_key);
    if (!r.ok) return refuse(c, r);
    const out: ClientConfigResponse = r.value;
    return c.json(out);
  });

  api.put("/clients/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    const r = await editClient(c.env, c.get("user"), id, (await body<Record<string, unknown>>(c)) ?? {});
    if (!r.ok) return refuse(c, r);
    const out: ClientEditResponse = { peer: r.value };
    return c.json(out);
  });

  api.delete("/clients/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    const gone = await db.getPeer(c.env, id);
    const r = await deleteClient(c.env, c.get("user"), id);
    if (!r.ok) return refuse(c, r);
    const out: ApiOk = { ok: true, message: `Deleted ${gone!.name}. Its config stops working at the next heartbeat.` };
    return c.json(out);
  });
```

(Add `import type { Context } from "hono";` to `worker/src/api/clients.ts` for the `refuse` helper.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/api-clients.test.ts` → PASS.
Run: `npm test` then `npm run typecheck` → both pass (the peers and expiry tests prove the old JSON routes still behave).

- [ ] **Step 5: Commit**

```bash
git add shared/api.ts worker/src/clients.ts worker/src/index.ts worker/src/api worker/test/api-clients.test.ts
git commit -m "API: add, re-key, change and delete clients (one implementation for pages and API)

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 8: Review and hand over

**Files:** none changed.

- [ ] **Step 1: Full verification**

Run: `npm test` and `npm run typecheck` (separately, reading each exit code).
Expected: all pass. Record the counts.

- [ ] **Step 2: Push and open the PR into `redesign`**

```bash
git push -u origin feat/api-core
gh pr create --base redesign --title "API core: /api/v1 foundation, overview, lifecycle, history, clients" --body-file - <<'EOF'
Plan 2a of the dashboard redesign (docs/superpowers/plans/2026-10-02-redesign-plan-2a-api-core.md).
Adds the JSON API the new app will use, behind the same login and same-origin checks; today's
pages are unchanged. Nothing is deployed (the redesign switches over in one deploy at the end).

Routes: GET session, POST notes/ack, GET overview, GET ssh-password, POST deploy/move/hibernate/
resume/destroy/cleanup/cancel/reconcile/extend/speedtest/allow-ssh, GET history, GET clients,
GET clients/:id, POST clients, POST clients/:id/rekey, PUT clients/:id, DELETE clients/:id.

Tests: <paste counts>.

https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV
EOF
gh pr checks --watch
```

Expected: both CI checks pass.

- [ ] **Step 3: Stop and ask Steven before merging into `redesign`.**
