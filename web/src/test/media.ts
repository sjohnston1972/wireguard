// How a browser of a given size answers a media query, for the test
// matchMedia (polyfills.ts gives every test a 1600 x 900 dark desktop;
// viewport.ts's setViewport changes the size). Width/height features,
// prefers-color-scheme (always dark, the app's default) and media types are
// understood; any other feature answers false.

function feature(f: string, width: number, height: number): boolean {
  const m = f.trim().match(/^\(\s*([a-z-]+)\s*(?::\s*([^)]+?)\s*)?\)$/i);
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  const raw = (m[2] ?? "").toLowerCase();
  const px = parseFloat(raw);
  switch (name) {
    case "max-width":
      return width <= px;
    case "min-width":
      return width >= px;
    case "max-height":
      return height <= px;
    case "min-height":
      return height >= px;
    case "prefers-color-scheme":
      return raw === "dark";
    default:
      return false;
  }
}

/** Whether `query` (features joined by "and", alternatives by ",") matches a width x height browser. */
export function mediaMatches(query: string, width: number, height: number): boolean {
  return query.split(",").some((alt) => {
    // A media type ("screen", "only screen", "all") always matches; drop it.
    const parts = alt
      .split(/\band\b/i)
      .map((p) => p.trim())
      .filter((p) => p && !/^(only\s+)?(screen|all)$/i.test(p));
    return parts.every((p) => feature(p, width, height));
  });
}

/** A MediaQueryList whose `matches` is read live from `size()`; listeners go to `onAdd`/`onRemove`. */
export function mediaList(
  query: string,
  size: () => [number, number],
  onAdd: (cb: (e: MediaQueryListEvent) => void) => void = () => {},
  onRemove: (cb: (e: MediaQueryListEvent) => void) => void = () => {},
): MediaQueryList {
  return {
    media: query,
    get matches() {
      return mediaMatches(query, ...size());
    },
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => onAdd(cb),
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => onRemove(cb),
    addListener: onAdd,
    removeListener: onRemove,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}
