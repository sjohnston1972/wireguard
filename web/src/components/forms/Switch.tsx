import * as RadixSwitch from "@radix-ui/react-switch";
import { cx } from "../cx";
import "./Switch.css";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name (the switch has no visible text of its own). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/** The blue pill toggle from the Firewall mockup. */
export function Switch({ checked, onCheckedChange, label, disabled, className }: SwitchProps) {
  return (
    <RadixSwitch.Root
      className={cx("switch", className)}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      disabled={disabled}
    >
      <RadixSwitch.Thumb className="switch__thumb" />
    </RadixSwitch.Root>
  );
}
