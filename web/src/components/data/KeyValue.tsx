import type { ReactNode } from "react";
import { cx } from "../cx";
import { CopyButton } from "./CopyButton";
import "./KeyValue.css";

export interface KeyValueItem {
  label: string;
  value: ReactNode | null;
  /** Monospace (addresses, keys). */
  mono?: boolean;
  /** Adds a copy button. true copies the value when it is a string; a string copies that text instead. */
  copy?: boolean | string;
}

export interface KeyValueProps {
  items: KeyValueItem[];
  className?: string;
}

/** Label/value list used in the client drawer and Settings (Tunnel address, Public key, Endpoint...). */
export function KeyValue({ items, className }: KeyValueProps) {
  return (
    <dl className={cx("kv", className)}>
      {items.map((it) => {
        const text = typeof it.copy === "string" ? it.copy : typeof it.value === "string" ? it.value : null;
        const missing = it.value === null || it.value === undefined || it.value === "";
        return (
          <div className="kv__row" key={it.label}>
            <dt className="kv__label">{it.label}</dt>
            <dd className={cx("kv__value", it.mono && "kv__value--mono", missing && "kv__value--none")}>
              <span className="kv__text">{missing ? "no data" : it.value}</span>
              {it.copy && text && !missing && <CopyButton text={text} label={`Copy ${it.label}`} />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
