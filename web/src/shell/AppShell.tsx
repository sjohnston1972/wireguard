import { Link, NavLink, Outlet } from "react-router-dom";
import { TABS } from "@/routes";
import { AccountSlot, RegionChipSlot, SearchSlot, ThemeToggleSlot } from "./slots";
import "./AppShell.css";

/**
 * The frame around every view: top bar (wordmark, six tabs, search, region
 * chip, theme toggle, account), the page area, and a bottom tab bar on phones.
 * The slots in the top bar live in ./slots.tsx; the data-layer/shell work
 * (plan 3 P3) replaces them with the live versions.
 */
export function AppShell() {
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
        <SearchSlot />
        <RegionChipSlot />
        <ThemeToggleSlot />
        <AccountSlot />
      </header>
      <main id="main" className="app-shell__page" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Phone">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="tabbar__tab">
            <t.icon className="tabbar__icon" size={20} aria-hidden="true" />
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
