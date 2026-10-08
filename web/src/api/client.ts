import type { ApiError as ApiErrorBody } from "@shared/api";
import { DEMO_DATA_HEADER, DEMO_REFUSED_MESSAGE, demoRouteKind, type DemoDataSource } from "@shared/demo";
import { connection } from "./connection";

/** The API refused or failed: the status and the API's own error shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** The Cloudflare Access sign-in has lapsed (redirect, 401, or a 2xx login page instead of JSON). */
export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired, sign in again");
    this.name = "SessionExpiredError";
  }
}

/** The dashboard could not be reached at all (offline, DNS, the Worker down). */
export class NetworkError extends Error {
  constructor() {
    super("Cannot reach the dashboard");
    this.name = "NetworkError";
  }
}

/**
 * An answer came from the other data source (demo mode was switched on or off
 * while it was on its way, here or in another tab). It is never returned, so
 * never cached or shown; queries retry it like a network blip (demo mode spec §8.2).
 */
export class SourceChangedError extends Error {
  constructor() {
    super("Switched between demo and real data; loading again.");
    this.name = "SourceChangedError";
  }
}

// ── Where the data comes from (demo mode spec §8.2) ──
// Every /api/v1 answer carries X-WG-Data: real|demo. `source` is the one the
// app believes is current (null until the first answer); `epoch` counts the
// switches, so an answer to a request sent before a switch can be told apart
// and can never switch the source back.

let source: DemoDataSource | null = null;
let epoch = 0;
const watchers = new Set<() => void>();
let changeHandler: ((next: DemoDataSource) => void) | null = null;

/** The data source the app is showing: "real", "demo", or null before the first answer. */
export function currentSource(): DemoDataSource | null {
  return source;
}

/** Be told whenever currentSource() changes (for useSyncExternalStore). Returns the unsubscribe. */
export function subscribeSource(fn: () => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

/**
 * What the app does when an answer from the other source arrives (another tab
 * switched, or the switch changed under it): clear every query and read again.
 * One handler; registering replaces the last. Returns the unregister.
 */
export function onSourceChange(handler: (next: DemoDataSource) => void): () => void {
  changeHandler = handler;
  return () => {
    if (changeHandler === handler) changeHandler = null;
  };
}

function setSource(next: DemoDataSource | null) {
  if (source === next) return;
  source = next;
  for (const w of watchers) w();
}

/**
 * A switch the app made or learned of itself (PUT /demo answered, GET /demo's
 * `on`): adopt the source and start a new epoch, so every answer still on its
 * way from before is dropped. Clearing the cache is the caller's (useSetDemo).
 */
export function switchSource(next: DemoDataSource): void {
  epoch++;
  setSource(next);
}

/**
 * The source as GET /demo's body states it (a fallback for an answer without the header):
 * the first one is simply adopted; a different one is followed like a mismatched header,
 * new epoch and the registered handler (clear and read again).
 */
export function followSource(next: DemoDataSource): void {
  if (source === next) return;
  const known = source !== null;
  epoch++;
  setSource(next);
  if (known) changeHandler?.(next);
}

/** Tests only: back to "no answer yet", with no handler. */
export function resetSource(): void {
  epoch++;
  changeHandler = null;
  setSource(null);
}

function headerSource(res: Response): DemoDataSource | null {
  const h = res.headers?.get?.(DEMO_DATA_HEADER);
  return h === "real" || h === "demo" ? h : null;
}

const BASE = "/api/v1";

function url(path: string): string {
  if (path.startsWith(BASE + "/") || path === BASE) return path;
  return BASE + (path.startsWith("/") ? path : "/" + path);
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === "object" && v !== null && typeof (v as ApiErrorBody).error === "object" && (v as ApiErrorBody).error !== null && typeof (v as ApiErrorBody).error.message === "string";
}

async function request<T>(method: string, path: string, body?: unknown, opts: SendOptions = {}): Promise<T> {
  const target = url(path);
  const kind = demoRouteKind(method, target.slice(BASE.length) || "/");
  // The client guard: while the data is demo, a write never leaves the browser
  // (the Worker refuses it too). The switch itself and the simulator still go.
  if (source === "demo" && kind === "refuse") throw new ApiError(409, "demo_mode", DEMO_REFUSED_MESSAGE);
  const sentIn = epoch;
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", redirect: "manual", headers };
  if (opts.keepalive) init.keepalive = true;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch {
    connection.unreachable();
    throw new NetworkError();
  }

  // Access answers an expired session with a redirect to its login, before the Worker runs.
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    connection.expired();
    throw new SessionExpiredError();
  }
  if (res.status === 401) {
    connection.expired();
    throw new SessionExpiredError();
  }

  // Where this answer came from. PUT /demo is the switch itself: useSetDemo adopts its answer.
  const from = headerSource(res);
  let dropped = false;
  if (from && !(kind === "control" && method.toUpperCase() === "PUT")) {
    if (source === null) {
      setSource(from);
    } else if (from !== source) {
      if (sentIn === epoch) {
        // The switch happened elsewhere (another tab, or the row changed): follow it.
        epoch++;
        setSource(from);
        changeHandler?.(from);
        // GET /demo and the refresh state the mode after the call: their answer stands.
        dropped = kind !== "control";
      } else {
        // Sent before this app switched: stale, and it must not switch the source back.
        dropped = true;
      }
    }
  }

  let data: unknown;
  try {
    data = JSON.parse(await res.text());
  } catch {
    // Not JSON: something in front of the Worker answered instead of the API.
    if (res.status >= 500) {
      // Cloudflare's own error page (502, 524, 1101...): the dashboard is down or
      // timing out, which is a server problem, not a lapsed sign-in.
      connection.unreachable();
      throw new ApiError(res.status, "upstream", `The dashboard is not answering properly (${res.status}). Try again shortly.`);
    }
    if (res.status >= 400) throw new ApiError(res.status, "http_" + res.status, `The dashboard answered ${res.status}.`);
    // A 2xx that is not JSON is Access's login page served in place of the API.
    connection.expired();
    throw new SessionExpiredError();
  }

  connection.ok();
  if (!res.ok) {
    // A refusal is not data: it says why, whichever source sent it.
    if (isErrorBody(data)) throw new ApiError(res.status, data.error.code, data.error.message, data.error.field);
    throw new ApiError(res.status, "http_" + res.status, `The dashboard answered ${res.status}.`);
  }
  if (dropped) throw new SourceChangedError();
  return data as T;
}

/** GET a JSON resource under /api/v1 (path like "/clients" or "/history?scope=vm&range=1h"). */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export interface SendOptions {
  /** Let the request outlive the page (a save sent as the tab is hidden or closed; body under 64 KiB). */
  keepalive?: boolean;
}

/** POST, PUT or DELETE under /api/v1. Leave `body` out to send nothing. */
export function apiSend<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, opts?: SendOptions): Promise<T> {
  return request<T>(method, path, body, opts);
}
