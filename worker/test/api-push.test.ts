// api-push.test.ts
//
// Plain English: phone alerts, through /api/v1/push (the app and its service
// worker call these): proper JSON errors, and a phone's keys never shown.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";

afterEach(() => vi.unstubAllGlobals());

const P256 = "BpEcTzQ" + "x".repeat(80); // 87 characters of the right alphabet
const AUTH = "aUthSecret0123456789"; // 20 characters
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abcdefghijkl";
const sub = (over: Record<string, unknown> = {}) => ({ endpoint: ENDPOINT, keys: { p256dh: P256, auth: AUTH }, label: "Pixel", ...over });

// Nothing a phone's push service gave us may come back out of the API.
const noKeys = (text: string) => {
  expect(text).not.toContain(P256);
  expect(text).not.toContain(AUTH);
  expect(text).not.toContain("p256dh");
  expect(text).not.toContain("fcm.googleapis.com");
};

describe("POST /push/subscribe", () => {
  it("cuts a long label to 40 characters; no label is a device", async () => {
    const { env } = apiEnv();
    await api(env, "POST", "/push/subscribe", sub({ label: "L".repeat(60) }));
    expect((await db.listPushSubs(env))[0].label).toBe("L".repeat(40));
    await api(env, "POST", "/push/subscribe", sub({ endpoint: ENDPOINT + "2", label: undefined }));
    expect((await db.listPushSubs(env))[1].label).toBeNull();
    expect((await db.listAlerts(env)).map((a) => a.message)).toContain("Phone alerts turned on for a device by dev@localhost.");
  });

  it("registers a phone, with an alert and an audit entry, and answers ApiOk", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/push/subscribe", sub());
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.message).toBe("string");
    noKeys(r.text);
    expect((await db.listPushSubs(env)).map((s) => s.label)).toEqual(["Pixel"]);
    expect((await db.listAlerts(env)).map((a) => a.message)).toContain("Phone alerts turned on for Pixel by dev@localhost.");
    expect((await db.listAudit(env)).find((a) => a.action === "push.add")?.target).toBe("Pixel");
  });

  it("refuses a bad subscription with 400 and stores nothing", async () => {
    const { env } = apiEnv();
    const cases: [unknown, string][] = [
      [sub({ endpoint: "https://evil.example/collect/abcdef" }), "endpoint"],
      [sub({ endpoint: 5 }), "endpoint"],
      [sub({ keys: { p256dh: "short", auth: AUTH } }), "keys"],
      [sub({ keys: "nope" }), "keys"],
      [sub({ keys: { p256dh: P256, auth: "!" } }), "keys"],
      [sub({ label: 7 }), "label"],
      [{}, "endpoint"],
    ];
    for (const [bad, field] of cases) {
      const r = await api(env, "POST", "/push/subscribe", bad);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("bad_input");
      expect(r.json.error.field).toBe(field);
      if (field !== "label") expect(r.json.error.message).toBe("That does not look like a push subscription.");
    }
    expect((await api(env, "POST", "/push/subscribe")).status).toBe(400);
    expect(await db.listPushSubs(env)).toEqual([]);
  });
});

describe("GET /push/status", () => {
  it("says whether this phone is on the list, with its id and the public key, and no keys", async () => {
    const { env } = apiEnv({ VAPID_PUBLIC_KEY: "PUBKEY" });
    await api(env, "POST", "/push/subscribe", sub());
    const id = (await db.listPushSubs(env))[0].id;
    const yes = await api(env, "GET", `/push/status?endpoint=${encodeURIComponent(ENDPOINT)}`);
    expect(yes.json).toEqual({ registered: true, id, last_error: null, vapid: "PUBKEY" });
    noKeys(yes.text);
    const no = await api(env, "GET", "/push/status?endpoint=https%3A%2F%2Fnope");
    expect(no.json).toEqual({ registered: false, id: null, last_error: null, vapid: "PUBKEY" });
    expect((await api(env, "GET", "/push/status")).json.registered).toBe(false);
  });
});

describe("POST /push/unsubscribe", () => {
  it("removes the phone and audits it", async () => {
    const { env } = apiEnv();
    await api(env, "POST", "/push/subscribe", sub());
    const r = await api(env, "POST", "/push/unsubscribe", { endpoint: ENDPOINT });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(await db.listPushSubs(env)).toEqual([]);
    expect((await db.listAudit(env)).find((a) => a.action === "push.remove")?.target).toBe("this device");
  });

  it("wants an endpoint, as text", async () => {
    const { env } = apiEnv();
    for (const bad of [{}, { endpoint: "" }, { endpoint: 4 }]) {
      const r = await api(env, "POST", "/push/unsubscribe", bad);
      expect(r.status).toBe(400);
      expect(r.json.error.field).toBe("endpoint");
    }
  });
});

describe("DELETE /push/:id", () => {
  it("removes a phone (200), then says it is gone (404)", async () => {
    const { env } = apiEnv();
    await api(env, "POST", "/push/subscribe", sub());
    const id = (await db.listPushSubs(env))[0].id;
    const r = await api(env, "DELETE", `/push/${id}`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    noKeys(r.text);
    expect(await db.listPushSubs(env)).toEqual([]);
    expect((await db.listAudit(env)).find((a) => a.action === "push.remove")?.target).toBe("Pixel");
    const again = await api(env, "DELETE", `/push/${id}`);
    expect(again.status).toBe(404);
    expect(again.json.error.code).toBe("not_found");
  });

  it("refuses an id that is not a number", async () => {
    const { env } = apiEnv();
    const r = await api(env, "DELETE", "/push/abc");
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("id");
  });
});

describe("POST /push/test", () => {
  it("sends a test alert (the ntfy stub sees it) and counts the phones", async () => {
    const { env, world } = apiEnv();
    await api(env, "POST", "/push/subscribe", sub());
    const r = await api(env, "POST", "/push/test");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, message: "Test alert sent to 1 phone(s)." });
    expect(world.notes.length).toBe(1);
  });

  it("answers 502 with the reason when the alert could not go out", async () => {
    const { env } = apiEnv({ NOTIFY_WEBHOOK_URL: "https://hooks.example.com/x" });
    const r = await api(env, "POST", "/push/test");
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe("upstream");
    expect(r.json.error.message.length).toBeGreaterThan(0);
  });
});
