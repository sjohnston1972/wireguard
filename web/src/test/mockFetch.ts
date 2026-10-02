import { vi } from "vitest";

/** What a mocked route answers with. */
export type MockReply =
  | { status?: number; json: unknown }
  | { status?: number; text: string; contentType?: string }
  | { opaqueRedirect: true }
  | { networkError: true };

/** A MockReply, any other value (sent as 200 JSON), or a function returning either (may be async). */
export type MockHandler = unknown;

export interface Call {
  method: string;
  url: string;
  body: unknown;
  init: RequestInit;
}

/**
 * Replaces global fetch with a router. Keys are "METHOD /path" (query string
 * included when you want to match it; otherwise matched on the path alone).
 * A handler may return a MockReply, a ready-made Response, or any other
 * value, which is sent as a 200 JSON answer. Unmatched requests fail the test loudly.
 */
export function mockFetch(routes: Record<string, MockHandler>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body, init });
    const path = url.split("?")[0]!;
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${path}`];
    if (handler === undefined) throw new Error(`mockFetch: no route for ${method} ${url}`);
    const raw = typeof handler === "function" ? await (handler as (req: { url: string; method: string; body: unknown; init: RequestInit }) => unknown)({ url, method, body, init }) : handler;
    // A handler may build the whole Response itself (headers such as Content-Disposition).
    if (raw instanceof Response) return raw;
    const reply = isReply(raw) ? raw : ({ json: raw } as MockReply);
    if ("networkError" in reply) throw new TypeError("Failed to fetch");
    if ("opaqueRedirect" in reply) return { type: "opaqueredirect", status: 0, ok: false, headers: new Headers(), text: async () => "" } as unknown as Response;
    if ("text" in reply) return new Response(reply.text, { status: reply.status ?? 200, headers: { "Content-Type": reply.contentType ?? "text/html" } });
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return { calls, spy, callsTo: (method: string, pathPrefix: string) => calls.filter((c) => c.method === method && c.url.startsWith(pathPrefix)) };
}

function isReply(v: unknown): v is MockReply {
  return typeof v === "object" && v !== null && ("json" in v || "text" in v || "opaqueRedirect" in v || "networkError" in v);
}
