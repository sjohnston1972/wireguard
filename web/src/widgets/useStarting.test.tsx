// useStarting.test.tsx
//
// Plain English: an in-panel control that starts at a widget's "Starting
// ..." setting (spec §3.8). The setting may arrive after the page has
// drawn (preferences load late); a pick in the panel lasts for the visit
// and is never saved; a later change of the setting itself takes over.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStarting } from "@/widgets";

describe("useStarting", () => {
  it("starts at the setting and follows it when the setting arrives after the first render", () => {
    const { result, rerender } = renderHook(({ start }) => useStarting(start), { initialProps: { start: "all" } });
    expect(result.current[0]).toBe("all");
    rerender({ start: "custom" });
    expect(result.current[0]).toBe("custom");
  });

  it("a pick in the panel lasts while the setting stays the same", () => {
    const { result, rerender } = renderHook(({ start }) => useStarting(start), { initialProps: { start: "all" } });
    act(() => result.current[1]("disabled"));
    expect(result.current[0]).toBe("disabled");
    rerender({ start: "all" });
    expect(result.current[0]).toBe("disabled");
  });

  it("a later change of the setting takes over from the pick", () => {
    const { result, rerender } = renderHook(({ start }) => useStarting(start), { initialProps: { start: 30 } });
    act(() => result.current[1](60));
    rerender({ start: 90 });
    expect(result.current[0]).toBe(90);
  });

  it("an object setting rebuilt on every render is the same setting (no reset, no render loop)", () => {
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ zone }) => {
        renders++;
        return useStarting({ kind: "zone", value: zone });
      },
      { initialProps: { zone: "clients" } },
    );
    act(() => result.current[1]({ kind: "zone", value: "home" }));
    rerender({ zone: "clients" });
    expect(result.current[0]).toEqual({ kind: "zone", value: "home" });
    expect(renders).toBeLessThan(10);
    rerender({ zone: "azure" });
    expect(result.current[0]).toEqual({ kind: "zone", value: "azure" });
  });
});
