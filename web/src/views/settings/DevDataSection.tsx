// views/settings/DevDataSection.tsx
//
// Plain English: Settings → Dev data, on the local dev server only (demo mode
// spec §8.4). One row per seed story with Seed: after a confirmation it wipes
// this PC's local database and loads that story through /__dev/seed, the same
// as `npm run seed -- <story>`. The live site never shows this section (GET
// /demo says devSeed: null there) and its /__dev/seed answers 404.
// Loaded only when opened (lazyPart), so it costs the app's entry nothing.

import { useState } from "react";
import { Button, Modal, Panel } from "@/components";
import { useDemo } from "@/api/demo";
import { useDevSeed } from "@/api/devSeed";
import "./DevDataSection.css";

/** One line per story, as the seeder tells it (worker/src/devseed.ts). */
const STORY: Record<string, string> = {
  empty: "Nothing at all: no clients, runs, history or costs.",
  destroyed: "Clients and past runs, the VM torn down (£0 now).",
  deploying: "A deploy half-way through its GitHub steps.",
  running: "The gateway up with clients online and live history.",
  failed: "The last deploy failed at a step, ready to clean up.",
  standby: "The VM hibernated: disk and address kept.",
  "busy-month": "30 days of runs, notes, changes and cost days.",
  insights: "Running, plus Azure metrics, boot log and service health.",
  labs: "Running, plus lab sessions live, finished and failed.",
  "labs-setup": "Labs before setup: permissions and limits still to do.",
  everything: "Every story at once: every widget on every page has data.",
};

export function DevDataSection() {
  const scenarios = useDemo().data?.devSeed?.scenarios ?? [];
  const seed = useDevSeed();
  const [asking, setAsking] = useState<string | null>(null);

  return (
    <div className="set-stack">
      <Panel title="Dev data">
        <p className="set-lead">Wipes this PC's local database and loads a story. Dev server only.</p>
        <ul className="set-seed" aria-label="Seed stories">
          {scenarios.map((s) => (
            <li key={s} className="set-seed__row">
              <span className="set-seed__text">
                <span className="set-seed__name">{s}</span>
                <span className="set-seed__desc">{STORY[s] ?? "A seed story."}</span>
              </span>
              <Button size="sm" aria-label={`Seed ${s}`} loading={seed.isPending && seed.variables === s} disabled={seed.isPending} onClick={() => setAsking(s)}>
                Seed
              </Button>
            </li>
          ))}
        </ul>
        <Modal
          open={asking !== null}
          onOpenChange={(o) => !o && setAsking(null)}
          title={`Replace the local data with ${asking ?? ""}?`}
          description="Everything in this PC's local database is wiped first. Your demo mode switch is kept."
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                aria-label={`Seed ${asking ?? ""}`}
                loading={seed.isPending}
                onClick={() => {
                  if (!asking) return;
                  seed.mutate(asking, { onSettled: () => setAsking(null) });
                }}
              >
                Seed
              </Button>
            </>
          }
        />
      </Panel>
    </div>
  );
}
