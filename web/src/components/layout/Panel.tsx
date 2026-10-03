import { useId, type ReactNode } from "react";
import { cx } from "../cx";
import "./Panel.css";

export interface PanelProps {
  title?: ReactNode;
  /** Small pill next to the title (for example a StatusPill "Healthy"). */
  status?: ReactNode;
  /** Right-hand title-row content: segmented control, "View all", buttons. */
  actions?: ReactNode;
  /** Remove body padding (tables, logs, lists that scroll inside the panel). */
  flush?: boolean;
  /** Body fills the panel height and scrolls inside it (desktop one-screen rule). */
  scroll?: boolean;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** The bordered surface every dashboard block sits on. A titled panel is a named region. */
export function Panel({ title, status, actions, flush, scroll, children, className, bodyClassName }: PanelProps) {
  const titleId = useId();
  return (
    <section
      className={cx("panel", scroll && "panel--scroll", className)}
      role={title ? "region" : undefined}
      aria-labelledby={title ? titleId : undefined}
    >
      {(title || actions) && (
        <header className="panel__head">
          <div className="panel__title-wrap">
            {title && (
              <h2 className="panel__title" id={titleId}>
                {title}
              </h2>
            )}
            {status}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className={cx("panel__body", flush && "panel__body--flush", bodyClassName)}>{children}</div>
    </section>
  );
}
