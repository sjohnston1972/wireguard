import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, SessionExpiredError, apiGet, apiSend } from "./client";
import { connection, resetConnection } from "./connection";
import { mockFetch } from "@/test/mockFetch";

beforeEach(() => resetConnection());
afterEach(() => vi.unstubAllGlobals());

describe("apiGet", () => {
  it("sends a same-origin credentialed request that does not follow redirects", async () => {
    const m = mockFetch({ "GET /api/v1/session": { user: "a@b.c" } });
    expect(await apiGet("/session")).toEqual({ user: "a@b.c" });
    const init = m.calls[0]!.init;
    expect(m.calls[0]!.url).toBe("/api/v1/session");
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
  });

  it("accepts a path that already starts with /api/v1", async () => {
    const m = mockFetch({ "GET /api/v1/clients": { clients: [] } });
    await apiGet("/api/v1/clients");
    expect(m.calls[0]!.url).toBe("/api/v1/clients");
  });

  it("maps the API's error shape to ApiError with status, code, message and field", async () => {
    mockFetch({ "GET /api/v1/history": { status: 400, json: { error: { code: "bad_input", message: "Range is one of 1h.", field: "range" } } } });
    const err = await apiGet("/history").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "bad_input", message: "Range is one of 1h.", field: "range" });
  });

  it("leaves field undefined when the error has none", async () => {
    mockFetch({ "GET /api/v1/x": { status: 409, json: { error: { code: "conflict", message: "Locked." } } } });
    const err = (await apiGet("/x").catch((e) => e)) as ApiError;
    expect(err.field).toBeUndefined();
    expect(err.status).toBe(409);
  });

  it("treats an opaque redirect (Access at the edge) as an expired session", async () => {
    mockFetch({ "GET /api/v1/session": { opaqueRedirect: true } });
    await expect(apiGet("/session")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(connection.get().sessionExpired).toBe(true);
  });

  it("treats a 401 as an expired session", async () => {
    mockFetch({ "GET /api/v1/session": { status: 401, json: { error: { code: "unauthorized", message: "Sign in." } } } });
    await expect(apiGet("/session")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("treats a non-JSON answer (a login page) as an expired session", async () => {
    mockFetch({ "GET /api/v1/session": { text: "<html>Sign in</html>", contentType: "text/html" } });
    await expect(apiGet("/session")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("raises NetworkError when fetch fails, and marks the app disconnected", async () => {
    mockFetch({ "GET /api/v1/overview": { networkError: true } });
    await expect(apiGet("/overview")).rejects.toBeInstanceOf(NetworkError);
    expect(connection.get().disconnected).toBe(true);
  });

  it("clears disconnected after the next good answer", async () => {
    let fail = true;
    mockFetch({ "GET /api/v1/overview": () => (fail ? { networkError: true } : { ok: 1 }) });
    await apiGet("/overview").catch(() => {});
    fail = false;
    await apiGet("/overview");
    expect(connection.get().disconnected).toBe(false);
  });

  it("a 500 with the API's error shape is an ApiError, not a disconnection", async () => {
    mockFetch({ "GET /api/v1/x": { status: 500, json: { error: { code: "internal", message: "Something broke (reference ab12cd34)." } } } });
    const err = await apiGet("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(connection.get().disconnected).toBe(false);
  });

  it("a non-JSON answer to an API call is an expired session even on a 502", async () => {
    mockFetch({ "GET /api/v1/x": { status: 502, text: "Bad gateway", contentType: "text/plain" } });
    await expect(apiGet("/x")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe("apiSend", () => {
  it("sends a JSON body with the JSON content type", async () => {
    const m = mockFetch({ "POST /api/v1/destroy": { ok: true, message: "Started." } });
    const out = await apiSend("POST", "/destroy", { confirm: "destroy" });
    expect(out).toEqual({ ok: true, message: "Started." });
    expect(m.calls[0]!.init.method).toBe("POST");
    expect((m.calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(m.calls[0]!.init.body).toBe('{"confirm":"destroy"}');
  });

  it("sends nothing, and no content type, when there is no body", async () => {
    const m = mockFetch({ "POST /api/v1/cancel": { ok: true, message: "Cancelled." } });
    await apiSend("POST", "/cancel");
    expect(m.calls[0]!.init.body).toBeUndefined();
    expect((m.calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("maps a refusal to ApiError carrying the field", async () => {
    mockFetch({ "POST /api/v1/destroy": { status: 422, json: { error: { code: "confirm_required", message: 'Type "destroy" to confirm.', field: "confirm" } } } });
    const err = (await apiSend("POST", "/destroy", {}).catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ status: 422, code: "confirm_required", field: "confirm" });
  });

  it("a DELETE with an opaque redirect is an expired session", async () => {
    mockFetch({ "DELETE /api/v1/clients/3": { opaqueRedirect: true } });
    await expect(apiSend("DELETE", "/clients/3")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
