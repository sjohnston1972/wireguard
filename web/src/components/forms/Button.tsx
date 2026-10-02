import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cx } from "../cx";
import "./Button.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  /** Shows a spinner and ignores clicks (the label stays so the name is stable). */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, onClick, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", `btn--${variant}`, `btn--${size}`, className)}
      disabled={disabled}
      aria-busy={loading ? true : undefined}
      onClick={(e) => {
        if (loading) return;
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <Loader2 className="btn__spin" size={14} aria-hidden /> : icon}
      {children}
    </button>
  );
});
