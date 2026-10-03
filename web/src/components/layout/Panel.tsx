import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "../cx";
import "./Panel.css";

/**
 * Widget chrome a <Widget> (web/src/widgets) hands to the panel it wraps:
 * the move handle and the settings cog for a panel header, or the same pair
 * as a corner overlay. Every element in it carries data-widget-chrome, so
 * with the chrome taken away the panel's markup is exactly what it was.
 */
export interface PanelChrome {
  /** Overlay at the left of the header (absent when the widget cannot move). */
  handle: ReactNode;
  /** The cog, after the panel's own actions. */
  cog: ReactNode;
  /** Handle and cog as one overlay in the panel's top corners (headerless widgets). */
  corner: ReactNode;
  /** The widget asked for the corner overlay even if the panel has a header. */
  headerless: boolean;
}
export const PanelChromeContext = createContext<PanelChrome | null>(null);

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
  /**
   * Inside a <Widget>, the outermost panel shows the widget's cog. Set false
   * on a second panel of the same widget (two panels side by side) so only one does.
   */
  widgetChrome?: boolean;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** The bordered surface every dashboard block sits on. A titled panel is a named region. */
export function Panel({ title, status, actions, flush, scroll, widgetChrome = true, children, className, bodyClassName }: PanelProps) {
  const titleId = useId();
  const given = useContext(PanelChromeContext);
  const chrome = widgetChrome ? given : null;
  const hasHead = !!(title || actions);
  const inHead = !!chrome && hasHead && !chrome.headerless;
  const body = <div className={cx("panel__body", flush && "panel__body--flush", bodyClassName)}>{children}</div>;
  return (
    <section
      className={cx("panel", scroll && "panel--scroll", className, chrome && !inHead && "wg-corner-host")}
      role={title ? "region" : undefined}
      aria-labelledby={title ? titleId : undefined}
    >
      {hasHead && (
        <header className="panel__head">
          {inHead && chrome.handle}
          <div className="panel__title-wrap">
            {title && (
              <h2 className="panel__title" id={titleId}>
                {title}
              </h2>
            )}
            {status}
          </div>
          {actions ? (
            <div className="panel__actions">
              {actions}
              {inHead && chrome.cog}
            </div>
          ) : (
            inHead && chrome.cog
          )}
        </header>
      )}
      {/* Panels inside this one never take the widget's chrome. */}
      {given ? <PanelChromeContext.Provider value={null}>{body}</PanelChromeContext.Provider> : body}
      {chrome && !inHead && chrome.corner}
    </section>
  );
}
