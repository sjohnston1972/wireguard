import type { ApiError as ApiErrorBody } from "@shared/api";
import { ApiError, NetworkError, SessionExpiredError } from "./client";
import { connection } from "./connection";

// File downloads (the backup export and the nightly config backups). These are
// real files saved by the browser, so they do not go through apiGet (which
// parses JSON): the answer is fetched as a blob and handed to a temporary
// <a download>. An expired sign-in is still caught: Access answers with a
// redirect, which is never saved as a file.

const BASE = "/api/v1";

/** The file name from a Content-Disposition header, if it gives one. */
export function fileNameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1]!.trim() : null;
}

/** Fetch `path` under /api/v1 and save it, named as the server says (else `fallbackName`). */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(BASE + (path.startsWith("/") ? path : "/" + path), { method: "GET", credentials: "same-origin", redirect: "manual" });
  } catch {
    connection.unreachable();
    throw new NetworkError();
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || res.status === 401) {
    connection.expired();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      /* not the API's error shape */
    }
    if (res.status >= 500 && body === null) connection.unreachable();
    else connection.reached();
    const e = (body as ApiErrorBody | null)?.error;
    if (e && typeof e.message === "string") throw new ApiError(res.status, e.code, e.message, e.field);
    throw new ApiError(res.status, res.status >= 500 ? "upstream" : "http_" + res.status, `The dashboard answered ${res.status}.`);
  }
  // Access's login page is HTML; a backup is always JSON.
  if ((res.headers.get("Content-Type") ?? "").includes("text/html")) {
    connection.expired();
    throw new SessionExpiredError();
  }
  connection.ok();
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileNameFrom(res.headers.get("Content-Disposition")) ?? fallbackName;
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Some browsers read the blob after click returns; let go of it on the next turn.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}

/** Everything the dashboard keeps, as one JSON file (GET /backup/export). */
export const downloadExport = () => downloadFile("/backup/export", "wg-admin-export.json");

/** One nightly config backup by day, "YYYY-MM-DD" (GET /backup/config/:day). */
export const downloadConfigBackup = (day: string) => downloadFile(`/backup/config/${encodeURIComponent(day)}`, `wg-admin-config-${day}.json`);
