import { expect, test, vi } from "vitest";
import { FakeClock, FakeWa, drain, hashEmbed, makeEvalDeps, stubLlm } from "../../evals/harness";
import { WaError } from "../whatsapp";
import { bubblePauseMs } from "./cadence";
import { ContactCore } from "./contact";
import { vecToBlob } from "./db";
import type { Deps, Features, Inbound, ObjectCall, StreamCall } from "./types";

const FROM = "15550000001";
type State = { turn_due: number | null; insights_due: number | null; followup_due: number | null; burst_started_at: number | null; generation: number; turn_attempts: number };

type Reply = string | { chunks: string[]; error: Error };
function setup(o: { reply?: (c: StreamCall) => Reply | Promise<Reply>; object?: (c: ObjectCall<unknown>) => unknown; features?: Partial<Features>; snapshot?: Deps["snapshot"] } = {}) {
  const clock = new FakeClock();
  const view = clock.forContact(FROM);
  const wa = new FakeWa(clock);
  const llm = stubLlm({ reply: o.reply, object: o.object });
  const deps = makeEvalDeps({ clock: view, wa, llm, features: o.features, snapshot: o.snapshot });
  const core = new ContactCore(deps);
  const { db } = deps;
  let n = 0;
  const say = (text: string, extra: Partial<Inbound> = {}) =>
    core.ingest({ id: `wamid.in.${++n}`, from: FROM, ts: clock.t, kind: "text", text, ...extra });
  const state = () => db.all<State>("SELECT * FROM state")[0];
  const rows = (where: string) => db.all<{ id: string; status: string; text: string; quoted_id: string | null; reactions: string | null }>(`SELECT * FROM messages WHERE ${where} ORDER BY ts, rowid`);
  const turns = () => db.all<{ ttfb_ms: number | null; total_ms: number; regenerated: number; error: string | null; bubbles: number }>("SELECT * FROM turns");
  const fire = async () => { clock.t = Math.max(clock.t, view.alarmAt!); view.alarmAt = null; await core.alarm(); };
  return { clock, view, wa, llm, deps, core, db, say, state, rows, turns, fire, run: (until = clock.t + 60_000) => drain(core, view, clock, until) };
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
  expect(t.llm.calls[0].tools).toBeUndefined(); // memory off: no forget tool
  expect(t.db.all("SELECT recalled FROM turns")).toEqual([{ recalled: "[]" }]);
  expect(t.llm.calls[0].system[1].content).not.toContain("forget");
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.rows("direction = 'out'").map((r) => [r.text, r.status])).toEqual([["hi", "sent"], ["second", "sent"]]);
  const turns = t.turns();
  expect(turns).toHaveLength(1);
  expect(turns[0].ttfb_ms).toBeGreaterThanOrEqual(0);
  expect(turns[0].total_ms).toBeGreaterThan(0);
  expect(turns[0].bubbles).toBe(2);
});

test("only the first reaction of a turn is sent (a tool step can repeat the header)", async () => {
  const t = setup({ reply: () => "react: #1 👍\nreact: #1 ❤️\nok" });
  await t.say("the movie was great");
  await t.run();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "reaction", "text"]);
  expect(t.wa.sent[1].emoji).toBe("👍");
  expect(JSON.parse(t.rows("id = 'wamid.in.1'")[0].reactions!)).toEqual({ me: "👍" });
});

test("react: 👍 without a target reacts to the newest inbound message", async () => {
  const t = setup({ reply: () => "react: 👍\nok" });
  await t.say("first");
  t.clock.t += 1000;
  await t.say("second");
  await t.run();
  expect(t.wa.sent.filter((s) => s.kind === "reaction")).toMatchObject([{ target: "wamid.in.2", emoji: "👍" }]);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok"]);
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

test("an early failure on both attempts still marks the pending rows handled", async () => {
  const t = setup({ features: { memory: true }, reply: () => { throw new Error("upstream down"); } });
  await t.say("the movie was great");
  const lastInbound = t.clock.t;
  await t.fire();
  expect(t.state()).toMatchObject({ turn_attempts: 1, turn_due: t.clock.t + 30_000 });
  await t.fire();
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.turns()).toHaveLength(1);
  expect(t.turns()[0].error).toContain("upstream down");
  expect(t.state()).toMatchObject({ turn_due: null, turn_attempts: 0 });
  await t.core.afterTurn;
  expect(t.view.alarmAt).toBe(lastInbound + 30 * 60_000); // only the insights timer is left
  expect(t.llm.objectCalls.map((c) => c.job)).toEqual(["extract"]); // what they said is remembered even though the reply failed
});

test("a failing recall still gets a reply, with no memories and a recall_failed log", async () => {
  const t = setup({ features: { memory: true }, object: () => ({ ops: [] }) });
  const log = vi.fn();
  t.deps.log = log;
  t.deps.embed = async () => { throw new Error("workers-ai down"); };
  await t.say("the movie was great");
  await t.run();
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok"]);
  expect(t.turns()).toMatchObject([{ error: null }]);
  expect(t.state().turn_attempts).toBe(0);
  expect(log).toHaveBeenCalledWith({ event: "recall_failed", error: "workers-ai down" });
  expect(t.llm.calls[0].system[1].content).not.toContain("memories:");
});

test("a mid-stream llm error sends only the complete bubble", async () => {
  const t = setup({ reply: () => ({ chunks: ["react: none\n", "first bubble\n", "---\n", "second is cut o"], error: new Error("stream cut") }) });
  await t.say("the movie was great");
  await t.run();
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["first bubble"]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.turns()).toHaveLength(1);
  expect(t.turns()[0].error).toContain("stream cut");
  expect(t.view.alarmAt).toBeNull();
});

test("a stream error after one bubble is still remembered", async () => {
  const t = setup({ features: { memory: true }, object: () => ({ ops: [] }), reply: () => ({ chunks: ["react: none\n", "first bubble\n", "---\n", "second is cut o"], error: new Error("stream cut") }) });
  await t.say("my sister lives in Almaty");
  await t.run();
  expect(t.turns()[0].error).toContain("stream cut");
  expect(t.llm.objectCalls.map((c) => c.job)).toEqual(["extract"]);
  expect(JSON.stringify(t.llm.objectCalls[0].messages)).toContain("user: my sister lives in Almaty\\nassistant: first bubble");
});

test("the next reply does not wait for the previous extraction; extractions stay in order and a failed one does not stop the next", async () => {
  let release!: (v: unknown) => void;
  const hang = new Promise((r) => { release = r; });
  const t = setup({ features: { memory: true }, object: () => (t.llm.objectCalls.length === 1 ? hang : { ops: [] }) });
  await t.say("first thing");
  void t.fire(); // replies, then its extraction hangs
  await vi.waitFor(() => expect(t.llm.objectCalls).toHaveLength(1));
  t.clock.t += 1000;
  await t.say("second thing");
  const due = t.view.alarmAt!;
  expect(due).toBe(t.clock.t + 3000);
  await t.fire();
  expect(t.clock.t).toBe(due); // replied in its own 3 s window: no +1 s re-arms
  expect(t.wa.sent.filter((s) => s.kind === "text")).toHaveLength(2);
  expect(t.turns()).toHaveLength(2);
  expect(t.state().turn_due).toBeNull();
  expect(t.llm.objectCalls).toHaveLength(1); // the second extraction waits for the first
  const log = vi.fn();
  t.deps.log = log;
  t.view.setAlarm = () => { throw new Error("storage down"); }; // every post-turn step now rejects at its end
  release({ ops: [] });
  await t.core.afterTurn;
  expect(t.llm.objectCalls.map((c) => JSON.stringify(c.messages))).toEqual([expect.stringContaining("user: first thing"), expect.stringContaining("user: second thing")]);
  expect(log.mock.calls.filter(([e]) => e.event === "post_turn_failed")).toHaveLength(2);
});

test("a reset mid-turn still gets a reply: the watchdog alarm fires on a fresh core", async () => {
  const t = setup({ reply: () => new Promise<string>(() => {}) }); // the first instance never finishes
  await t.say("the movie was great");
  void t.fire();
  await vi.waitFor(() => expect(t.llm.calls).toHaveLength(1));
  expect(t.view.alarmAt).toBe(t.clock.t + 60_000);
  const llm = stubLlm();
  const fresh = new ContactCore({ ...t.deps, llm }); // a Durable Object reset: same storage, new instance
  await drain(fresh, t.view, t.clock, t.clock.t + 120_000);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok"]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.view.alarmAt).toBeNull();
});

test("a sent reaction is stored under me and shown in the next prompt", async () => {
  const t = setup({ reply: (c) => (t.llm.calls.length === 1 ? "react: #1 🎉" : "react: none\nthanks!") });
  await t.say("I got the job");
  await t.run();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "reaction"]);
  expect(JSON.parse(t.rows("id = 'wamid.in.1'")[0].reactions!)).toEqual({ me: "🎉" });
  await t.say("anyway, how are you");
  await t.run();
  expect(JSON.stringify(t.llm.calls[1].messages)).toContain("I got the job (you reacted 🎉)");
});

test("voice note with failing transcribe leaves the marker and the stub prompt contains it", async () => {
  const t = setup();
  t.deps.transcribe = async () => { throw new Error("whisper down"); };
  t.wa.media.set("media.v", { bytes: new Uint8Array([1]), mime: "audio/ogg" });
  await t.say("", { kind: "audio", mediaId: "media.v", mime: "audio/ogg", voice: true });
  await t.run();
  expect(t.rows("kind = 'audio'")[0].text).toBe("[voice note could not be transcribed]");
  expect(JSON.stringify(t.llm.calls[0].messages)).toContain("[voice note could not be transcribed]");
});

test("image on a text-only reply model switches to the vision model", async () => {
  const t = setup();
  t.deps.models = { ...t.deps.models, reply: "z-ai/glm-5.2" };
  t.wa.media.set("media.1", { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: "image/jpeg" });
  await t.say("[photo]", { kind: "image", mediaId: "media.1", mime: "image/jpeg" });
  await t.run();
  expect(t.llm.calls[0].modelId).toBe("openai/gpt-6.1-terra");
});

test("oversized image gets the could-not-read text and no file part", async () => {
  const t = setup();
  t.wa.media.set("media.big", { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mime: "image/jpeg" });
  await t.say("my cat", { kind: "image", mediaId: "media.big", mime: "image/jpeg" });
  await t.run();
  expect(t.rows("kind = 'image'")[0].text).toBe("my cat [an image that could not be read]");
  const parts = t.llm.calls[0].messages.at(-1)!.content as { type: string }[];
  expect(parts.some((p) => p.type === "file")).toBe(false);
});

const SISTER = "Sister Aru lives in Almaty";
const addFact = async (db: ReturnType<typeof setup>["db"], text: string) =>
  db.run("INSERT INTO facts(text, kind, signal, created_at, source_message_ids, embedding) VALUES (?, 'person', 5, 0, '[]', ?)", text, vecToBlob((await hashEmbed([text]))[0]));

test("memory on: recall feeds the prompt, the reply carries forget, and the turn is remembered", async () => {
  const t = setup({ features: { memory: true }, object: () => (t.llm.objectCalls.length === 1 ? { ops: [{ op: "ADD", text: SISTER, kind: "person", signal: 5 }], profile: "Sister: Aru (Almaty)" } : { ops: [] }) });
  const embed = vi.spyOn(t.deps, "embed");
  await t.say("my sister Aru lives in Almaty");
  await t.run();
  const extract = t.llm.objectCalls[0];
  expect(extract).toMatchObject({ job: "extract", modelId: t.deps.models.extract, sessionId: t.llm.calls[0].sessionId });
  expect(JSON.stringify(extract.messages)).toContain("user: my sister Aru lives in Almaty\\nassistant: ok");
  expect(t.db.all("SELECT text, status FROM facts")).toEqual([{ text: SISTER, status: "active" }]);

  t.clock.t += 60_000;
  await t.say("where does she live now?");
  await t.run();
  expect(embed.mock.calls.map((c) => c[0][0])).toContain("my sister Aru lives in Almaty\nok\nwhere does she live now?"); // last two messages + pending
  const dyn = t.llm.calls[1].system[1].content as string;
  expect(dyn).toContain("profile:\nSister: Aru (Almaty)");
  expect(dyn).toContain(`- ${SISTER} (said 2026-11-04)`);
  expect(dyn).toContain("what you know about them");
  expect(t.llm.calls[1].tools?.forget).toBeDefined();
  const turns = t.db.all<{ retrieval_ms: number | null; recalled: string }>("SELECT retrieval_ms, recalled FROM turns ORDER BY id");
  for (const r of turns) {
    expect(r.retrieval_ms).toEqual(expect.any(Number));
    expect(r.retrieval_ms).toBeGreaterThanOrEqual(0);
  }
  expect(turns.map((r) => JSON.parse(r.recalled))).toEqual([[], [SISTER]]); // what each reply was shown
});

test("logs and model sessions use the opaque contact key, never the phone number; the turn log counts recalled memories", async () => {
  const t = setup({ features: { memory: true }, object: () => ({ ops: [] }) });
  const log = vi.fn();
  t.deps.log = log;
  await addFact(t.db, SISTER);
  await t.say("where does my sister live");
  await t.run();
  expect([...t.llm.calls, ...t.llm.objectCalls].map((c) => c.sessionId)).toEqual([t.deps.contactKey, t.deps.contactKey]);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "turn", contact: t.deps.contactKey, recalled: 1 }));
  expect(JSON.stringify(log.mock.calls)).not.toContain(FROM);
  expect(JSON.stringify(log.mock.calls)).not.toContain("Almaty"); // recalled texts stay in turns.recalled only
  expect(t.db.all("SELECT recalled FROM turns")).toEqual([{ recalled: JSON.stringify([SISTER]) }]);
});

test("the forget tool deletes matching facts and returns the count and the texts", async () => {
  const t = setup({
    features: { memory: true }, object: () => ({ ops: [] }),
    reply: async (c) => `react: none\n${JSON.stringify(await c.tools!.forget.execute!({ query: "Almaty" }, { toolCallId: "t1", messages: [] } as never))}`,
  });
  await addFact(t.db, SISTER);
  await t.say("forget my sister's city please");
  await t.run();
  expect(t.wa.sent.find((s) => s.kind === "text")?.body).toBe('{"deleted":1,"texts":["Sister Aru lives in Almaty"]}');
  expect(t.db.all("SELECT * FROM facts")).toEqual([]);
});

test("forget waits for the previous turn's extraction, so that extraction cannot bring the fact back", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let forgot: unknown;
  const t = setup({
    features: { memory: true },
    object: async () => {
      if (t.llm.objectCalls.length > 1) return { ops: [] };
      await gate; // turn 1's extraction is still running when turn 2 forgets
      return { ops: [{ op: "ADD", text: SISTER, kind: "person", signal: 5 }], profile: "Name: Dana\nSister: Aru, lives in Almaty" };
    },
    reply: async (c) => {
      if (t.llm.calls.length === 1) return "react: none\nnice";
      forgot = await c.tools!.forget.execute!({ query: "Almaty" }, { toolCallId: "t1", messages: [] } as never);
      return "react: none\ndone, forgotten";
    },
  });
  await t.say("my sister Aru lives in Almaty");
  void t.fire();
  await vi.waitFor(() => expect(t.llm.objectCalls).toHaveLength(1));
  t.clock.t += 1000;
  await t.say("please forget my sister's city");
  const second = t.fire();
  await vi.waitFor(() => expect(t.llm.calls).toHaveLength(2));
  release();
  await second;
  await t.core.afterTurn;
  expect(forgot).toEqual({ deleted: 1, texts: [SISTER] });
  expect(t.db.all("SELECT text FROM facts")).toEqual([]);
  expect(t.db.all("SELECT text FROM profile")).toEqual([{ text: "Name: Dana" }]);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["nice", "done, forgotten"]);
});

test("a failing remember is logged and the turn still completes", async () => {
  const t = setup({ features: { memory: true }, object: () => { throw new Error("extract down"); } });
  const log = vi.fn();
  t.deps.log = log;
  await t.say("my sister lives in Almaty");
  const lastInbound = t.clock.t;
  await t.run();
  expect(log).toHaveBeenCalledWith({ event: "remember_failed", error: "extract down" });
  expect(t.turns()).toMatchObject([{ error: null }]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.view.alarmAt).toBe(lastInbound + 30 * 60_000);
});

test("recall runs on a voice note's transcript, not on the empty prefetch", async () => {
  const t = setup({ features: { memory: true }, object: () => ({ ops: [] }) });
  await addFact(t.db, SISTER);
  const embed = vi.spyOn(t.deps, "embed");
  t.deps.transcribe = async () => "where does my sister live";
  t.wa.media.set("media.v", { bytes: new Uint8Array([1]), mime: "audio/ogg" });
  await t.say("", { kind: "audio", mediaId: "media.v", mime: "audio/ogg", voice: true });
  await t.run();
  expect(embed.mock.calls[0][0]).toEqual(["where does my sister live"]);
  expect(t.llm.calls[0].system[1].content).toContain(SISTER);
});

test("the turn's images go to remember and the media_note lands on the image row", async () => {
  const t = setup({ features: { memory: true }, object: () => ({ ops: [], media_note: "a red road bike" }) });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  t.wa.media.set("media.1", { bytes: jpeg, mime: "image/jpeg" });
  await t.say("[photo]", { kind: "image", mediaId: "media.1", mime: "image/jpeg" });
  t.clock.t += 1000;
  await t.say("my new bike!");
  await t.run();
  const parts = t.llm.objectCalls[0].messages[0].content as { type: string }[];
  expect(parts.filter((p) => p.type === "file")).toEqual([{ type: "file", mediaType: "image/jpeg", data: jpeg }]);
  expect(t.db.all("SELECT id, media_note FROM messages WHERE direction='in' ORDER BY ts")).toEqual([{ id: "wamid.in.1", media_note: "a red road bike" }, { id: "wamid.in.2", media_note: null }]);
});

test("insights alarm fires 30 min after the last message and not before", async () => {
  const t = setup({ features: { memory: true }, object: (c) => (c.job === "derive" ? { insights: [] } : { ops: [{ op: "ADD", text: "Flight on 2026-12-10", kind: "plan", signal: 4 }] }) });
  await t.say("flight on the 10th of December");
  const lastInbound = t.clock.t;
  await t.run(lastInbound + 29 * 60_000);
  expect(t.view.alarmAt).toBe(lastInbound + 30 * 60_000);
  expect(t.llm.objectCalls.map((c) => c.job)).toEqual(["extract"]);
  await t.run(lastInbound + 31 * 60_000);
  expect(t.llm.objectCalls.map((c) => c.job)).toEqual(["extract", "derive"]);
  expect(t.view.alarmAt).toBeNull();
  expect(t.state().insights_due).toBeNull();
});

test("a failing derive call is logged and does not stop the alarm", async () => {
  const t = setup({ features: { memory: true }, object: (c) => { if (c.job === "derive") throw new Error("derive down"); return { ops: [{ op: "ADD", text: "Flight on 2026-12-10", kind: "plan", signal: 4 }] }; } });
  const log = vi.fn();
  t.deps.log = log;
  await t.say("flight on the 10th");
  await t.run(t.clock.t + 31 * 60_000);
  expect(log).toHaveBeenCalledWith({ event: "insights_failed", error: "derive down" });
  expect(t.view.alarmAt).toBeNull();
});

const PAGE = { url: "https://a.com/x", finalUrl: "https://a.com/x", title: "A page", status: 200, markdown: "# Hello page", jpeg: new Uint8Array([1, 2, 3]) };

test("URL at t, text at t+1 s: snapshot called once and the model gets the page text and a file part", async () => {
  const snapshot = vi.fn(async () => PAGE);
  const t = setup({ snapshot });
  await t.say("https://a.com/x");
  t.clock.t += 1000;
  await t.say("thoughts?");
  await t.run();
  expect(snapshot).toHaveBeenCalledTimes(1);
  const parts = t.llm.calls[0].messages.flatMap((m) => (typeof m.content === "string" ? [] : (m.content as { type: string; text?: string }[])));
  expect(parts.some((p) => p.type === "text" && !!p.text?.includes("Hello page"))).toBe(true);
  expect(parts.some((p) => p.type === "file")).toBe(true);
});

test("view_page tool is attached only when the thread has a URL", async () => {
  const snapshot = vi.fn(async () => PAGE);
  const t = setup({ snapshot });
  await t.say("no link here");
  await t.run();
  expect(t.llm.calls[0].tools?.view_page).toBeUndefined();
  await t.say("https://a.com/x");
  await t.run();
  expect(t.llm.calls[1].tools?.view_page).toBeDefined();
  const out = await t.llm.calls[1].tools!.view_page.execute!({ url: "https://a.com/x" }, { toolCallId: "t", messages: [] } as never);
  expect(out).toEqual({ title: "A page", status: 200, finalUrl: "https://a.com/x", markdown: "# Hello page" });
});

test("an outbound bubble with a URL is sent with previewUrl", async () => {
  const t = setup({ reply: () => "react: none\nsee https://a.com/x" });
  await t.say("recommend something");
  await t.run();
  expect(t.wa.sent.find((s) => s.kind === "text")?.previewUrl).toBe(true);
});

test("remember gets a (shared a link) note from the resolved snapshot; the stored row is unchanged", async () => {
  const t = setup({ features: { memory: true }, snapshot: async () => PAGE, object: () => ({ ops: [] }) });
  await t.say("look https://a.com/x");
  await t.run();
  const prompt = JSON.stringify(t.llm.objectCalls[0].messages);
  expect(prompt).toContain("look https://a.com/x (shared a link: A page https://a.com/x)");
  expect(t.rows("direction='in'")[0].text).toBe("look https://a.com/x");
});

test("view_page is attached when the URL is in one of the last 5 handled rows, not the 6th-from-last", async () => {
  for (const [after, attached] of [[1, true], [2, false]] as const) {
    const t = setup();
    await t.say("https://a.com/x");
    await t.run();
    for (let i = 0; i < after; i++) { t.clock.t += 60_000; await t.say(`plain ${i}`); await t.run(); }
    t.clock.t += 60_000;
    await t.say("and now?");
    await t.run();
    expect(!!t.llm.calls.at(-1)!.tools?.view_page).toBe(attached);
  }
});

// Follow-ups: the plan is stored by remember() from a real turn; times below are New York (EST) local.
const ny = (s: string) => Date.parse(s.replace(" ", "T") + ":00-05:00");
const planOps = (...dates: string[]) => (c: ObjectCall<unknown>) =>
  c.job === "extract" ? { ops: dates.map((d, i) => ({ op: "ADD", text: `Plan ${i + 1}`, kind: "plan", signal: 4, event_date: d })) } : { insights: [] };
const followupT = (dates: string[], start = "2026-11-04 10:00") => {
  const t = setup({ features: { memory: true }, object: planOps(...dates), reply: (c) => (c.job === "followup" ? "react: none\nhow did it go?" : "react: none\nok") });
  t.clock.t = ny(start);
  return t;
};
const outs = (t: ReturnType<typeof setup>) => t.rows("direction = 'out'");

test("follow-up fires after the alarm and sends exactly one bubble, marks the fact followup_done, and the alarm is clear afterwards", async () => {
  const t = followupT(["2026-11-04 14:00"]);
  await t.say("interview at two today");
  await t.run(t.clock.t + 60_000);
  expect(t.state().followup_due).toBe(ny("2026-11-04 16:00"));
  await t.run(ny("2026-11-04 16:00") + 1);
  const call = t.llm.calls.find((c) => c.job === "followup")!;
  expect(JSON.stringify(call.system)).toContain('\\"Plan 1\\"');
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok", "how did it go?"]);
  expect(outs(t)).toHaveLength(2);
  expect(t.db.all("SELECT followup_done FROM facts")).toEqual([{ followup_done: 1 }]);
  expect(t.db.all("SELECT last_proactive_date FROM contact")).toEqual([{ last_proactive_date: "2026-11-04" }]);
  expect(t.state().followup_due).toBeNull();
  expect(t.view.alarmAt).toBeNull();
});

test("a skipped plan is not re-picked (no alarm storm)", async () => {
  const t = followupT(["2026-11-04 14:00"]);
  await t.say("interview at two today");
  await t.run(t.clock.t + 60_000);
  t.db.run("INSERT INTO messages(id, direction, kind, text, ts, status) VALUES ('wamid.in.9', 'in', 'text', 'it went fine', ?, 'handled')", ny("2026-11-04 14:30"));
  t.db.run("UPDATE contact SET last_inbound_ts = ?", ny("2026-11-04 14:30"));
  await t.run(ny("2026-11-04 16:00") + 1);
  expect(t.llm.calls.some((c) => c.job === "followup")).toBe(false);
  expect(t.db.all("SELECT followup_done FROM facts")).toEqual([{ followup_done: 1 }]);
  expect(t.state()).toMatchObject({ followup_due: null, followup_fact_id: null });
  expect(t.view.alarmAt).toBeNull();
});

test("two plans: after the first fires, followup_due === D2 + 2h", async () => {
  const t = followupT(["2026-11-04 14:00", "2026-11-05 12:00"]);
  await t.say("two things coming up");
  await t.run(t.clock.t + 60_000);
  await t.run(ny("2026-11-04 16:00") + 1);
  expect(t.llm.calls.filter((c) => c.job === "followup")).toHaveLength(1);
  expect(t.state().followup_due).toBe(ny("2026-11-05 14:00"));
  expect(t.db.all("SELECT followup_done FROM facts ORDER BY id")).toEqual([{ followup_done: 1 }, { followup_done: 0 }]);
});

test("a follow-up due at night is deferred to 09:00 and then sent", async () => {
  const t = followupT(["2026-11-04 21:30"], "2026-11-04 20:00");
  await t.say("dinner later");
  await t.run(t.clock.t + 60_000);
  await t.run(ny("2026-11-04 23:30") + 1);
  expect(t.llm.calls.some((c) => c.job === "followup")).toBe(false);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok"]);
  expect(t.state().followup_due).toBe(ny("2026-11-05 09:00"));
  await t.run(ny("2026-11-05 09:00") + 1);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok", "how did it go?"]);
  expect(t.llm.calls.filter((c) => c.job === "followup")).toHaveLength(1);
  expect(t.state().followup_due).toBeNull();
});

test("the follow-up conversation ends on a user turn", async () => {
  const t = followupT(["2026-11-04 14:00"]);
  await t.say("interview at two today");
  await t.run(ny("2026-11-04 16:00") + 1);
  const m = t.llm.calls.find((c) => c.job === "followup")!.messages;
  expect(m.at(-1)).toMatchObject({ role: "user", content: "[scheduled check-in]" });
});

test("a failed follow-up send stores a failed row, marks the fact done and does not retry", async () => {
  const t = followupT(["2026-11-04 14:00"]);
  await t.say("interview at two today");
  await t.run(t.clock.t + 60_000);
  t.wa.failNext = new WaError(131047, 400, "re-engagement");
  await t.run(ny("2026-11-04 16:00") + 1);
  expect(outs(t).map((r) => r.status)).toEqual(["sent", "failed"]);
  expect(t.db.all("SELECT followup_done FROM facts")).toEqual([{ followup_done: 1 }]);
  expect(t.db.all("SELECT last_proactive_date FROM contact")).toEqual([{ last_proactive_date: null }]);
  expect(t.llm.calls.filter((c) => c.job === "followup")).toHaveLength(1);
  expect(t.view.alarmAt).toBeNull();
});

test("an empty follow-up reply is logged and the fact is still done", async () => {
  const t = setup({ features: { memory: true }, object: planOps("2026-11-04 14:00"), reply: (c) => (c.job === "followup" ? "react: none\n" : "react: none\nok") });
  t.clock.t = ny("2026-11-04 10:00");
  const log = vi.fn();
  t.deps.log = log;
  await t.say("interview at two today");
  await t.run(ny("2026-11-04 16:00") + 1);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "followup_empty" }));
  expect(t.db.all("SELECT followup_done FROM facts")).toEqual([{ followup_done: 1 }]);
});

test("two plans due the same day: the daily limit defers the second to tomorrow 09:00", async () => {
  const t = followupT(["2026-11-04 12:00", "2026-11-04 12:30"]);
  await t.say("two things today");
  await t.run(ny("2026-11-04 16:00"));
  expect(t.llm.calls.filter((c) => c.job === "followup")).toHaveLength(1);
  expect(t.db.all("SELECT followup_done, followup_due FROM facts ORDER BY id")).toEqual([{ followup_done: 1, followup_due: null }, { followup_done: 0, followup_due: ny("2026-11-05 09:00") }]);
  expect(t.state().followup_due).toBe(ny("2026-11-05 09:00"));
});

test("two plans plus a night deferral do not storm: one send, the other skipped by the window", async () => {
  const t = followupT(["2026-11-04 21:30", "2026-11-04 22:30"], "2026-11-04 20:00");
  let alarms = 0;
  const alarm = t.core.alarm.bind(t.core);
  t.core.alarm = async () => { alarms++; await alarm(); };
  await t.say("dinner and a call");
  await t.run(ny("2026-11-05 09:00") + 1);
  expect(t.llm.calls.filter((c) => c.job === "followup")).toHaveLength(1);
  expect(alarms).toBeLessThanOrEqual(6); // turn, insights, 2 night deferrals, send, daily-limit deferral
  expect(t.db.all("SELECT followup_done, followup_due FROM facts ORDER BY id")).toEqual([{ followup_done: 1, followup_due: ny("2026-11-05 09:00") }, { followup_done: 1, followup_due: ny("2026-11-05 09:00") }]); // D2: tomorrow 09:00 is past the 24h window, so it is skipped
});
