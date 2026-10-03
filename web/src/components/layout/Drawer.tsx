import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { useReturnFocus } from "./useReturnFocus";
import { ESCAPE_HANDOFF, escapeHandedToDialog } from "../escapeHandoff";
import { SidePanel } from "./SidePanel";
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
  /** "right" is a ~420 px side drawer that becomes a bottom sheet below 640 px; "bottom" forces a sheet. */
  side?: "right" | "bottom";
  /**
   * "modal" (default): an overlay dialog. "inline": the non-modal split-view
   * panel beside the page (see SidePanel; put it in a SplitView), which is
   * still the modal bottom sheet on the phone.
   */
  mode?: "modal" | "inline";
  children?: ReactNode;
  className?: string;
}

/**
 * Right-hand detail drawer. Radix Dialog gives focus trapping, Escape to close
 * and focus restore to the trigger. Below 640 px the CSS turns it into a bottom sheet.
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

function ModalDrawer({ open, onOpenChange, title, subtitle, leading, footer, side = "right", children, className }: DrawerProps) {
  const { onCloseAutoFocus } = useReturnFocus(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer__overlay" />
        <Dialog.Content
          className={cx("drawer", className)}
          data-side={side}
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
export function Sheet(props: Omit<DrawerProps, "side">) {
  return <Drawer {...props} side="bottom" />;
}
