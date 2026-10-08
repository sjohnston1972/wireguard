// demo-schema.test.ts
//
// Plain English: the demo store builds its tables from a copy of the
// migrations bundled into the Worker (worker/src/demo/schema.gen.ts). This
// fails the moment a migration is added without regenerating that copy
// (npm run demo-schema), so the demo store can never be built from an old
// schema without noticing.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { DEMO_SCHEMA, DEMO_SCHEMA_HASH } from "../src/demo/schema.gen";

describe("schema.gen.ts", () => {
  it("matches worker/migrations: every file, in name order, same text (LF), same hash", async () => {
    const dir = new URL("../migrations/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const list = files.map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8").replace(/\r\n?/g, "\n") }));
    expect(DEMO_SCHEMA.map((m) => m.name), "run npm run demo-schema").toEqual(files);
    expect(DEMO_SCHEMA, "run npm run demo-schema").toEqual(list);
    const bytes = new TextEncoder().encode(list.map((m) => `${m.name}\n${m.sql}\n\0`).join(""));
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(DEMO_SCHEMA_HASH).toBe(hex);
  });

  it("includes the demo switch table's migration (it is harmless in the demo store: nothing reads it there)", () => {
    expect(DEMO_SCHEMA.at(-1)?.name).toBe("0022_demo_mode.sql");
  });
});
