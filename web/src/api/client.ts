import type { ApiError as ApiErrorBody } from "@shared/api";
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

const BASE = "/api/v1";

function url(path: string): string {
  if (path.startsWith(BASE + "/") || path === BASE) return path;
  return BASE + (path.startsWith("/") ? path : "/" + path);
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === "object" && v !== null && typeof (v as ApiErrorBody).error === "object" && (v as ApiErrorBody).error !== null && typeof (v as ApiErrorBody).error.message === "string";
}

async function request<T>(method: string, path: string, body?: unknown, opts: SendOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", redirect: "manual", headers };
  if (opts.keepalive) init.keepalive = true;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url(path), init);
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
    if (isErrorBody(data)) throw new ApiError(res.status, data.error.code, data.error.message, data.error.field);
    throw new ApiError(res.status, "http_" + res.status, `The dashboard answered ${res.status}.`);
  }
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
