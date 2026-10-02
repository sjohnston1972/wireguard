import { useState } from "react";
import { Moon, Search, Sun } from "lucide-react";
import { currentTheme, setTheme } from "./theme";
import { AccountMenu } from "./AccountMenu";
import { ConnectionIndicator } from "./Connection";
import { EnvLabel, StateChip } from "./StateChip";
import { NotesIndicator } from "./NotesIndicator";

// The top bar's right-hand side, in order: search, state chip (with the
// read-only environment label), connection light, notes bell, theme toggle,
// account menu. Each is live; the data they show comes from the api/ hooks.

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");

export function SearchSlot({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="topbar__search" aria-label="Search" aria-keyshortcuts="Control+K Meta+K" onClick={onOpen}>
      <Search size={16} aria-hidden="true" />
      <span className="topbar__search-text">Search clients, logs, settings...</span>
      <kbd className="topbar__kbd" aria-hidden="true">
        {isMac ? "⌘ K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

export function StateSlot() {
  return (
    <>
      <EnvLabel />
      <StateChip />
    </>
  );
}

export const ConnectionSlot = ConnectionIndicator;
export const NotesSlot = NotesIndicator;

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

export const AccountSlot = AccountMenu;
