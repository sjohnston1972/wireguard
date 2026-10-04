// widgets/store.ts
//
// Plain English: the save queue behind the widget preferences. A change
// shows at once (an "override" on top of what the server last confirmed)
// and is sent after a quiet spell, so typing a number is one request, not
// one per key. One save per page is in flight at a time; changes made
// meanwhile go after it, on the version it produced. A save that fails puts
// the page back to its last confirmed state and says why; a conflict (409)
// reloads what the other device saved. A hidden or closing tab sends what is
// waiting with keepalive, so the request outlives the page.
//
// One store per query client (so each test gets its own). React reads it
// through useSyncExternalStore in usePrefs.ts.

import type { QueryClient } from "@tanstack/react-query";
import type { PagePrefs, PrefsPage, PrefsResponse } from "@shared/api";
import { PAGE_TITLES, normalisePagePrefs, PAGE_IDS, type PageId } from "@shared/widgets";
import { apiSend, ApiError } from "@/api/client";
import type { ToastInput } from "@/components";

export const PREFS_KEY = ["prefs"] as const;
/** The quiet spell before a change is saved. */
export const SAVE_DELAY_MS = 600;
/** localStorage key of the last good GET /prefs answer, shown while the next one loads. */
export const PREFS_MIRROR_KEY = "wg.prefs.v1";

export const STALE_TOAST = "Changed on another device. Showing the latest.";

interface PageQueue {
  /** The page as shown, ahead of the server; null = show what the server confirmed. */
  override: PagePrefs | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** A change waited for the save in flight. */
  queued: boolean;
  /**
   * The server version the shown change was made on: taken from the confirmed
   * page when the first change of a batch is made, advanced by each save that
   * lands. Sent as `baseVersion`, so a refetch that lands between a change and
   * its save cannot make the save win over another device's newer change.
   */
  base: number | null;
  /** The next save goes out as the page is hidden or closed (fetch keepalive). */
  keepalive: boolean;
}

/** The last good answer, or undefined (none, unreadable, or storage refused). */
export function readMirror(): PrefsResponse | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_MIRROR_KEY) ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null || typeof (raw as PrefsResponse).pages !== "object" || (raw as PrefsResponse).pages === null) return undefined;
    const pages = {} as PrefsResponse["pages"];
    for (const p of PAGE_IDS) {
      const page = (raw as PrefsResponse).pages[p];
      pages[p] = { version: typeof page?.version === "number" ? page.version : 0, updatedAt: typeof page?.updatedAt === "string" ? page.updatedAt : null, prefs: normalisePagePrefs(p, page?.prefs) };
    }
    return { pages };
  } catch {
    return undefined;
  }
}

export function writeMirror(r: PrefsResponse): void {
  try {
    localStorage.setItem(PREFS_MIRROR_KEY, JSON.stringify(r));
  } catch {
    /* storage full or refused: the next load just shows defaults until it answers */
  }
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * `next` with every part that did not change taken from `prev` (the same
 * objects), so a widget whose settings did not change gets the same settings
 * object and does not re-render.
 */
function keepUnchanged(prev: PagePrefs, next: PagePrefs): PagePrefs {
  const out: PagePrefs = { ...next };
  if (next.layout && same(prev.layout, next.layout)) out.layout = prev.layout;
  if (next.widgets) {
    const widgets: NonNullable<PagePrefs["widgets"]> = {};
    for (const [id, entry] of Object.entries(next.widgets)) widgets[id] = prev.widgets?.[id] && same(prev.widgets[id], entry) ? prev.widgets[id]! : entry;
    out.widgets = widgets;
  }
  return out;
}

export class PrefsStore {
  private queues = new Map<PageId, PageQueue>();
  private listeners = new Set<() => void>();
  private watching = false;
  private mirrored: { value: PrefsResponse | undefined } | null = null;
  /** Set by the hooks from the app's toast host. */
  toast: ((t: ToastInput) => void) | null = null;

  constructor(private client: QueryClient) {}

  /** The localStorage copy, read once per load (every widget's query shares it while the first answer is out). */
  mirror(): PrefsResponse | undefined {
    if (!this.mirrored) this.mirrored = { value: readMirror() };
    return this.mirrored.value;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private queue(page: PageId): PageQueue {
    let q = this.queues.get(page);
    if (!q) {
      q = { override: null, timer: null, inFlight: false, queued: false, base: null, keepalive: false };
      this.queues.set(page, q);
    }
    return q;
  }

  /** The page as changed here and not yet confirmed, or null. */
  override(page: PageId): PagePrefs | null {
    return this.queues.get(page)?.override ?? null;
  }

  /** What the server last confirmed for the page. */
  confirmed(page: PageId): PrefsPage {
    return this.client.getQueryData<PrefsResponse>(PREFS_KEY)?.pages[page] ?? { version: 0, updatedAt: null, prefs: {} };
  }

  /** Apply a change at once and save it after the quiet spell. `fn` gets a copy of the page as shown. */
  change(page: PageId, fn: (p: PagePrefs) => PagePrefs): void {
    this.watchVisibility();
    const q = this.queue(page);
    if (q.override === null || q.base === null) q.base = this.confirmed(page).version;
    const shown = q.override ?? this.confirmed(page).prefs;
    q.override = keepUnchanged(shown, normalisePagePrefs(page, fn(structuredClone(shown))));
    this.notify();
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => this.flush(page), SAVE_DELAY_MS);
  }

  private disposed = false;

  /** Stop: waiting saves are dropped and answers still out are ignored (tests only, see dropPrefsStores). */
  dispose(): void {
    this.disposed = true;
    for (const q of this.queues.values()) if (q.timer) clearTimeout(q.timer);
    this.queues.clear();
    this.listeners.clear();
  }

  /** Send what is waiting for the page now (or right after the save in flight). */
  flush(page: PageId, opts: { keepalive?: boolean } = {}): void {
    if (this.disposed) return;
    const q = this.queue(page);
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    if (!q.override) return;
    if (opts.keepalive) q.keepalive = true;
    if (q.inFlight) {
      q.queued = true;
      return;
    }
    void this.send(page);
  }

  private watchVisibility() {
    if (this.watching || typeof document === "undefined") return;
    this.watching = true;
    // The page may be going away: send what is waiting with keepalive, so the
    // browser finishes the request even if the tab is closed.
    const leaving = () => {
      for (const [page, q] of this.queues) if (q.timer) this.flush(page, { keepalive: true });
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") leaving();
    });
    if (typeof window !== "undefined") window.addEventListener("pagehide", leaving);
  }

  private setPage(page: PageId, value: PrefsPage) {
    this.client.setQueryData<PrefsResponse>(PREFS_KEY, (old) => (old ? { pages: { ...old.pages, [page]: value } } : old));
  }

  private async send(page: PageId): Promise<void> {
    const q = this.queue(page);
    const sent = q.override!;
    const keepalive = q.keepalive;
    q.inFlight = true;
    q.queued = false;
    q.keepalive = false;
    try {
      const res = await apiSend<PrefsPage>("PUT", `/prefs/${page}`, { baseVersion: q.base ?? this.confirmed(page).version, prefs: sent }, keepalive ? { keepalive: true } : undefined);
      if (this.disposed) return;
      // A refetch started before this save landed must not put the old version back.
      await this.client.cancelQueries({ queryKey: PREFS_KEY });
      this.setPage(page, res);
      q.inFlight = false;
      q.base = res.version; // changes made since were made on top of this save
      if (q.queued) void this.send(page);
      else if (!q.timer && q.override === sent) {
        q.override = null; // nothing newer: show what the server stored
        q.base = null;
      }
      this.notify();
    } catch (e) {
      if (this.disposed) return;
      q.inFlight = false;
      q.queued = false;
      if (q.timer) clearTimeout(q.timer);
      q.timer = null;
      q.override = null;
      q.base = null;
      this.notify();
      this.failed(page, e);
    }
  }

  private failed(page: PageId, e: unknown) {
    const toast = this.toast ?? (() => {});
    if (e instanceof ApiError && e.status === 409 && e.code === "stale") {
      toast({ tone: "info", title: STALE_TOAST });
      void this.client.invalidateQueries({ queryKey: PREFS_KEY });
      return;
    }
    if (e instanceof ApiError && e.status === 409 && e.code === "outdated") {
      toast({ tone: "warning", title: e.message });
      return;
    }
    const why = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
    toast({ tone: "error", title: `Couldn't save your ${PAGE_TITLES[page]} widgets: ${why}. Put back as it was.` });
  }
}

const stores = new Map<QueryClient, PrefsStore>();

/** The store for this query client. */
export function storeFor(client: QueryClient): PrefsStore {
  let s = stores.get(client);
  if (!s) {
    s = new PrefsStore(client);
    stores.set(client, s);
  }
  return s;
}

/**
 * Tests only (web/src/test/setup.ts, after each test): forget every store,
 * dropping saves still waiting, so one test's change is never sent to the
 * next test's mocked server.
 */
export function dropPrefsStores(): void {
  for (const s of stores.values()) s.dispose();
  stores.clear();
}
