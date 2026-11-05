import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { fromNode, migrate } from "./db";
import { followupDecision, localToUtc, scheduleFollowup } from "./followups";

const TZ = "America/New_York";
const H = 3_600_000;
const at = (s: string) => localToUtc(s, TZ)!;
function fresh() {
  const db = fromNode(new DatabaseSync(":memory:"));
  migrate(db);
  return db;
}
const plan = (db: ReturnType<typeof fresh>, date: string, text = "Interview") =>
  db.all<{ id: number }>("INSERT INTO facts(text, kind, signal, event_date) VALUES (?, 'plan', 3, ?) RETURNING id", text, date)[0].id;
const st = (db: ReturnType<typeof fresh>) => db.all<{ followup_due: number | null; followup_fact_id: number | null }>("SELECT followup_due, followup_fact_id FROM state")[0];

test("localToUtc handles offsets, date-only noon, DST edges and junk", () => {
  expect(localToUtc("2026-11-04 10:00", TZ)).toBe(Date.UTC(2026, 10, 4, 15, 0)); // EST
  expect(localToUtc("2026-07-04", TZ)).toBe(Date.UTC(2026, 6, 4, 16, 0)); // EDT, noon
  expect(localToUtc("2026-03-08 12:00", TZ)).toBe(Date.UTC(2026, 2, 8, 16, 0)); // day of spring-forward
  expect(localToUtc("2026-11-01 12:00", TZ)).toBe(Date.UTC(2026, 10, 1, 17, 0)); // day of fall-back
  expect(localToUtc("2026-11-04 10:00", "Asia/Almaty")).toBe(Date.UTC(2026, 10, 4, 5, 0));
  expect(localToUtc("next friday", TZ)).toBeNull();
  expect(localToUtc("2026-13-45", TZ)).toBeNull();
});

test("scheduleFollowup picks the soonest future plan and adds 2h", () => {
  const db = fresh();
  const now = at("2026-11-04 10:00");
  plan(db, "2026-11-10 09:00");
  const soon = plan(db, "2026-11-06");
  scheduleFollowup(db, now, TZ);
  expect(st(db)).toEqual({ followup_due: at("2026-11-06 12:00") + 2 * H, followup_fact_id: soon });
});

test("scheduleFollowup keeps a deferred due for the tracked fact and skips followup_done facts", () => {
  const db = fresh();
  const now = at("2026-11-04 23:30");
  const a = plan(db, "2026-11-04 20:00"), done = plan(db, "2026-11-04 21:00"), old = plan(db, "2026-11-01 09:00"), junk = plan(db, "soon");
  db.run("UPDATE facts SET followup_done = 1 WHERE id = ?", done);
  db.run("UPDATE state SET followup_due = ?, followup_fact_id = ?", at("2026-11-05 09:00"), a);
  scheduleFollowup(db, now, TZ);
  expect(st(db)).toEqual({ followup_due: at("2026-11-05 09:00"), followup_fact_id: a });
  expect(db.all<{ id: number; followup_done: number }>("SELECT id, followup_done FROM facts WHERE id IN (?, ?)", old, junk)).toEqual([{ id: old, followup_done: 1 }, { id: junk, followup_done: 1 }]);
  db.run("UPDATE facts SET followup_done = 1 WHERE id = ?", a);
  scheduleFollowup(db, now, TZ);
  expect(st(db)).toEqual({ followup_due: null, followup_fact_id: null });
});

test("followupDecision table", () => {
  const db = fresh();
  const id = plan(db, "2026-11-04 10:00");
  db.run("INSERT INTO contact(id, wa_id, timezone, last_inbound_ts) VALUES (1, 'x', ?, ?)", TZ, at("2026-11-04 10:00"));
  db.run("UPDATE state SET followup_fact_id = ?", id);
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ)).toEqual({ kind: "send", factId: id, text: "Interview" });
  expect(followupDecision(db, at("2026-11-04 23:30"), TZ)).toEqual({ kind: "defer", to: at("2026-11-05 09:00") });
  expect(followupDecision(db, at("2026-11-04 10:00") + 30 * H, TZ)).toEqual({ kind: "skip", reason: "window" });
  db.run("UPDATE contact SET last_proactive_date = '2026-11-04'");
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ)).toEqual({ kind: "defer", to: at("2026-11-05 09:00") });
  db.run("UPDATE contact SET last_proactive_date = NULL");
  db.run("INSERT INTO messages(id, direction, kind, text, ts) VALUES ('m', 'in', 'text', 'hi', ?)", at("2026-11-04 10:01"));
  expect(followupDecision(db, at("2026-11-04 10:30"), TZ)).toEqual({ kind: "skip", reason: "messaged" });
  db.run("UPDATE state SET followup_fact_id = NULL");
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ)).toEqual({ kind: "skip", reason: "no-fact" });
});

test("quiet hours before 09:00 defer to today 09:00", () => {
  const db = fresh();
  const id = plan(db, "2026-11-03 20:00");
  db.run("INSERT INTO contact(id, wa_id, timezone, last_inbound_ts) VALUES (1, 'x', ?, ?)", TZ, at("2026-11-03 19:00"));
  db.run("UPDATE state SET followup_fact_id = ?", id);
  expect(followupDecision(db, at("2026-11-04 07:00"), TZ)).toEqual({ kind: "defer", to: at("2026-11-04 09:00") });
});
