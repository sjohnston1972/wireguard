import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { TABS } from "@/routes";
import { useConnection } from "@/api/connection";
import { AccountSlot, ConnectionSlot, NotesSlot, SearchSlot, StateSlot, ThemeToggleSlot } from "./slots";
import { DisconnectedBanner } from "./Connection";
import { SessionExpiredScreen } from "./SessionExpired";
import { CommandPalette } from "./CommandPalette";
import "./AppShell.css";

/**
 * The frame around every view: top bar (wordmark, six tabs, search, state
 * chip, connection light, notes, theme toggle, account), the disconnected
 * banner, the page area (or the session-expired screen), the command palette,
 * and a bottom tab bar on phones. The slots live in ./slots.tsx.
 */
export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { sessionExpired } = useConnection();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <a className="app-shell__skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="topbar__brand" aria-label="wg-admin home">
          <span className="topbar__dot" aria-hidden="true" />
          <span className="topbar__name">wg-admin</span>
        </Link>
        <nav className="topbar__tabs" aria-label="Main">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className="topbar__tab">
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar__spacer" />
        <SearchSlot onOpen={() => setPaletteOpen(true)} />
        <StateSlot />
        <ConnectionSlot />
        <NotesSlot />
        <ThemeToggleSlot />
        <AccountSlot />
      </header>
      <DisconnectedBanner />
      <main id="main" className="app-shell__page" tabIndex={-1}>
        {sessionExpired ? <SessionExpiredScreen /> : <Outlet />}
      </main>
      <nav className="tabbar" aria-label="Phone">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="tabbar__tab">
            <t.icon className="tabbar__icon" size={20} aria-hidden="true" />
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
