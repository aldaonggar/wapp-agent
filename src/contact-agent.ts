import { DurableObject } from "cloudflare:workers";
import { ContactCore } from "./core/contact";
import { fromDO, migrate } from "./core/db";
import type { Db, Deps, Inbound } from "./core/types";
import { makeLlm } from "./llm";
import { pickModels } from "./models";
import { makeWaClient } from "./whatsapp";
import { embedViaBinding, rerankViaBinding, transcribeViaBinding } from "./workers-ai";

const notImplemented = () => Promise.reject(new Error("not implemented")); // snapshot: Task 11

export function makeDeps(env: Env, ctx: DurableObjectState, db: Db): Deps {
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
  return {
    db,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), setAlarm: (at) => (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)) },
    wa: makeWaClient({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }),
    llm: makeLlm(env.OPENROUTER_API_KEY, {
      log: (u) => {
        log({ event: "call", ...u });
        db.run("INSERT INTO calls(at, job, model, usage) VALUES (?,?,?,?)", Date.now(), u.job, u.model, JSON.stringify(u));
      },
    }),
    embed: embedViaBinding(env.AI),
    rerank: rerankViaBinding(env.AI),
    transcribe: transcribeViaBinding(env.AI),
    snapshot: notImplemented,
    models: pickModels(env),
    features: { memory: true, retrieval: "hybrid" },
    log,
  };
}

/** One per contact (named by wa_id): owns the SQLite database and the alarm; all behaviour is in ContactCore. */
export class ContactAgent extends DurableObject<Env> {
  private core: ContactCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = fromDO(ctx.storage.sql);
    void ctx.blockConcurrencyWhile(async () => migrate(db));
    this.core = new ContactCore(makeDeps(env, ctx, db));
  }

  ingest(m: Inbound): Promise<void> { return this.core.ingest(m); }

  alarm(): Promise<void> { return this.core.alarm(); }

  // Temporary CPU probe (Task 14 removes it): fixed work, since clocks are frozen during sync code.
  burn(n: number): { iterations: number; checksum: number } {
    let h = 0;
    for (let i = 0; i < n; i++) h = (Math.imul(h ^ i, 0x9e3779b1) + 0x7f4a7c15) | 0;
    return { iterations: n, checksum: h };
  }
}
