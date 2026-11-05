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
  db.run("UPDATE facts SET followup_due = ? WHERE id = ?", at("2026-11-05 09:00"), a);
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
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ, id, true)).toEqual({ kind: "send", factId: id, text: "Interview" });
  expect(followupDecision(db, at("2026-11-04 23:30"), TZ, id, true)).toEqual({ kind: "defer", to: at("2026-11-05 09:00") });
  expect(followupDecision(db, at("2026-11-04 10:00") + 30 * H, TZ, id, true)).toEqual({ kind: "skip", reason: "window" });
  expect(followupDecision(db, at("2026-11-04 10:00") + 30 * H, TZ, id, false)).toEqual({ kind: "send", factId: id, text: "Interview" }); // Telegram: no window
  db.run("UPDATE contact SET last_inbound_ts = ?", at("2026-11-04 08:00")); // quiet hours, and 09:00 tomorrow is past the window
  expect(followupDecision(db, at("2026-11-04 23:30"), TZ, id, true)).toEqual({ kind: "skip", reason: "window" });
  expect(followupDecision(db, at("2026-11-04 23:30"), TZ, id, false)).toEqual({ kind: "defer", to: at("2026-11-05 09:00") });
  db.run("UPDATE contact SET last_inbound_ts = ?", at("2026-11-04 10:00"));
  db.run("UPDATE contact SET last_proactive_date = '2026-11-04'");
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ, id, true)).toEqual({ kind: "defer", to: at("2026-11-05 09:00") });
  db.run("UPDATE contact SET last_proactive_date = NULL");
  db.run("INSERT INTO messages(id, direction, kind, text, ts) VALUES ('m', 'in', 'text', 'hi', ?)", at("2026-11-04 10:01"));
  expect(followupDecision(db, at("2026-11-04 10:30"), TZ, id, true)).toEqual({ kind: "skip", reason: "messaged" });
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ, null, true)).toEqual({ kind: "skip", reason: "no-fact" });
  db.run("UPDATE facts SET status = 'deleted' WHERE id = ?", id);
  expect(followupDecision(db, at("2026-11-04 10:00"), TZ, id, true)).toEqual({ kind: "skip", reason: "no-fact" });
});

test("quiet hours before 09:00 defer to today 09:00", () => {
  const db = fresh();
  const id = plan(db, "2026-11-03 20:00");
  db.run("INSERT INTO contact(id, wa_id, timezone, last_inbound_ts) VALUES (1, 'x', ?, ?)", TZ, at("2026-11-03 19:00"));
  expect(followupDecision(db, at("2026-11-04 07:00"), TZ, id, true)).toEqual({ kind: "defer", to: at("2026-11-04 09:00") });
});

test("localToUtc at the real DST edges", () => {
  expect(localToUtc("2026-03-08 03:30", TZ)).toBe(Date.UTC(2026, 2, 8, 7, 30)); // just after spring-forward, already EDT
  expect(localToUtc("2026-03-08 02:30", TZ)).toBe(Date.UTC(2026, 2, 8, 7, 30)); // inside the gap: shifted forward to 03:30 EDT
  expect(localToUtc("2026-03-29 02:30", "Europe/Berlin")).toBe(Date.UTC(2026, 2, 29, 1, 30)); // same with a positive offset: 03:30 CEST
  expect(localToUtc("2026-11-01 01:30", TZ)).toBe(Date.UTC(2026, 10, 1, 5, 30)); // fall-back overlap: the first occurrence (EDT)
  expect(at("2026-11-01 12:00") - at("2026-10-31 12:00")).toBe(25 * H); // fall back
  expect(at("2026-03-08 12:00") - at("2026-03-07 12:00")).toBe(23 * H); // spring forward
});
