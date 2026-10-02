import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../cx";
import "./IconButton.css";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Required: an icon button has no visible text, so this is its accessible name. */
  label: string;
  size?: "sm" | "md";
  variant?: "bordered" | "plain";
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", variant = "bordered", className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx("icon-btn", `icon-btn--${size}`, `icon-btn--${variant}`, className)}
      {...rest}
    >
      {children}
    </button>
  );
});
