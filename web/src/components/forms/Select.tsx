import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../cx";
import "./Select.css";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional leading element, for example a flag or a status dot. */
  icon?: ReactNode;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name. */
  label: string;
  /** Show the label as small text above the control (the mockups' "Region", "VM Size"). */
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Select({ options, value, onValueChange, label, showLabel, disabled, className }: SelectProps) {
  const selected = options.find((o) => o.value === value);
  return (
    <div className={cx("select", className)}>
      {showLabel && <span className="select__caption">{label}</span>}
      <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RadixSelect.Trigger className="select__trigger" aria-label={label}>
          <span className="select__value">
            {selected?.icon}
            <RadixSelect.Value>{selected?.label}</RadixSelect.Value>
          </span>
          <RadixSelect.Icon>
            <ChevronDown size={15} aria-hidden />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content className="select__content" position="popper" sideOffset={4}>
            <RadixSelect.Viewport className="select__viewport">
              {options.map((o) => (
                <RadixSelect.Item key={o.value} value={o.value} className="select__item">
                  {o.icon}
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="select__check">
                    <Check size={14} aria-hidden />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
