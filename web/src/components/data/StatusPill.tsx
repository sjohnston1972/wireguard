import { cx, type Tone } from "../cx";
import "./StatusPill.css";

export type PillStatus =
  | "online"
  | "offline"
  | "running"
  | "success"
  | "failure"
  | "allow"
  | "deny"
  | "healthy"
  | "degraded"
  | "down"
  | "pending"
  | "deployed"
  | "stopped"
  | "unknown"
  | "custom";

const MAP: Record<PillStatus, { tone: Tone; label: string }> = {
  online: { tone: "green", label: "Online" },
  offline: { tone: "red", label: "Offline" },
  running: { tone: "amber", label: "Running" },
  success: { tone: "green", label: "Success" },
  failure: { tone: "red", label: "Failed" },
  allow: { tone: "green", label: "Allow" },
  deny: { tone: "red", label: "Deny" },
  healthy: { tone: "green", label: "Healthy" },
  degraded: { tone: "amber", label: "Degraded" },
  down: { tone: "red", label: "Down" },
  pending: { tone: "grey", label: "Pending" },
  deployed: { tone: "green", label: "Deployed" },
  stopped: { tone: "grey", label: "Stopped" },
  unknown: { tone: "grey", label: "Unknown" },
  custom: { tone: "blue", label: "Custom" },
};

export interface StatusPillProps {
  status: PillStatus;
  /** Overrides the word (for example "Deploying" for a running pill). */
  label?: string;
  /** Overrides the colour; status colours otherwise mean status only. */
  tone?: Tone;
  /** Hide the leading dot (the "Custom" tag has none). */
  dot?: boolean;
  /** "solid" fills with a tint like the table pills; "outline" is the small bordered chip. */
  variant?: "solid" | "outline";
  className?: string;
}

/** A status is always a dot plus a word, never colour alone. */
export function StatusPill({ status, label, tone, dot = true, variant = "solid", className }: StatusPillProps) {
  const m = MAP[status];
  return (
    <span className={cx("pill", `pill--${tone ?? m.tone}`, `pill--${variant}`, className)}>
      {dot && <span className="pill__dot" aria-hidden />}
      {label ?? m.label}
    </span>
  );
}
