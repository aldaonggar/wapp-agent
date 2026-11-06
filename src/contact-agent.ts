import { DurableObject } from "cloudflare:workers";
import { makeSearch, makeSnapshot } from "./browser";
import { ContactCore } from "./core/contact";
import { fromDO, migrate } from "./core/db";
import { getPage, setPageState } from "./core/pages";
import type { Db, Deps, Inbound } from "./core/types";
import { makeLlm } from "./llm";
import { pickModels, replyEffortFrom } from "./models";
import { makeTgClient, routeTransports } from "./telegram";
import { makeWaClient } from "./whatsapp";
import { embedViaBinding, rerankViaBinding, transcribeViaBinding, ttsViaBinding } from "./workers-ai";

export function makeDeps(env: Env, ctx: DurableObjectState, db: Db): Deps {
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
  return {
    db,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), setAlarm: (at) => (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)) },
    wa: routeTransports(makeWaClient({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }), makeTgClient({ token: env.TELEGRAM_BOT_TOKEN })),
    llm: makeLlm(env.OPENROUTER_API_KEY, {
      log: (u) => {
        log({ event: "call", ...u });
        db.run("INSERT INTO calls(at, job, model, usage) VALUES (?,?,?,?)", Date.now(), u.job, u.model, JSON.stringify(u));
      },
    }),
    embed: embedViaBinding(env.AI),
    rerank: rerankViaBinding(env.AI),
    transcribe: transcribeViaBinding(env.AI),
    tts: ttsViaBinding(env.AI),
    snapshot: makeSnapshot({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, log }),
    search: makeSearch({ apiKey: env.OPENROUTER_API_KEY, log }),
    models: pickModels(env),
    publicUrl: env.PUBLIC_URL,
    features: { memory: true, retrieval: "hybrid", replyEffort: replyEffortFrom(env.REPLY_EFFORT) },
    contactKey: ctx.id.toString(),
    log,
  };
}

/** One per contact (named by wa_id): owns the SQLite database and the alarm; all behaviour is in ContactCore. */
export class ContactAgent extends DurableObject<Env> {
  private core: ContactCore;
  private db: Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = fromDO(ctx.storage.sql);
    void ctx.blockConcurrencyWhile(async () => migrate(db));
    this.db = db;
    this.core = new ContactCore(makeDeps(env, ctx, db));
  }

  ingest(m: Inbound): Promise<void> { return this.core.ingest(m); }

  alarm(): Promise<void> { return this.core.alarm(); }

  page(id: string): { html: string; title: string } | null { return getPage(this.db, id); }

  setPageState(id: string, checked: number[]): boolean { return setPageState(this.db, id, checked); }
}
