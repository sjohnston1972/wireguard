import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { useReturnFocus } from "./useReturnFocus";
import { ESCAPE_HANDOFF, escapeHandedToDialog } from "../escapeHandoff";
import { SidePanel, useIsPhone } from "./SidePanel";
import "./Drawer.css";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Small line under the title (address, id). */
  subtitle?: ReactNode;
  /** Leading element in the header, for example a status dot or device icon. */
  leading?: ReactNode;
  /** Pinned at the bottom (actions). */
  footer?: ReactNode;
  /**
   * "auto" (default): a centred modal dialog on the desktop and tablet, the
   * bottom sheet on the phone (640 px and below). "bottom": always a sheet.
   * "right": a full-height modal panel sliding in from the right (about 440 px,
   * the labs catalogue's tablet details), still the bottom sheet on the phone.
   */
  side?: "auto" | "bottom" | "right";
  /**
   * The centred modal's width: "md" about 640 px (default), "lg" up to 1100 px, "xl" up to 1400 px and a
   * little taller (a lab's diagram). The phone sheet ignores it.
   */
  size?: "md" | "lg" | "xl";
  /**
   * "modal" (default): an overlay dialog. "inline": the non-modal split-view
   * panel beside the page (see SidePanel; put it in a SplitView), which is
   * still the modal bottom sheet on the phone.
   */
  mode?: "modal" | "inline";
  children?: ReactNode;
  className?: string;
  /** Where focus goes on close: call preventDefault() and focus something to override the default (back to what had focus before). */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Details and secondary flows in a dialog: a centred modal on the desktop, a
 * bottom sheet on the phone. Radix Dialog gives the focus trap, and Escape or
 * a click on the dimmed backdrop closes it; useReturnFocus puts focus back on
 * whatever opened it. The body scrolls inside; the header and footer stay put.
 */
export function Drawer(props: DrawerProps) {
  if (props.mode === "inline") {
    const { open, onOpenChange, title, subtitle, leading, footer, children, className } = props;
    return (
      <SidePanel open={open} onClose={() => onOpenChange(false)} title={title} subtitle={subtitle} leading={leading} footer={footer} className={className}>
        {children}
      </SidePanel>
    );
  }
  return <ModalDrawer {...props} />;
}

function ModalDrawer({ open, onOpenChange, title, subtitle, leading, footer, side = "auto", size = "md", children, className, onCloseAutoFocus: onClose }: DrawerProps) {
  const returnFocus = useReturnFocus(open);
  const phone = useIsPhone();
  const sheet = side === "bottom" || phone;
  const where = sheet ? "bottom" : side === "right" ? "right" : "center";
  const onCloseAutoFocus = (e: Event) => {
    onClose?.(e);
    if (!e.defaultPrevented) returnFocus.onCloseAutoFocus(e);
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer__overlay" data-side={where} />
        <Dialog.Content
          className={cx("drawer", where === "center" && "drawer--modal", where === "right" && "drawer--right", className)}
          data-side={where}
          data-size={where === "center" ? size : undefined}
          aria-modal="true"
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          {...{ [ESCAPE_HANDOFF]: "" }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && escapeHandedToDialog(e.nativeEvent)) {
              e.stopPropagation(); // an outer dialog stays open
              onOpenChange(false);
            }
          }}
        >
          <header className="drawer__head">
            {leading}
            <div className="drawer__titles">
              <Dialog.Title className="drawer__title">{title}</Dialog.Title>
              {subtitle && <p className="drawer__subtitle">{subtitle}</p>}
            </div>
            <Dialog.Close className="drawer__close" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </header>
          <div className="drawer__body">{children}</div>
          {footer && <footer className="drawer__foot">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A Drawer that is always a bottom sheet (phone flows). */
export function Sheet(props: Omit<DrawerProps, "side" | "size">) {
  return <Drawer {...props} side="bottom" />;
}
