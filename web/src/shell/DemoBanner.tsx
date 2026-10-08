// shell/DemoBanner.tsx
//
// Plain English: while demo mode is on, an amber strip under the top bar on
// every page says the data is made up and actions are off, with a Turn off
// button that always works (it needs nothing but the switch itself), even when
// every other answer fails (demo mode spec §8.1).

import { Eye } from "lucide-react";
import { Button } from "@/components/forms/Button";
import { useToast } from "@/components/feedback/Toast";
import { useDemoOn, useSetDemo } from "@/api/demo";
import "./DemoBanner.css";

export const DEMO_BANNER_WORDS = "Demo data — nothing here is real. Actions are off.";

export function DemoBanner() {
  // On whenever the answers or GET /demo say so: shown even when GET /demo itself fails.
  const on = useDemoOn();
  const set = useSetDemo();
  const { toast } = useToast();
  if (!on) return null;
  return (
    <div className="demo-banner" role="status" aria-label="Demo mode">
      <Eye className="demo-banner__icon" size={16} aria-hidden="true" />
      <span className="demo-banner__text">{DEMO_BANNER_WORDS}</span>
      <Button
        size="sm"
        className="demo-banner__off"
        loading={set.isPending}
        onClick={() => set.mutate(false, { onError: (err) => toast({ tone: "error", title: err.message }) })}
      >
        Turn off
      </Button>
    </div>
  );
}
