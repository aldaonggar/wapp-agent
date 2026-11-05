import { expect, test, vi } from "vitest";
import { FakeClock, FakeWa, drain, makeEvalDeps, stubLlm } from "../../evals/harness";
import { WaError } from "../whatsapp";
import { bubblePauseMs } from "./cadence";
import { ContactCore } from "./contact";
import type { Features, Inbound, ObjectCall, StreamCall } from "./types";

const FROM = "15550000001";
type State = { turn_due: number | null; insights_due: number | null; followup_due: number | null; burst_started_at: number | null; generation: number; turn_attempts: number };

function setup(o: { reply?: (c: StreamCall) => string | Promise<string>; object?: (c: ObjectCall<unknown>) => unknown; features?: Partial<Features> } = {}) {
  const clock = new FakeClock();
  const view = clock.forContact(FROM);
  const wa = new FakeWa(clock);
  const llm = stubLlm({ reply: o.reply, object: o.object });
  const deps = makeEvalDeps({ clock: view, wa, llm, features: o.features });
  const core = new ContactCore(deps);
  const { db } = deps;
  let n = 0;
  const say = (text: string, extra: Partial<Inbound> = {}) =>
    core.ingest({ id: `wamid.in.${++n}`, from: FROM, ts: clock.t, kind: "text", text, ...extra });
  const state = () => db.all<State>("SELECT * FROM state")[0];
  const rows = (where: string) => db.all<{ id: string; status: string; text: string; quoted_id: string | null; reactions: string | null }>(`SELECT * FROM messages WHERE ${where} ORDER BY ts, rowid`);
  const turns = () => db.all<{ ttfb_ms: number | null; total_ms: number; regenerated: number; error: string | null; bubbles: number }>("SELECT * FROM turns");
  const fire = async () => { clock.t = Math.max(clock.t, view.alarmAt!); view.alarmAt = null; await core.alarm(); };
  return { clock, view, wa, llm, core, db, say, state, rows, turns, fire, run: (until = clock.t + 60_000) => drain(core, view, clock, until) };
}

test("ingest same wamid twice stores one row and arms one alarm", async () => {
  const t = setup();
  const t0 = t.clock.t;
  const m: Inbound = { id: "wamid.in.x", from: FROM, ts: t0, kind: "text", text: "the movie was great" };
  await t.core.ingest(m);
  t.clock.t += 1000;
  await t.core.ingest(m);
  expect(t.rows("1")).toHaveLength(1);
  expect(t.view.alarmAt).toBe(t0 + 3000);
  expect(t.state().generation).toBe(1);
});

test("unfinished last message arms 8 s", async () => {
  const t = setup();
  await t.say("so basically...");
  expect(t.view.alarmAt).toBe(t.clock.t + 8000);
});

test("third message at +14 s is capped at burst + 15 s", async () => {
  const t = setup();
  const t0 = t.clock.t;
  await t.say("so basically...");
  t.clock.t = t0 + 7000;
  await t.say("the thing is,");
  t.clock.t = t0 + 14_000;
  await t.say("ok");
  expect(t.view.alarmAt).toBe(t0 + 15_000);
});

test("a reaction webhook never arms an alarm and lands in reactions JSON", async () => {
  const t = setup();
  t.db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES ('wamid.out.1', 'out', 'text', 'see you', ?, 'sent')", t.clock.t);
  await t.core.ingest({ id: "wamid.in.r", from: FROM, ts: t.clock.t, kind: "reaction", reaction: { messageId: "wamid.out.1", emoji: "❤️" } });
  expect(t.view.alarmAt).toBeNull();
  expect(t.rows("1")).toHaveLength(1);
  expect(JSON.parse(t.rows("id = 'wamid.out.1'")[0].reactions!)).toEqual({ [FROM]: "❤️" });
  expect(t.state()).toMatchObject({ turn_due: null, generation: 0 });
});

test("runTurn sends reaction then bubbles with the pacing and marks pending handled", async () => {
  const t = setup({ reply: async () => { await new Promise((r) => setTimeout(r, 20)); return "react: #1 👍\nhi\n---\nsecond"; } });
  await t.say("the movie was great");
  await t.run();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "reaction", "text", "typing", "text"]);
  expect(t.wa.sent[1]).toMatchObject({ to: FROM, target: "wamid.in.1", emoji: "👍" });
  const texts = t.wa.sent.filter((s) => s.kind === "text");
  expect(texts.map((s) => s.body)).toEqual(["hi", "second"]);
  expect(texts[1].at - texts[0].at).toBe(bubblePauseMs(2));
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.rows("direction = 'out'").map((r) => [r.text, r.status])).toEqual([["hi", "sent"], ["second", "sent"]]);
  const turns = t.turns();
  expect(turns).toHaveLength(1);
  expect(turns[0].ttfb_ms).toBeGreaterThanOrEqual(0);
  expect(turns[0].total_ms).toBeGreaterThan(0);
  expect(turns[0].bubbles).toBe(2);
});

test("quote: #1 becomes opts.quote with the real wamid", async () => {
  const t = setup({ reply: () => "react: none\nquote: #1\nyes, that one" });
  await t.say("option one");
  t.clock.t += 1000;
  await t.say("option two");
  await t.run();
  expect(t.wa.sent.find((s) => s.kind === "text")).toMatchObject({ body: "yes, that one", quote: "wamid.in.1" });
  expect(t.rows("direction = 'out'")[0].quoted_id).toBe("wamid.in.1");
});

test("alias resolution ignores an unknown #n", async () => {
  const t = setup({ reply: () => "react: #9 👍\nquote: #7\nok" });
  await t.say("the movie was great");
  await t.run();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "text"]);
  expect(t.wa.sent[1].quote).toBeUndefined();
});

test("regenerates when a message arrives before the first bubble", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const t = setup({ reply: async () => { if (t.llm.calls.length === 1) await gate; return "react: none\nok"; } });
  await t.say("first thing");
  const turn = t.run();
  await vi.waitFor(() => expect(t.llm.calls).toHaveLength(1));
  await t.say("second thing");
  release();
  await turn;
  expect(t.wa.sent.filter((s) => s.kind === "text")).toHaveLength(1);
  expect(t.turns()).toHaveLength(1);
  expect(t.turns()[0].regenerated).toBe(1);
  expect(t.llm.calls[0].abortSignal?.aborted).toBe(true);
  const prompt = JSON.stringify(t.llm.calls[1].messages);
  expect(prompt).toContain("first thing");
  expect(prompt).toContain("second thing");
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled", "handled"]);
});

test("a WaError on send marks the outbound row failed and the turn completes", async () => {
  const t = setup();
  t.wa.failNext = new WaError(131047, 400, "Re-engagement message");
  await t.say("the movie was great");
  await expect(t.run()).resolves.toBeUndefined();
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.rows("direction = 'out'").map((r) => [r.text, r.status])).toEqual([["ok", "failed"]]);
  expect(t.turns()).toHaveLength(1);
  expect(t.view.alarmAt).toBeNull();
});

test("an llm error ends the turn cleanly", async () => {
  const t = setup({ reply: () => { throw new Error("upstream 500"); } });
  await t.say("the movie was great");
  await t.fire();
  const now = t.clock.t;
  expect(t.state()).toMatchObject({ turn_due: now + 30_000, turn_attempts: 1 });
  expect(t.view.alarmAt).toBe(now + 30_000);
  expect(t.rows("direction = 'in'")[0].status).toBe("pending");
  await t.fire();
  expect(t.rows("direction = 'in'")[0].status).toBe("handled");
  expect(t.turns()).toHaveLength(1);
  expect(t.turns()[0].error).toContain("upstream 500");
  expect(t.state()).toMatchObject({ turn_due: null, turn_attempts: 0 });
  expect(t.view.alarmAt).toBeNull();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "typing"]);
});

test("timers are consumed with memory off", async () => {
  const t = setup();
  await t.say("the movie was great");
  await t.run();
  expect(t.view.alarmAt).toBeNull();
  expect(t.state()).toMatchObject({ turn_due: null, insights_due: null, followup_due: null, burst_started_at: null });

  const m = setup({ features: { memory: true }, object: () => ({ ops: [] }) });
  await m.say("the movie was great");
  const lastInbound = m.clock.t;
  await m.run();
  expect(m.wa.sent.filter((s) => s.kind === "text")).toHaveLength(1);
  expect(m.view.alarmAt).toBe(lastInbound + 30 * 60_000);
});

test("a message arriving mid-turn opens a fresh burst", async () => {
  const t = setup();
  const send = t.wa.sendText.bind(t.wa);
  let itsTs = 0;
  t.wa.sendText = async (...a) => {
    const r = await send(...a);
    if (!itsTs) {
      t.clock.t += 12_000; // a slow model: the old burst's 15 s cap has passed
      itsTs = t.clock.t;
      await t.say("what about the price");
    }
    return r;
  };
  await t.say("the movie was great");
  await t.fire();
  expect(t.state()).toMatchObject({ turn_due: itsTs + 3000, burst_started_at: itsTs });
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled", "pending"]);
  await t.run();
  expect(t.turns()).toHaveLength(2);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled", "handled"]);
});

test("image at t, text at t+1 s: fetchMedia called once and the model gets one file part", async () => {
  const t = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  t.wa.media.set("media.1", { bytes: jpeg, mime: "image/jpeg" });
  const fetchMedia = vi.spyOn(t.wa, "fetchMedia");
  await t.say("[photo]", { kind: "image", mediaId: "media.1", mime: "image/jpeg" });
  t.clock.t += 1000;
  await t.say("what colour is it?");
  await t.run();
  expect(fetchMedia).toHaveBeenCalledTimes(1);
  const parts = t.llm.calls[0].messages.at(-1)!.content as { type: string }[];
  expect(parts.filter((p) => p.type === "file")).toEqual([{ type: "file", mediaType: "image/jpeg", data: jpeg }]);
});
