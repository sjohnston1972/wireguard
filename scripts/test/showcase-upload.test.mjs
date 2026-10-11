// The showcase uploader's plan. Nothing here talks to Cloudflare: the file
// list is built from a fake folder listing and only the wrangler steps are checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filmIds, uploads, uploadSteps, BUCKET } from "../showcase-upload.mjs";

const pageDir = fileURLToPath(new URL("../../showcase/", import.meta.url));
const FULL = ["manifest.json", "init.mp4", "chunk-000.m4s", "chunk-001.m4s", "fallback-720p.mp4", "poster.jpg"];

test("the page lists the hero film first, then the highlights", () => {
  const ids = filmIds(readFileSync(pageDir + "showcase.js", "utf8"));
  assert.equal(ids[0], "00-hero");
  assert.ok(ids.length >= 2);
  assert.equal(new Set(ids).size, ids.length);
});

test("uploads: the page, then every listed film's own files only (no stray files)", () => {
  const list = uploads(pageDir, "/films", () => [...FULL, "notes.txt", "master.mp4"]);
  assert.deepEqual(list.slice(0, 2).map((u) => u.key), ["index.html", "showcase.js"]);
  const hero = list.filter((u) => u.key.startsWith("films/00-hero/")).map((u) => u.key.slice("films/00-hero/".length));
  assert.deepEqual(hero, [...FULL].sort());
  assert.ok(!list.some((u) => /notes|master/.test(u.key)));
  assert.equal(list.find((u) => u.key.endsWith(".m4s")).type, "video/mp4");
  assert.equal(list.find((u) => u.key === "index.html").type, "text/html; charset=utf-8");
});

test("a listed film with a missing file stops the upload before anything is sent", () => {
  assert.throws(() => uploads(pageDir, "/films", () => ["manifest.json", "init.mp4", "poster.jpg"]), /fallback-720p\.mp4 is missing/);
});

test("each file is one remote wrangler put into the showcase bucket, with its type", () => {
  const steps = uploadSteps([{ key: "films/00-hero/poster.jpg", file: "/x/poster.jpg", type: "image/jpeg" }]);
  assert.deepEqual(steps, [["wrangler", "r2", "object", "put", `${BUCKET}/films/00-hero/poster.jpg`, "--file", "/x/poster.jpg", "--content-type", "image/jpeg", "--remote"]]);
});
