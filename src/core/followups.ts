import { formatLocal } from "./db";
import type { Db } from "./types";

export type FollowupDecision =
  | { kind: "send"; factId: number; text: string }
  | { kind: "skip"; reason: "window" | "messaged" | "no-fact" }
  | { kind: "defer"; to: number };

const HOUR = 3_600_000, DAY = 24 * HOUR;
const AFTER_EVENT_MS = 2 * HOUR;

// "YYYY-MM-DD" (-> 12:00) or "YYYY-MM-DD HH:mm" in tz -> epoch ms; null when malformed.
export function localToUtc(s: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  if (Number.isNaN(guess) || new Date(guess).getUTCMonth() !== +m[2] - 1 || new Date(guess).getUTCHours() !== (m[4] ? +m[4] : 12)) return null;
  const offset = (t: number) => Date.parse(formatLocal(t, tz).replace(" ", "T") + ":00Z") - Math.floor(t / 60_000) * 60_000;
  // Offset read at the guess, then re-read at the corrected instant (DST edges).
  let t = guess - offset(guess);
  const o2 = offset(t);
  t = guess - o2;
  const o3 = offset(t);
  if (o3 !== o2) t = guess - Math.min(o2, o3); // a wall time inside a spring-forward gap does not exist: shift it forward
  return t;
}

// 09:00 local: today if it is still before 09:00 and `skipToday` is false, else tomorrow.
const next9am = (ts: number, tz: string, skipToday: boolean): number => {
  const [date, time] = formatLocal(ts, tz).split(" ");
  const plusDays = skipToday || +time.slice(0, 2) >= 9 ? DAY : 0;
  const day = new Date(Date.parse(date + "T00:00:00Z") + plusDays).toISOString().slice(0, 10);
  return localToUtc(`${day} 09:00`, tz)!;
};

interface Plan { id: number; event_date: string; followup_due: number | null }
const plans = (db: Db) => db.all<Plan>("SELECT id, event_date, followup_due FROM facts WHERE kind='plan' AND status='active' AND event_date IS NOT NULL AND followup_done = 0 ORDER BY id");

// Each plan is due at max(event + 2h, its own stored deferral); the earliest one arms the timer.
export function scheduleFollowup(db: Db, now: number, tz: string): void {
  let best: { id: number; due: number } | null = null;
  for (const p of plans(db)) {
    const ev = localToUtc(p.event_date, tz);
    const due = ev === null ? null : Math.max(ev + AFTER_EVENT_MS, p.followup_due ?? 0);
    if (due === null || due <= now - DAY) { db.run("UPDATE facts SET followup_done = 1 WHERE id = ?", p.id); continue; } // malformed or too old: never re-picked
    if (!best || due < best.due) best = { id: p.id, due };
  }
  db.run("UPDATE state SET followup_due = ?, followup_fact_id = ?", best?.due ?? null, best?.id ?? null);
}

// `id` is the fact the alarm was armed for, read when the alarm started; `window24h` is false on a transport without Meta's rule (Telegram).
export function followupDecision(db: Db, now: number, tz: string, id: number | null, window24h: boolean): FollowupDecision {
  const fact = id === null ? undefined : db.all<{ text: string; event_date: string | null }>("SELECT text, event_date FROM facts WHERE id = ? AND status = 'active'", id)[0];
  const eventMs = fact?.event_date ? localToUtc(fact.event_date, tz) : null;
  if (!fact || eventMs === null) return { kind: "skip", reason: "no-fact" };
  const c = db.all<{ last_inbound_ts: number | null; last_proactive_date: string | null }>("SELECT last_inbound_ts, last_proactive_date FROM contact")[0];
  const lastIn = c?.last_inbound_ts ?? 0;
  if (window24h && now - lastIn > DAY) return { kind: "skip", reason: "window" };
  if (db.all("SELECT 1 FROM messages WHERE direction='in' AND ts > ? LIMIT 1", eventMs).length) return { kind: "skip", reason: "messaged" };
  const [today, time] = formatLocal(now, tz).split(" ");
  const hour = +time.slice(0, 2);
  const quiet = hour < 9 || hour >= 22, sentToday = c?.last_proactive_date === today;
  if (!quiet && !sentToday) return { kind: "send", factId: id!, text: fact.text };
  const to = next9am(now, tz, sentToday);
  return !window24h || to <= lastIn + DAY ? { kind: "defer", to } : { kind: "skip", reason: "window" };
}
