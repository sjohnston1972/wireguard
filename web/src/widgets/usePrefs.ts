// widgets/usePrefs.ts
//
// Plain English: the signed-in person's widget preferences, loaded once
// with the shell (GET /api/v1/prefs), refreshed when the window gets focus
// (how the phone picks up a change made on the PC) and mirrored to
// localStorage so a reload shows them at once instead of flashing defaults.

import { useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { PagePrefs, PrefsResponse } from "@shared/api";
import type { PageId } from "@shared/widgets";
import { apiGet } from "@/api/client";
import { useToast } from "@/components";
import { PREFS_KEY, storeFor, writeMirror, type PrefsStore } from "./store";

/** "loading": not answered yet (the mirror may be showing); "ready": read; "failed": could not be read, so nothing may be saved. */
export type PrefsStatus = "loading" | "ready" | "failed";

export function usePrefsQuery(): UseQueryResult<PrefsResponse> {
  const store = storeFor(useQueryClient());
  return useQuery<PrefsResponse>({
    queryKey: PREFS_KEY,
    queryFn: () => apiGet<PrefsResponse>("/prefs"),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    placeholderData: () => store.mirror(),
  });
}

export function statusOf(q: UseQueryResult<PrefsResponse>): PrefsStatus {
  if (q.data !== undefined && !q.isPlaceholderData) return "ready";
  if (q.isError) return "failed";
  return "loading";
}

/** The save queue for this app, wired to its toast host. */
export function usePrefsStore(): PrefsStore {
  const store = storeFor(useQueryClient());
  const { toast } = useToast();
  store.toast = toast;
  return store;
}

/**
 * Load the preferences (the shell calls this once, so they arrive with the
 * first page) and keep the localStorage mirror up to date.
 */
export function usePrefs(): UseQueryResult<PrefsResponse> {
  const q = usePrefsQuery();
  usePrefsStore();
  const real = q.isPlaceholderData ? undefined : q.data;
  useEffect(() => {
    if (real) writeMirror(real);
  }, [real]);
  return q;
}

/** Whether the preferences have been read: widgets show defaults and cogs are read-only until "ready". */
export function usePrefsStatus(): PrefsStatus {
  return statusOf(usePrefsQuery());
}

/**
 * One page's preferences as shown now: a change not yet confirmed, else
 * what the server holds, else (while loading) the mirror; {} (every widget
 * at its defaults) when they could not be read.
 */
export function usePagePrefs(page: PageId): { prefs: PagePrefs; status: PrefsStatus } {
  const q = usePrefsQuery();
  const store = usePrefsStore();
  const override = useSyncExternalStore(store.subscribe, () => store.override(page));
  const status = statusOf(q);
  if (status === "failed") return { prefs: EMPTY, status };
  return { prefs: override ?? q.data?.pages[page]?.prefs ?? EMPTY, status };
}

/**
 * One part of a page's preferences as shown now (as usePagePrefs), for a
 * hook that needs only that part: `pick` returns a piece of the page (the
 * same object while it is unchanged, see the store's keepUnchanged), so a
 * change elsewhere on the page does not re-render the caller.
 */
export function usePagePart<T>(page: PageId, pick: (p: PagePrefs) => T): { value: T; status: PrefsStatus } {
  const q = usePrefsQuery();
  const store = usePrefsStore();
  const status = statusOf(q);
  const base = q.data?.pages[page]?.prefs ?? EMPTY;
  const value = useSyncExternalStore(store.subscribe, () => pick(status === "failed" ? EMPTY : (store.override(page) ?? base)));
  return { value, status };
}

const EMPTY: PagePrefs = {};
