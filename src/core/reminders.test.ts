import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { fromNode, migrate } from "./db";
import { localToUtc } from "./followups";
import { addReminder, cancelReminder, pendingReminders, scheduleReminder } from "./reminders";

const TZ = "America/New_York", H = 3_600_000;
const at = (s: string) => localToUtc(s, TZ)!;
const fresh = () => { const db = fromNode(new DatabaseSync(":memory:")); migrate(db); return db; };
const due = (db: ReturnType<typeof fresh>) => db.all<{ reminder_due: number | null }>("SELECT reminder_due FROM state")[0].reminder_due;
const dueOf = (db: ReturnType<typeof fresh>, id: number) => db.all<{ due_ts: number }>("SELECT due_ts FROM reminders WHERE id = ?", id)[0].due_ts;

test("addReminder resolves the person's local time across DST and tolerates ISO spelling and a bare date", () => {
  const db = fresh();
  const now = at("2026-02-01 10:00");
  expect(addReminder(db, now, TZ, " call the dentist ", "2026-02-02 09:00", "w1")).toEqual({ id: 1, at: "2026-02-02 09:00" });
  expect(db.all("SELECT text, due_ts, created_at, source_message_id, status FROM reminders")).toEqual([{ text: "call the dentist", due_ts: Date.UTC(2026, 1, 2, 14, 0), created_at: now, source_message_id: "w1", status: "pending" }]); // EST
  addReminder(db, now, TZ, "a", "2026-03-07 09:00", null);
  addReminder(db, now, TZ, "b", "2026-03-08 09:00", null);
  expect(dueOf(db, 3) - dueOf(db, 2)).toBe(23 * H); // spring forward
  addReminder(db, now, TZ, "c", "2026-10-31 12:00", null);
  addReminder(db, now, TZ, "d", "2026-11-01 12:00", null);
  expect(dueOf(db, 5) - dueOf(db, 4)).toBe(25 * H); // fall back
  expect(addReminder(db, now, TZ, "e", "2026-02-02T08:30:00", null)).toEqual({ id: 6, at: "2026-02-02 08:30" });
  expect(addReminder(db, now, TZ, "f", "2026-02-03", null)).toEqual({ id: 7, at: "2026-02-03 12:00" });
  expect(addReminder(db, now, "Asia/Almaty", "g", "2026-02-02 10:00", null)).toEqual({ id: 8, at: "2026-02-02 10:00" });
  expect(dueOf(db, 8)).toBe(Date.UTC(2026, 1, 2, 5, 0));
});

test("addReminder refuses the past, more than a year ahead, and junk, storing nothing", () => {
  const db = fresh();
  const now = at("2026-11-04 10:00");
  expect(addReminder(db, now, TZ, "x", "2026-11-04 10:00", null)).toEqual({ error: expect.stringContaining("already past; it is 2026-11-04 10:00 now") });
  expect(addReminder(db, now, TZ, "x", "2027-11-06 10:00", null)).toEqual({ error: expect.stringContaining("more than a year ahead") });
  expect(addReminder(db, now, TZ, "x", "tomorrow at 9", null)).toEqual({ error: expect.stringContaining('"YYYY-MM-DD HH:mm"') });
  expect(db.all("SELECT 1 FROM reminders")).toEqual([]);
  expect(due(db)).toBeNull();
});

test("the earliest pending reminder arms the timer; cancelReminder only cancels pending rows", () => {
  const db = fresh();
  const now = at("2026-11-04 10:00");
  addReminder(db, now, TZ, "later", "2026-11-06 09:00", null);
  addReminder(db, now, TZ, "sooner", "2026-11-05 09:00", null);
  expect(due(db)).toBe(at("2026-11-05 09:00"));
  expect(pendingReminders(db).map((r) => r.text)).toEqual(["sooner", "later"]);
  expect(cancelReminder(db, 2)).toEqual({ cancelled: true });
  expect(due(db)).toBe(at("2026-11-06 09:00"));
  expect(cancelReminder(db, 2)).toEqual({ cancelled: false });
  expect(cancelReminder(db, 9)).toEqual({ cancelled: false });
  db.run("UPDATE reminders SET status = 'sent' WHERE id = 1");
  scheduleReminder(db);
  expect(due(db)).toBeNull();
  expect(pendingReminders(db)).toEqual([]);
});
