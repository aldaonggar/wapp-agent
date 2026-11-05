import type { ModelMessage } from "ai";
import { z } from "zod";
import { EFFORT, reasoningFor } from "../models";
import { blobToVec, formatLocal, vecToBlob } from "./db";
import { rezoneReminders } from "./reminders";
import type { Db, Deps, MemoryHit } from "./types";

export const KINDS = ["identity", "person", "preference", "plan", "routine", "work", "place", "other"] as const;
export const ExtractSchema = z.object({
  ops: z.array(z.object({ op: z.enum(["ADD", "UPDATE", "DELETE", "NONE"]), text: z.string(), kind: z.enum(KINDS), signal: z.number().int().min(1).max(5), event_date: z.string().nullable().optional(), target_id: z.number().int().nullable().optional() })),
  profile: z.string().nullable().optional(),
  media_note: z.string().nullable().optional(), // one line about an image in this turn, when it matters
  timezone: z.string().nullable().optional(), // IANA id, only when the person stated their city or zone in this turn
});
export interface TurnForMemory { messages: { role: "user" | "assistant"; text: string; id: string }[]; images: { messageId: string; bytes: Uint8Array; mime: string }[]; nowLocal: string; tz: string; sessionId: string }

const DAY = 86_400_000;
const PERSIST = 3, RECENCY = 0.05, PROFILE_CHARS = 1200; // 300 tokens at 4 chars each
// bge-m3 scores unrelated short pairs up to 0.625 (measured 2026-11-05): a match clears 0.68 and is near the best one.
const FORGET_MIN = 0.68, FORGET_MARGIN = 0.05, FORGET_MIN_CHARS = 4;

// Adapted from mem0's FACT_RETRIEVAL_PROMPT and DEFAULT_UPDATE_MEMORY_PROMPT (github.com/mem0ai/mem0, mem0/configs/prompts.py, Apache-2.0).
export const EXTRACT_PROMPT = `You are a Personal Information Organizer for a WhatsApp companion, specialized in accurately storing facts, memories and preferences about one person. You read the latest turn of the conversation and decide what is worth remembering long term, so that weeks from now the companion knows them the way a good friend would. You also keep the memory current: you compare what you learn with the existing facts and decide, for each piece of information, whether to add it, update an old fact, delete one, or change nothing.

Types of information to remember (kind):
- identity: their name, age, where they live and their time zone, languages, health, diet, allergies.
- person: the people in their life, with names and relationships ("Sister Aru lives in Almaty", "Manager is called Oliver").
- preference: stable likes, dislikes and standing preferences (food, music, travel, how they like to be talked to).
- plan: upcoming events, trips, appointments and deadlines with a date; always set event_date.
- routine: recurring habits and schedules ("Runs every morning at 7").
- work: job, employer, role, projects and their names, studies.
- place: places that matter to them (home, neighbourhood, favourite spots, where they are travelling).
- other: anything else that will still matter in a month.

Signal (1 to 5): how much it will matter in future conversations. Only signal 3 or higher is stored.
- 5: core identity and key relationships: their name, family and partner, where they live, diet and allergies.
- 4: plans with dates, work and projects, stable preferences.
- 3: recurring routines, places, lasting details still worth knowing next month.
- 2: one-off details unlikely to matter again.
- 1: noise.
DELETE needs no signal: a fact that is no longer true is always removed.
Noise is signal 1 or 2 and is never stored:
- small talk, greetings, thanks, jokes and reactions ("haha", "ok", "nice", "good morning");
- passing states ("I'm tired", "so hungry", "stuck in traffic", "bored", "my phone is dying");
- one-off trivia (what they had for lunch, the weather, a show they happen to be watching);
- one-off requests and questions ("looking for a restaurant tonight", "what's a good movie?");
- requests to be reminded ("remind me at 9 to call the dentist"): a reminder is set by a tool and is never a fact; only an event behind it with its own date ("dentist appointment on 2026-11-07 10:00") is a plan;
- anything the assistant said: its suggestions, recommendations, ideas, opinions and questions. Store only what the person states about themselves and their life. A suggestion becomes a fact only when the person adopts it as their own ("booked Hoppers for Friday 20:00" is a plan).

How to write a fact (text):
- One short self-contained statement about the person, without "User" or "The person": "Is vegetarian", "Brother Tom is a nurse".
- Resolve pronouns and references from the conversation ("she" → "Sister Aru").
- Absolute dates only, computed from the current local time and the calendar given with the input; never "tomorrow", "next week" or "on Thursday". Said on Tuesday 2026-11-10, "interview at Monzo thursday next week at 2" becomes "Job interview at Monzo on 2026-11-19 14:00".
- event_date: "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" in their local time, for plans; otherwise null.
- Write facts in the language the person writes in.

Operations, comparing each piece of information with the existing facts (listed as [id] text (kind, date said)):
- ADD: new information not present in the existing facts.
- UPDATE: it changes or adds to an existing fact about the same thing (they moved, changed jobs, a plan moved, more detail). text is the full new statement and target_id the id of the old fact, which is kept as history so "where did she live before?" still works. If both say the same thing, it is NONE.
- DELETE: the person says an existing fact is wrong or no longer true and nothing replaces it, or asks to forget it. target_id is that fact's id; text repeats it.
- NONE: already known (same meaning in other words). NONE may be left out.
target_id is always an id from the existing facts; never invent one. Return each piece of information once.

Examples (each shows the input briefly, then the output):

Conversation: user: Hi.
Output: {"ops": []}

Conversation: user: There are branches in trees.
Output: {"ops": []}

Conversation: user: ugh so tired today, long day
Output: {"ops": []}

Conversation: user: Hi, I am looking for a restaurant in San Francisco.
Output: {"ops": []}

Conversation: user: any ideas for dinner? / assistant: You could try Dishoom or Hoppers, both great. / user: ooh maybe, thanks
Output: {"ops": []}

Conversation: user: remind me tomorrow at 9 to call the dentist / assistant: Will do, tomorrow at 09:00.
Output: {"ops": []}

Conversation: user: Hi, my name is John. I am a software engineer.
Output: {"ops": [{"op": "ADD", "text": "Name is John", "kind": "identity", "signal": 5}, {"op": "ADD", "text": "Works as a software engineer", "kind": "work", "signal": 4}], "profile": "Name: John\\nWork: software engineer"}

Existing facts: [3] Sister Aru lives in Almaty (person, 2026-11-04)
Conversation: user: big news, Aru moved to Astana last weekend!
Output: {"ops": [{"op": "UPDATE", "text": "Sister Aru lives in Astana", "kind": "person", "signal": 5, "target_id": 3}], "profile": "Name: Dana\\nLives in London (Europe/London)\\nSister: Aru, lives in Astana"}

Now: Tuesday 2026-11-10 10:00
Conversation: user: got an interview at Monzo thursday next week at 2pm!!
Output: {"ops": [{"op": "ADD", "text": "Job interview at Monzo on 2026-11-19 14:00", "kind": "plan", "signal": 4, "event_date": "2026-11-19 14:00"}], "profile": "Name: Dana\\nWork: job hunting, interview at Monzo on 2026-11-19 14:00"}

Existing facts: [7] Likes cheese pizza (preference, 2026-10-02)
Conversation: user: honestly I can't stand cheese pizza anymore
Output: {"ops": [{"op": "UPDATE", "text": "Dislikes cheese pizza", "kind": "preference", "signal": 4, "target_id": 7}], "profile": "Name: Dana\\nFood: dislikes cheese pizza"}

Existing facts: [2] Is vegetarian (identity, 2026-10-01)
Conversation: user: as a vegetarian I love this place
Output: {"ops": []}

Existing facts: [5] Has a dog named Biscuit (person, 2026-10-20)
Conversation: user: please forget about my dog
Output: {"ops": [{"op": "DELETE", "text": "Has a dog named Biscuit", "kind": "person", "signal": 5, "target_id": 5}], "profile": "Name: Sam\\nWork: nurse in Leeds"}

Conversation: user: just moved to Lisbon for good!
Output: {"ops": [{"op": "ADD", "text": "Lives in Lisbon", "kind": "identity", "signal": 5}], "profile": "Name: Dana\\nLives in Lisbon (Europe/Lisbon)", "timezone": "Europe/Lisbon"}

The other fields:
- profile: only when your ops change something (an ADD or UPDATE with signal 3 or more, or a DELETE); otherwise null. Then return the whole new profile: at most 300 tokens, plain lines without markdown, the most important stable facts: name, where they live and time zone, key people, work, standing preferences. Start from the current profile, keep what still holds, and drop what was superseded or forgotten.
- media_note: only when the person sent an image in this turn and it matters later: one line on what it shows ("photo of her new red road bike"). Otherwise null.
- timezone: only when the person states, in this turn, the city or time zone they live in or are staying in: its IANA id ("Europe/Lisbon"). Otherwise null. Store the city as an identity fact too.

Remember:
- Take facts only from the conversation, never from the profile, the existing facts or these examples.
- Facts are about the person and the people in their life, never about the assistant.
- Anything the person asked to forget is never stored again.
- If nothing is worth storing, return {"ops": []}.`;

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const json = (xs: unknown[]) => JSON.stringify(xs);
const tzOf = (db: Db) => db.all<{ timezone: string | null }>("SELECT timezone FROM contact")[0]?.timezone || "UTC";
const day = (ts: number, tz: string) => formatLocal(ts, tz).slice(0, 10);
const eventDate = (s: string | null | undefined) => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(s ?? "");
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : null;
};

/** Brute-force dot product (vectors are L2-normalised). Facts: every stored row, superseded included, unless activeOnly. */
export function cosineTopN(db: Db, q: Float32Array, n: number, table: "facts" | "insights", activeOnly = false): { id: number; score: number }[] {
  const where = table === "insights" || activeOnly ? "status='active'" : "status!='deleted'";
  return db.all<{ id: number; embedding: Uint8Array }>(`SELECT id, embedding FROM ${table} WHERE ${where} AND embedding IS NOT NULL`)
    .map((r) => ({ id: r.id, v: blobToVec(r.embedding) }))
    .filter((r) => r.v.length === q.length)
    .map((r) => ({ id: r.id, score: dot(r.v, q) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

export function cascadeInsights(db: Db, factIds: number[]): void {
  if (!factIds.length) return;
  db.run("DELETE FROM insights WHERE EXISTS (SELECT 1 FROM json_each(insights.evidence_fact_ids) WHERE value IN (SELECT value FROM json_each(?)))", json(factIds));
}

export function profileText(db: Db): string {
  return db.all<{ text: string | null }>("SELECT text FROM profile")[0]?.text ?? "";
}

function setProfile(db: Db, text: string, now: number): void {
  db.run("INSERT INTO profile(id, text, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at", text.slice(0, PROFILE_CHARS), now);
}

function dropFacts(db: Db, ids: number[]): void {
  if (!ids.length) return;
  db.run("DELETE FROM facts WHERE id IN (SELECT value FROM json_each(?))", json(ids));
  db.run("DELETE FROM facts_fts WHERE fact_id IN (SELECT value FROM json_each(?))", json(ids));
  cascadeInsights(db, ids);
}

// "Now: Wednesday 2026-11-04 10:00 (zone)" plus two weeks of weekday-dated days, so "thursday next week" needs no arithmetic.
function dateContext(nowLocal: string, tz: string): string {
  const d0 = Date.parse(nowLocal.slice(0, 10));
  const wd = (t: number, weekday: "long" | "short") => new Date(t).toLocaleDateString("en-US", { weekday, timeZone: "UTC" });
  const days = Array.from({ length: 14 }, (_, i) => `${wd(d0 + i * DAY, "short")} ${new Date(d0 + i * DAY).toISOString().slice(0, 10)}${i ? "" : " (today)"}`);
  return `Now: ${wd(d0, "long")} ${nowLocal} (${tz})\nCalendar: ${days.join(", ")}`;
}

export async function remember(deps: Deps, turn: TurnForMemory): Promise<{ added: number; updated: number; deleted: number }> {
  const out = { added: 0, updated: 0, deleted: 0 };
  const { db, clock, features, models, llm } = deps;
  if (!features.memory) return out;
  const userText = turn.messages.filter((m) => m.role === "user").map((m) => m.text).join("\n").trim();
  const anyFacts = db.all("SELECT 1 FROM facts WHERE status='active' LIMIT 1").length > 0;
  const similar = userText && anyFacts ? cosineTopN(db, (await deps.embed([userText]))[0], 10, "facts", true) : [];
  const rows = new Map(db.all<{ id: number; text: string; kind: string; created_at: number }>("SELECT id, text, kind, created_at FROM facts WHERE id IN (SELECT value FROM json_each(?))", json(similar.map((s) => s.id))).map((r) => [r.id, r]));
  const known = similar.map((s) => rows.get(s.id)!);

  const input = [
    dateContext(turn.nowLocal, turn.tz),
    `Current profile:\n${profileText(db) || "(empty)"}`,
    `Existing facts (most similar first):\n${known.map((f) => `[${f.id}] ${f.text} (${f.kind}, ${day(f.created_at, turn.tz)})`).join("\n") || "(none)"}`,
    `Conversation (this turn):\n${turn.messages.map((m) => `${m.role}: ${m.text}`).join("\n")}`,
  ].join("\n\n");
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: input }, ...turn.images.map((i) => ({ type: "file" as const, mediaType: i.mime, data: i.bytes }))] }];
  const { value } = await llm.object({ job: "extract", modelId: models.extract, system: EXTRACT_PROMPT, messages, schema: ExtractSchema, reasoning: reasoningFor(models.extract, EFFORT.extract), sessionId: turn.sessionId });

  const now = clock.now();
  const shown = new Set(known.map((f) => f.id)); // the extractor may only touch facts it was shown, each once
  const ops = value.ops.filter((o) => o.op === "DELETE" || (o.op !== "NONE" && o.signal >= PERSIST));
  const writes = ops.filter((o) => o.op !== "DELETE" && o.text.trim());
  const vecs = writes.length ? await deps.embed(writes.map((o) => o.text.trim())) : [];
  const source = json(turn.messages.filter((m) => m.role === "user").map((m) => m.id));
  const superseded: number[] = [];
  writes.forEach((o, i) => {
    const id = db.all<{ id: number }>("INSERT INTO facts(text, kind, signal, created_at, event_date, source_message_ids, embedding) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      o.text.trim(), o.kind, o.signal, now, eventDate(o.event_date), source, vecToBlob(vecs[i]))[0].id;
    db.run("INSERT INTO facts_fts(text, fact_id) VALUES (?, ?)", o.text.trim(), id);
    if (o.op === "UPDATE" && o.target_id != null && shown.delete(o.target_id)) {
      db.run("UPDATE facts SET status='superseded', superseded_by=? WHERE id=?", id, o.target_id);
      superseded.push(o.target_id);
      out.updated++;
    } else out.added++;
  });
  cascadeInsights(db, superseded);
  const deleted = ops.filter((o) => o.op === "DELETE" && o.target_id != null && shown.delete(o.target_id)).map((o) => o.target_id!);
  dropFacts(db, deleted);
  out.deleted = deleted.length;

  const profile = value.profile?.trim() ?? "";
  if (profile.length >= 5 && out.added + out.updated + out.deleted > 0) setProfile(db, profile, now); // not a placeholder, and something changed
  const note = value.media_note?.trim();
  if (note && turn.images[0]) db.run("UPDATE messages SET media_note=? WHERE id=?", note, turn.images[0].messageId);
  if (value.timezone) {
    try {
      const zone = new Intl.DateTimeFormat(undefined, { timeZone: value.timezone }).resolvedOptions().timeZone;
      const c = db.all<{ timezone: string | null; timezone_confirmed: number }>("SELECT timezone, timezone_confirmed FROM contact")[0];
      const old = c?.timezone || "UTC";
      if (zone !== old && !c?.timezone_confirmed) rezoneReminders(db, old, zone, now); // only a guessed zone was wrong; a traveller's confirmed one was not
      db.run("UPDATE contact SET timezone=?, timezone_confirmed=1", zone);
    } catch { /* not an IANA zone: keep the current one */ }
  }
  return out;
}

type Candidate = { kind: "fact" | "insight"; id: number; text: string; status: string; created_at: number; shown_at: number; confidence: number | null };

export async function recall(deps: Deps, query: string, k = 12): Promise<{ hits: MemoryHit[]; ms: number }> {
  const q = query.trim();
  if (!q) return { hits: [], ms: 0 };
  const t0 = performance.now();
  try {
    const { db, clock, features } = deps;
    const hybrid = features.retrieval === "hybrid";
    const [v] = await deps.embed([q]);
    const cos = new Map<string, number>();
    const top = [...cosineTopN(db, v, Infinity, "facts").map((s) => ({ ...s, key: `fact:${s.id}` })), ...cosineTopN(db, v, Infinity, "insights").map((s) => ({ ...s, key: `insight:${s.id}` }))]
      .sort((a, b) => b.score - a.score).slice(0, hybrid ? 30 : Infinity);
    for (const s of top) cos.set(s.key, s.score);
    const factIds = top.filter((s) => s.key.startsWith("fact:")).map((s) => s.id);
    const insightIds = top.filter((s) => s.key.startsWith("insight:")).map((s) => s.id);
    // Embeddings are weak on exact names: add the facts that FTS finds for the capitalised words and numbers.
    const terms = [...new Set(q.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => /^\p{Lu}|\p{N}/u.test(w));
    if (hybrid && terms.length)
      for (const r of db.all<{ fact_id: number }>("SELECT fact_id FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT 20", terms.map((w) => `"${w}"`).join(" OR ")))
        if (!factIds.includes(Number(r.fact_id))) factIds.push(Number(r.fact_id));

    const cands: Candidate[] = [
      ...db.all<Candidate>("SELECT 'fact' AS kind, f.id, f.text, f.status, f.created_at, coalesce(n.created_at, f.created_at) AS shown_at, NULL AS confidence FROM facts f LEFT JOIN facts n ON n.id = f.superseded_by WHERE f.id IN (SELECT value FROM json_each(?)) AND f.status != 'deleted'", json(factIds)),
      ...db.all<Candidate>("SELECT 'insight' AS kind, id, text, status, created_at, created_at AS shown_at, confidence FROM insights WHERE id IN (SELECT value FROM json_each(?))", json(insightIds)),
    ];
    const base = hybrid ? await deps.rerank(q, cands.map((c) => c.text)) : cands.map((c) => cos.get(`${c.kind}:${c.id}`) ?? 0);
    const now = clock.now(), tz = tzOf(db);
    const hits = cands.map((c, i): MemoryHit => ({
      id: c.id, kind: c.kind, text: c.text, date: day(c.shown_at, tz), // a superseded fact shows the day it stopped being true
      score: base[i] + RECENCY * Math.max(0, 1 - (now - c.created_at) / DAY / 365),
      status: c.status === "superseded" ? "superseded" : "active",
      ...(c.kind === "insight" ? { confidence: c.confidence ?? 0 } : {}),
    })).sort((a, b) => b.score - a.score).slice(0, k);
    return { hits, ms: performance.now() - t0 };
  } catch (e) {
    deps.log({ event: "recall_failed", error: e instanceof Error ? e.message : String(e) });
    return { hits: [], ms: performance.now() - t0 };
  }
}

export async function forget(deps: Deps, query: string): Promise<{ deleted: number; texts: string[] }> {
  const q = query.trim(), lq = q.toLowerCase();
  if (!q) return { deleted: 0, texts: [] };
  // Whole words only ("work" never hits "works"), and only for queries long enough to mean something.
  const words = q.length >= FORGET_MIN_CHARS ? new RegExp(`(?<![\\p{L}\\p{N}])${lq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u") : null;
  const mentions = (text: string) => !!words && words.test(text.toLowerCase());
  const { db } = deps;
  const lines = profileText(db).split("\n").filter((l) => l.trim());
  const [v, ...lineVecs] = await deps.embed([q, ...lines]);
  const near = (scores: number[]) => { const best = Math.max(0, ...scores); return scores.map((s) => s >= Math.max(FORGET_MIN, best - FORGET_MARGIN)); };

  const scored = cosineTopN(db, v, Infinity, "facts");
  const close = near(scored.map((s) => s.score));
  const ids = new Set(scored.filter((_, i) => close[i]).map((s) => s.id));
  const facts = db.all<{ id: number; text: string }>("SELECT id, text FROM facts ORDER BY id");
  for (const f of facts) if (mentions(f.text)) ids.add(f.id);
  dropFacts(db, [...ids]);

  // The profile is rewritten only by extraction; drop its matching lines now so the forgotten thing is gone from the next reply.
  const hit = near(lineVecs.map((u) => dot(u, v)));
  const kept = lines.filter((l, i) => !hit[i] && !mentions(l));
  if (kept.length < lines.length) setProfile(db, kept.join("\n"), deps.clock.now());
  return { deleted: ids.size, texts: facts.filter((f) => ids.has(f.id)).map((f) => f.text) }; // the texts tell the reply model what is now off limits
}
