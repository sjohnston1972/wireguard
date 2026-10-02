import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cx } from "../cx";
import "./Tabs.css";

export interface TabItem {
  value: string;
  label: string;
  /** Shown as "Label (n)" in the pill variant, like "Online (3)". */
  count?: number;
  icon?: ReactNode;
  /** Panel content. Omit when the parent renders content itself from `value`. */
  content?: ReactNode;
  /** Leading status dot in a pill tab ("In progress" is amber, "Completed" green). */
  dot?: "green" | "amber" | "red" | "grey";
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** underline: Overview/Configuration/Traffic; pill: filter pills "All (12)", section tabs. */
  variant?: "underline" | "pill";
  "aria-label": string;
  className?: string;
}

export function Tabs({ items, value, defaultValue, onValueChange, variant = "underline", className, ...rest }: TabsProps) {
  return (
    <RadixTabs.Root
      className={cx("tabs", `tabs--${variant}`, className)}
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={onValueChange}
    >
      <RadixTabs.List className="tabs__list" aria-label={rest["aria-label"]}>
        {items.map((it) => (
          <RadixTabs.Trigger key={it.value} value={it.value} className="tabs__tab">
            {it.dot && <span className={cx("tabs__dot", `tabs__dot--${it.dot}`)} aria-hidden />}
            {it.icon}
            {it.label}
            {it.count !== undefined && ` (${it.count})`}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map(
        (it) =>
          it.content !== undefined && (
            <RadixTabs.Content key={it.value} value={it.value} className="tabs__panel">
              {it.content}
            </RadixTabs.Content>
          ),
      )}
    </RadixTabs.Root>
  );
}
