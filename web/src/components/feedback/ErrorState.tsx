import { AlertTriangle } from "lucide-react";
import { Button } from "../forms/Button";
import "./ErrorState.css";

export interface ErrorStateProps {
  title?: string;
  /** The API's message, shown as is. */
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title = "Could not load this", message, onRetry }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={22} aria-hidden className="error-state__icon" />
      <p className="error-state__title">{title}</p>
      <p className="error-state__msg">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
