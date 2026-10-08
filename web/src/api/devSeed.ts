// api/devSeed.ts
//
// Plain English: the dev server's seed stories (demo mode spec §8.4), used only
// by Settings → Dev data, so it loads with that lazy section and never costs
// the app's entry anything.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/feedback/Toast";

/** /__dev/seed answered 404: the live site, or a dev server reached by another name. */
export const DEV_SEED_404 = "The seeder only exists on the local dev server.";

interface SeedAnswer {
  ok: boolean;
  scenario?: string;
  counts?: Record<string, number>;
  error?: string;
}

/**
 * Dev server only: POST /__dev/seed?scenario=<s> (same origin, not an /api/v1
 * write), which wipes this PC's local data and loads a story. Toasts the counts
 * and reads everything again.
 */
export function useDevSeed() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<SeedAnswer, Error, string>({
    mutationFn: async (scenario) => {
      const res = await fetch(`/__dev/seed?scenario=${encodeURIComponent(scenario)}`, { method: "POST", credentials: "same-origin" });
      if (res.status === 404) throw new Error(DEV_SEED_404);
      let body: SeedAnswer | null = null;
      try {
        body = (await res.json()) as SeedAnswer;
      } catch {
        body = null;
      }
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `The seeder answered ${res.status}.`);
      return body;
    },
    onSuccess: (res, scenario) => {
      const counts = Object.entries(res.counts ?? {})
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      toast({ tone: "success", title: `Seeded ${res.scenario ?? scenario}${counts ? `: ${counts}` : ""}` });
      void qc.invalidateQueries();
    },
    onError: (err) => toast({ tone: "error", title: err.message }),
  });
}
