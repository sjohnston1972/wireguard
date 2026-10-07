// shell/Chromeless.tsx
//
// Plain English: the frame of the app's pages, chosen by address. Every page
// has the AppShell (top bar, tabs, palette), except a lab diagram popped out
// into its own window (/labs/:id/diagram?popout=1, issue #93), which is drawn
// chromeless: no navigation, just the page, with the same disconnected banner
// and the same "Session expired" screen as the rest of the app.

import { Outlet, useLocation } from "react-router-dom";
import { useConnection } from "@/api/connection";
import { AppShell } from "./AppShell";
import { DisconnectedBanner } from "./Connection";
import { SessionExpiredScreen } from "./SessionExpired";
import "./AppShell.css";

/** A lab's diagram in its pop-out window: /labs/:id/diagram?popout=1. */
export function isPopOutAddress(pathname: string, search: string): boolean {
  return /^\/labs\/[^/]+\/diagram\/?$/.test(pathname) && new URLSearchParams(search).get("popout") === "1";
}

/** A page with no navigation around it (the pop-out window). */
export function ChromelessShell() {
  const { sessionExpired } = useConnection();
  return (
    <div className="app-shell app-shell--chromeless">
      <DisconnectedBanner />
      <main id="main" className="app-shell__page app-shell__page--chromeless" tabIndex={-1}>
        {sessionExpired ? <SessionExpiredScreen /> : <Outlet />}
      </main>
    </div>
  );
}

/** The frame for the current address: the AppShell, or chromeless for a pop-out window. */
export function Shell() {
  const { pathname, search } = useLocation();
  return isPopOutAddress(pathname, search) ? <ChromelessShell /> : <AppShell />;
}
