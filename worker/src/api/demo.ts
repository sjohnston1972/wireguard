// api/demo.ts
//
// Plain English: demo mode's own switch (spec §7), on the REAL environment.
// These three routes work whether the caller is in demo mode or not (the gate
// lets them through as "control"); they read and write only the caller's
// demo_mode row and the demo store, nothing else.
//
//   GET  /demo          the caller's switch and what the demo store holds
//   PUT  /demo {on}     on: get the demo store ready (seed it if empty, out of
//                       date or 12 h old, budget permitting), THEN write the
//                       row; off: delete the row. Turning off never depends on
//                       the demo store.
//   POST /demo/refresh  re-seed the demo store (on or off), within its budget
//
// Every answer carries X-WG-Data: the data the caller sees after the call.
// Errors: 400 bad_input, 409 demo_busy (the message names when to try again),
// 503 demo_unknown (the switch could not be read or written) and 503
// demo_unavailable (the demo store failed).

import type { Context, Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { demoOn, setDemo } from "../demo/switch";
import { demoStub, DEMO_UNKNOWN_MESSAGE, DEMO_UNAVAILABLE_MESSAGE } from "../demo/gate";
import { isDemoEnv } from "../demo/env";
import { DEMO_DAILY_ROWS, type DemoStoreStatus } from "../demo/store";
import { devSeedAllowed, SCENARIOS } from "../devseed";
import { DEMO_DATA_HEADER, DEMO_STORY, type DemoDataSource } from "../../../shared/demo";
import type { DemoActionResponse, DemoSetBody, DemoStatusResponse } from "../../../shared/api";

type C = Context<ApiEnv>;

const source = (on: boolean): DemoDataSource => (on ? "demo" : "real");

/** What a status looks like when the demo store could not be asked (turning off must still answer). */
const UNKNOWN_STORE: Omit<DemoStoreStatus, "lastRows" | "schemaOk"> = { refreshedAt: null, story: DEMO_STORY, rowsToday: 0, dailyRows: DEMO_DAILY_ROWS, nextRefreshAt: null };

function statusBody(c: C, on: boolean, st: Omit<DemoStoreStatus, "lastRows" | "schemaOk">): DemoStatusResponse {
  return {
    on,
    refreshedAt: st.refreshedAt,
    story: DEMO_STORY,
    rowsToday: st.rowsToday,
    dailyRows: st.dailyRows,
    nextRefreshAt: st.nextRefreshAt,
    devSeed: devSeedAllowed(c.env, c.req.url) ? { scenarios: [...SCENARIOS] } : null,
  };
}

/** A JSON answer marked with the data the caller sees now. */
function answer(c: C, on: boolean, out: object, status: 200 = 200) {
  c.header(DEMO_DATA_HEADER, source(on));
  return c.json(out, status);
}

/** A refusal marked with the data the caller sees now (unmarked when that is not known). */
function refuse(c: C, on: boolean | null, status: 400 | 409 | 503, code: string, message: string) {
  if (on !== null) c.header(DEMO_DATA_HEADER, source(on));
  return fail(c, status, code, message);
}

/** The switch, or null when D1 cannot answer. */
async function readSwitch(c: C): Promise<boolean | null> {
  try {
    return await demoOn(c.env, c.var.user);
  } catch (e) {
    console.error("demo mode: could not read the switch:", (e as Error).message);
    return null;
  }
}

export function registerDemo(api: Hono<ApiEnv>): void {
  // Never inside the demo store itself: these routes act on the real switch (the gate never forwards them there).
  api.use("/demo", async (c, next) => (isDemoEnv(c.env) ? fail(c, 404, "not_found", "No such API route.") : next()));
  api.use("/demo/*", async (c, next) => (isDemoEnv(c.env) ? fail(c, 404, "not_found", "No such API route.") : next()));

  api.get("/demo", async (c) => {
    const on = await readSwitch(c);
    if (on === null) return refuse(c, null, 503, "demo_unknown", DEMO_UNKNOWN_MESSAGE);
    let st: DemoStoreStatus;
    try {
      st = await demoStub(c.env).status(new Date().toISOString());
    } catch (e) {
      console.error("demo mode: the demo store could not report:", (e as Error).message);
      return refuse(c, on, 503, "demo_unavailable", DEMO_UNAVAILABLE_MESSAGE);
    }
    return answer(c, on, statusBody(c, on, st));
  });

  api.put("/demo", async (c) => {
    const b = await body<DemoSetBody>(c).catch(() => null);
    if (!b || typeof b.on !== "boolean") return refuse(c, await readSwitch(c), 400, "bad_input", "Send { \"on\": true } or { \"on\": false } as JSON.");
    const want = b.on;

    if (!want) {
      try {
        await setDemo(c.env, c.var.user, false);
      } catch (e) {
        console.error("demo mode: could not turn off:", (e as Error).message);
        return refuse(c, null, 503, "demo_unknown", "Could not change demo mode. Try again.");
      }
      // Off never depends on the demo store: if it cannot report, answer without its figures.
      let st: Omit<DemoStoreStatus, "lastRows" | "schemaOk"> = UNKNOWN_STORE;
      try {
        st = await demoStub(c.env).status(new Date().toISOString());
      } catch (e) {
        console.error("demo mode: the demo store could not report:", (e as Error).message);
      }
      const out: DemoActionResponse = { ...statusBody(c, false, st), message: "Demo mode is off. Showing your real data." };
      return answer(c, false, out);
    }

    // On: the demo store must be ready BEFORE the row is written, so nobody is switched to an empty store.
    const was = await readSwitch(c);
    if (was === null) return refuse(c, null, 503, "demo_unknown", DEMO_UNKNOWN_MESSAGE);
    let ready;
    try {
      ready = await demoStub(c.env).ensureReady(new Date().toISOString());
    } catch (e) {
      console.error("demo mode: the demo store could not get ready:", (e as Error).message);
      return refuse(c, was, 503, "demo_unavailable", DEMO_UNAVAILABLE_MESSAGE);
    }
    if (!ready.ok) return refuse(c, was, 409, "demo_busy", ready.message);
    try {
      await setDemo(c.env, c.var.user, true);
    } catch (e) {
      console.error("demo mode: could not turn on:", (e as Error).message);
      return refuse(c, null, 503, "demo_unknown", "Could not change demo mode. Try again.");
    }
    const out: DemoActionResponse = { ...statusBody(c, true, ready.status), message: "Demo mode is on." };
    return answer(c, true, out);
  });

  api.post("/demo/refresh", async (c) => {
    const on = await readSwitch(c);
    if (on === null) return refuse(c, null, 503, "demo_unknown", DEMO_UNKNOWN_MESSAGE);
    let r;
    try {
      r = await demoStub(c.env).refresh(new Date().toISOString());
    } catch (e) {
      console.error("demo mode: the refresh failed:", (e as Error).message);
      return refuse(c, on, 503, "demo_unavailable", DEMO_UNAVAILABLE_MESSAGE);
    }
    if (!r.ok) return refuse(c, on, 409, "demo_busy", r.message);
    const out: DemoActionResponse = { ...statusBody(c, on, r.status), message: "Demo data refreshed." };
    return answer(c, on, out);
  });
}
