import type { ReactNode } from "react";
import { Button } from "../forms/Button";
import "./EmptyState.css";

export interface EmptyStateProps {
  icon?: ReactNode;
  /** What is empty ("No clients"). */
  title: string;
  /** For which range or filter, and what to do. */
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty__icon" aria-hidden>
          {icon}
        </span>
      )}
      <p className="empty__title">{title}</p>
      {description && <p className="empty__desc">{description}</p>}
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
