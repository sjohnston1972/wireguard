import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "@/App";

/** Renders the whole app (shell + routes) at a URL, without a browser. */
export function renderApp(url = "/") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}
