import { Moon, Search, Sun } from "lucide-react";
import { IconButton } from "@/components/forms/IconButton";
import { setTheme, useTheme } from "./theme";
import { AccountMenu } from "./AccountMenu";
import { ConnectionIndicator } from "./Connection";
import { StateChip } from "./StateChip";
import { NotesIndicator } from "./NotesIndicator";

// The top bar's right-hand side, in order: search, state chip (its dot also
// carries the connection level; a screen-reader-only status announces it),
// notes bell, theme toggle, account menu. Each is live; the data they show
// comes from the api/ hooks. The read-only "Production" environment is not in
// the bar: views put <EnvironmentField /> in their PageHeader's `env` slot.

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

export const StateSlot = StateChip;

export const ConnectionSlot = ConnectionIndicator;
export const NotesSlot = NotesIndicator;

export function ThemeToggleSlot() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <IconButton className="topbar__icon-btn" label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      {theme === "dark" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
    </IconButton>
  );
}

export const AccountSlot = AccountMenu;
