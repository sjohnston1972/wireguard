// views/labs/topology/data.ts
//
// Plain English: what a lab's diagram shows, wherever it is placed (lab
// topology spec §6.4, §7, ruling 23).
//
// - No live session: the planned graph, with a note that its addresses are
//   examples (slot 31's).
// - A live session (deploying, running, failed, tearing down): the live graph
//   from Resource Graph merged with "ghosts" (planned resources the live view
//   does not have), every key's status for the badges. The Planned toggle
//   shows the planned graph moved into the session's own /18.
// - The live view cannot answer (Azure not configured, refused, throttled, or
//   the request failed): the planned graph with a banner naming why.
//
// Also the two per-device choices (ruling 18): show dependency edges, and
// Diagram or List, kept in localStorage `wg.topology.v1` (every access in
// try/catch; only the arrangement syncs between devices).

import { useCallback, useMemo, useState } from "react";
import type { LabSession, LabTopologyResponse } from "@shared/api";
import type { TopologyGraph } from "@shared/topology/model";
import { mergeForView, rebaseSlot, type NodeDiffStatus } from "@shared/topology/diff";
import { ARG_TOP } from "@shared/topology/query";
import { LAB_LIVE_STATES } from "@shared/labs";
import { useLabTopology, usePlannedTopology } from "@/api/topology";

export const EXAMPLE_ADDRESSES_NOTE = "Example addresses (slot 31); each session gets its own /18.";
const FALLBACK = "Showing the planned diagram.";
const TRUNCATED = `The lab has more than ${ARG_TOP} resources: showing the first ${ARG_TOP}.`;

/** What the live view says when it has no message of its own. */
const REASON: Record<Exclude<LabTopologyResponse["status"], "ok">, string> = {
  not_running: "The lab is not running.",
  no_azure: "Azure is not configured, so there is no live view.",
  failed: "The live view could not be read from Azure.",
  throttled: "Azure is busy just now.",
};

export interface DiagramData {
  /** What to draw; null while loading or when the planned file did not load. */
  graph: TopologyGraph | null;
  /** By node key ({} for a planned graph). */
  status: Record<string, NodeDiffStatus>;
  /** What `graph` is; null while there is none. */
  source: "live" | "planned" | null;
  /** A session holds Azure resources, so the Live/Planned toggle applies. */
  live: boolean;
  /** The session is deploying: missing resources read "Not deployed yet". */
  deploying: boolean;
  /** Why the live view is not (fully) shown, in plain words. */
  banner: string | null;
  /** A note under the diagram (the example addresses). */
  note: string | null;
  loading: boolean;
  /** The planned file did not load. */
  error: string | null;
  retry: () => void;
}

const isLive = (s: LabSession | null | undefined): s is LabSession => !!s && (LAB_LIVE_STATES as readonly string[]).includes(s.state);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");

/**
 * The diagram of `labId` for its session (null: idle). `source` is the
 * person's Live/Planned choice (only used while a session is live).
 */
export function useDiagramData(labId: string, session: LabSession | null, opts: { source?: "live" | "planned" } = {}): DiagramData {
  const live = isLive(session);
  const wantLive = live && (opts.source ?? "live") === "live";
  const planned = usePlannedTopology(labId);
  const topo = useLabTopology(labId, { enabled: wantLive });
  const cidr = live ? session.cidr : null;
  const deploying = live && session.state === "deploying";

  const rebased = useMemo(() => (planned.data && cidr ? rebaseSlot(planned.data, cidr) : (planned.data ?? null)), [planned.data, cidr]);
  const r = wantLive ? topo.data : undefined;
  const merged = useMemo(() => (rebased && r?.live ? mergeForView(rebased, r.live, { deploying }) : null), [rebased, r?.live, deploying]);

  const retry = useCallback(() => {
    void planned.refetch();
    if (wantLive) void topo.refetch();
  }, [planned, topo, wantLive]);

  const base = { live, deploying, retry, note: null as string | null, banner: null as string | null };
  if (planned.isError && !planned.data) return { ...base, graph: null, status: {}, source: null, loading: false, error: why(planned.error) + "." };
  if (!rebased) return { ...base, graph: null, status: {}, source: null, loading: true, error: null };
  if (!live) return { ...base, graph: rebased, status: {}, source: "planned", loading: false, error: null, note: EXAMPLE_ADDRESSES_NOTE };
  if (!wantLive) return { ...base, graph: rebased, status: {}, source: "planned", loading: false, error: null };

  // Live wanted.
  if (topo.isError && !r) return { ...base, graph: rebased, status: {}, source: "planned", loading: false, error: null, banner: `The live view did not load: ${why(topo.error)}. ${FALLBACK}` };
  if (!r) return { ...base, graph: null, status: {}, source: null, loading: true, error: null };
  if (merged) {
    const banner = r.status !== "ok" ? `${r.message ?? REASON[r.status]} Showing the last live view.` : r.truncated ? TRUNCATED : null;
    return { ...base, graph: merged.graph, status: merged.status, source: "live", loading: false, error: null, banner };
  }
  const reason = r.status === "ok" ? "The live view answered with no diagram." : (r.message ?? REASON[r.status]);
  return { ...base, graph: rebased, status: {}, source: "planned", loading: false, error: null, banner: `${reason} ${FALLBACK}` };
}

// ── This device's choices ────────────────────────────────────────────────

export const DEVICE_PREFS_KEY = "wg.topology.v1";

export interface DiagramDevicePrefs {
  showDependencies: boolean;
  view: "diagram" | "list";
}

const DEFAULT_DEVICE: DiagramDevicePrefs = { showDependencies: true, view: "diagram" };

export function readDevicePrefs(): DiagramDevicePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) ?? "null") as Partial<DiagramDevicePrefs> | null;
    return {
      showDependencies: typeof raw?.showDependencies === "boolean" ? raw.showDependencies : DEFAULT_DEVICE.showDependencies,
      view: raw?.view === "list" || raw?.view === "diagram" ? raw.view : DEFAULT_DEVICE.view,
    };
  } catch {
    return DEFAULT_DEVICE;
  }
}

function writeDevicePrefs(p: DiagramDevicePrefs): void {
  try {
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage refused: the choice lasts for this visit */
  }
}

/** The dependency toggle and the Diagram/List choice, remembered on this device. */
export function useDevicePrefs(): [DiagramDevicePrefs, (change: Partial<DiagramDevicePrefs>) => void] {
  const [prefs, setPrefs] = useState(readDevicePrefs);
  const change = useCallback((c: Partial<DiagramDevicePrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...c };
      writeDevicePrefs(next);
      return next;
    });
  }, []);
  return [prefs, change];
}
