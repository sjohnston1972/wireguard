import { describe, it, expect } from "vitest";
import { makeEnv } from "./harness";
import worker from "../src/index";
import { movedTo } from "../src/moved";

// The move to cloudlabs.clydeford.net (#126): the old address's showcase links
// go on to the new one; the machines' API paths stay put on both.

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const OLD = "https://wg-admin.clydeford.net";

describe("movedTo", () => {
  it("sends the old showcase on, path and query kept", () => {
    expect(movedTo(`${OLD}/showcase/?film=02`, "GET")).toBe("https://cloudlabs.clydeford.net/showcase/?film=02");
    expect(movedTo(`${OLD}/showcase`, "HEAD")).toBe("https://cloudlabs.clydeford.net/showcase");
  });

  it("leaves the machines' paths, other methods and the new address alone", () => {
    for (const p of ["/api/agent", "/api/callback", "/api/act/abc", "/api/v1/overview", "/assets/x.js", "/manifest.webmanifest", "/health"]) expect(movedTo(OLD + p, "GET"), p).toBeNull();
    expect(movedTo(`${OLD}/showcase/`, "POST")).toBeNull();
    expect(movedTo("https://cloudlabs.clydeford.net/showcase/", "GET")).toBeNull();
    expect(movedTo("http://localhost:8787/showcase/", "GET")).toBeNull();
  });

  it("the Worker answers the old showcase with a permanent redirect", async () => {
    const r = (await worker.fetch(new Request(`${OLD}/showcase/`), makeEnv().env, ctx)) as Response;
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("https://cloudlabs.clydeford.net/showcase/");
  });

  it("the VM's heartbeat still reaches the Worker on the old address", async () => {
    const r = (await worker.fetch(new Request(`${OLD}/api/agent`, { method: "POST" }), makeEnv().env, ctx)) as Response;
    expect(r.status).not.toBe(301);
  });
});
