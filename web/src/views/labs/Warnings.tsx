import type { LabWarning, LabWarningKind } from "@shared/api";
import type { Tone } from "./model";

const KIND: Record<LabWarningKind, { label: string; tone: Tone }> = {
  budget: { label: "Budget", tone: "amber" },
  capacity: { label: "Capacity", tone: "amber" },
  pricey: { label: "Pricey", tone: "blue" },
  slow: { label: "Slow", tone: "blue" },
  unavailable: { label: "Not available", tone: "red" },
};

/** The overrides "Deploy anyway" sends for these warnings (spec §9.2): budget and capacity only. */
export function overridesFor(warnings: LabWarning[]): { overBudgetOk?: true; capacityOk?: true } {
  const out: { overBudgetOk?: true; capacityOk?: true } = {};
  for (const w of warnings) {
    if (!w.overridable) continue;
    if (w.kind === "budget") out.overBudgetOk = true;
    if (w.kind === "capacity") out.capacityOk = true;
  }
  return out;
}

/** The deploy warnings (spec §9.2), each a word with its colour and the server's sentence. */
export function Warnings({ warnings }: { warnings: LabWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="labs-warnings" aria-label="Warnings">
      {warnings.map((w, i) => {
        const k = KIND[w.kind];
        return (
          <li key={`${w.kind}-${i}`} className={`labs-warning labs-warning--${k.tone}`}>
            <span className={`labs-word labs-word--${k.tone}`}>{k.label}</span>
            <span className="labs-warning__text">{w.message}</span>
          </li>
        );
      })}
    </ul>
  );
}
