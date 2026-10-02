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

/**
 * The JSON body: null when there is no body at all (an action with no
 * options), the object when there is one. A body that is not labelled
 * JSON, does not parse, or is not an object is refused (400), never read
 * as "nothing": on Extend, nothing means "no timer", and a garbled request
 * must not quietly leave the VM running.
 */
export async function body<T>(c: Context<ApiEnv>): Promise<T | null> {
  const text = await c.req.text();
  if (!text.trim()) return null;
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) throw new RunError("Send the request body as JSON (Content-Type: application/json).", "bad_input");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new RunError("The request body is not valid JSON.", "bad_input");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new RunError("The request body must be a JSON object.", "bad_input");
  return v as T;
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
