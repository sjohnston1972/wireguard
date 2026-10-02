import { Clock } from "lucide-react";
import { Button } from "../forms/Button";
import { DataAge } from "../data/DataAge";
import "./StaleBanner.css";

export interface StaleBannerProps {
  /** When the shown values were last fresh (epoch ms). */
  at: number | null;
  message?: string;
  onRetry?: () => void;
  /** Fixed clock for tests. */
  now?: number;
}

/** Shown above a panel whose live values have stopped refreshing; the values below are greyed by the owner. */
export function StaleBanner({ at, message = "These values may be out of date.", onRetry, now }: StaleBannerProps) {
  return (
    <div className="stale-banner" role="status">
      <Clock size={15} aria-hidden />
      <span>{message}</span>
      <DataAge at={at} now={now} staleAfterMs={Infinity} />
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
