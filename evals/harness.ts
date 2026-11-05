import { DatabaseSync } from "node:sqlite";
import type { ContactCore } from "../src/core/contact";
import { fromNode, migrate } from "../src/core/db";
import type { Clock, Deps, Features, Llm, ModelChoice, ObjectCall, StreamCall, Usage, WaClient } from "../src/core/types";
import { pickModels } from "../src/models";
import { WaError } from "../src/whatsapp";

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
