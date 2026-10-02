import { useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../cx";
import { Drawer } from "./Drawer";
import { Tabs, type TabItem } from "./Tabs";
import "./SidePanel.css";

const PHONE = "(max-width: 640px)";

function subscribePhone(cb: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(PHONE);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}
const isPhone = () => (typeof window.matchMedia === "function" ? window.matchMedia(PHONE).matches : false);

/** True below 640 px, where details open as a bottom sheet instead of beside the page. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Small line under the title (address, id). */
  subtitle?: ReactNode;
  /** Leading element in the header, for example a status dot or device icon. */
  leading?: ReactNode;
  /** Tabs across the top (Overview, Configuration, Traffic, Activity); their content fills the body. */
  tabs?: TabItem[];
  /** Accessible name of the tab list; defaults to "<title> sections". */
  tabsLabel?: string;
  /** Pinned at the bottom (actions). */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * The Clients mockup's split-view details: a ~350 px rounded panel that sits
 * beside the page content, below the page header. It is not modal: the table
 * beside it stays usable. Opening moves focus into it; Escape from inside it
 * or the close X shuts it and puts focus back where it was. On the phone it
 * is the modal bottom sheet (Drawer side="bottom") instead.
 */
export function SidePanel({ open, onClose, title, subtitle, leading, tabs, tabsLabel, footer, children, className }: SidePanelProps) {
  const phone = useIsPhone();
  const titleId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // Remember what had focus when the panel opened (captured during render, before focus moves).
  if (open && !wasOpen.current) {
    const el = typeof document !== "undefined" ? document.activeElement : null;
    returnTo.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }

  useEffect(() => {
    if (open && !wasOpen.current && !phone) ref.current?.focus();
    if (!open && wasOpen.current && !phone) {
      // Closed: if focus was in the panel it is now lost to <body>; put it back.
      const el = returnTo.current;
      const active = document.activeElement;
      if (el && el.isConnected && (!active || active === document.body)) el.focus();
    }
    wasOpen.current = open;
  }, [open, phone]);

  const label = tabsLabel ?? `${typeof title === "string" ? title : "Details"} sections`;
  const body = tabs ? <Tabs items={tabs} aria-label={label} className="side-panel__tabs" /> : children;

  if (phone) {
    return (
      <Drawer open={open} onOpenChange={(o) => !o && onClose()} side="bottom" title={title} subtitle={subtitle} leading={leading} footer={footer} className={className}>
        {body}
      </Drawer>
    );
  }
  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <aside ref={ref} className={cx("side-panel", className)} aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="side-panel__head">
        {leading}
        <div className="side-panel__titles">
          <h2 id={titleId} className="side-panel__title">
            {title}
          </h2>
          {subtitle && <p className="side-panel__subtitle">{subtitle}</p>}
        </div>
        <button type="button" className="side-panel__close" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className={cx("side-panel__body", tabs && "side-panel__body--tabs")}>{body}</div>
      {footer && <footer className="side-panel__foot">{footer}</footer>}
    </aside>
  );
}

/** Page content with a SidePanel beside it (the panel takes no room while closed). */
export function SplitView({ panel, children, className }: { panel: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("split-view", className)}>
      <div className="split-view__main">{children}</div>
      {panel}
    </div>
  );
}
