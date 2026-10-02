import { vi } from "vitest";
import { mediaList, mediaMatches } from "./media";

// Every test starts as a 1600 x 900 dark desktop (polyfills.ts). setViewport
// stubs matchMedia (and innerWidth/innerHeight) as a browser of another size
// would answer, so useIsPhone() and anything else reading media queries sees
// that size. Calling it again resizes: every listener whose query changes
// answer is told, as a real resize would. Wrap a resize of a mounted
// component in act(). The stub is undone after each test (unstubGlobals).
//
//   setViewport("phone")    390 x 844  (spec §9: phone is max-width 640 px)
//   setViewport("tablet")   800 x 1000 (641-1099 px: panels stack)
//   setViewport("desktop")  1600 x 900
//   setViewport(1100)       any width, height 900

export type Viewport = "phone" | "tablet" | "desktop";

const SIZES: Record<Viewport, [number, number]> = { phone: [390, 844], tablet: [800, 1000], desktop: [1600, 900] };

type Listener = (e: MediaQueryListEvent) => void;
interface Watch {
  query: string;
  cb: Listener;
  last: boolean;
}

let size: [number, number] = SIZES.desktop;
let watches: Watch[] = [];
let stub: ((q: string) => MediaQueryList) | null = null;

function makeList(query: string): MediaQueryList {
  const mine: Watch[] = [];
  return mediaList(
    query,
    () => size,
    (cb) => {
      const w = { query, cb, last: mediaMatches(query, ...size) };
      mine.push(w);
      watches.push(w);
    },
    (cb) => {
      watches = watches.filter((w) => !(w.cb === cb && mine.includes(w)));
    },
  );
}

/** Make the test browser this size; see the top of this file. */
export function setViewport(to: Viewport | number): void {
  size = typeof to === "number" ? [to, 900] : SIZES[to];
  if (!stub || window.matchMedia !== stub) {
    // A fresh test (the previous stub was undone): start with no listeners.
    watches = [];
    stub = (q: string) => makeList(q);
    vi.stubGlobal("matchMedia", stub);
  }
  vi.stubGlobal("innerWidth", size[0]);
  vi.stubGlobal("innerHeight", size[1]);
  for (const w of [...watches]) {
    const now = mediaMatches(w.query, ...size);
    if (now !== w.last) {
      w.last = now;
      w.cb({ matches: now, media: w.query } as MediaQueryListEvent);
    }
  }
}
