import { formatLocal } from "./db";
import { localToUtc } from "./followups";
import type { Db } from "./types";

export interface Reminder { id: number; text: string; due_ts: number }
const YEAR = 366 * 86_400_000, MAX_TEXT = 200;
const AT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/; // a zone designator or AM/PM would be read as the wrong local digits, so it is refused

const RESEND_MS = 60_000; // a row still 'sending' this long after its attempt was cut off by a reset: it is sent once more

// The earliest pending reminder, or a cut-off send's retry time, arms the timer (state.reminder_due); NULL when there is none.
export const scheduleReminder = (db: Db): void =>
  db.run(`UPDATE state SET reminder_due = (SELECT min(CASE status WHEN 'sending' THEN attempted_at + ${RESEND_MS} ELSE due_ts END) FROM reminders WHERE status IN ('pending', 'sending'))`);

// What the timer sends now: pending rows past their time, and sends cut off at least RESEND_MS ago.
export const dueReminders = (db: Db, now: number): (Reminder & { status: string })[] =>
  db.all("SELECT id, text, due_ts, status FROM reminders WHERE (status = 'pending' AND due_ts <= ?) OR (status = 'sending' AND attempted_at <= ?) ORDER BY due_ts, id", now, now - RESEND_MS);

export const pendingReminders = (db: Db): Reminder[] => db.all<Reminder>("SELECT id, text, due_ts FROM reminders WHERE status = 'pending' ORDER BY due_ts, id");

/**
 * `at` is "YYYY-MM-DD HH:mm" in `tz` (a date alone means noon; "T" and seconds are tolerated). Errors are worded for the model.
 * `relative` marks a duration request ("in 20 minutes"): its instant is right whatever the zone, so a zone correction leaves it alone.
 */
export function addReminder(db: Db, now: number, tz: string, text: string, at: string, sourceId: string | null, relative = false): { id: number; at: string } | { error: string } {
  const s = at.trim();
  const due = AT.test(s) ? localToUtc(s.replace("T", " ").slice(0, 16), tz) : null;
  if (due === null) return { error: `at must be "YYYY-MM-DD HH:mm" in their local time (${tz}), got "${at}"` };
  if (due < now - (now % 60_000)) return { error: `${at} is already past; it is ${formatLocal(now, tz)} now` }; // the current minute still counts and fires at once
  if (due > now + YEAR) return { error: `${at} is more than a year ahead` };
  const t = text.trim().slice(0, MAX_TEXT);
  // The same reminder asked twice (a regenerated turn calling the tool again) stays one row.
  const dup = db.all<{ id: number }>("SELECT id FROM reminders WHERE status = 'pending' AND text = ? AND due_ts = ?", t, due)[0];
  const id = dup?.id ?? db.all<{ id: number }>("INSERT INTO reminders(text, due_ts, created_at, source_message_id, relative) VALUES (?, ?, ?, ?, ?) RETURNING id", t, due, now, sourceId, relative ? 1 : 0)[0].id;
  scheduleReminder(db);
  return { id, at: formatLocal(due, tz) };
}

export function cancelReminder(db: Db, id: number): { cancelled: boolean } {
  const n = db.all("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending' RETURNING id", id).length;
  scheduleReminder(db);
  return { cancelled: n > 0 };
}

// A wall time confirmed in the guessed zone `from` stays that wall time in the real zone `to`. Duration requests were
// already at the right instant and are left alone, and nothing moves into the past (it would fire at once).
export function rezoneReminders(db: Db, from: string, to: string, now: number): void {
  for (const r of db.all<{ id: number; due_ts: number }>("SELECT id, due_ts FROM reminders WHERE status = 'pending' AND relative = 0")) {
    const due = localToUtc(formatLocal(r.due_ts, from), to);
    if (due !== null && due > now) db.run("UPDATE reminders SET due_ts = ? WHERE id = ?", due, r.id);
  }
  scheduleReminder(db);
}
