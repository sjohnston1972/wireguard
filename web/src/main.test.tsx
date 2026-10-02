import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// main.tsx is the app's entry point: it renders the app and, in a production
// build only, registers the service worker. Its collaborators are stubbed.
const registerSw = vi.fn().mockResolvedValue(undefined);
vi.mock("./registerSw", () => ({ registerSw }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: vi.fn() }) }));
vi.mock("./App", () => ({ App: () => null }));

describe("main.tsx", () => {
  beforeEach(() => {
    vi.resetModules();
    registerSw.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a production build registers the service worker", async () => {
    vi.stubEnv("PROD", true);
    await import("./main");
    expect(registerSw).toHaveBeenCalledTimes(1);
  });

  it("the dev server does not", async () => {
    vi.stubEnv("PROD", false);
    await import("./main");
    expect(registerSw).not.toHaveBeenCalled();
  });
});
