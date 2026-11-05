import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { MAX_WAIT_MS } from "../src/core/cadence";
import { ContactCore } from "../src/core/contact";
import { fromNode, migrate, vecToBlob } from "../src/core/db";
import type { Clock, Deps, Features, Inbound, Llm, ModelChoice, ObjectCall, StreamCall, Usage, WaClient } from "../src/core/types";
import { MODELS, pickModels } from "../src/models";
import { WaError } from "../src/whatsapp";
import { judge, judgeFacts } from "./judge";

export type ClockView = Clock & { alarmAt: number | null };

/** One shared fake time; each contact gets its own alarm slot. `sleep` advances the shared time. */
export class FakeClock {
  t: number;
  private views = new Map<string, ClockView>();
  constructor(t = Date.UTC(2026, 10, 4, 9, 0)) { this.t = t; }
  forContact(id: string): ClockView {
    let view = this.views.get(id);
    if (!view) {
      const v: ClockView = {
        alarmAt: null,
        now: () => this.t,
        sleep: async (ms) => { this.t += Math.max(0, ms); },
        setAlarm: (at) => { v.alarmAt = at; },
      };
      this.views.set(id, (view = v));
    }
    return view;
  }
}

export interface Sent { at: number; kind: "text" | "reaction" | "typing"; to: string; body?: string; quote?: string; previewUrl?: boolean; target?: string; emoji?: string; id: string }

export class FakeWa implements WaClient {
  sent: Sent[] = [];
  media = new Map<string, { bytes: Uint8Array; mime: string }>();
  failNext?: WaError;
  private clock: FakeClock;
  private n = 0;
  constructor(clock: FakeClock) { this.clock = clock; }
  private rec(e: Omit<Sent, "at" | "id">): string {
    const id = `wamid.out.${++this.n}`;
    this.sent.push({ ...e, at: this.clock.t, id });
    return id;
  }
  async sendText(to: string, body: string, opts?: { quote?: string; previewUrl?: boolean }) {
    const e = this.failNext;
    if (e) { this.failNext = undefined; throw e; }
    return { id: this.rec({ kind: "text", to, body, previewUrl: opts?.previewUrl ?? false, ...(opts?.quote ? { quote: opts.quote } : {}) }) };
  }
  async sendReaction(to: string, messageId: string, emoji: string) { this.rec({ kind: "reaction", to, target: messageId, emoji }); }
  async markReadTyping(messageId: string) { this.rec({ kind: "typing", to: "", target: messageId }); }
  async fetchMedia(mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new WaError(0, 404, `media ${mediaId}: 404`);
    return m;
  }
}

const zeroUsage = (job: string, model: string): Usage => ({ job, model, input: 0, output: 0, cached: 0, reasoning: 0, costTable: 0, ms: 0 });

/** A reply hook result: the full text, or chunks followed by a stream error (text throws after them, done rejects). */
export type StubReply = string | { chunks: string[]; error: Error };

/** Canned line-format replies, streamed line by line; honours abortSignal and errors like the real stream. */
export function stubLlm(o: {
  reply?: (call: StreamCall) => StubReply | Promise<StubReply>;
  object?: (call: ObjectCall<unknown>) => unknown;
} = {}): Llm & { calls: StreamCall[]; objectCalls: ObjectCall<unknown>[] } {
  const calls: StreamCall[] = [];
  const objectCalls: ObjectCall<unknown>[] = [];
  return {
    calls,
    objectCalls,
    stream(call) {
      calls.push(call);
      const reply = Promise.resolve().then((): StubReply | Promise<StubReply> => (o.reply ? o.reply(call) : "react: none\nok"));
      let resolve!: (v: Usage & { ttftMs: number; finishReason: string }) => void, reject!: (e: unknown) => void;
      const done = new Promise<Usage & { ttftMs: number; finishReason: string }>((res, rej) => { resolve = res; reject = rej; });
      done.catch(() => {});
      const aborted = () => call.abortSignal?.reason ?? new DOMException("aborted", "AbortError");
      async function* text() {
        try {
          const r = await reply;
          for (const chunk of typeof r === "string" ? r.split(/(?<=\n)/) : r.chunks) {
            if (call.abortSignal?.aborted) throw aborted();
            yield chunk;
          }
          if (typeof r !== "string") throw r.error;
          resolve({ ...zeroUsage(call.job, call.modelId), ttftMs: 0, finishReason: "stop" });
        } catch (e) {
          reject(e);
          throw e;
        } finally {
          reject(aborted()); // consumer stopped early; no-op once settled
        }
      }
      return { text: text(), done };
    },
    async object<T>(call: ObjectCall<T>) {
      objectCalls.push(call as ObjectCall<unknown>);
      if (!o.object) throw new Error("stubLlm: no object hook");
      return { value: (await o.object(call as ObjectCall<unknown>)) as T, usage: zeroUsage(call.job, call.modelId) };
    },
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Deterministic bag-of-words embedding: each word hashed into 64 dims, L2-normalised. */
export async function hashEmbed(texts: string[]): Promise<Float32Array[]> {
  return texts.map((t) => {
    const v = new Float32Array(64);
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[fnv1a(w) % 64] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

export async function cosineRerank(query: string, docs: string[]): Promise<number[]> {
  const [q, ...d] = await hashEmbed([query, ...docs]);
  return d.map((v) => v.reduce((s, x, i) => s + x * q[i], 0));
}

export function makeEvalDeps(o: {
  clock: Clock; wa: FakeWa; llm: Llm; features?: Partial<Features>; models?: Partial<ModelChoice>;
  embed?: Deps["embed"]; rerank?: Deps["rerank"]; transcribe?: Deps["transcribe"]; snapshot?: Deps["snapshot"];
}): Deps {
  const db = fromNode(new DatabaseSync(":memory:"));
  migrate(db);
  const log = () => {};
  // Same ledger as makeDeps' makeLlm hook, wrapped here because the Llm arrives already built.
  const ledger = (u: Usage) => { db.run("INSERT INTO calls(at, job, model, usage) VALUES (?,?,?,?)", o.clock.now(), u.job, u.model, JSON.stringify(u)); };
  const llm: Llm = {
    stream(call) {
      const r = o.llm.stream(call);
      r.done.then(ledger, () => {});
      return r;
    },
    async object(call) {
      const r = await o.llm.object(call);
      ledger(r.usage);
      return r;
    },
  };
  return {
    db, clock: o.clock, wa: o.wa, llm,
    embed: o.embed ?? hashEmbed,
    rerank: o.rerank ?? cosineRerank,
    transcribe: o.transcribe ?? (async () => "(voice)"),
    snapshot: o.snapshot ?? (async () => null),
    models: { ...pickModels({}), ...o.models },
    features: { memory: false, retrieval: "hybrid", ...o.features },
    log,
  };
}

/** Fire the contact's pending alarm while it is due by `until` (at most 10 passes). */
export async function drain(core: ContactCore, view: ClockView, clock: FakeClock, until: number): Promise<void> {
  for (let i = 0; i < 10 && view.alarmAt !== null && view.alarmAt <= until; i++) {
    clock.t = Math.max(clock.t, view.alarmAt);
    view.alarmAt = null;
    await core.alarm();
  }
}

// Task 8 switches this to embedViaRest/rerankViaRest when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set.
export function evalEmbedders(_env: NodeJS.ProcessEnv): { embed: Deps["embed"]; rerank: Deps["rerank"] } {
  return { embed: hashEmbed, rerank: cosineRerank };
}

// ---- Scenarios ----

export interface EvalConfig { reply?: string; extract?: string; derive?: string; effort?: "low" | "medium" | "high"; memory: boolean; retrieval: "cosine" | "hybrid"; filter?: string; tag: string }

export function evalConfig(): EvalConfig {
  const e = process.env, d = pickModels({});
  const pick = (v: string | undefined) => {
    if (v && !MODELS[v]) throw new Error(`unknown model ${v} (see src/models.ts)`);
    return v || undefined;
  };
  const effort = (e.EVAL_EFFORT || undefined) as EvalConfig["effort"];
  if (effort && !["low", "medium", "high"].includes(effort)) throw new Error(`EVAL_EFFORT must be low, medium or high, got ${effort}`);
  const retrieval = (e.EVAL_RETRIEVAL || "hybrid") as EvalConfig["retrieval"];
  if (retrieval !== "cosine" && retrieval !== "hybrid") throw new Error(`EVAL_RETRIEVAL must be cosine or hybrid, got ${retrieval}`);
  const cfg = { reply: pick(e.EVAL_REPLY), extract: pick(e.EVAL_EXTRACT), derive: pick(e.EVAL_DERIVE), effort, memory: e.EVAL_MEMORY !== "0", retrieval, filter: e.EVAL_FILTER || undefined };
  const id = (m: string) => m.replaceAll("/", "_");
  const tag = [
    `reply=${id(cfg.reply ?? d.reply)}`, `memory=${cfg.memory ? 1 : 0}`, `retrieval=${retrieval}`,
    cfg.extract && cfg.extract !== d.extract && `extract=${id(cfg.extract)}`, cfg.derive && cfg.derive !== d.derive && `derive=${id(cfg.derive)}`, effort && `effort=${effort}`,
  ].filter(Boolean).join(",");
  return { ...cfg, tag };
}

export type Step =
  | { at: string; contact?: string; say?: string; image?: string; caption?: string; url?: string; quote?: number }
  | { fill: number }
  | { seed_facts: number }
  | { at: string; contact?: string; ask: string; gold: string; quote?: number; expect_contains?: string[]; expect_not_contains?: string[]; max_turns?: number }
  | { expect_facts: { count: number; gold: string[] } }
  | { expect_facts_not_contains: string[] }
  | { expect_insights: { min: number; evidence_count?: number } };
export interface Scenario { name: string; category: "short-term" | "long-term" | "derived" | "judgement" | "forget" | "isolation"; steps: Step[] }
export interface ProbeResult { ask: string; gold: string; answer: string; label: "correct" | "partial" | "wrong" | "hallucinated"; reason: string; ttftMs?: number; ttfbMs?: number; totalMs?: number }
export interface ScenarioResult { name: string; category: string; probes: ProbeResult[]; checks: { name: string; passed: boolean; detail: string }[]; transcript: string[]; turns: Record<string, unknown>[]; costUsd: number; costByJob: Record<string, number>; passed: boolean; at?: string }

const CATEGORIES = ["short-term", "long-term", "derived", "judgement", "forget", "isolation"];
// Keys each step kind may carry besides its own; `at` and `contact` are accepted on every step.
const KEYS: Record<string, string[]> = {
  say: ["quote"], image: ["caption", "quote"], url: ["quote"], ask: ["gold", "quote", "expect_contains", "expect_not_contains", "max_turns"],
  fill: [], seed_facts: [], expect_facts: [], expect_facts_not_contains: [], expect_insights: [],
};
const MESSAGE_KINDS = ["say", "ask", "image", "url"];
const isInt = (x: unknown, min: number): x is number => Number.isInteger(x) && (x as number) >= min;

function stepProblem(s: unknown, n: number): string {
  if (typeof s !== "object" || s === null) return "is not a mapping";
  const r = s as Record<string, unknown>, kinds = Object.keys(KEYS).filter((k) => k in r), kind = kinds[0];
  if (kinds.length !== 1) return `needs exactly one of ${Object.keys(KEYS).join(", ")}`;
  const unknown = Object.keys(r).find((k) => k !== kind && k !== "at" && k !== "contact" && !KEYS[kind].includes(k));
  if (unknown) return `unknown key "${unknown}" for ${kind}`;
  if (MESSAGE_KINDS.includes(kind) && r.at === undefined) return `${kind} needs at`;
  if (r.at !== undefined) try { parseAt(String(r.at), 0); } catch (e) { return (e as Error).message; }
  if (kind === "ask" && typeof r.gold !== "string") return "ask needs gold";
  for (const k of ["expect_contains", "expect_not_contains"])
    if (k in r && !(Array.isArray(r[k]) && r[k].length > 0 && r[k].every((x) => typeof x === "string"))) return `${k} must be a non-empty list of strings`;
  if ("quote" in r && !(isInt(r.quote, 1) && r.quote < n)) return `quote must be an earlier step number (1..${n - 1})`;
  if ("max_turns" in r && !isInt(r.max_turns, 1)) return "max_turns must be a positive integer";
  return "";
}

export function loadScenarios(dir: string, filter?: string): Scenario[] {
  const re = filter ? new RegExp(filter) : null;
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => {
    const sc = parse(readFileSync(join(dir, f), "utf8")) as Scenario | null;
    const problem = !sc || typeof sc.name !== "string" || !CATEGORIES.includes(sc.category) || !Array.isArray(sc.steps) ? "needs name, category and steps"
      : sc.steps.map((s, i) => { const p = stepProblem(s, i + 1); return p && `step ${i + 1}: ${p}`; }).find(Boolean);
    if (problem) throw new Error(`${f}: ${problem}`);
    return sc!;
  }).filter((sc) => !re || re.test(sc.name));
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 };

/** `+10s`, `+31 min`, `+1d 2h` (from the scenario start), `day 4` (= +3d) or an ISO time. */
export function parseAt(at: string, t0: number): number {
  const s = String(at).trim(), bad = () => new Error(`bad at "${at}": use +10s, +31 min, +1d 2h, day 4 or an ISO time`);
  const day = /^day\s+(\d+)$/i.exec(s);
  if (day) return t0 + (Number(day[1]) - 1) * UNIT_MS.d;
  if (s.startsWith("+")) {
    let ms = 0;
    const rest = s.slice(1).replace(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi, (_, n: string, u: string) => {
      if (!UNIT_MS[u.toLowerCase()]) throw bad();
      ms += Number(n) * UNIT_MS[u.toLowerCase()];
      return "";
    });
    if (rest.trim()) throw bad();
    return t0 + ms;
  }
  const abs = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) ? Date.parse(s) : NaN;
  if (Number.isNaN(abs)) throw bad();
  return abs;
}

const T0 = Date.UTC(2026, 10, 4, 15, 0); // Wednesday 10:00 in New York, the zone of the +1 test numbers
const FILL: [string, string][] = [["ok", "sure"], ["haha yeah", "😄"], ["brb", "take your time"], ["back", "welcome back"], ["lol", "right?"], ["anyway", "go on"], ["true", "yep"], ["nice", "🙌"]];
const SEED_FACTS: [string, string][] = [
  ["Likes espresso", "preference"], ["Colleague Dana works in sales", "person"], ["Plays five-a-side football on Wednesdays", "routine"], ["Has a dog named Biscuit", "person"],
  ["Prefers window seats on flights", "preference"], ["Works as a product designer", "work"], ["Is learning Spanish on Duolingo", "routine"], ["Allergic to cats", "identity"],
  ["Favourite band is Radiohead", "preference"], ["Brother Tom is a nurse", "person"], ["Lives in a flat on the fourth floor", "place"], ["Drinks oat milk", "preference"],
  ["Bikes to work when it is dry", "routine"], ["Best friend Priya lives in Toronto", "person"], ["Hates horror films", "preference"], ["Reads before bed every night", "routine"],
  ["Manager is called Oliver", "work"], ["Grew up near the sea", "identity"], ["Owns a green Vespa", "other"], ["Does yoga on Sunday mornings", "routine"],
  ["Likes spicy ramen", "preference"], ["Mother is a retired teacher", "person"], ["Uses a standing desk", "work"], ["Supports Arsenal", "preference"],
  ["Is saving for a sailing trip", "other"], ["Cousin Mira just had a baby", "person"], ["Gym is around the corner from home", "place"], ["Prefers tea in the afternoon", "preference"],
  ["Team ships a release every two weeks", "work"], ["Plays chess online most evenings", "routine"], ["Neighbour Ken waters the plants when away", "person"], ["Favourite city break was Porto", "place"],
  ["Is left-handed", "identity"], ["Bakes sourdough on weekends", "routine"], ["Dislikes coriander", "preference"], ["Office is near the river", "place"],
  ["Has two houseplants named Fern and Frank", "other"], ["Uncle Sam runs a bakery", "person"], ["Takes the 8:10 train", "routine"], ["Wants to learn to surf", "other"],
];

interface Contact { id: string; phone: string; view: ClockView; wa: FakeWa; deps: Deps; core: ContactCore; shown: number; shownTurn: number }
type MessageStep = { at: string; contact?: string; say?: string; ask?: string; image?: string; caption?: string; url?: string; quote?: number };

/**
 * Feeds a scenario through the real ContactCore on one fake clock. A step with `at` (any kind, though only messages
 * need one) first drains every core up to it, so a burst stays a burst; an ask's own turn, and every non-message step,
 * then let pending turns finish.
 */
export async function runScenario(sc: Scenario, cfg: EvalConfig, realLlm: Llm, embedders = evalEmbedders(process.env)): Promise<ScenarioResult> {
  const clock = new FakeClock(T0);
  const features: Features = { memory: cfg.memory, retrieval: cfg.retrieval, replyEffort: cfg.effort };
  const models = pickModels({ MODEL_REPLY: cfg.reply, MODEL_EXTRACT: cfg.extract, MODEL_DERIVE: cfg.derive });
  const contacts = new Map<string, Contact>();
  const contact = (id: string): Contact => {
    let c = contacts.get(id);
    if (!c) {
      if (!/^[a-z]$/.test(id)) throw new Error(`${sc.name}: contact ids are single letters, got "${id}"`);
      const view = clock.forContact(id), wa = new FakeWa(clock);
      const deps = makeEvalDeps({ clock: view, wa, llm: realLlm, features, models, ...embedders });
      contacts.set(id, (c = { id, phone: "1555" + String(id.charCodeAt(0) - 96).padStart(7, "0"), view, wa, deps, core: new ContactCore(deps), shown: 0, shownTurn: 0 }));
    }
    return c;
  };

  const transcript: string[] = [];
  const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
  const flush = () => { // the bots' sends and failed turns since the last flush, in time order
    const out: { at: number; line: string }[] = [];
    for (const c of contacts.values()) {
      for (const s of c.wa.sent.slice(c.shown)) {
        if (s.kind === "text") out.push({ at: s.at, line: `bot → ${c.id}: ${s.body}` });
        if (s.kind === "reaction") out.push({ at: s.at, line: `bot → ${c.id}: (reacted ${s.emoji})` });
      }
      c.shown = c.wa.sent.length;
      // A failed turn is stamped at its last bubble, or its start when it sent nothing.
      for (const t of c.deps.db.all<{ id: number; at: number; error: string | null }>("SELECT id, coalesce((SELECT max(ts) FROM messages WHERE turn_id=turns.id AND direction='out'), started_at) AS at, error FROM turns WHERE id > ? ORDER BY id", c.shownTurn)) {
        if (t.error) out.push({ at: t.at, line: `bot → ${c.id}: (turn error: ${t.error})` });
        c.shownTurn = t.id;
      }
    }
    for (const o of out.sort((x, y) => x.at - y.at)) transcript.push(`[${stamp(o.at)}] ${o.line}`);
  };
  const note = (line: string) => { flush(); transcript.push(`[${stamp(clock.t)}] ${line}`); };
  const hasPending = (c: Contact) => c.deps.db.all("SELECT 1 FROM messages WHERE direction='in' AND status='pending' LIMIT 1").length > 0;
  const settle = async (c: Contact) => { // 15 s windows, at most 5, while messages are unanswered (covers a 30 s retry)
    for (let i = 0, until = clock.t + MAX_WAIT_MS + 1; i < 5; i++, until += 15_000) {
      await drain(c.core, c.view, clock, until);
      if (!hasPending(c)) return;
    }
  };

  const probes: ProbeResult[] = [], checks: ScenarioResult["checks"] = [];
  let lastAt = -Infinity, last = "a";
  for (const [i, step] of sc.steps.entries()) {
    const n = i + 1, m = step as MessageStep;
    if (m.at !== undefined) {
      const T = parseAt(m.at, T0);
      if (T < lastAt) throw new Error(`${sc.name}: step ${n} at "${m.at}" is earlier than the step before it`);
      lastAt = T;
      for (const c of contacts.values()) await drain(c.core, c.view, clock, T);
      clock.t = Math.max(clock.t, T);
    }
    if (m.say !== undefined || m.ask !== undefined || m.image !== undefined || m.url !== undefined) {
      const c = contact((last = m.contact ?? "a"));
      const text = m.image !== undefined ? m.caption ?? "[photo]" : m.ask ?? m.say ?? m.url ?? "";
      const msg: Inbound = { id: `wamid.${n}`, from: c.phone, ts: clock.t, kind: "text", text, ...(m.quote ? { quotedId: `wamid.${m.quote}` } : {}) };
      if (m.image !== undefined) {
        Object.assign(msg, { kind: "image", mediaId: `media.${n}`, mime: "image/jpeg" });
        c.wa.media.set(`media.${n}`, { bytes: readFileSync(new URL(`./fixtures/${m.image}`, import.meta.url)), mime: "image/jpeg" });
      }
      flush();
      const context = transcript.slice(-12);
      note(`${c.id}: ${m.image !== undefined ? `[photo ${m.image}] ` : ""}${m.quote ? `(replying to step ${m.quote}) ` : ""}${text}`);
      const mark = c.wa.sent.length;
      await c.core.ingest(msg);
      if ("ask" in step) {
        await settle(c);
        const answer = c.wa.sent.slice(mark).filter((s) => s.kind === "text").map((s) => s.body).join("\n");
        const turn = c.deps.db.all<Record<string, number | null>>("SELECT ttft_ms, ttfb_ms, total_ms FROM turns WHERE started_at >= ? ORDER BY id DESC LIMIT 1", msg.ts)[0];
        const turns = c.deps.db.all<{ n: number }>("SELECT count(*) AS n FROM turns")[0].n;
        const verdict = step.max_turns !== undefined && turns > step.max_turns
          ? { label: "wrong" as const, reason: `turns=${turns} > max_turns=${step.max_turns}` }
          : await score(realLlm, step, answer, context);
        probes.push({ ask: step.ask, gold: step.gold, answer, ...verdict, ttftMs: turn?.ttft_ms ?? undefined, ttfbMs: turn?.ttfb_ms ?? undefined, totalMs: turn?.total_ms ?? undefined });
      }
      continue;
    }

    for (const c of contacts.values()) await settle(c);
    const c = contact((step as { contact?: string }).contact ?? last), { db } = c.deps;
    if ("fill" in step) {
      const start = clock.t;
      note(`(${step.fill} canned message pairs, one a minute, until ${stamp(start + 120_000 * step.fill)})`);
      for (let k = 0; k < 2 * step.fill; k++) {
        const pair = FILL[Math.floor(k / 2) % FILL.length];
        db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES (?, ?, 'text', ?, ?, 'handled')", `fill.${n}.${k}`, k % 2 ? "out" : "in", pair[k % 2], start + 60_000 * (k + 1));
      }
      clock.t = start + 120_000 * step.fill;
    } else if ("seed_facts" in step) {
      if (step.seed_facts > SEED_FACTS.length) throw new Error(`${sc.name}: seed_facts is at most ${SEED_FACTS.length}`);
      const seeds = SEED_FACTS.slice(0, step.seed_facts);
      const vecs = seeds.length ? await c.deps.embed(seeds.map(([t]) => t)) : [];
      seeds.forEach(([text, kind], k) => {
        const id = db.all<{ id: number }>("INSERT INTO facts(text, kind, signal, created_at, source_message_ids, embedding) VALUES (?, ?, 3, ?, '[]', ?) RETURNING id", text, kind, clock.t, vecToBlob(vecs[k]))[0].id;
        db.run("INSERT INTO facts_fts(text, fact_id) VALUES (?, ?)", text, id);
      });
      note(`(${seeds.length} unrelated facts seeded into ${c.id}'s memory)`);
    } else if ("expect_facts" in step) {
      const { count, gold } = step.expect_facts;
      const stored = db.all<{ text: string }>("SELECT text FROM facts WHERE status='active' ORDER BY id").map((r) => r.text);
      const { matched, junk } = stored.length ? await judgeFacts(realLlm, { gold, stored }) : { matched: 0, junk: 0 };
      checks.push({ name: "expect_facts", passed: stored.length === count && matched === gold.length && junk === 0, detail: `${stored.length} active facts (want ${count}), ${matched}/${gold.length} gold matched, ${junk} junk: ${stored.join(" | ")}` });
    } else if ("expect_facts_not_contains" in step) {
      const texts = db.all<{ text: string }>("SELECT text FROM facts UNION ALL SELECT text FROM facts_fts UNION ALL SELECT text FROM insights").map((r) => r.text.toLowerCase());
      const found = step.expect_facts_not_contains.filter((x) => texts.some((t) => t.includes(x.toLowerCase())));
      checks.push({ name: "expect_facts_not_contains", passed: found.length === 0, detail: found.length ? `stored text contains ${found.map((x) => `"${x}"`).join(", ")}` : `${texts.length} stored texts, none contain ${step.expect_facts_not_contains.join(", ")}` });
    } else if ("expect_insights" in step) {
      const { min, evidence_count } = step.expect_insights;
      const rows = db.all<{ text: string; evidence_fact_ids: string | null }>("SELECT text, evidence_fact_ids FROM insights WHERE status='active'");
      const ok = rows.filter((r) => evidence_count === undefined || (JSON.parse(r.evidence_fact_ids ?? "[]") as unknown[]).length === evidence_count);
      checks.push({ name: "expect_insights", passed: ok.length >= min, detail: `${ok.length} active insights${evidence_count === undefined ? "" : ` citing ${evidence_count} facts`} (want ≥ ${min}): ${rows.map((r) => r.text).join(" | ")}` });
    }
  }
  for (const c of contacts.values()) await drain(c.core, c.view, clock, clock.t + MAX_WAIT_MS + 1); // a trailing say still gets its turn
  flush();

  const turns = [...contacts.values()].flatMap((c) => c.deps.db.all("SELECT * FROM turns ORDER BY id").map((r) => ({ contact: c.id, ...r })));
  const costByJob: Record<string, number> = {};
  for (const c of contacts.values())
    for (const r of c.deps.db.all<{ job: string; usage: string }>("SELECT job, usage FROM calls")) costByJob[r.job] = (costByJob[r.job] ?? 0) + (JSON.parse(r.usage) as Usage).costTable;
  return {
    name: sc.name, category: sc.category, probes, checks, transcript, turns, costByJob,
    costUsd: Object.values(costByJob).reduce((a, b) => a + b, 0),
    passed: probes.every((p) => p.label === "correct") && checks.every((c) => c.passed),
  };
}

/** String checks when the step has them (no judge call), else the judge with the conversation leading up to the ask. */
async function score(llm: Llm, s: { ask: string; gold: string; expect_contains?: string[]; expect_not_contains?: string[] }, answer: string, context: string[]): Promise<Pick<ProbeResult, "label" | "reason">> {
  if (!s.expect_contains && !s.expect_not_contains) return judge(llm, { question: `${context.join("\n")}\n\nQuestion: ${s.ask}`, gold: s.gold, answer });
  const a = answer.toLowerCase();
  const fails = [
    ...(s.expect_contains ?? []).filter((x) => !a.includes(x.toLowerCase())).map((x) => `missing "${x}"`),
    ...(s.expect_not_contains ?? []).filter((x) => a.includes(x.toLowerCase())).map((x) => `contains "${x}"`),
  ];
  return fails.length ? { label: "wrong", reason: fails.join("; ") } : { label: "correct", reason: "string checks passed" };
}
