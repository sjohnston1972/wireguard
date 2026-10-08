// shared/demo.ts
//
// Plain English: demo mode's rule book, read by both the Worker's gate and the
// app's client guard (demo mode spec §3 ruling 4). While a person is in demo
// mode every request is one of three kinds:
//
//   control  the demo switch itself (GET/PUT /demo, POST /demo/refresh): works
//            in both modes, against the real switch and the demo store
//   read     GET and HEAD, plus the one POST that writes nothing (the firewall
//            simulator): answered from the demo store
//   refuse   everything else: 409 "Demo mode is on: actions are off." before
//            any handler runs
//
// Reads are by method; the two short lists are exact (no case folding, no
// trailing-slash or percent-decoding), so a path that only looks like a
// control or read route is refused, never let through. A new write route is
// refused by default.

/** The demo switch's own routes (paths after /api/v1). */
export const DEMO_CONTROL: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/demo" },
  { method: "PUT", path: "/demo" },
  { method: "POST", path: "/demo/refresh" },
];

/** POSTs that write nothing, so demo mode serves them from the demo store. */
export const DEMO_READ_POSTS: readonly string[] = ["/firewall/simulate"];

/** The refusal's words (409 demo_mode), also the app's toast. */
export const DEMO_REFUSED_MESSAGE = "Demo mode is on: actions are off.";

/** Every /api/v1 answer says where its data came from: "real" or "demo". */
export const DEMO_DATA_HEADER = "X-WG-Data";

/** The dev seeder's story the demo store holds. */
export const DEMO_STORY = "everything";

export type DemoDataSource = "real" | "demo";
export type DemoRouteKind = "control" | "read" | "refuse";

/**
 * What a request is in demo mode. `subPath` is the path after /api/v1 (any
 * query string or fragment is ignored); `method` in any case.
 */
export function demoRouteKind(method: string, subPath: string): DemoRouteKind {
  const m = method.toUpperCase();
  const cut = subPath.search(/[?#]/);
  const path = cut === -1 ? subPath : subPath.slice(0, cut);
  if (DEMO_CONTROL.some((c) => c.method === m && c.path === path)) return "control";
  if (m === "GET" || m === "HEAD") return "read";
  if (m === "POST" && DEMO_READ_POSTS.includes(path)) return "read";
  return "refuse";
}
