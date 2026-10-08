// The service worker (web/public/sw.js) run in node:vm with a fake `self`:
// its listeners are captured and fired with fake events; fetch, clients and
// the push registration are recorded stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8");

function load({ fetchReply = () => ({ ok: true, json: async () => ({}), text: async () => "" }), windows = [] } = {}) {
  const listeners = {};
  const calls = { fetch: [], subscribe: [], shown: [], opened: [], focused: [], navigated: [], respondWith: [] };
  const self = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14)" },
    skipWaiting() {},
    registration: {
      showNotification: async (title, opts) => calls.shown.push({ title, opts }),
      pushManager: {
        subscribe: async (opts) => {
          calls.subscribe.push(opts);
          return { toJSON: () => ({ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } }) };
        },
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => calls.opened.push(url),
    },
  };
  for (const w of windows) {
    w.focus = async () => (calls.focused.push(w.url), w);
    w.navigate = async (url) => (calls.navigated.push(url), w);
  }
  const fetch = async (url, init = {}) => {
    calls.fetch.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return fetchReply(String(url));
  };
  vm.runInNewContext(source, { self, fetch, btoa, atob, Response, Uint8Array, Promise, JSON, String, Number }, { filename: "sw.js" });
  async function fire(type, event) {
    const waits = [];
    event.waitUntil = (p) => waits.push(p);
    event.respondWith = (p) => calls.respondWith.push(p);
    await listeners[type](event);
    await Promise.all(waits);
  }
  return { listeners, calls, fire };
}

const KEY = new Uint8Array([1, 2, 3, 250, 251, 252]).buffer;

test("pushsubscriptionchange re-subscribes through /api/v1/push", async () => {
  const sw = load();
  await sw.fire("pushsubscriptionchange", { oldSubscription: { endpoint: "https://push.example/old", options: { applicationServerKey: KEY } }, newSubscription: null });
  assert.equal(sw.calls.subscribe.length, 1, "signs up again");
  assert.deepEqual([...sw.calls.subscribe[0].applicationServerKey], [1, 2, 3, 250, 251, 252], "with the same dashboard key");
  assert.deepEqual(
    sw.calls.fetch.map((f) => `${f.method} ${f.url}`),
    ["POST /api/v1/push/subscribe", "POST /api/v1/push/unsubscribe"],
  );
  assert.equal(sw.calls.fetch[0].body.endpoint, "https://push.example/new");
  assert.equal(sw.calls.fetch[1].body.endpoint, "https://push.example/old");
});

test("pushsubscriptionchange refused by demo mode (409): keeps the renewal in a notification for the app, unsubscribes nothing", async () => {
  const sw = load({ fetchReply: (url) => (url.endsWith("/push/subscribe") ? { ok: false, status: 409, json: async () => ({ error: { code: "demo_mode" } }) } : { ok: true, status: 200, json: async () => ({}) }) });
  await sw.fire("pushsubscriptionchange", { oldSubscription: { endpoint: "https://push.example/old", options: { applicationServerKey: KEY } }, newSubscription: null });
  assert.deepEqual(sw.calls.fetch.map((f) => `${f.method} ${f.url}`), ["POST /api/v1/push/subscribe"], "the old one is not dropped");
  assert.equal(sw.calls.shown.length, 1);
  const { opts } = sw.calls.shown[0];
  assert.equal(opts.tag, "push-renew");
  assert.match(opts.body, /demo mode/i);
  assert.equal(opts.data.url, "/settings/demo");
  assert.deepEqual(JSON.parse(JSON.stringify(opts.data.renew)), {
    subscribe: { endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" }, label: "Android phone (renewed)" },
    old: "https://push.example/old",
  });
});

test("pushsubscriptionchange without the old key asks /api/v1/push/status for it", async () => {
  const sw = load({ fetchReply: (url) => ({ ok: true, json: async () => (url.includes("status") ? { vapid: "AQID-vv8" } : {}) }) });
  await sw.fire("pushsubscriptionchange", { oldSubscription: null, newSubscription: null });
  assert.deepEqual(sw.calls.fetch.map((f) => `${f.method} ${f.url}`), ["GET /api/v1/push/status", "POST /api/v1/push/subscribe"]);
  assert.deepEqual([...sw.calls.subscribe[0].applicationServerKey], [1, 2, 3, 250, 251, 252]);
  assert.ok(!sw.calls.fetch.some((f) => /^\/api\/push\//.test(f.url)), "never the removed /api/push/*");
});

test("a notification tap navigates an open window to its url", async () => {
  const win = { url: "https://wg-admin.example/", type: "window" };
  const sw = load({ windows: [win] });
  await sw.fire("notificationclick", { action: "", notification: { data: { url: "/activity/runs/42" }, close() {} } });
  assert.deepEqual(sw.calls.focused, ["https://wg-admin.example/"]);
  assert.deepEqual(sw.calls.navigated, ["/activity/runs/42"]);
  assert.deepEqual(sw.calls.opened, []);
});

test("a tap on a general alert (url /) only focuses an open window, never moving it off its page", async () => {
  for (const url of ["/", "https://wg-admin.example/"]) {
    const win = { url: "https://wg-admin.example/clients/3", type: "window" };
    const sw = load({ windows: [win] });
    await sw.fire("notificationclick", { action: "", notification: { data: { url }, close() {} } });
    assert.deepEqual(sw.calls.focused, ["https://wg-admin.example/clients/3"]);
    assert.deepEqual(sw.calls.navigated, []);
    assert.deepEqual(sw.calls.opened, []);
  }
  const none = load();
  await none.fire("notificationclick", { action: "", notification: { data: { url: "/" }, close() {} } });
  assert.deepEqual(none.calls.opened, ["/"], "with no window open, a new one opens");
});

test("a tap on an alert for the page already open only focuses it", async () => {
  const win = { url: "https://wg-admin.example/cost", type: "window" };
  const sw = load({ windows: [win] });
  await sw.fire("notificationclick", { action: "", notification: { data: { url: "/cost" }, close() {} } });
  assert.deepEqual(sw.calls.focused, ["https://wg-admin.example/cost"]);
  assert.deepEqual(sw.calls.navigated, []);
});

test("alert urls are absolute (publicUrl + path): same page only focuses, another page navigates", async () => {
  const same = load({ windows: [{ url: "https://wg-admin.example/cost", type: "window" }] });
  await same.fire("notificationclick", { action: "", notification: { data: { url: "https://wg-admin.example/cost" }, close() {} } });
  assert.deepEqual(same.calls.navigated, []);
  const other = load({ windows: [{ url: "https://wg-admin.example/", type: "window" }] });
  await other.fire("notificationclick", { action: "", notification: { data: { url: "https://wg-admin.example/settings/mobile" }, close() {} } });
  assert.deepEqual(other.calls.navigated, ["https://wg-admin.example/settings/mobile"]);
});

test("a window the worker does not control is left focused and the page opens in a new one", async () => {
  const win = { url: "https://wg-admin.example/", type: "window" };
  const sw = load({ windows: [win] });
  win.navigate = async () => { throw new TypeError("not controlled"); };
  await sw.fire("notificationclick", { action: "", notification: { data: { url: "/cost" }, close() {} } });
  assert.deepEqual(sw.calls.opened, ["/cost"]);
});

test("a notification tap with no window open opens its url", async () => {
  const sw = load();
  await sw.fire("notificationclick", { action: "", notification: { data: { url: "/settings/mobile" }, close() {} } });
  assert.deepEqual(sw.calls.opened, ["/settings/mobile"]);
});

test("an alert button still posts its single-use link without opening anything", async () => {
  const sw = load({ fetchReply: () => ({ ok: true, text: async () => "Extended by 1 hour." }) });
  await sw.fire("notificationclick", { action: "a0", notification: { data: { url: "/", actions: [{ title: "Extend 1h", url: "https://wg-admin.example/api/act/tok" }] }, close() {} } });
  assert.deepEqual(sw.calls.fetch.map((f) => `${f.method} ${f.url}`), ["POST https://wg-admin.example/api/act/tok"]);
  assert.deepEqual(sw.calls.opened, []);
  assert.equal(sw.calls.shown[0].opts.body, "Extended by 1 hour.");
});

test("the fetch handler only touches navigations", async () => {
  const sw = load();
  for (const mode of ["cors", "no-cors", "same-origin"]) {
    await sw.fire("fetch", { request: { mode, url: "/api/v1/overview" } });
  }
  assert.equal(sw.calls.respondWith.length, 0);
  assert.equal(sw.calls.fetch.length, 0);
  await sw.fire("fetch", { request: { mode: "navigate", url: "/clients/3" } });
  assert.equal(sw.calls.respondWith.length, 1);
});

test("sw.js caches nothing", () => {
  assert.ok(!/\bcaches\b|CacheStorage/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
});
