import { formatLocal } from "./db";
import { localToUtc } from "./followups";
import type { Db } from "./types";

export interface Reminder { id: number; text: string; due_ts: number }
const YEAR = 366 * 86_400_000;

// The earliest pending reminder arms the timer (state.reminder_due); NULL when there is none.
export const scheduleReminder = (db: Db): void => db.run("UPDATE state SET reminder_due = (SELECT min(due_ts) FROM reminders WHERE status = 'pending')");

export const pendingReminders = (db: Db): Reminder[] => db.all<Reminder>("SELECT id, text, due_ts FROM reminders WHERE status = 'pending' ORDER BY due_ts, id");

/** `at` is "YYYY-MM-DD HH:mm" in `tz` (a date alone means noon; "T" and seconds are tolerated). Errors are worded for the model to relay. */
export function addReminder(db: Db, now: number, tz: string, text: string, at: string, sourceId: string | null): { id: number; at: string } | { error: string } {
  const due = localToUtc(at.trim().replace("T", " ").slice(0, 16), tz);
  if (due === null) return { error: `at must be "YYYY-MM-DD HH:mm" in ${tz}, got "${at}"` };
  if (due < now - (now % 60_000)) return { error: `${at} is already past; it is ${formatLocal(now, tz)} now` }; // the current minute still counts and fires at once
  if (due > now + YEAR) return { error: `${at} is more than a year ahead` };
  // The same reminder asked twice (a regenerated turn calling the tool again) stays one row.
  const dup = db.all<{ id: number }>("SELECT id FROM reminders WHERE status = 'pending' AND text = ? AND due_ts = ?", text.trim(), due)[0];
  const id = dup?.id ?? db.all<{ id: number }>("INSERT INTO reminders(text, due_ts, created_at, source_message_id) VALUES (?, ?, ?, ?) RETURNING id", text.trim(), due, now, sourceId)[0].id;
  scheduleReminder(db);
  return { id, at: formatLocal(due, tz) };
}

export function cancelReminder(db: Db, id: number): { cancelled: boolean } {
  const n = db.all("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending' RETURNING id", id).length;
  scheduleReminder(db);
  return { cancelled: n > 0 };
}
