import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useReturnFocus } from "./useReturnFocus";
import { ESCAPE_HANDOFF, escapeHandedToDialog } from "../escapeHandoff";
import "./Modal.css";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Becomes the dialog's accessible description. */
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  width?: number;
}

/**
 * Centred dialog for reviewed forms and confirmations (never window.confirm).
 * It has the same look as a Drawer's desktop modal: blurred backdrop, header
 * and footer bars, and the body scrolling between them.
 */
export function Modal({ open, onOpenChange, title, description, footer, children, width = 480 }: ModalProps) {
  const { onCloseAutoFocus } = useReturnFocus(open);
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal__overlay" />
        <Dialog.Content
          className="modal"
          style={{ maxWidth: width }}
          aria-modal="true"
          onCloseAutoFocus={onCloseAutoFocus}
          {...(description ? {} : { "aria-describedby": undefined })}
          {...{ [ESCAPE_HANDOFF]: "" }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && escapeHandedToDialog(e.nativeEvent)) {
              e.stopPropagation(); // an outer dialog stays open
              onOpenChange(false);
            }
          }}
        >
          <header className="modal__head">
            <div className="modal__titles">
              <Dialog.Title className="modal__title">{title}</Dialog.Title>
              {description && <Dialog.Description className="modal__desc">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="modal__close" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </header>
          {hasBody && <div className="modal__body">{children}</div>}
          {footer && <footer className="modal__foot">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
