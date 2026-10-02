import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setViewport } from "@/test/viewport";
import { useMedia } from "./useMedia";

describe("useMedia", () => {
  it("answers the query and follows a resize", () => {
    setViewport("desktop");
    const { result } = renderHook(() => useMedia("(max-width: 1399px)"));
    expect(result.current).toBe(false);
    act(() => setViewport(1100));
    expect(result.current).toBe(true);
  });

  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useMedia("(max-width: 1399px)"));
    expect(result.current).toBe(false);
  });
});
