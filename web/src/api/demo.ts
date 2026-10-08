// api/demo.ts
//
// Plain English: demo mode from the app's side (demo mode spec §7, §8). The
// switch (GET/PUT /api/v1/demo), "Refresh demo data", the dev server's seed
// stories, and one question every view can ask: is demo mode on?
//
// Switching clears every cached answer at once, so the banner and every view
// move to the other data together and nothing from before is ever shown.

import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { DemoActionResponse, DemoSetBody, DemoStatusResponse } from "@shared/api";
import { apiGet, apiSend, currentSource, followSource, onSourceChange, subscribeSource, switchSource } from "./client";
import { useToast } from "@/components/feedback/Toast";

export const DEMO_KEY = ["demo"] as const;

/** The tooltip on every action demo mode turns off (spec ruling 18). */
export const DEMO_ACTIONS_OFF = "Actions are off in demo mode";

/** The switch's status without the action's sentence. */
function statusOf(res: DemoActionResponse): DemoStatusResponse {
  const { message: _m, ...status } = res;
  return status;
}

/** Forget every cached answer and read the shown ones again (a switch between real and demo data). */
export function resetForSource(qc: QueryClient): void {
  void qc.resetQueries();
}

/** The shell's half of §8.2: an answer from the other source arrived, so clear everything and read again. */
export function useSourceChangeReset(): void {
  const qc = useQueryClient();
  useEffect(() => onSourceChange(() => resetForSource(qc)), [qc]);
}

/** GET /demo: the caller's switch, the demo store's state and (dev server only) the seed stories. */
export function useDemo(): UseQueryResult<DemoStatusResponse> {
  return useQuery<DemoStatusResponse>({
    queryKey: DEMO_KEY,
    queryFn: async ({ signal }) => {
      const d = await apiGet<DemoStatusResponse>("/demo");
      // A read cancelled by a switch must not state the old mode.
      if (!signal.aborted) followSource(d.on ? "demo" : "real");
      return d;
    },
    staleTime: 30_000,
  });
}

/** True while the shown data is the demo's: the source says so, or GET /demo does. */
export function useDemoOn(): boolean {
  const source = useSyncExternalStore(subscribeSource, currentSource, currentSource);
  const demo = useDemo();
  return source === "demo" || demo.data?.on === true;
}

/**
 * PUT /demo { on }. On success the source switches, every query is cleared (the
 * banner and every view move at once), and the server's sentence is toasted.
 * Errors are the caller's to show (the section inline, the banner as a toast).
 */
export function useSetDemo() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<DemoActionResponse, Error, boolean>({
    mutationFn: (on) => apiSend<DemoActionResponse>("PUT", "/demo", { on } satisfies DemoSetBody),
    onSuccess: (res) => {
      switchSource(res.on ? "demo" : "real");
      resetForSource(qc);
      qc.setQueryData(DEMO_KEY, statusOf(res));
      toast({ tone: "success", title: res.message });
    },
  });
}

/**
 * POST /demo/refresh (works on and off). Success keeps the new status and reads
 * everything again; a refusal (409 demo_busy, naming the time) is the caller's
 * to show, and the status is read again so the button knows when it may run.
 */
export function useRefreshDemo() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<DemoActionResponse, Error, void>({
    mutationFn: () => apiSend<DemoActionResponse>("POST", "/demo/refresh"),
    onSuccess: (res) => {
      qc.setQueryData(DEMO_KEY, statusOf(res));
      toast({ tone: "success", title: res.message });
      void qc.invalidateQueries();
    },
    onError: () => void qc.invalidateQueries({ queryKey: DEMO_KEY }),
  });
}

// useDevSeed (the dev server's seed stories) lives in ./devSeed, loaded only with Settings → Dev data.
