// views/labs/topology/useTopologyLayout.ts
//
// Plain English: the person's arrangement of one lab's diagram, synced
// between their devices through ui_prefs (page "topology:<lab id>", lab
// topology spec §8.2-§8.3), with the widgets' save discipline (widgets spec
// §7, web/src/widgets/store.ts):
//
// - a move shows at once and is saved after 600 ms of quiet;
// - one save at a time; moves made meanwhile go after it, on the version it
//   produced;
// - a failed save puts the arrangement back as it was and says why;
// - a 409 (another device saved first) reloads theirs and says so;
// - a hidden or closing tab sends what is waiting with keepalive, and closing
//   the diagram sends it at once;
// - an arrangement that could not be read is never saved over: moves still
//   work for the visit, and a note says they will not be kept.
//
// Positions are kept by node key (stable between planned and live), as whole
// numbers relative to the parent, with the parent's key they were made under.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { EMPTY_LAYOUT, MAX_TOPOLOGY_COORD, normaliseTopologyLayout, type TopologyLayout, type TopologyLayoutPage } from "@shared/topology/layout";
import { ApiError } from "@/api/client";
import { putTopologyLayout, useTopologyLayoutQuery } from "@/api/topology";
import { useToast, type ToastInput } from "@/components";

/** The quiet spell before a move is saved (the widgets' SAVE_DELAY_MS). */
export const LAYOUT_SAVE_DELAY_MS = 600;
export const LAYOUT_STALE_TOAST = "Changed on another device. Showing the latest.";
export const LAYOUT_NOT_KEPT = "The saved arrangement did not load, so changes made now will not be kept.";

const queryKey = (labId: string) => ["prefs", "topology", labId] as const;
const clamp = (n: number) => Math.max(-MAX_TOPOLOGY_COORD, Math.min(MAX_TOPOLOGY_COORD, Math.round(n)));

/** The save queue of one lab's arrangement, for one diagram on screen. */
class LayoutSaver {
  /** The arrangement as shown, ahead of the server; null = what the server confirmed. */
  override: TopologyLayout | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private queued = false;
  /** The server version the shown change was made on (sent as baseVersion). */
  private base: number | null = null;
  private keepalive = false;
  private listeners = new Set<() => void>();
  /** The arrangement could not be read: nothing may be saved. Set by the hook on every render. */
  readOnly = false;
  toast: (t: ToastInput) => void = () => {};

  constructor(
    private client: QueryClient,
    private labId: string,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private confirmed(): TopologyLayoutPage | undefined {
    return this.client.getQueryData<TopologyLayoutPage>(queryKey(this.labId));
  }

  /** Apply a change at once and save it after the quiet spell (`now`: at once). */
  change(fn: (l: TopologyLayout) => TopologyLayout, opts: { now?: boolean } = {}): void {
    if (this.override === null || this.base === null) this.base = this.confirmed()?.version ?? 0;
    const shown = this.override ?? this.confirmed()?.layout ?? EMPTY_LAYOUT;
    this.override = normaliseTopologyLayout(fn(structuredClone(shown)));
    this.notify();
    if (this.readOnly) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (opts.now) this.flush();
    else this.timer = setTimeout(() => this.flush(), LAYOUT_SAVE_DELAY_MS);
  }

  /** Whether a save is waiting for its quiet spell. */
  get waiting(): boolean {
    return this.timer !== null;
  }

  /** Send what is waiting now (or right after the save in flight). */
  flush(opts: { keepalive?: boolean } = {}): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.override || this.readOnly) return;
    if (opts.keepalive) this.keepalive = true;
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    void this.send();
  }

  private async send(): Promise<void> {
    const sent = this.override!;
    const keepalive = this.keepalive;
    this.inFlight = true;
    this.queued = false;
    this.keepalive = false;
    try {
      const body = { baseVersion: this.base ?? this.confirmed()?.version ?? 0, layout: sent };
      const res = await putTopologyLayout(this.labId, body, keepalive ? { keepalive: true } : undefined);
      // A refetch started before this save landed must not put the old version back.
      await this.client.cancelQueries({ queryKey: queryKey(this.labId) });
      this.client.setQueryData<TopologyLayoutPage>(queryKey(this.labId), res);
      this.inFlight = false;
      this.base = res.version; // moves made since were made on top of this save
      if (this.queued) void this.send();
      else if (!this.timer && this.override === sent) {
        this.override = null; // nothing newer: show what the server stored
        this.base = null;
      }
      this.notify();
    } catch (e) {
      this.inFlight = false;
      this.queued = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.override = null;
      this.base = null;
      this.notify();
      this.failed(e);
    }
  }

  private failed(e: unknown) {
    if (e instanceof ApiError && e.status === 409 && e.code === "stale") {
      this.toast({ tone: "info", title: LAYOUT_STALE_TOAST });
      void this.client.invalidateQueries({ queryKey: queryKey(this.labId) });
      return;
    }
    const why = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
    this.toast({ tone: "error", title: `Couldn't save the diagram layout: ${why}. Put back as it was.` });
  }
}

export interface TopologyLayoutState {
  /** What to hand the canvas: the arrangement as shown; null while loading, or none could be read and nothing was moved. */
  saved: TopologyLayout | null;
  status: "loading" | "ready" | "failed";
  /** Shown under the diagram when moves will not be kept. */
  note: string | null;
  /** A node was dragged (or moved with the arrow keys) to `at`, relative to the parent with key `at.p`. */
  move: (key: string, at: { x: number; y: number; p: string | null }) => void;
  /** Reset layout: save an empty arrangement (everything back to the automatic packing). */
  reset: () => void;
}

/** One lab's synced arrangement. `enabled: false` reads nothing (and never saves). */
export function useTopologyLayout(labId: string, opts: { enabled?: boolean } = {}): TopologyLayoutState {
  const client = useQueryClient();
  const { toast } = useToast();
  const q = useTopologyLayoutQuery(labId, opts);
  const saver = useMemo(() => new LayoutSaver(client, labId), [client, labId]);
  saver.toast = toast;
  const status: TopologyLayoutState["status"] = q.data ? "ready" : q.isError ? "failed" : "loading";
  saver.readOnly = status !== "ready";
  const override = useSyncExternalStore(saver.subscribe, () => saver.override);

  useEffect(() => {
    // The page may be going away: send what is waiting with keepalive.
    const leaving = () => {
      if (saver.waiting) saver.flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leaving);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leaving);
      // The diagram closed with a move waiting: send it now.
      if (saver.waiting) saver.flush();
    };
  }, [saver]);

  const move = useCallback<TopologyLayoutState["move"]>(
    (key, at) => saver.change((l) => ({ v: 1, nodes: { ...l.nodes, [key]: { x: clamp(at.x), y: clamp(at.y), p: at.p } } })),
    [saver],
  );
  const reset = useCallback(() => saver.change(() => ({ v: 1, nodes: {} }), { now: true }), [saver]);

  return {
    saved: override ?? q.data?.layout ?? null,
    status,
    note: status === "failed" ? LAYOUT_NOT_KEPT : null,
    move,
    reset,
  };
}
