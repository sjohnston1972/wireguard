import { Check, Minus, X } from "lucide-react";
import { cx } from "../cx";
import "./StepList.css";

export type StepState = "done" | "running" | "pending" | "failed" | "skipped";

export interface Step {
  id: string;
  label: string;
  state: StepState;
  /** "12s" */
  duration?: string;
  /** Start time, "10:22:14". */
  time?: string;
}

export interface StepListProps {
  steps: Step[];
  "aria-label": string;
  className?: string;
}

const WORD: Record<StepState, string> = { done: "Done", running: "Running", pending: "Pending", failed: "Failed", skipped: "Skipped" };

/** The deployment pipeline: one row per step, state in words as well as icons. */
export function StepList({ steps, className, ...rest }: StepListProps) {
  return (
    <ol className={cx("steps", className)} aria-label={rest["aria-label"]}>
      {steps.map((s) => (
        <li key={s.id} className={cx("steps__item", `steps__item--${s.state}`)} aria-current={s.state === "running" ? "step" : undefined}>
          <span className={cx("steps__icon", `steps__icon--${s.state}`)} aria-hidden>
            {s.state === "done" && <Check size={12} strokeWidth={3} />}
            {s.state === "failed" && <X size={12} strokeWidth={3} />}
            {s.state === "skipped" && <Minus size={12} strokeWidth={3} />}
            {s.state === "running" && <span className="steps__spinner" />}
          </span>
          <span className="steps__label">{s.label}</span>
          <span className={cx("steps__state", (s.state === "running" || s.state === "failed") ? "" : "visually-hidden")}>
            {s.state === "running" ? "Running…" : WORD[s.state]}
          </span>
          <span className="steps__duration">{s.duration ?? ""}</span>
          <span className="steps__time">{s.time ?? ""}</span>
        </li>
      ))}
    </ol>
  );
}
