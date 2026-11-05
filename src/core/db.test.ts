import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, test } from "vitest";
import { blobToVec, formatLocal, fromDO, fromNode, migrate, vecToBlob } from "./db";
import type { Db } from "./types";

let db: Db;
beforeEach(() => { db = fromNode(new DatabaseSync(":memory:")); });

test("migrate is idempotent and creates all tables", () => {
  migrate(db); migrate(db);
  const names = db.all<{ name: string }>("SELECT name FROM sqlite_master").map((r) => r.name);
  expect(names).toEqual(expect.arrayContaining(["messages", "facts", "facts_fts", "insights", "profile", "contact", "state", "turns", "calls"]));
  expect(db.all<{ generation: number }>("SELECT generation FROM state")[0].generation).toBe(0);
});

test("migrate adds turns.recalled to a database created before it existed", () => {
  db.batch("CREATE TABLE turns(id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER)");
  migrate(db); migrate(db);
  db.run("INSERT INTO turns(started_at, recalled) VALUES (1, '[]')");
  expect(db.all("SELECT recalled FROM turns")).toEqual([{ recalled: "[]" }]);
  expect(db.all("SELECT 1 FROM pragma_table_info('turns') WHERE name='recalled'")).toHaveLength(1);
});

test("blob round trip keeps float32 values", () => {
  migrate(db);
  db.run("INSERT INTO facts(text, embedding) VALUES ('a', ?)", vecToBlob(new Float32Array([0.1, -2, 3.5])));
  const b = db.all<{ embedding: Uint8Array }>("SELECT embedding FROM facts")[0].embedding;
  expect(Array.from(blobToVec(b))).toEqual(Array.from(new Float32Array([0.1, -2, 3.5])));
});

test("fts5 match finds the fact", () => {
  migrate(db);
  db.run("INSERT INTO facts_fts(text, fact_id) VALUES ('Job interview at Monzo on 2026-11-12', 7)");
  expect(db.all<{ fact_id: number }>("SELECT fact_id FROM facts_fts WHERE facts_fts MATCH 'Monzo'")[0].fact_id).toBe(7);
});

test("INSERT OR IGNORE ... RETURNING id yields no row on a duplicate", () => {
  migrate(db);
  const q = "INSERT OR IGNORE INTO messages(id, direction) VALUES (?, 'in') RETURNING id";
  expect(db.all(q, "m1")).toHaveLength(1);
  expect(db.all(q, "m1")).toEqual([]);
});

test("formatLocal formats in the timezone", () => {
  expect(formatLocal(Date.UTC(2026, 10, 4, 9, 5), "Asia/Almaty")).toBe("2026-11-04 14:05");
});

test("fromDO converts ArrayBuffer results and binds Uint8Array as ArrayBuffer", () => {
  let seen: unknown[] = [];
  const sql = { exec: (_q: string, ...b: unknown[]) => { seen = b; return { toArray: () => [{ e: new Uint8Array([1, 2, 3]).buffer, n: 1 }] }; } };
  const d = fromDO(sql as unknown as SqlStorage);
  const rows = d.all<{ e: Uint8Array }>("SELECT 1", new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
  expect(rows[0].e).toBeInstanceOf(Uint8Array);
  expect(Array.from(rows[0].e)).toEqual([1, 2, 3]);
  expect(seen[0]).toBeInstanceOf(ArrayBuffer);
  expect(Array.from(new Uint8Array(seen[0] as ArrayBuffer))).toEqual([8, 7]);
});
