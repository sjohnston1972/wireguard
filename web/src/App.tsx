import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "@/shell/AppShell";
import {
  ActivityPage,
  ClientDetailPage,
  ClientsPage,
  CostPage,
  FirewallPage,
  FirewallRulePage,
  NotFoundPage,
  OverviewPage,
  RunDetailPage,
  SettingsPage,
} from "@/views/pages";

/** The route table, inside whatever router the caller provides (tests use MemoryRouter). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="clients/:id" element={<ClientDetailPage />} />
        <Route path="firewall" element={<FirewallPage />} />
        <Route path="firewall/rules/:id" element={<FirewallRulePage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="activity/runs/:id" element={<RunDetailPage />} />
        <Route path="cost" element={<CostPage />} />
        <Route path="settings/:section?" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
