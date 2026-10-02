import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useReturnFocus } from "./useReturnFocus";
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

/** Centred dialog for reviewed forms and confirmations (never window.confirm). */
export function Modal({ open, onOpenChange, title, description, footer, children, width = 480 }: ModalProps) {
  const { onCloseAutoFocus } = useReturnFocus(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal__overlay" />
        <Dialog.Content
          className="modal"
          style={{ maxWidth: width }}
          onCloseAutoFocus={onCloseAutoFocus}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <header className="modal__head">
            <Dialog.Title className="modal__title">{title}</Dialog.Title>
            <Dialog.Close className="modal__close" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </header>
          {description && <Dialog.Description className="modal__desc">{description}</Dialog.Description>}
          <div className="modal__body">{children}</div>
          {footer && <footer className="modal__foot">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
