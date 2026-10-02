import { Search } from "lucide-react";
import { type KeyboardEvent } from "react";
import { cx } from "../cx";
import "./SearchInput.css";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name; also the placeholder unless one is given. */
  label: string;
  placeholder?: string;
  /** Hint shown at the right, for example "⌘ K". */
  shortcut?: string;
  className?: string;
}

export function SearchInput({ value, onChange, label, placeholder, shortcut, className }: SearchInputProps) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && value) {
      e.preventDefault();
      onChange("");
    }
  };
  return (
    <div className={cx("search", className)}>
      <Search size={15} aria-hidden className="search__icon" />
      <input
        type="search"
        className="search__input"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
      />
      {shortcut && <kbd className="search__kbd">{shortcut}</kbd>}
    </div>
  );
}
