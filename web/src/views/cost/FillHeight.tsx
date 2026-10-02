import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Gives a chart the height its panel has left. On a desktop window the box
 * takes the rest of the panel body (CSS `.cost-fill`) and reports its height;
 * where it cannot (no ResizeObserver, or the page stacks below 1100 px and
 * nothing fixes the panel's height) the chart gets `fallback`.
 */
export function FillHeight({ fallback, min = 48, children }: { fallback: number; min?: number; children: (height: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // Only a box that takes its height from the panel (flex: 1 1 0) is measured; a stacked page keeps the fallback.
      if (getComputedStyle(el).flexBasis !== "0px") return setHeight(fallback);
      const h = Math.floor(el.getBoundingClientRect().height);
      if (h > 0) setHeight(Math.max(min, h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback, min]);
  return (
    <div ref={ref} className="cost-fill">
      {children(height)}
    </div>
  );
}
