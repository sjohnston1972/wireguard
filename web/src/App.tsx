import { lazy, Suspense, useState } from "react";
import { createBrowserRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient } from "@/api/queryClient";
import { AppShell } from "@/shell/AppShell";
import { ToastProvider } from "@/components/feedback/Toast";
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

// Dev-only component gallery. `import.meta.env.DEV` is a build-time constant, so
// production builds drop both the lazy import and the route.
const Gallery = import.meta.env.DEV ? lazy(() => import("@/gallery")) : null;

/**
 * The route table, inside whatever data router the caller provides (the app
 * a browser router, tests a memory router). A data router, so a page can hold
 * navigation with useBlocker (Settings' unsaved changes).
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {Gallery && (
          <Route
            path="__gallery"
            element={
              <Suspense fallback={null}>
                <Gallery />
              </Suspense>
            }
          />
        )}
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

const queryClient = makeQueryClient();

export function App() {
  // Made on first render, not at import, so importing AppRoutes has no side effects.
  const [router] = useState(() => createBrowserRouter([{ path: "*", element: <AppRoutes /> }]));
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
