// demo/gate.ts
//
// Plain English: the one decision every signed-in request passes through
// (demo mode spec §5). It runs after the login (requireAccess), the
// same-origin check and the old-page shim, and before the data API,
// /captures and /health.
//
//   demo's own switch (GET/PUT /api/v1/demo, POST /api/v1/demo/refresh)
//       → straight on to its handlers (api/demo.ts), real environment
//   otherwise read the caller's switch (demo_mode, real D1)
//       cannot read it   → 503 demo_unknown, never a guess
//       off              → the real routes, marked X-WG-Data: real
//       on, a read (GET/HEAD /api/v1/*, POST /api/v1/firewall/simulate,
//           GET/HEAD /health) → answered by the demo store, marked demo;
//           if the demo store fails → 503 demo_unavailable, never real data
//       on, GET /captures/<id> → 404 "Not available in demo mode."
//       on, anything else → 409 demo_mode "Demo mode is on: actions are
//           off.", before any handler runs and before the body is read
//
// For a person in demo mode the gate never hands the request on to the real
// routes (except demo's own switch). That is the property the tests pin.

import type { Context, Next } from "hono";
import type { Env } from "../env";
import type { AuthedVars } from "../auth";
import { demoOn } from "./switch";
import { DEMO_INSTANCE } from "./store";
import { DEMO_DATA_HEADER, DEMO_REFUSED_MESSAGE, demoRouteKind } from "../../../shared/demo";

type C = Context<{ Bindings: Env; Variables: AuthedVars }>;

/** 503 demo_unknown: the switch could not be read (spec ruling 6). */
export const DEMO_UNKNOWN_MESSAGE = "Could not check demo mode. Try again.";
/** 503 demo_unavailable: the demo store failed (never a fall-through to real data). */
export const DEMO_UNAVAILABLE_MESSAGE = "Demo data could not be read. Turn demo mode off or refresh it in Settings.";
/** 404 for a packet capture while in demo mode (seeded captures have no file). */
export const DEMO_CAPTURE_MESSAGE = "Not available in demo mode.";

/** The demo store's one instance, as the Worker reaches it. */
export function demoStub(env: Env) {
  return env.DEMO_STORE.get(env.DEMO_STORE.idFromName(DEMO_INSTANCE));
}

const API = "/api/v1";

/** A refusal: the API's JSON error shape under /api/v1, plain text elsewhere. */
function refuse(c: C, api: boolean, status: 404 | 409 | 503, code: string, message: string, source: "demo" | null): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (source) headers[DEMO_DATA_HEADER] = source;
  if (api) return Response.json({ error: { code, message } }, { status, headers });
  return new Response(message, { status, headers: { ...headers, "Content-Type": "text/plain; charset=UTF-8" } });
}

/** Hono middleware: the demo gate (spec §5). Mount after requireAccess, sameOriginOnly and the HX shim. */
export async function demoGate(c: C, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method.toUpperCase();
  const api = path === API || path.startsWith(`${API}/`);
  const kind = api ? demoRouteKind(method, path.slice(API.length) || "/") : null;

  // 1. Demo's own switch: its handlers mark their answers; anything they could not mark is marked here if the switch can be read.
  if (kind === "control") {
    await next();
    if (!c.res.headers.has(DEMO_DATA_HEADER)) {
      try {
        c.res.headers.set(DEMO_DATA_HEADER, (await demoOn(c.env, c.var.user)) ? "demo" : "real");
      } catch {
        /* unknown: left unmarked rather than guessed */
      }
    }
    return;
  }

  // 2. Everyone else: the caller's switch, from D1, on every request. Unreadable → 503, never a guess.
  let on: boolean;
  try {
    on = await demoOn(c.env, c.var.user);
  } catch (e) {
    console.error("demo mode: could not read the switch:", (e as Error).message);
    return refuse(c, api, 503, "demo_unknown", DEMO_UNKNOWN_MESSAGE, null);
  }

  // 3. Off: the real routes, untouched.
  if (!on) {
    await next();
    if (api) c.res.headers.set(DEMO_DATA_HEADER, "real");
    return;
  }

  // 4. On. From here the real routes are never reached.
  const read = method === "GET" || method === "HEAD";
  if (kind === "read" || (read && path === "/health")) {
    let res: Response;
    try {
      res = await demoStub(c.env).serve(c.req.raw, c.var.user);
    } catch (e) {
      console.error("demo mode: the demo store could not answer:", (e as Error).message);
      return refuse(c, api, 503, "demo_unavailable", DEMO_UNAVAILABLE_MESSAGE, "demo");
    }
    const out = new Response(res.body, res);
    out.headers.set(DEMO_DATA_HEADER, "demo");
    out.headers.set("Cache-Control", "no-store");
    return out;
  }
  if (read && path.startsWith("/captures/")) return refuse(c, false, 404, "not_found", DEMO_CAPTURE_MESSAGE, "demo");
  return refuse(c, api, 409, "demo_mode", DEMO_REFUSED_MESSAGE, "demo");
}
