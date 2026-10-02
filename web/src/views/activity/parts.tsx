import { AlertCircle, ChevronRight, Eye, Rocket, Settings, Shield, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { EventType } from "../../../../worker/src/activity";
import { Button, cx } from "@/components";
import { typeInfo } from "./model";

const ICONS: Record<EventType, ReactNode> = {
  deploy: <Rocket size={14} />,
  destroy: <Trash2 size={14} />,
  failure: <AlertCircle size={14} />,
  config: <Settings size={14} />,
  firewall: <Shield size={14} />,
  watchman: <Eye size={14} />,
};

/** An event type as icon and word, never colour alone. */
export function TypeTag({ type, className }: { type: EventType; className?: string }) {
  const t = typeInfo(type);
  return (
    <span className={cx("act__type", `act__type--${t.tone}`, className)}>
      <span className="act__type-icon" aria-hidden>
        {ICONS[type]}
      </span>
      {t.label}
    </span>
  );
}

export function Chevron() {
  return <ChevronRight size={15} aria-hidden className="act__chev" />;
}

/** Previous and next page of the change log. */
export function Pager({ label, page, more, onPage }: { label: string; page: number; more: boolean; onPage: (page: number) => void }) {
  return (
    <nav className="act__pager" aria-label={label}>
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous page
      </Button>
      <span className="act__pager-page">Page {page}</span>
      <Button size="sm" disabled={!more} onClick={() => onPage(page + 1)}>
        Next page
      </Button>
    </nav>
  );
}

/** A panel body that fills its panel and scrolls inside it (the one-screen rule). */
export function Fill({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("act__fill", className)}>{children}</div>;
}
