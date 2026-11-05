import { tool } from "ai";
import { z } from "zod";
import { extractUrls } from "../browser";
import { maxOutputTokensFor, reasoningFor, replyModelFor } from "../models";
import { WaError } from "../whatsapp";
import { MAX_WAIT_MS, QUIET_MS, UNFINISHED_MS, bubblePauseMs, looksUnfinished, turnDue } from "./cadence";
import { formatLocal } from "./db";
import { deriveInsights } from "./insights";
import * as memory from "./memory";
import { buildPrompt, windowHistory, type HistoryRow } from "./prompt";
import { parseReply } from "./stream";
import { tzFromPhone } from "./timezone";
import type { Deps, Inbound, MemoryHit, Snapshot, Usage } from "./types";

type Media = { bytes: Uint8Array; mime: string };
type Recall = { hits: MemoryHit[]; ms: number };
interface Msg { id: string; direction: "in" | "out"; kind: string; text: string | null; ts: number; quoted_id: string | null; media_id: string | null; media_note: string | null; reactions: string | null }
interface State { turn_due: number | null; insights_due: number | null; followup_due: number | null; burst_started_at: number | null; generation: number; turn_attempts: number }

const MAX_IMAGE = 5 * 1024 * 1024, IMAGE_MIME = /^image\/(jpeg|png|webp)\b/i;
const VOICE_FAILED = "[voice note could not be transcribed]";
const INSIGHTS_AFTER_MS = 30 * 60_000;
const RETRY_MS = 30_000;
const MAX_REGENERATIONS = 2;
const WATCHDOG_MS = 60_000;

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const excerpt = (t: string) => (t.length > 80 ? t.slice(0, 79) + "…" : t);
const ms = (x: number | null | undefined) => (x == null ? null : Math.round(x));

export class ContactCore {
  // In-memory only: lost on a Durable Object reset by design; runTurn refills media from media_id.
  turnRunning = false;
  media = new Map<string, Promise<Media | null>>();
  pages = new Map<string, Promise<Snapshot | null>>();
  recallCache: { generation: number; query: string; promise: Promise<Recall> } | null = null;
  abort: AbortController | null = null;
  private deps: Deps;
  private forgetTool = tool({
    description: "Delete stored facts matching the query; call when the person asks to forget something",
    inputSchema: z.object({ query: z.string().describe("what to forget, in the words of the memory: names, places, the thing itself (e.g. \"Almaty\")") }),
    execute: async ({ query }) => ({ deleted: await memory.forget(this.deps, query) }),
  });

  constructor(deps: Deps) { this.deps = deps; }

  async ingest(m: Inbound): Promise<void> {
    const { db, clock, features } = this.deps;
    if (m.kind === "reaction") return this.setReaction(m.reaction?.messageId ?? "", m.from, m.reaction?.emoji);
    const fresh = db.all("INSERT OR IGNORE INTO messages(id, direction, kind, text, ts, quoted_id, media_id, mime, voice) VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      m.id, m.kind, m.text ?? null, m.ts, m.quotedId ?? null, m.mediaId ?? null, m.mime ?? null, m.voice ? 1 : 0);
    if (!fresh.length) return; // Meta redelivery
    db.run("INSERT INTO contact(id, wa_id, name, timezone, last_inbound_ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET wa_id=excluded.wa_id, name=coalesce(excluded.name, name), last_inbound_ts=excluded.last_inbound_ts",
      m.from, m.name ?? null, tzFromPhone(m.from), m.ts);
    if (m.kind === "unsupported") {
      db.run("UPDATE messages SET status='handled' WHERE id=?", m.id);
      return;
    }
    const now = clock.now();
    const s = this.state();
    const burst = s.burst_started_at ?? now;
    const generation = s.generation + 1;
    db.run("UPDATE state SET burst_started_at=?, generation=?, turn_due=?", burst, generation, turnDue(now, burst, m.text ?? ""));
    if (features.memory) db.run("UPDATE state SET insights_due=?", now + INSIGHTS_AFTER_MS);

    // Work during the wait, started before the await below and never awaited here.
    if ((m.kind === "image" || m.kind === "audio") && m.mediaId && !this.media.has(m.id)) this.media.set(m.id, this.loadMedia(m.id, m.kind, m.mediaId));
    const url = extractUrls(m.text ?? "")[0];
    if (url) void this.page(url);
    if (features.memory) {
      const query = this.recallQuery();
      this.recallCache = { generation, query, promise: memory.recall(this.deps, query) }; // never rejects
    }
    await this.scheduleNext();
  }

  async alarm(): Promise<void> {
    const { db, clock } = this.deps;
    try {
      const now = clock.now();
      const s = this.state();
      // Every due timer is consumed before the first await: alarms are at-least-once and retry on throw.
      const insightsDue = s.insights_due !== null && now >= s.insights_due;
      const followupDue = s.followup_due !== null && now >= s.followup_due;
      if (insightsDue) db.run("UPDATE state SET insights_due=NULL");
      if (followupDue) db.run("UPDATE state SET followup_due=NULL");
      if (s.turn_due !== null && now >= s.turn_due) {
        try { await this.turnTimer(s, now); } catch (e) { this.error("turn_failed", e); }
      }
      if (insightsDue && this.deps.features.memory) {
        try { await deriveInsights(this.deps, hash(db.all<{ wa_id: string }>("SELECT wa_id FROM contact")[0]?.wa_id ?? "")); } catch (e) { this.error("insights_failed", e); }
      }
      // Task 12: followupDue → send, defer or skip the follow-up, in its own try/catch.
    } catch (e) {
      this.error("alarm_failed", e);
    } finally {
      try { await this.scheduleNext(); } catch (e) { this.error("schedule_failed", e); }
    }
  }

  private async turnTimer(s: State, now: number): Promise<void> {
    const { db } = this.deps;
    const newest = this.pending().at(-1);
    if (!newest) db.run("UPDATE state SET turn_due=NULL");
    else if (this.turnRunning) db.run("UPDATE state SET turn_due=?", now + 1000);
    else if (s.burst_started_at !== null && now < s.burst_started_at + MAX_WAIT_MS && now - newest.ts < (looksUnfinished(newest.text ?? "") ? UNFINISHED_MS : QUIET_MS))
      db.run("UPDATE state SET turn_due=?", turnDue(now, s.burst_started_at, newest.text ?? ""));
    else await this.runTurn();
  }

  private async runTurn(): Promise<void> {
    this.turnRunning = true;
    try { await this.turn(); } finally { this.turnRunning = false; this.abort = null; }
  }

  private async turn(): Promise<void> {
    const { db, clock, wa, llm, models, features } = this.deps;
    const t0 = performance.now();
    const startedAt = clock.now();
    let to = "", pending: Msg[] = [], waitMs: number | null = null, retrievalMs = 0, model = "";
    let regenerated = 0, sends = 0, bubbles = 0, ttfb: number | null = null, lastSendAt = 0, prevChars = 0;
    let usage: (Usage & { ttftMs: number; finishReason: string }) | null = null, error: string | null = null;
    let tz = "UTC", images: memory.TurnForMemory["images"] = [], recalledTexts: string[] = [], reacted = false;
    const outIds: string[] = [];

    try {
      for (;;) {
        // Before anything can throw, and in the same synchronous step as the snapshot: a message arriving
        // from here on opens a fresh burst, and the turn timer becomes a watchdog so a reset mid-turn still replies.
        db.run("UPDATE state SET burst_started_at=NULL, turn_due=?", clock.now() + WATCHDOG_MS);
        const gen = this.state().generation;
        const snap = this.pending();
        pending = snap;
        const newest = snap.at(-1)!;
        await this.scheduleNext();
        const contact = db.all<{ wa_id: string; name: string | null; timezone: string; timezone_confirmed: number }>("SELECT * FROM contact")[0];
        to = contact.wa_id;
        tz = contact.timezone;
        waitMs ??= startedAt - newest.ts;
        wa.markReadTyping(newest.id).catch((e) => this.error("typing_failed", e));

        const files = new Map(await Promise.all(snap.map(async (r) => [r.id, await this.mediaFor(r)] as const)));
        const urls = [...new Set(snap.flatMap((r) => extractUrls(r.text ?? "").slice(0, 1)))];
        const snapshots = (await Promise.all(urls.map((u) => this.page(u)))).filter((p): p is Snapshot => p !== null);
        images = [...files].flatMap(([messageId, f]) => (f ? [{ messageId, ...f }] : []));
        // The prefetch is reused unless the query changed since ingest (a voice transcript landed, the last turn finished).
        const query = features.memory ? this.recallQuery() : "", cached = this.recallCache;
        const recalled = !features.memory ? { hits: [], ms: 0 } : cached?.generation === gen && cached.query === query ? await cached.promise : await memory.recall(this.deps, query);
        retrievalMs = recalled.ms;
        recalledTexts = recalled.hits.map((h) => h.text);

        // Re-read after the awaits: voice transcripts land in messages.text.
        const byId = new Map(this.pending().map((r) => [r.id, r]));
        pending = snap.map((r) => byId.get(r.id) ?? r);
        const history = windowHistory(this.historyRows());
        const current = pending.map((r) => ({ ...this.row(r), media: files.get(r.id) ?? undefined }));
        // #n aliases for inbound rows, chronological across history and pending; the model never sees a wamid.
        const alias = new Map<string, string>();
        for (const r of [...history, ...current]) if (r.direction === "in") { r.alias = `#${alias.size + 1}`; alias.set(r.alias, r.id); }
        const aliasOf = new Map([...alias].map(([a, id]) => [id, a]));
        for (const r of [...history, ...current]) {
          const quoted = r.quotedId && db.all<{ text: string | null }>("SELECT text FROM messages WHERE id=?", r.quotedId)[0]?.text;
          if (r.quotedId && quoted) Object.assign(r, { quotedText: excerpt(quoted), quotedAlias: aliasOf.get(r.quotedId) });
        }
        const resolve = (tag: string) => alias.get(tag.startsWith("#") ? tag : `#${tag}`);

        const prompt = buildPrompt({
          profile: features.memory ? memory.profileText(db) : "", memories: recalled.hits, history, pending: current, snapshots, memory: features.memory,
          nowLocal: formatLocal(clock.now(), tz), tz, tzConfirmed: contact.timezone_confirmed === 1, name: contact.name ?? undefined,
        });
        model = replyModelFor(models, [...files.values()].some(Boolean) || snapshots.some((p) => p.jpeg.length > 0));
        this.abort = new AbortController();
        const { text, done } = llm.stream({
          job: "reply", modelId: model, system: prompt.system, messages: prompt.messages, tools: features.memory ? { forget: this.forgetTool } : undefined,
          maxOutputTokens: maxOutputTokensFor(model, features.replyEffort), reasoning: reasoningFor(model, features.replyEffort),
          sessionId: hash(to), abortSignal: this.abort.signal,
        });

        let restart = false;
        for await (const ev of parseReply(text)) {
          if (sends === 0 && this.state().generation !== gen && regenerated < MAX_REGENERATIONS) {
            this.abort.abort();
            regenerated++;
            restart = true;
            break;
          }
          if (ev.type === "react") {
            const target = resolve(ev.target);
            if (!target || reacted) continue; // one reaction per turn, even if a tool step repeats the header
            reacted = true;
            sends++;
            try {
              await wa.sendReaction(to, target, ev.emoji);
              this.setReaction(target, "me", ev.emoji);
            } catch (e) {
              this.error("send_failed", e, { kind: "reaction" });
            }
            continue;
          }
          const quote = ev.quote ? resolve(ev.quote) : undefined;
          if (bubbles > 0) {
            wa.markReadTyping(newest.id).catch((e) => this.error("typing_failed", e));
            const wait = bubblePauseMs(prevChars) - (clock.now() - lastSendAt);
            if (wait > 0) await clock.sleep(wait);
          }
          sends++;
          bubbles++;
          let wamid: string | null = null;
          try {
            wamid = (await wa.sendText(to, ev.text, { quote, previewUrl: /https?:\/\//.test(ev.text) })).id;
            ttfb ??= performance.now() - t0;
          } catch (e) {
            this.error("send_failed", e, { kind: "text" });
          }
          lastSendAt = clock.now();
          prevChars = ev.text.length;
          const rowId = wamid || `local.${crypto.randomUUID()}`;
          db.run("INSERT INTO messages(id, direction, kind, text, ts, quoted_id, status) VALUES (?, 'out', 'text', ?, ?, ?, ?)", rowId, ev.text, lastSendAt, quote ?? null, wamid === null ? "failed" : "sent");
          outIds.push(rowId);
        }
        if (restart) continue; // the next snapshot takes the new messages
        usage = await done;
        break;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.error("turn_failed", e);
      if (sends === 0 && this.state().turn_attempts === 0) {
        db.run("UPDATE state SET turn_attempts=1, turn_due=?", clock.now() + RETRY_MS);
        this.recallCache = null; // the retry recomputes recall instead of reusing a failed promise
        return;
      }
    }

    // Bookkeeping (success, or a failure that already sent something / used its retry).
    const row = {
      started_at: startedAt, wait_ms: waitMs, retrieval_ms: ms(retrievalMs), ttft_ms: ms(usage?.ttftMs), ttfb_ms: ms(ttfb),
      total_ms: ms(performance.now() - t0), model, provider: usage?.provider ?? null, bubbles, regenerated, error, usage: usage ? JSON.stringify(usage) : null, recalled: JSON.stringify(recalledTexts),
    };
    const keys = Object.keys(row);
    const turnId = db.all<{ id: number }>(`INSERT INTO turns(${keys}) VALUES (${keys.map(() => "?")}) RETURNING id`, ...Object.values(row))[0].id;
    db.run("UPDATE messages SET status='handled', turn_id=? WHERE id IN (SELECT value FROM json_each(?))", turnId, JSON.stringify(pending.map((r) => r.id)));
    db.run("UPDATE messages SET turn_id=? WHERE id IN (SELECT value FROM json_each(?))", turnId, JSON.stringify(outIds));
    const next = this.pending().at(-1);
    const now = clock.now();
    db.run("UPDATE state SET turn_attempts=0, turn_due=?", next ? turnDue(now, this.state().burst_started_at ?? now, next.text ?? "") : null);
    for (const r of pending) {
      this.media.delete(r.id);
      for (const u of extractUrls(r.text ?? "")) this.pages.delete(u);
    }
    this.deps.log({ event: "turn", contact: hash(to), ...row, usage });
    if (error === null && features.memory) {
      const sent = db.all<{ id: string; text: string }>("SELECT id, text FROM messages WHERE id IN (SELECT value FROM json_each(?)) ORDER BY ts, rowid", JSON.stringify(outIds));
      try {
        await memory.remember(this.deps, {
          messages: [...pending.map((r) => ({ role: "user" as const, text: r.text ?? "", id: r.id })), ...sent.map((r) => ({ role: "assistant" as const, ...r }))],
          images, nowLocal: formatLocal(clock.now(), tz), tz, sessionId: hash(to),
        });
      } catch (e) {
        this.error("remember_failed", e);
      }
    }
    // Task 12: scheduleFollowup().
  }

  // reactions JSON on a message row: { [sender]: emoji }; "me" is the agent; no emoji removes it.
  private setReaction(id: string, who: string, emoji: string | undefined): void {
    const row = this.deps.db.all<{ reactions: string | null }>("SELECT reactions FROM messages WHERE id=?", id)[0];
    if (!row) return;
    const r = JSON.parse(row.reactions ?? "{}") as Record<string, string>;
    if (emoji) r[who] = emoji;
    else delete r[who];
    this.deps.db.run("UPDATE messages SET reactions=? WHERE id=?", JSON.stringify(r), id);
  }

  private state(): State { return this.deps.db.all<State>("SELECT * FROM state")[0]; }

  private pending(): Msg[] {
    return this.deps.db.all<Msg>("SELECT * FROM messages WHERE direction='in' AND status='pending' ORDER BY ts, rowid");
  }

  private historyRows(): (HistoryRow & { quotedId: string | null })[] {
    return this.deps.db.all<Msg>("SELECT * FROM messages WHERE status IN ('handled','sent') AND kind != 'unsupported' ORDER BY ts DESC, rowid DESC LIMIT 40")
      .reverse().map((m) => this.row(m));
  }

  private row(m: Msg): HistoryRow & { quotedId: string | null } {
    const { me, ...theirs } = m.reactions ? (JSON.parse(m.reactions) as Record<string, string>) : {};
    const reactions = Object.values(theirs).join("");
    return { id: m.id, direction: m.direction, text: m.text, ts: m.ts, kind: m.kind, mediaNote: m.media_note, quotedId: m.quoted_id, ...(reactions ? { reactions } : {}), ...(me ? { myReaction: me } : {}) };
  }

  private loadMedia(id: string, kind: string, mediaId: string): Promise<Media | null> {
    const { db } = this.deps;
    const file = this.deps.wa.fetchMedia(mediaId);
    if (kind !== "audio") return file.then((f) => {
      if (f.bytes.length <= MAX_IMAGE && IMAGE_MIME.test(f.mime)) return f;
      const text = db.all<{ text: string | null }>("SELECT text FROM messages WHERE id=?", id)[0]?.text;
      db.run("UPDATE messages SET text=? WHERE id=?", ((text === "[photo]" ? "" : text ?? "") + " [an image that could not be read]").trim(), id);
      return null;
    }).catch((e) => { this.error("media_failed", e); return null; });
    return file
      .then((f) => this.deps.transcribe(f.bytes, f.mime))
      .then((t) => db.run("UPDATE messages SET text=?, voice=1 WHERE id=?", t, id), (e) => {
        this.error("voice_failed", e);
        db.run("UPDATE messages SET text=? WHERE id=?", VOICE_FAILED, id);
      })
      .then(() => null, () => null);
  }

  // Refill after a reset: images always, voice notes only while still untranscribed.
  private mediaFor(r: Msg): Promise<Media | null> {
    if (!this.media.has(r.id) && r.media_id && (r.kind === "image" || (r.kind === "audio" && r.text === null)))
      this.media.set(r.id, this.loadMedia(r.id, r.kind, r.media_id));
    return this.media.get(r.id) ?? Promise.resolve(null);
  }

  private page(url: string): Promise<Snapshot | null> {
    if (!this.pages.has(url)) this.pages.set(url, this.deps.snapshot(url).catch(() => null));
    return this.pages.get(url)!;
  }

  // What to recall for: the last two messages before the pending ones, then the pending ones.
  private recallQuery(): string {
    const prev = this.deps.db.all<{ text: string | null }>("SELECT text FROM messages WHERE status IN ('handled','sent') AND kind != 'unsupported' ORDER BY ts DESC, rowid DESC LIMIT 2").reverse();
    return [...prev, ...this.pending()].map((r) => r.text ?? "").join("\n").trim();
  }

  private async scheduleNext(): Promise<void> {
    const s = this.state();
    const due = [s.turn_due, s.insights_due, s.followup_due].filter((x): x is number => x !== null);
    await this.deps.clock.setAlarm(due.length ? Math.min(...due) : null);
  }

  private error(event: string, e: unknown, extra: Record<string, unknown> = {}): void {
    this.deps.log({ event, error: e instanceof Error ? e.message : String(e), ...(e instanceof WaError ? { code: e.code, status: e.status } : {}), ...extra });
  }
}
