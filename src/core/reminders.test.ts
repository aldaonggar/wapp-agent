import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { fromNode, migrate } from "./db";
import { localToUtc } from "./followups";
import { addReminder, cancelReminder, pendingReminders, rezoneReminders, scheduleReminder } from "./reminders";

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
  expect(addReminder(db, now, TZ, "h", "2026-03-08 02:30", null)).toEqual({ id: 9, at: "2026-03-08 03:30" }); // the hour that does not exist: the confirmation says 03:30
  addReminder(db, now, TZ, "z".repeat(300), "2026-02-04 09:00", null);
  expect(db.all("SELECT length(text) AS n FROM reminders WHERE id = 10")).toEqual([{ n: 200 }]);
});

test("rezoneReminders moves only absolute pending rows, leaves durations alone, and never moves a row into the past", () => {
  const db = fresh();
  const now = at("2026-11-04 10:00");
  addReminder(db, now, TZ, "call the dentist", "2026-11-05 09:00", null); // 1: a clock time, confirmed in the guessed zone
  addReminder(db, now, TZ, "take the pizza out", "2026-11-04 10:20", null, true); // 2: "in 20 minutes"
  addReminder(db, now, TZ, "done already", "2026-11-05 20:00", null); // 3: sent
  addReminder(db, now, TZ, "soon", "2026-11-04 10:30", null); // 4: a clock time 30 min out
  db.run("UPDATE reminders SET status = 'sent' WHERE id = 3");
  rezoneReminders(db, TZ, "America/Los_Angeles", now); // westward, 3 h
  expect(dueOf(db, 1)).toBe(Date.UTC(2026, 10, 5, 17, 0)); // 09:00 Los Angeles, was 14:00Z
  expect(dueOf(db, 2)).toBe(now + 20 * 60_000); // the instant was right already
  expect(dueOf(db, 3)).toBe(at("2026-11-05 20:00"));
  expect(dueOf(db, 4)).toBe(now + 30 * 60_000 + 3 * H); // 10:30 Los Angeles
  expect(due(db)).toBe(now + 20 * 60_000);

  // Eastward: a +7 number is guessed Europe/Moscow, the person is in Novosibirsk (4 h ahead).
  const msk = fresh(), t0 = localToUtc("2026-11-04 10:00", "Europe/Moscow")!;
  addReminder(msk, t0, "Europe/Moscow", "call mum", "2026-11-04 12:00", null, true); // "in 2 hours"
  addReminder(msk, t0, "Europe/Moscow", "pills", "2026-11-04 12:00", null); // 12:00 Novosibirsk would be 2 h ago
  addReminder(msk, t0, "Europe/Moscow", "dentist", "2026-11-05 09:00", null);
  rezoneReminders(msk, "Europe/Moscow", "Asia/Novosibirsk", t0);
  expect(dueOf(msk, 1)).toBe(t0 + 2 * H);
  expect(dueOf(msk, 2)).toBe(t0 + 2 * H); // kept: the rezoned instant is in the past
  expect(dueOf(msk, 3)).toBe(Date.UTC(2026, 10, 5, 2, 0)); // 09:00 Novosibirsk
  expect(due(msk)).toBe(t0 + 2 * H);
});

test("addReminder refuses the past, more than a year ahead, and junk, storing nothing; the current minute is accepted", () => {
  const db = fresh();
  const now = at("2026-11-04 10:00") + 30_000;
  expect(addReminder(db, now, TZ, "x", "2026-11-04 09:59", null)).toEqual({ error: expect.stringContaining("already past; it is 2026-11-04 10:00 now") });
  expect(addReminder(db, now, TZ, "x", "2027-11-06 10:00", null)).toEqual({ error: expect.stringContaining("more than a year ahead") });
  expect(addReminder(db, now, TZ, "x", "tomorrow at 9", null)).toEqual({ error: expect.stringContaining('"YYYY-MM-DD HH:mm"') });
  for (const bad of ["2026-11-05T14:00:00Z", "2026-11-05T09:00+05:00", "2026-11-05 09:00 PM", "2026-11-05 9:00"]) // a zone or AM/PM would be misread as local digits
    expect(addReminder(db, now, TZ, "x", bad, null)).toEqual({ error: expect.stringContaining(`got "${bad}"`) });
  expect(db.all("SELECT 1 FROM reminders")).toEqual([]);
  expect(due(db)).toBeNull();
  expect(addReminder(db, now, TZ, "x", "2026-11-04 10:00", null)).toEqual({ id: 1, at: "2026-11-04 10:00" }); // fires at once
  expect(due(db)).toBe(at("2026-11-04 10:00"));
});

test("the earliest pending reminder arms the timer; cancelReminder only cancels pending rows", () => {
  const db = fresh();
  const now = at("2026-11-04 10:00");
  addReminder(db, now, TZ, "later", "2026-11-06 09:00", null);
  addReminder(db, now, TZ, "sooner", "2026-11-05 09:00", null);
  expect(due(db)).toBe(at("2026-11-05 09:00"));
  expect(pendingReminders(db).map((r) => r.text)).toEqual(["sooner", "later"]);
  expect(addReminder(db, now, TZ, "sooner", "2026-11-05 09:00", null)).toEqual({ id: 2, at: "2026-11-05 09:00" }); // the same reminder twice is one row
  expect(pendingReminders(db)).toHaveLength(2);
  expect(cancelReminder(db, 2)).toEqual({ cancelled: true });
  expect(due(db)).toBe(at("2026-11-06 09:00"));
  expect(cancelReminder(db, 2)).toEqual({ cancelled: false });
  expect(cancelReminder(db, 9)).toEqual({ cancelled: false });
  db.run("UPDATE reminders SET status = 'sent' WHERE id = 1");
  scheduleReminder(db);
  expect(due(db)).toBeNull();
  expect(pendingReminders(db)).toEqual([]);
});
