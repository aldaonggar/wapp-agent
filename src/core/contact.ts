import { tool } from "ai";
import { z } from "zod";
import { extractUrls } from "../browser";
import { EFFORT, maxOutputTokensFor, reasoningFor, replyModelFor } from "../models";
import { WaError } from "../whatsapp";
import { MAX_WAIT_MS, QUIET_MS, UNFINISHED_MS, bubblePauseMs, looksUnfinished, turnDue } from "./cadence";
import { formatLocal } from "./db";
import { followupDecision, scheduleFollowup } from "./followups";
import { deriveInsights } from "./insights";
import * as memory from "./memory";
import { buildPage, pagesLeftToday } from "./pages";
import { buildPrompt, windowHistory, type HistoryRow } from "./prompt";
import { addReminder, cancelReminder, dueReminders, pendingReminders, scheduleReminder } from "./reminders";
import { parseReply } from "./stream";
import { tzFromPhone } from "./timezone";
import type { Deps, Inbound, MemoryHit, Snapshot, Usage } from "./types";

type Media = { bytes: Uint8Array; mime: string };
type Recall = { hits: MemoryHit[]; ms: number };
interface Msg { id: string; direction: "in" | "out"; kind: string; text: string | null; ts: number; quoted_id: string | null; media_id: string | null; media_note: string | null; reactions: string | null; voice: number }
interface State { turn_due: number | null; insights_due: number | null; followup_due: number | null; followup_fact_id: number | null; reminder_due: number | null; burst_started_at: number | null; generation: number; turn_attempts: number }

const MAX_IMAGE = 5 * 1024 * 1024, IMAGE_MIME = /^image\/(jpeg|png|webp)\b/i;
const VOICE_FAILED = "[voice note could not be transcribed]";
const INSIGHTS_AFTER_MS = 30 * 60_000;
const DAY = 86_400_000; // Meta's free-form window after their last message; applied only when window24h() says so
const RETRY_MS = 30_000;
const MAX_REGENERATIONS = 2;
const WATCHDOG_MS = 60_000;
export const FALLBACK = "sorry, something broke on my side. can you send that again in a bit?";
const SPEAKABLE = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u; // Aura-1 is an English voice: a bubble in another script turns the reply into text

const excerpt = (t: string) => (t.length > 80 ? t.slice(0, 79) + "…" : t);
const ms = (x: number | null | undefined) => (x == null ? null : Math.round(x));

export class ContactCore {
  // In-memory only: lost on a Durable Object reset by design; runTurn refills media from media_id.
  turnRunning = false;
  media = new Map<string, Promise<Media | null>>();
  pages = new Map<string, Promise<Snapshot | null>>();
  recallCache: { generation: number; query: string; promise: Promise<Recall> } | null = null;
  abort: AbortController | null = null;
  /** Extraction and follow-up scheduling, off the reply path: each turn's runs after the previous one's; never rejects. */
  afterTurn: Promise<void> = Promise.resolve();
  private deps: Deps;
  private forgetTool = tool({
    description: "Delete stored facts matching the query; call when the person asks to forget something",
    inputSchema: z.object({ query: z.string().describe("what to forget, in the words of the memory: names, places, the thing itself (e.g. \"Almaty\")") }),
    // The previous turn's extraction may still be running; forgetting first would let it write the fact back.
    execute: async ({ query }) => { await this.afterTurn; return memory.forget(this.deps, query); },
  });

  private viewPageTool = tool({
    description: "Open a web page the person mentioned and read it",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const p = await this.page(url);
      if (!p) this.pages.delete(url); // a failed (rate-limited) open is not cached for the instance's lifetime
      return p ? { title: p.title, status: p.status, finalUrl: p.finalUrl, markdown: p.markdown.slice(0, 6000) } : { error: "could not open the page" };
    },
  });

  private setReminderTool = tool({
    description: "Set a reminder for an exact time: they get the text back as a message at that moment. Work `at` out from the \"now:\" line and confirm with the time this returns, relaying its note when there is one. Set relative when they spoke in a duration.",
    inputSchema: z.object({
      text: z.string().min(1).describe("what to remind them of, in their words (\"call the dentist\")"),
      at: z.string().describe("their local time as YYYY-MM-DD HH:mm"),
      relative: z.boolean().optional().describe("true when they gave a duration (\"in 20 minutes\", \"in 2 hours\") rather than a clock time or a day"),
    }),
    execute: async ({ text, at, relative }) => {
      const { db, clock } = this.deps;
      const r = addReminder(db, clock.now(), this.tz(), text, at, this.pending().at(-1)?.id ?? null, relative);
      await this.scheduleNext();
      // reminderTimer's own test, seen from now: past Meta's window from their last message it only arrives if they write again first.
      const lastIn = db.all<{ last_inbound_ts: number | null }>("SELECT last_inbound_ts FROM contact")[0]?.last_inbound_ts ?? 0;
      const far = "id" in r && this.window24h() && db.all<{ due_ts: number }>("SELECT due_ts FROM reminders WHERE id = ?", r.id)[0].due_ts > lastIn + DAY;
      return far ? { ...r, note: "on WhatsApp this will only arrive if you message me within the 24 hours before it" } : r;
    },
  });

  private cancelReminderTool = tool({
    description: "Cancel a pending reminder by the id shown in the reminders list",
    inputSchema: z.object({ id: z.number().int() }),
    execute: async ({ id }) => {
      const r = cancelReminder(this.deps.db, id);
      await this.scheduleNext();
      return r;
    },
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
      const reminderDue = s.reminder_due !== null && now >= s.reminder_due;
      if (insightsDue) db.run("UPDATE state SET insights_due=NULL");
      if (followupDue) db.run("UPDATE state SET followup_due=NULL");
      if (reminderDue) db.run("UPDATE state SET reminder_due=NULL");
      if (reminderDue) await this.reminderTimer(now); // first: no model call, and it is due at an exact time
      if (s.turn_due !== null && now >= s.turn_due) {
        try { await this.turnTimer(s, now); } catch (e) { this.error("turn_failed", e); }
      }
      if (insightsDue && this.deps.features.memory) {
        try { await deriveInsights(this.deps, this.deps.contactKey); } catch (e) { this.error("insights_failed", e); }
      }
      if (followupDue) await this.followupTimer(now, s.followup_fact_id);
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
    let tz = "UTC", images: memory.TurnForMemory["images"] = [], recalledTexts: string[] = [], reacted = false, searched = false, pageMade = false, says = 0, sayText = "";
    // Some models write their say line again after the tool step; it already went out.
    const norm = (s: string) => s.trim().toLowerCase().replace(/[.,!?…]+$/, "");
    const unsaid = (text: string): string => {
      if (!sayText) return text;
      const [first, ...rest] = text.split("\n");
      return norm(first) === norm(sayText) ? rest.join("\n").trim() : text;
    };
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
        // A voice note gets one voice note back with the whole reply; the bubbles are held until the stream ends.
        let voiceReply = newest.kind === "audio" && newest.voice === 1 && !!this.deps.tts && !!wa.sendAudio;
        const held: { text: string; quote?: string }[] = [];
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
          nowLocal: formatLocal(clock.now(), tz), tz, tzConfirmed: contact.timezone_confirmed === 1, name: contact.name ?? undefined, reminders: pendingReminders(db),
        });
        model = replyModelFor(models, [...files.values()].some(Boolean) || snapshots.some((p) => p.jpeg.length > 0));

        const deliver = async (text: string, quote?: string) => {
          if (bubbles > 0) {
            wa.markReadTyping(newest.id).catch((e) => this.error("typing_failed", e));
            const wait = bubblePauseMs(prevChars) - (clock.now() - lastSendAt);
            if (wait > 0) await clock.sleep(wait);
          }
          sends++;
          bubbles++;
          const wamid = await this.sendBubble(to, text, quote);
          if (wamid) ttfb ??= performance.now() - t0;
          lastSendAt = clock.now();
          prevChars = text.length;
          const rowId = wamid || `local.${crypto.randomUUID()}`;
          db.run("INSERT INTO messages(id, direction, kind, text, ts, quoted_id, status) VALUES (?, 'out', 'text', ?, ?, ?, ?)", rowId, text, lastSendAt, quote ?? null, wamid === null ? "failed" : "sent");
          outIds.push(rowId);
        };

        const { search } = this.deps;
        // After a search, view_page opens only the thread's links and the results: a result page must not pick where the bot goes.
        const allowed = new Set([...history.slice(-5), ...pending].flatMap((r) => extractUrls(r.text ?? "")));
        const blocked = (url: string) => searched && !allowed.has(url);
        const viewPage = { ...this.viewPageTool, execute: (a: { url: string }, o: never) => blocked(a.url) ? Promise.resolve({ error: "could not open the page" }) : this.viewPageTool.execute!(a, o) } as typeof this.viewPageTool;
        // Same allowlist as view_page. The snapshot is the cached one; a cached snapshot without a picture is retaken once.
        const screenshotTool = tool({
          description: "Send the person a screenshot of a web page as an image, with an optional caption",
          inputSchema: z.object({ url: z.string().url(), caption: z.string().max(1000).optional() }),
          execute: async ({ url, caption }) => {
            if (!wa.sendImage) return { error: "images cannot be sent here" };
            if (blocked(url)) return { error: "could not open the page" };
            let p = await this.page(url);
            if (p && !p.jpeg.length) { this.pages.delete(url); p = await this.page(url); }
            if (!p?.jpeg.length) { this.pages.delete(url); return { error: "could not take a screenshot" }; }
            try {
              const id = (await wa.sendImage(to, p.jpeg, "image/jpeg", { caption })).id;
              sends++; bubbles++;
              lastSendAt = clock.now(); prevChars = (caption ?? "").length;
              db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES (?, 'out', 'image', ?, ?, 'sent')", id, `[screenshot of ${url}]${caption ? " " + caption : ""}`, lastSendAt);
              outIds.push(id);
              return { sent: true };
            } catch (e) {
              this.error("send_failed", e, { kind: "image" });
              return { error: "could not send the screenshot" };
            }
          },
        });
        const pageTool = tool({
          description: "Build a small web page and get its link, for content that reads better as a page than as chat bubbles. Sends `say` to them first (building takes up to a minute). One page per turn.",
          inputSchema: z.object({
            say: z.string().min(1).describe("one short sentence in your own voice telling them you are putting it together (\"give me a minute, putting that together\")"),
            title: z.string().min(1).max(120).describe("the page title"),
            brief: z.string().min(1).max(8000).describe("everything the page must contain, written from the conversation and what you know (facts, rows, steps, preferences) and the kind of page it should be"),
          }),
          execute: async ({ say, title, brief }) => {
            if (pageMade) return { error: "one page per turn" };
            if (!pagesLeftToday(db, clock.now())) return { error: "10 pages made in the last 24 hours: tell them to ask again tomorrow" };
            pageMade = true;
            says++;
            sayText = say;
            await deliver(say); // before the build starts: the model call takes tens of seconds
            wa.markReadTyping(newest.id).catch((e) => this.error("typing_failed", e));
            try { return await buildPage(this.deps, title, brief); } catch (e) {
              this.error("page_failed", e);
              return { error: "could not build the page" };
            }
          },
        });
        const searchTool = search && tool({
          description: "Look something up on the web: current or outside information you do not have. Sends `say` to them first, then returns the top results' main pages.",
          inputSchema: z.object({
            say: z.string().min(1).describe("one short sentence in your own voice telling them you are checking (\"sec, let me look that up\")"),
            query: z.string().min(1).describe("what to search for"),
          }),
          execute: async ({ say, query }) => {
            if (searched) return { error: "one search per turn" };
            searched = true;
            says++;
            sayText = say;
            await deliver(say); // before the search starts: they see it at the usual first-bubble time
            wa.markReadTyping(newest.id).catch((e) => this.error("typing_failed", e));
            const t = performance.now(), results = (await search(query)).slice(0, 3).map((r) => ({ ...r, text: r.text.slice(0, 3000) }));
            this.deps.log({ event: "search", results: results.length, ms: ms(performance.now() - t) }); // never the query
            for (const r of results) allowed.add(r.url);
            return results.length ? { results } : { results: [], note: "nothing found" };
          },
        });
        const hasUrl = [...history.slice(-5), ...pending].some((r) => extractUrls(r.text ?? "").length > 0);
        const tools = {
          set_reminder: this.setReminderTool, cancel_reminder: this.cancelReminderTool, ...(features.memory ? { forget: this.forgetTool } : {}), make_page: pageTool,
          ...(hasUrl || searchTool ? { view_page: viewPage, send_screenshot: screenshotTool } : {}), ...(searchTool ? { search_web: searchTool } : {}),
        };
        this.abort = new AbortController();
        const { text, done } = llm.stream({
          job: "reply", modelId: model, system: prompt.system, messages: prompt.messages, tools,
          // view_page opens up once a search ran; search results are untrusted text, so the tools that delete close then.
          activeTools: () => Object.keys(tools).filter((k) => (k === "view_page" || k === "send_screenshot" ? hasUrl || searched : !(searched && (k === "forget" || k === "cancel_reminder" || k === "search_web")))),
          maxOutputTokens: maxOutputTokensFor(model, features.replyEffort ?? EFFORT.reply), reasoning: reasoningFor(model, features.replyEffort ?? EFFORT.reply),
          sessionId: this.deps.contactKey, abortSignal: this.abort.signal,
        });

        let restart = false;
        try {
          for await (const ev of parseReply(text)) {
            if (sends === 0 && this.state().generation !== gen && regenerated < MAX_REGENERATIONS) {
              this.abort.abort();
              regenerated++;
              restart = true;
              break;
            }
            if (ev.type === "react") {
              const target = ev.target ? resolve(ev.target) : pending.at(-1)?.id;
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
            if (ev.type === "voice") { // asked for in text: the same held voice reply as for a voice note in, only before the first bubble
              if (this.deps.tts && wa.sendAudio) voiceReply = true; // the parser guarantees no reply bubble came first; a search's say line does not count
              continue;
            }
            const quote = ev.quote ? resolve(ev.quote) : undefined;
            if (voiceReply && !SPEAKABLE.test(ev.text)) { // from here on the reply streams as text, starting with what was held
              voiceReply = false;
              for (const b of held.splice(0)) await deliver(b.text, b.quote);
            }
            const text = unsaid(ev.text);
            if (!text) continue; // the bubble was only the repeated say line
            if (voiceReply) held.push({ text, quote });
            else await deliver(text, quote);
          }
        } catch (e) {
          for (const b of held.splice(0)) await deliver(b.text, b.quote); // the stream died: the complete bubbles go out as text, like the text path
          throw e;
        }
        if (restart) continue; // the next snapshot takes the new messages
        if (held.length) {
          const joined = held.map((b) => b.text).join("\n\n"), quote = held.find((b) => b.quote)?.quote; // one voice note carries one quote
          const wamid = await this.sendVoice(to, joined, quote);
          if (wamid) {
            sends++;
            bubbles += held.length; // a search's say line may have gone out as text before
            ttfb ??= performance.now() - t0;
            db.run("INSERT INTO messages(id, direction, kind, text, ts, quoted_id, voice, status) VALUES (?, 'out', 'audio', ?, ?, ?, 1, 'sent')", wamid, joined, clock.now(), quote ?? null);
            outIds.push(wamid);
          } else for (const b of held) await deliver(b.text, b.quote); // synthesis or upload failed: the text bubbles, paced as usual
        }
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
    // A failed turn that showed them no text and has no retry left: one fixed line instead of a typing indicator and silence.
    // After the rows are handled, so it can never go out twice for the same burst. A search's say line is not an answer.
    db.run("UPDATE state SET turn_attempts=0"); // before the send: a reset during it must not leave the next burst without its retry
    if (error !== null && bubbles === says && to) {
      try {
        const wamid = await this.sendBubble(to, FALLBACK), rowId = wamid || `local.${crypto.randomUUID()}`;
        db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES (?, 'out', 'text', ?, ?, ?)", rowId, FALLBACK, clock.now(), wamid === null ? "failed" : "sent");
        outIds.push(rowId);
        this.deps.log({ event: "fallback_sent", contact: this.deps.contactKey, ok: wamid !== null });
      } catch (e) {
        this.error("fallback_failed", e);
      }
    }
    db.run("UPDATE messages SET turn_id=? WHERE id IN (SELECT value FROM json_each(?))", turnId, JSON.stringify(outIds));
    const next = this.pending().at(-1);
    const now = clock.now();
    db.run("UPDATE state SET turn_attempts=0, turn_due=?", next ? turnDue(now, this.state().burst_started_at ?? now, next.text ?? "") : null);
    // Cache entries only (never starts a snapshot); read before the cleanup below drops them.
    const cachedPages = pending.map((r) => this.pages.get(extractUrls(r.text ?? "")[0] ?? ""));
    for (const r of pending) {
      this.media.delete(r.id);
      for (const u of extractUrls(r.text ?? "")) this.pages.delete(u);
    }
    this.deps.log({ event: "turn", contact: this.deps.contactKey, ...row, recalled: recalledTexts.length, usage }); // never the phone number or memory texts
    // Not awaited: turnRunning is released now, so the next reply never waits for this extraction.
    const finished = { pending, cachedPages, outIds, images, tz };
    this.afterTurn = this.afterTurn.then(() => this.postTurn(finished)).catch((e) => this.error("post_turn_failed", e));
  }

  // Remember the turn (failed turns too: what they said still counts), then re-arm for any plan it stored.
  private async postTurn(t: { pending: Msg[]; cachedPages: (Promise<Snapshot | null> | undefined)[]; outIds: string[]; images: memory.TurnForMemory["images"]; tz: string }): Promise<void> {
    const { db, clock, features } = this.deps;
    if (features.memory) {
      try {
        const noted = await Promise.all(t.pending.map(async (r, i) => {
          const p = await t.cachedPages[i];
          return p ? `${r.text} (shared a link: ${p.title} ${p.finalUrl})` : r.text ?? "";
        }));
        const sent = db.all<{ id: string; text: string }>("SELECT id, text FROM messages WHERE id IN (SELECT value FROM json_each(?)) ORDER BY ts, rowid", JSON.stringify(t.outIds));
        await memory.remember(this.deps, {
          messages: [...t.pending.map((r, i) => ({ role: "user" as const, text: noted[i], id: r.id })), ...sent.map((r) => ({ role: "assistant" as const, ...r }))],
          images: t.images, nowLocal: formatLocal(clock.now(), t.tz), tz: t.tz, sessionId: this.deps.contactKey,
        });
      } catch (e) {
        this.error("remember_failed", e);
      }
    }
    scheduleFollowup(db, clock.now(), t.tz);
    await this.scheduleNext();
  }

  // One text send: a failure is logged and returns null (callers store a 'failed' row).
  private async sendBubble(to: string, text: string, quote?: string): Promise<string | null> {
    try {
      return (await this.deps.wa.sendText(to, text, { quote, previewUrl: /https?:\/\//.test(text) })).id;
    } catch (e) {
      this.error("send_failed", e, { kind: "text" });
      return null;
    }
  }

  // Timer 3 (followup_due is already NULL). Never retries a proactive message: send and skip both mark the fact done.
  private async followupTimer(now: number, factId: number | null): Promise<void> {
    const { db, clock } = this.deps;
    let tz = "UTC";
    const done = () => {
      db.run("UPDATE facts SET followup_done = 1 WHERE id = ?", factId);
      db.run("UPDATE state SET followup_fact_id = NULL");
    };
    try {
      tz = this.tz();
      const d = followupDecision(db, now, tz, factId, this.window24h());
      if (d.kind === "defer") {
        db.run("UPDATE facts SET followup_due = ? WHERE id = ?", d.to, factId);
        db.run("UPDATE state SET followup_due = ?", d.to);
      } else {
        done();
        if (d.kind === "send") await this.sendFollowup(d.text, tz, now);
      }
    } catch (e) {
      this.error("followup_failed", e);
      done();
    } finally {
      scheduleFollowup(db, clock.now(), tz);
    }
  }

  // One voice note for the whole reply; null when synthesis or the upload fails, and the caller falls back to text.
  private async sendVoice(to: string, text: string, quote?: string): Promise<string | null> {
    const { tts, wa } = this.deps;
    if (!tts || !wa.sendAudio) return null;
    try {
      const a = await tts(text);
      return (await wa.sendAudio(to, a.bytes, a.mime, { quote })).id;
    } catch (e) {
      this.error("voice_reply_failed", e);
      return null;
    }
  }

  // Timer 4 (reminder_due is already NULL). At least once: 'sending' before the send, 'sent' after it. A row a reset left in
  // 'sending' is sent once more after a minute, marked 'sent' first, so a reset costs one duplicate at worst and never loops.
  private async reminderTimer(now: number): Promise<void> {
    const { db, clock } = this.deps;
    try {
      const c = db.all<{ wa_id: string; last_inbound_ts: number | null }>("SELECT wa_id, last_inbound_ts FROM contact")[0];
      const windowed = this.window24h();
      for (const r of dueReminders(db, now)) {
        const inWindow = !windowed || now - (c?.last_inbound_ts ?? 0) <= DAY;
        if (!inWindow) {
          db.run("UPDATE reminders SET status='skipped' WHERE id=?", r.id);
          this.deps.log({ event: "reminder_skipped", reason: "window", id: r.id });
          continue;
        }
        db.run("UPDATE reminders SET status=?, attempted_at=? WHERE id=?", r.status === "sending" ? "sent" : "sending", clock.now(), r.id);
        const text = `Reminder: ${r.text}`;
        const wamid = await this.sendBubble(c.wa_id, text);
        db.run("UPDATE reminders SET status=? WHERE id=?", wamid !== null ? "sent" : "skipped", r.id);
        if (wamid === null) this.deps.log({ event: "reminder_skipped", reason: "send", id: r.id }); // the send error itself is logged by sendBubble
        db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES (?, 'out', 'text', ?, ?, ?)", wamid || `local.${crypto.randomUUID()}`, text, clock.now(), wamid === null ? "failed" : "sent");
      }
    } catch (e) {
      this.error("reminder_failed", e);
      db.run("UPDATE reminders SET status='skipped' WHERE status='pending' AND due_ts <= ?", now); // never re-armed into an alarm storm
    }
  }

  private async sendFollowup(factText: string, tz: string, now: number): Promise<void> {
    const { db, clock, llm, models, features } = this.deps;
    const contact = db.all<{ wa_id: string; name: string | null; timezone_confirmed: number }>("SELECT * FROM contact")[0];
    const prompt = buildPrompt({
      profile: features.memory ? memory.profileText(db) : "", memories: [], history: windowHistory(this.historyRows()), pending: [], snapshots: [], memory: features.memory,
      nowLocal: formatLocal(now, tz), tz, tzConfirmed: contact.timezone_confirmed === 1, name: contact.name ?? undefined,
    });
    const last = prompt.system[1];
    const system = [prompt.system[0], { ...last, content: `${last.content}\n\nWrite one short check-in about this plan, in the person's language and register: "${factText}". No reaction line. One bubble, at most two sentences, one question at most.` }];
    // buildPrompt ends on an empty user turn; some providers reject a conversation that ends on an assistant message.
    const history = prompt.messages.slice(0, -1);
    const messages = history.at(-1)?.role === "assistant" || history.length === 0 ? [...history, { role: "user" as const, content: "[scheduled check-in]" }] : history;
    const { text, done } = llm.stream({
      job: "followup", modelId: models.reply, maxOutputTokens: maxOutputTokensFor(models.reply, features.replyEffort ?? EFFORT.reply), reasoning: reasoningFor(models.reply, features.replyEffort ?? EFFORT.reply),
      sessionId: this.deps.contactKey, system, messages,
    });
    let bubbles = 0;
    for await (const ev of parseReply(text, 1)) {
      if (ev.type !== "bubble") continue;
      bubbles++;
      const wamid = await this.sendBubble(contact.wa_id, ev.text);
      db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES (?, 'out', 'text', ?, ?, ?)", wamid || `local.${crypto.randomUUID()}`, ev.text, clock.now(), wamid === null ? "failed" : "sent");
      if (wamid) db.run("UPDATE contact SET last_proactive_date = ?", formatLocal(now, tz).slice(0, 10));
    }
    if (!bubbles) this.error("followup_empty", new Error("the model wrote no check-in"));
    await done;
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

  private tz(): string { return this.deps.db.all<{ timezone: string }>("SELECT timezone FROM contact")[0]?.timezone ?? "UTC"; }

  /** Meta's 24-hour free-form window applies unless the transport says otherwise (Telegram has none). */
  private window24h(): boolean { return this.deps.wa.window24h?.(this.deps.db.all<{ wa_id: string }>("SELECT wa_id FROM contact")[0]?.wa_id ?? "") !== false; }

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
      .then((t) => db.run("UPDATE messages SET text=? WHERE id=?", t, id), (e) => { // voice stays what the webhook said: a forwarded audio file is not a voice note
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
    scheduleReminder(this.deps.db); // from the table, so a reset mid-send cannot lose the next reminder
    const s = this.state();
    const due = [s.turn_due, s.insights_due, s.followup_due, s.reminder_due].filter((x): x is number => x !== null);
    await this.deps.clock.setAlarm(due.length ? Math.min(...due) : null);
  }

  private error(event: string, e: unknown, extra: Record<string, unknown> = {}): void {
    this.deps.log({ event, error: e instanceof Error ? e.message : String(e), ...(e instanceof WaError ? { code: e.code, status: e.status } : {}), ...extra });
  }
}
