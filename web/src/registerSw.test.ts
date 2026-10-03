import { describe, expect, it, vi } from "vitest";
import { registerSw } from "./registerSw";

describe("registerSw", () => {
  it("main registers /sw.js at scope /", async () => {
    // The same URL and scope as the old dashboard, so phones keep their push subscription.
    const register = vi.fn().mockResolvedValue({});
    await registerSw({ serviceWorker: { register } } as unknown as Navigator);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("a failed registration is swallowed", async () => {
    const register = vi.fn().mockRejectedValue(new Error("blocked"));
    await expect(registerSw({ serviceWorker: { register } } as unknown as Navigator)).resolves.toBeUndefined();
  });

  it("a browser without service workers is left alone", async () => {
    await expect(registerSw({} as Navigator)).resolves.toBeUndefined();
  });
});
