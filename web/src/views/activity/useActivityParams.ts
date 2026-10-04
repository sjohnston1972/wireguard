import { useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { ActivityRange } from "../../../../worker/src/activity";
import { DEFAULT_RANGE, DEFAULT_TAB, isRange, isTab, type Tab } from "./model";

export interface ActivityParams {
  range: ActivityRange;
  tab: Tab;
  /** The change log's filter (the API's `kind`) and search. */
  kind: string;
  q: string;
  page: number;
  /** The change whose drawer is open. */
  change: string | null;
}

type Patch = Partial<Record<"range" | "tab" | "kind" | "q" | "page" | "change", string | number | null>>;

/** Where the page starts when the address says nothing (the widgets' starting settings): a tab, and the change log's kind ("all" or "" for every kind). */
export interface ActivityStart {
  tab?: Tab;
  kind?: string;
}

/** "all" is what the address says for every kind once a starting kind is set, because an absent kind means "start there". */
const ALL_KINDS = "all";

/** The page's context lives in the address (spec §7): range, tab, the change log's filter and page, the open change. */
export function useActivityParams(start: ActivityStart = {}) {
  const startKind = !start.kind || start.kind === ALL_KINDS ? "" : start.kind;
  const startKindRef = useRef(startKind);
  startKindRef.current = startKind;
  const [sp, setSp] = useSearchParams();
  const spRef = useRef(sp);
  spRef.current = sp;

  const r = sp.get("range");
  const t = sp.get("tab");
  const kindParam = sp.get("kind");
  const page = Math.max(1, Math.min(1000, Number(sp.get("page")) || 1));
  const params: ActivityParams = {
    range: isRange(r) ? r : DEFAULT_RANGE,
    tab: isTab(t) ? t : (start.tab ?? DEFAULT_TAB),
    // The address wins; with none, the starting kind; "all" in the address is every kind.
    kind: kindParam === null || kindParam === "" ? startKind : kindParam === ALL_KINDS ? "" : kindParam,
    q: sp.get("q") ?? "",
    page,
    change: sp.get("change"),
  };

  /** Merge into the address. A new range, filter or search starts the change log at page 1. */
  const set = useCallback(
    (patch: Patch, opts: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(spRef.current);
      for (const [k, v] of Object.entries(patch)) {
        // Every kind: say so in the address only when it would otherwise start on a kind.
        if (k === "kind" && (v === null || v === "" || v === undefined || v === ALL_KINDS)) {
          if (startKindRef.current) next.set("kind", ALL_KINDS);
          else next.delete("kind");
          continue;
        }
        if (v === null || v === "" || v === undefined || (k === "page" && Number(v) <= 1)) next.delete(k);
        else next.set(k, String(v));
      }
      if (("range" in patch || "kind" in patch || "q" in patch) && !("page" in patch)) next.delete("page");
      setSp(next, { replace: opts.replace });
    },
    [setSp],
  );

  return { ...params, set, search: sp.toString() };
}
