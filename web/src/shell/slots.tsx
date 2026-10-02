import { useState } from "react";
import { ChevronDown, Moon, Search, Sun, User } from "lucide-react";
import { currentTheme, setTheme } from "./theme";

// Placeholder slots for the top bar. They look like the mockups but show no
// live data (no invented numbers). Plan 3 P3 replaces them: the search button
// opens the command palette, the chip comes from /overview, the account menu
// from /session.

export function SearchSlot() {
  return (
    <button type="button" className="topbar__search" aria-label="Search">
      <Search size={16} aria-hidden="true" />
      <span className="topbar__search-text">Search clients, logs, settings...</span>
      <kbd className="topbar__kbd" aria-hidden="true">
        ⌘ K
      </kbd>
    </button>
  );
}

export function RegionChipSlot() {
  return (
    <div className="topbar__chip">
      <span className="topbar__chip-dot" aria-hidden="true" />
      <span>Azure • UK South</span>
    </div>
  );
}

export function ThemeToggleSlot() {
  const [theme, set] = useState(currentTheme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="topbar__icon-btn"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
        set(next);
      }}
    >
      {theme === "dark" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
    </button>
  );
}

export function AccountSlot() {
  return (
    <button type="button" className="topbar__account" aria-label="Account menu">
      <span className="topbar__avatar" aria-hidden="true">
        <User size={16} />
      </span>
      <span className="topbar__account-text">Account</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
}
