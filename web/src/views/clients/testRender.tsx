import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { AppRoutes } from "@/App";
import { resetConnection } from "@/api/connection";
import { ToastProvider } from "@/components/feedback/Toast";
import { mockFetch } from "@/test/mockFetch";
import { defaultRoutes } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";

function LocationProbe() {
  const l = useLocation();
  return <output aria-label="location">{l.pathname + l.search}</output>;
}

/**
 * Like renderApp, but with a router the test holds, so it can press the
 * browser's Back (`router.navigate(-1)`).
 */
export function renderRouted(url: string, routes: Record<string, unknown>) {
  resetConnection();
  const fetchMock = mockFetch({ ...defaultRoutes(), ...routes });
  const client = testQueryClient();
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
  return { ...utils, router, client, fetchMock };
}
