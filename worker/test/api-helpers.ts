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
