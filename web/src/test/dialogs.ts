import { expect } from "vitest";

/** The dialog is the desktop's centred modal (Drawer side="auto" off the phone) at this size. */
export function expectCentredModal(dialog: HTMLElement, size: "md" | "lg" | "xl") {
  expect(dialog).toHaveAttribute("role", "dialog");
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveClass("drawer--modal");
  expect(dialog).toHaveAttribute("data-side", "center");
  expect(dialog).toHaveAttribute("data-size", size);
}

/** The dialog is the phone's bottom sheet. */
export function expectBottomSheet(dialog: HTMLElement) {
  expect(dialog).toHaveAttribute("role", "dialog");
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveAttribute("data-side", "bottom");
  expect(dialog).not.toHaveClass("drawer--modal");
}

/** The dimmed backdrop behind the open drawer or sheet. */
export const backdrop = () => document.querySelector<HTMLElement>(".drawer__overlay")!;
