import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { resetConnection } from "@/api/connection";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes } from "@/App";
import { makeQueryClient } from "@/api/queryClient";
import { ToastProvider } from "@/components/feedback/Toast";
import { mockFetch } from "./mockFetch";
import { defaultRoutes } from "./fixtures";

/** Exposes the current path and query string to assertions (role "log", name "location"). */
function LocationProbe() {
  const l = useLocation();
  return <output aria-label="location">{l.pathname + l.search}</output>;
}

/** A query client for tests: no retries, so a failure shows at once. */
export function testQueryClient() {
  const client = makeQueryClient();
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false, staleTime: 0 } });
  return client;
}

/**
 * Renders one piece of UI (not the whole app) the way the app hosts it: a
 * fresh query client, a toast host and a router, with fetch mocked by
 * `routes` (the shell's default answers, widget preferences included, unless
 * `routes: null`). For widget framework tests and small view parts.
 */
export function renderWithProviders(ui: React.ReactNode, opts: { routes?: Record<string, unknown> | null; url?: string } = {}) {
  resetConnection();
  const fetchMock = opts.routes === null ? null : mockFetch({ ...defaultRoutes(), ...(opts.routes ?? {}) });
  const client = testQueryClient();
  const router = createMemoryRouter([{ path: "*", element: ui }], { initialEntries: [opts.url ?? "/"] });
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client, fetchMock, router };
}

/**
 * Renders the whole app (shell + routes) at a URL, without a browser, with a
 * fresh query client, a toast host, and fetch mocked with `routes` (default:
 * a running session; see fixtures.ts). Pass `routes: null` to leave fetch alone.
 */
export function renderApp(url = "/", opts: { routes?: Record<string, unknown> | null } = {}) {
  resetConnection();
  const fetchMock = opts.routes === null ? null : mockFetch({ ...defaultRoutes(), ...(opts.routes ?? {}) });
  const client = testQueryClient();
  // A data router, as in the app, so useBlocker works.
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <AppRoutes />
            <LocationProbe />
          </>
        ),
      },
    ],
    { initialEntries: [url] },
  );
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client, fetchMock, router };
}
