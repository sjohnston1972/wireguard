// widgets/WidgetCog.tsx
//
// Plain English: the settings cog. On a desktop it opens a small popover
// beside the widget; on the phone a bottom sheet. Inside: Data, Thresholds
// and Display (each only when the widget has such settings), then the
// layout controls (Move left / Move right, Hide widget) and Reset to
// default. Changes apply at once; there is no Save button.

import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Settings2 } from "lucide-react";
import { Button, IconButton, Sheet, useIsPhone } from "@/components";
import type { PageId } from "@shared/widgets";
import { useWidget } from "./useWidget";
import { SettingsForm } from "./SettingsForm";
import { announce } from "./announce";

/** Says where a widget went, for screen readers: "Last run moved to position 2 of 3". */
export function announceMove(title: string, index: number, count: number, dir: "left" | "right") {
  announce(`${title} moved to position ${index + (dir === "left" ? 0 : 2)} of ${count}`);
}

/**
 * Focus the page's Layout button (where a hidden widget comes back from).
 * The header may hold more than one (desktop and phone): the one on screen.
 */
export function focusLayout(page: PageId) {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-wg-layout="${page}"]`)).filter((el) => el.isConnected);
  (all.find((el) => el.getClientRects().length > 0) ?? all[0])?.focus();
}

export const READ_ONLY_FAILED = "Widget settings couldn't be loaded, so changes can't be saved right now.";
export const READ_ONLY_LOADING = "Loading widget settings…";

/** The cog's contents for one widget: the form and the footer. Also used by the phone's Widget settings list. */
export function WidgetSettings({ id, onClose, onHidden }: { id: string; onClose?: () => void; onHidden?: () => void }) {
  const w = useWidget(id);
  const phone = useIsPhone();
  // A widget in a stack moves its whole column.
  const ofStack = w.canMove.item !== id;
  const move = (dir: "left" | "right") => {
    const { index, count } = w.canMove;
    if (w.move(dir)) announceMove(ofStack ? `${w.def.title} column` : w.def.title, index, count, dir);
  };
  return (
    <div className="wg-settings">
      {w.readOnly && <p className="wg-settings__note">{w.status === "failed" ? READ_ONLY_FAILED : READ_ONLY_LOADING}</p>}
      <SettingsForm def={w.def} settings={w.settings} onSet={w.set} readOnly={w.readOnly} />
      <footer className="wg-settings__foot">
        {/* Order is desktop-only: the phone keeps its own layout. */}
        {w.canMove.movable && !phone && (
          <>
            <Button size="sm" disabled={w.readOnly || !w.canMove.left} onClick={() => move("left")}>
              {ofStack ? "Move column left" : "Move left"}
            </Button>
            <Button size="sm" disabled={w.readOnly || !w.canMove.right} onClick={() => move("right")}>
              {ofStack ? "Move column right" : "Move right"}
            </Button>
          </>
        )}
        {!w.def.pinned && (
          <Button
            size="sm"
            disabled={w.readOnly}
            onClick={() => {
              w.hide();
              announce(`${w.def.title} hidden. Show it from Layout.`);
              onClose?.();
              onHidden?.();
            }}
          >
            Hide widget
          </Button>
        )}
        <Button size="sm" disabled={w.readOnly || !w.differs} onClick={w.reset}>
          Reset to default
        </Button>
      </footer>
    </div>
  );
}

/** The cog button and what it opens. */
export function WidgetCog({ id }: { id: string }) {
  const w = useWidget(id);
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const label = `${w.def.title} settings`;
  // Hiding unmounts the cog, so focus cannot go back to it: it goes to the
  // page's Layout button instead, where the widget can be shown again.
  const hid = useRef(false);
  const onHidden = () => {
    hid.current = true;
    setTimeout(() => focusLayout(w.def.page), 0);
  };
  const closeFocus = (e: Event) => {
    if (!hid.current) return;
    e.preventDefault();
    focusLayout(w.def.page);
  };
  const button = (
    <IconButton label={label} size="sm" variant="plain" className="wg-cog" data-widget-chrome="" onClick={phone ? () => setOpen(true) : undefined}>
      <Settings2 size={15} aria-hidden />
    </IconButton>
  );
  if (phone)
    return (
      <>
        {button}
        <Sheet open={open} onOpenChange={setOpen} title={label} className="wg-sheet" onCloseAutoFocus={closeFocus}>
          <WidgetSettings id={id} onClose={() => setOpen(false)} onHidden={onHidden} />
        </Sheet>
      </>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="wg-pop" align="end" sideOffset={6} collisionPadding={12} aria-label={label} onCloseAutoFocus={closeFocus}>
          <h2 className="wg-pop__title">{label}</h2>
          <WidgetSettings id={id} onClose={() => setOpen(false)} onHidden={onHidden} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
