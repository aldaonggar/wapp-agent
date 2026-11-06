import { expect, test, vi } from "vitest";
import { FakeClock, FakeWa, drain, hashEmbed, makeEvalDeps, stubLlm } from "../../evals/harness";
import { routeTransports } from "../telegram";
import { WaError } from "../whatsapp";
import { bubblePauseMs } from "./cadence";
import { ContactCore, FALLBACK } from "./contact";
import { STUB_PAGE } from "../../evals/harness";
import { vecToBlob } from "./db";
import type { Deps, Features, Inbound, ObjectCall, StreamCall, TextCall } from "./types";

const FROM = "15550000001";
type State = { turn_due: number | null; insights_due: number | null; followup_due: number | null; reminder_due: number | null; burst_started_at: number | null; generation: number; turn_attempts: number };

type Reply = string | { chunks: string[]; error: Error };
function setup(o: { reply?: (c: StreamCall) => Reply | Promise<Reply>; object?: (c: ObjectCall<unknown>) => unknown; features?: Partial<Features>; snapshot?: Deps["snapshot"]; search?: Deps["search"]; text?: (c: TextCall) => string } = {}) {
  const clock = new FakeClock();
  const view = clock.forContact(FROM);
  const wa = new FakeWa(clock);
  const llm = stubLlm({ reply: o.reply, object: o.object, text: o.text });
  const deps = makeEvalDeps({ clock: view, wa, llm, features: o.features, snapshot: o.snapshot, search: o.search });
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
  expect(Object.keys(t.llm.calls[0].tools!)).toEqual(["set_reminder", "cancel_reminder", "make_page", "view_page", "send_screenshot", "search_web"]); // memory off: no forget tool
  expect(t.llm.calls[0].activeTools!()).toEqual(["set_reminder", "cancel_reminder", "make_page", "search_web"]); // view_page and send_screenshot wait for a link or a search
  expect(t.db.all("SELECT recalled FROM turns")).toEqual([{ recalled: "[]" }]);
  expect(t.llm.calls[0].system[1].content).not.toContain("forget tool"); // memory off: no control sentences (the first-contact line may say "forget")
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
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "typing", "text"]); // the fallback line after the second failure
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

test("two failures in a row send exactly one fallback, after the second alarm, stored as an outbound row; the pending rows are handled", async () => {
  const t = setup({ reply: () => { throw new Error("upstream 500"); } });
  const log = vi.fn();
  t.deps.log = log;
  await t.say("the movie was great");
  await t.fire();
  expect(t.wa.sent.filter((s) => s.kind === "text")).toEqual([]);
  await t.fire();
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual([FALLBACK]);
  expect(t.rows("direction = 'out'").map((r) => [r.text, r.status])).toEqual([[FALLBACK, "sent"]]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(log).toHaveBeenCalledWith({ event: "fallback_sent", contact: "test", ok: true });
  expect(t.view.alarmAt).toBeNull();
  await t.run(t.clock.t + 3_600_000);
  expect(t.wa.sent.filter((s) => s.kind === "text")).toHaveLength(1);
});

test("a reaction-only turn that then fails gets the fallback (no retry: something already went out)", async () => {
  const t = setup({ reply: () => ({ chunks: ["react: #1 👍\n"], error: new Error("stream cut") }) });
  await t.say("the movie was great");
  await t.fire();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "reaction", "text"]);
  expect(t.wa.sent.at(-1)!.body).toBe(FALLBACK);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.state()).toMatchObject({ turn_due: null, turn_attempts: 0 });
});

test("a fallback that cannot be sent is stored failed and logged; the alarm still completes", async () => {
  const t = setup({ reply: () => ({ chunks: ["react: #1 👍\n"], error: new Error("stream cut") }) });
  const log = vi.fn();
  t.deps.log = log;
  t.wa.failNext = new WaError(0, 502, "bad gateway");
  await t.say("the movie was great");
  await expect(t.fire()).resolves.toBeUndefined();
  expect(t.rows("direction = 'out'").map((r) => [r.text, r.status])).toEqual([[FALLBACK, "failed"]]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(log).toHaveBeenCalledWith({ event: "fallback_sent", contact: "test", ok: false });
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

// Voice replies: a voice note in gets one voice note back; anything that fails falls back to the text bubbles.
const voiceNote = async (t: ReturnType<typeof setup>, transcript = "how are you") => {
  t.deps.transcribe = async () => transcript;
  t.wa.media.set("media.v", { bytes: new Uint8Array([1]), mime: "audio/ogg; codecs=opus" });
  await t.say("", { kind: "audio", mediaId: "media.v", mime: "audio/ogg; codecs=opus", voice: true });
};

test("a voice note gets one voice note with the whole reply and the model's quote, stored as an audio row", async () => {
  const t = setup({ reply: () => "react: none\nquote: #1\nall good here\n---\nand you?" });
  const spoken: string[] = [];
  t.deps.tts = async (text) => { spoken.push(text); return { bytes: new Uint8Array([7]), mime: "audio/ogg" }; };
  await voiceNote(t);
  await t.run();
  expect(spoken).toEqual(["all good here\n\nand you?"]);
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "audio"]);
  expect(t.wa.sent[1]).toMatchObject({ to: FROM, bytes: new Uint8Array([7]), mime: "audio/ogg", quote: "wamid.in.1" });
  expect(t.rows("direction = 'out'")).toMatchObject([{ id: "wamid.out.2", text: "all good here\n\nand you?", status: "sent", quoted_id: "wamid.in.1" }]);
  expect(t.db.all("SELECT kind, voice FROM messages WHERE direction = 'out'")).toEqual([{ kind: "audio", voice: 1 }]);
  expect(t.turns()[0]).toMatchObject({ bubbles: 2, error: null });
  expect(t.turns()[0].ttfb_ms).toBeGreaterThanOrEqual(0);
});

test("voice reply falls back to the paced text bubbles when synthesis fails, when the upload fails, and when the client cannot send audio", async () => {
  const cases: [string, (t: ReturnType<typeof setup>) => void][] = [
    ["tts down", (t) => { t.deps.tts = async () => { throw new Error("aura down"); }; }],
    ["upload down", (t) => { t.wa.failNext = new WaError(131053, 400, "bad media"); }],
    ["no sendAudio", (t) => { Object.assign(t.wa, { sendAudio: undefined }); }],
  ];
  for (const [name, arrange] of cases) {
    const t = setup({ reply: () => "react: none\nall good here\n---\nand you?" });
    const log = vi.fn();
    t.deps.log = log;
    arrange(t);
    await voiceNote(t);
    await t.run();
    const texts = t.wa.sent.filter((s) => s.kind === "text");
    expect(texts.map((s) => s.body), name).toEqual(["all good here", "and you?"]);
    expect(texts[1].at - texts[0].at, name).toBe(bubblePauseMs("all good here".length));
    expect(t.wa.sent.some((s) => s.kind === "audio"), name).toBe(false);
    expect(t.rows("direction = 'out'").map((r) => r.status), name).toEqual(["sent", "sent"]);
    expect(log.mock.calls.some(([e]) => e.event === "voice_reply_failed"), name).toBe(name !== "no sendAudio");
  }
});

test("a non-Latin bubble on a voice note streams as text at once, not after the whole reply", async () => {
  const t = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stream = t.llm.stream.bind(t.llm);
  t.deps.llm.stream = (c) => {
    const s = stream(c); // drained first so the stub's own `done` still settles
    return { done: s.done, text: (async function* () { for await (const chunk of s.text) void chunk; yield "react: none\nвсё хорошо\n---\n"; await gate; yield "и у тебя?"; })() };
  };
  await voiceNote(t, "как дела");
  const turn = t.run();
  await vi.waitFor(() => expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["всё хорошо"])); // sent while the stream is still open
  release();
  await turn;
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "text", "typing", "text"]);
  expect(t.turns()).toMatchObject([{ bubbles: 2, error: null }]);
});

test("a mid-stream error on a voice note still sends the complete bubble as text, like the text path", async () => {
  const t = setup({ reply: () => ({ chunks: ["react: #1 👍\n", "bubble one\n", "---\n", "bubble two is cut o"], error: new Error("stream cut") }) });
  await voiceNote(t);
  await t.run();
  expect(t.wa.sent.map((s) => [s.kind, s.body ?? s.emoji])).toEqual([["typing", undefined], ["reaction", "👍"], ["text", "bubble one"]]);
  expect(t.turns()).toMatchObject([{ error: expect.stringContaining("stream cut"), bubbles: 1 }]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
  expect(t.view.alarmAt).toBeNull();
});

// Voice asked for in text: the model writes a "voice: yes" header and the reply takes the voice-note path.
test("a text message whose reply carries voice: yes gets one voice note and no text bubbles", async () => {
  const t = setup({ reply: () => "react: none\nvoice: yes\nsure, here it is\n---\nhave a good one" });
  const spoken: string[] = [];
  t.deps.tts = async (text) => { spoken.push(text); return { bytes: new Uint8Array([7]), mime: "audio/ogg" }; };
  await t.say("say it out loud please");
  await t.run();
  expect(spoken).toEqual(["sure, here it is\n\nhave a good one"]);
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "audio"]);
  expect(t.db.all("SELECT kind, voice, text FROM messages WHERE direction = 'out'")).toEqual([{ kind: "audio", voice: 1, text: "sure, here it is\n\nhave a good one" }]);
  expect(t.turns()[0]).toMatchObject({ bubbles: 2, error: null });
});

test("voice: yes after the first bubble is ignored: the reply stays text", async () => {
  const t = setup({ reply: () => "react: none\nsure\n---\nvoice: yes\nhere it is" });
  await t.say("say it out loud please");
  await t.run();
  expect(t.wa.sent.map((s) => [s.kind, s.body])).toEqual([["typing", undefined], ["text", "sure"], ["typing", undefined], ["text", "here it is"]]);
});

test("voice: yes on a client that cannot send audio, or with no text-to-speech, stays text", async () => {
  for (const arrange of [(t: ReturnType<typeof setup>) => { Object.assign(t.wa, { sendAudio: undefined }); }, (t: ReturnType<typeof setup>) => { t.deps.tts = undefined; }]) {
    const t = setup({ reply: () => "react: none\nvoice: yes\nsure, here it is" });
    arrange(t);
    await t.say("say it out loud please");
    await t.run();
    expect(t.wa.sent.map((s) => [s.kind, s.body])).toEqual([["typing", undefined], ["text", "sure, here it is"]]);
  }
});

test("when the extractor learns the real timezone, a clock-time reminder keeps the wall time the person was told and a duration keeps its instant", async () => {
  const t = setup({
    features: { memory: true }, object: (c) => (c.job === "extract" ? { ops: [], timezone: "America/Los_Angeles" } : { insights: [] }),
    reply: async (c) => {
      if (t.llm.calls.length > 1) return "react: none\nok";
      await c.tools!.set_reminder.execute!({ text: "take the pizza out", at: "2026-11-04 10:20", relative: true }, { toolCallId: "t", messages: [] } as never);
      return remind("call the dentist", "2026-11-05 09:00")(c);
    },
  });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("I'm in LA btw, pizza out in 20 minutes, and remind me tomorrow at 9 to call the dentist");
  await t.run(); // the +1 number was guessed as New York: the tool confirmed 09:00 there (14:00Z)
  expect(t.db.all("SELECT timezone, timezone_confirmed FROM contact")).toEqual([{ timezone: "America/Los_Angeles", timezone_confirmed: 1 }]);
  expect(t.db.all("SELECT text, due_ts, relative FROM reminders ORDER BY id")).toEqual([
    { text: "take the pizza out", due_ts: ny("2026-11-04 10:20"), relative: 1 }, // still 20 minutes after the request
    { text: "call the dentist", due_ts: Date.UTC(2026, 10, 5, 17, 0), relative: 0 }, // 09:00 Los Angeles
  ]);
  expect(t.state().reminder_due).toBe(ny("2026-11-04 10:20"));
  t.clock.t += 60_000;
  await t.say("thanks");
  await t.run();
  expect(t.llm.calls[1].system[1].content).toContain("- 2026-11-05 09:00 call the dentist (id 2)");
});

test("a change of an already confirmed zone (travel) moves no reminder", async () => {
  const t = setup({ features: { memory: true }, object: (c) => (c.job === "extract" ? { ops: [], timezone: "Europe/London" } : { insights: [] }), reply: (c) => (t.llm.calls.length === 1 ? remind("call the dentist", "2026-11-05 09:00")(c) : "react: none\nok") });
  t.clock.t = ny("2026-11-04 10:00");
  t.db.run("INSERT INTO contact(id, wa_id, timezone, timezone_confirmed) VALUES (1, ?, 'America/New_York', 1)", FROM); // ingest keeps the zone on conflict
  await t.say("in London this week, remind me tomorrow at 9 to call the dentist");
  await t.run();
  expect(t.db.all("SELECT timezone FROM contact")).toEqual([{ timezone: "Europe/London" }]);
  expect(t.db.all("SELECT due_ts FROM reminders")).toEqual([{ due_ts: ny("2026-11-05 09:00") }]); // set under a confirmed zone: untouched
  expect(t.state().reminder_due).toBe(ny("2026-11-05 09:00"));
});

test("a text message keeps text replies, and a reply in another script is sent as text even to a voice note", async () => {
  const t = setup({ reply: () => "react: none\nвсё хорошо" });
  await voiceNote(t, "как дела");
  await t.run();
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "text"]);
  const u = setup({ reply: () => "react: none\nall good" });
  await u.say("how are you");
  await u.run();
  expect(u.wa.sent.map((s) => s.kind)).toEqual(["typing", "text"]);
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
  expect(t.llm.calls[0].activeTools!()).not.toContain("view_page");
  await t.say("https://a.com/x");
  await t.run();
  expect(t.llm.calls[1].activeTools!()).toContain("view_page");
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
    expect(t.llm.calls.at(-1)!.activeTools!().includes("view_page")).toBe(attached);
  }
});

// search_web: the say line goes out first through the usual bubble path, then the results come back to the model.
const searchCall = (c: StreamCall, input = { say: "sec, let me look that up", query: "louvre hours" }) => c.tools!.search_web.execute!(input, { toolCallId: "s", messages: [] } as never);

test("search_web sends `say` first, then searches and returns at most 3 results capped at 3,000 characters; logged without the query", async () => {
  const order: string[] = [];
  const hits = [1, 2, 3, 4].map((i) => ({ title: `T${i}`, url: `https://${i}.example/`, text: "x".repeat(5000) }));
  const t = setup({
    search: async (q) => { order.push(`search:${q}`); return hits; },
    reply: async (c) => {
      const out = (await searchCall(c)) as { results: { text: string }[] };
      order.push("result");
      expect(out.results.map((r) => r.text.length)).toEqual([3000, 3000, 3000]);
      return "react: none\nopen 9 to 6 today";
    },
  });
  const log = vi.fn();
  t.deps.log = log;
  const send = t.wa.sendText.bind(t.wa);
  t.wa.sendText = async (...a) => { order.push(`send:${a[1]}`); return send(...a); };
  await t.say("is the louvre open today?");
  await t.run();
  expect(order).toEqual(["send:sec, let me look that up", "search:louvre hours", "result", "send:open 9 to 6 today"]);
  expect(t.wa.sent.map((s) => s.kind)).toEqual(["typing", "text", "typing", "typing", "text"]); // typing again after the say line, and before the next bubble
  expect(t.rows("direction = 'out'").map((r) => [r.text, r.status])).toEqual([["sec, let me look that up", "sent"], ["open 9 to 6 today", "sent"]]);
  expect(t.turns()[0].bubbles).toBe(2);
  expect(log).toHaveBeenCalledWith({ event: "search", results: 3, ms: expect.any(Number) });
  expect(JSON.stringify(log.mock.calls)).not.toContain("louvre");
});

test("search_web runs once per turn: a second call returns an error without a second say line or search", async () => {
  const search = vi.fn(async () => [{ title: "T", url: "https://t.example/", text: "hours" }]);
  const t = setup({ search, reply: async (c) => `react: none\n${JSON.stringify([await searchCall(c), await searchCall(c, { say: "one more sec", query: "again" })].map((r) => Object.keys(r as object)))}\n${JSON.stringify(await searchCall(c, { say: "x", query: "y" }))}` });
  await t.say("is the louvre open today?");
  await t.run();
  expect(search).toHaveBeenCalledTimes(1);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["sec, let me look that up", '[["results"],["error"]]\n{"error":"one search per turn"}']);
});

test("search_web with nothing found returns an empty list and a note (the harness default never touches the network)", async () => {
  const t = setup({ reply: async (c) => `react: none\n${JSON.stringify(await searchCall(c))}` });
  await t.say("what's the weather in almaty");
  await t.run();
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["sec, let me look that up", '{"results":[],"note":"nothing found"}']);
});

test("view_page is offered from the step after a search, so the model can open a result; forget and cancel_reminder are not", async () => {
  let before: string[] = [], after: string[] = [];
  const t = setup({ features: { memory: true }, object: () => ({ ops: [] }), reply: async (c) => { before = c.activeTools!(); await searchCall(c); after = c.activeTools!(); return "react: none\nok"; } });
  await t.say("no link here");
  await t.run();
  expect(before).toEqual(["set_reminder", "cancel_reminder", "forget", "make_page", "search_web"]);
  expect(after).toEqual(["set_reminder", "make_page", "view_page", "send_screenshot"]); // a fetched page must not be able to talk the model into deleting anything
});

test("without a search dependency there is no search_web tool and view_page keeps its link-only rule", async () => {
  const t = setup();
  t.deps.search = undefined;
  await t.say("no link here");
  await t.run();
  expect(Object.keys(t.llm.calls[0].tools!)).toEqual(["set_reminder", "cancel_reminder", "make_page"]);
});

test("a stream that dies after only the say line still gets the fallback: the say line is not an answer", async () => {
  const t = setup({ reply: async (c) => { await searchCall(c); return { chunks: ["react: none\n"], error: new Error("stream cut") }; } });
  await t.say("is the louvre open today?");
  await t.run();
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["sec, let me look that up", FALLBACK]);
  expect(t.rows("direction = 'in'").map((r) => r.status)).toEqual(["handled"]);
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

// Reminders: the reply model calls set_reminder during the turn; the timer sends their words back at that local time.
const call = async (c: StreamCall, name: string, input: unknown) => `react: none\n${JSON.stringify(await c.tools![name].execute!(input, { toolCallId: "t", messages: [] } as never))}`;
const remind = (text: string, at: string) => (c: StreamCall) => call(c, "set_reminder", { text, at });
const texts = (t: ReturnType<typeof setup>) => t.wa.sent.filter((s) => s.kind === "text");

test("set_reminder stores the reminder and arms the alarm; the timer sends it once, on time, in their words, with no model call", async () => {
  const t = setup({ reply: remind("call the dentist", "2026-11-05 09:00") });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("remind me tomorrow at 9 to call the dentist");
  await t.run();
  expect(texts(t).map((s) => s.body)).toEqual(['{"id":1,"at":"2026-11-05 09:00"}']);
  expect(t.db.all("SELECT text, due_ts, status, source_message_id FROM reminders")).toEqual([{ text: "call the dentist", due_ts: ny("2026-11-05 09:00"), status: "pending", source_message_id: "wamid.in.1" }]);
  expect(t.state().reminder_due).toBe(ny("2026-11-05 09:00"));
  expect(t.view.alarmAt).toBe(ny("2026-11-05 09:00"));
  await t.run(ny("2026-11-05 09:00") - 1);
  expect(texts(t)).toHaveLength(1);
  await t.run(ny("2026-11-05 09:00"));
  expect(texts(t).at(-1)).toMatchObject({ body: "Reminder: call the dentist", at: ny("2026-11-05 09:00") });
  expect(outs(t).map((r) => [r.text, r.status])).toEqual([['{"id":1,"at":"2026-11-05 09:00"}', "sent"], ["Reminder: call the dentist", "sent"]]);
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "sent" }]);
  expect(t.state().reminder_due).toBeNull();
  expect(t.view.alarmAt).toBeNull();
  await t.run(ny("2026-11-06 09:00"));
  expect(texts(t)).toHaveLength(2);
  expect(t.llm.calls).toHaveLength(1);
});

test("a reset during one reminder's send loses neither it nor the next: the cut-off one is sent again a minute later", async () => {
  const t = setup({ reply: async (c) => { await c.tools!.set_reminder.execute!({ text: "a", at: "2026-11-05 09:00" }, { toolCallId: "t", messages: [] } as never); return remind("b", "2026-11-05 10:00")(c); } });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("two reminders tomorrow");
  await t.run();
  expect(t.view.alarmAt).toBe(ny("2026-11-05 09:00"));
  const send = t.wa.sendText.bind(t.wa);
  t.wa.sendText = () => new Promise(() => {}); // the send hangs and the object is reset mid-handler
  t.clock.t = ny("2026-11-05 09:00");
  t.view.alarmAt = null;
  void t.core.alarm();
  await vi.waitFor(() => expect(t.db.all("SELECT status, attempted_at FROM reminders WHERE id = 1")).toEqual([{ status: "sending", attempted_at: ny("2026-11-05 09:00") }]));
  expect(t.state().reminder_due).toBeNull();
  t.wa.sendText = send;
  const fresh = new ContactCore(t.deps); // same storage, new instance; alarms are at-least-once, so it is delivered again
  await fresh.alarm();
  expect(t.view.alarmAt).toBe(ny("2026-11-05 09:01")); // the cut-off send's retry comes before the next reminder
  await drain(fresh, t.view, t.clock, ny("2026-11-05 10:00"));
  expect(texts(t).map((s) => [s.body, s.at])).toEqual([[expect.stringContaining('"id":2'), ny("2026-11-04 10:00") + 3000], ["Reminder: a", ny("2026-11-05 09:01")], ["Reminder: b", ny("2026-11-05 10:00")]]);
  expect(t.db.all("SELECT id, status FROM reminders ORDER BY id")).toEqual([{ id: 1, status: "sent" }, { id: 2, status: "sent" }]);
  expect(t.view.alarmAt).toBeNull();
});

// A contact row and a reminder already in 'sending', as a reset mid-send leaves it.
const stuck = async (attemptedAgo: number) => {
  const t = setup();
  await t.say("hi");
  await t.run();
  const now = t.clock.t;
  t.db.run("INSERT INTO reminders(text, due_ts, created_at, status, attempted_at) VALUES ('call mum', ?, ?, 'sending', ?)", now - attemptedAgo, now - 3_600_000, now - attemptedAgo);
  await t.core.alarm(); // nothing due yet: the alarm only re-arms from the table
  return { t, now };
};

test("a reminder left in 'sending' for 61 s is sent on the next alarm and ends sent; the alarm was armed for its retry time", async () => {
  const { t, now } = await stuck(61_000);
  expect(t.view.alarmAt).toBe(now - 1000); // attempted_at + 60 s, already past: fires at once
  await t.fire();
  expect(texts(t).map((s) => s.body)).toEqual(["ok", "Reminder: call mum"]);
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "sent" }]);
  expect(t.view.alarmAt).toBeNull();
});

test("a reminder in 'sending' for 10 s is not touched; the alarm is armed for attempted_at + 60 s", async () => {
  const { t, now } = await stuck(10_000);
  expect(t.state().reminder_due).toBe(now + 50_000);
  expect(t.view.alarmAt).toBe(now + 50_000);
  t.db.run("UPDATE state SET reminder_due=?", now); // an alarm that fires now anyway (another timer) leaves it alone
  await t.core.alarm();
  expect(texts(t)).toHaveLength(1);
  expect(t.db.all("SELECT status, attempted_at FROM reminders")).toEqual([{ status: "sending", attempted_at: now - 10_000 }]);
  expect(t.view.alarmAt).toBe(now + 50_000);
});

test("the retry of a cut-off send is marked sent before it goes out: a second reset cannot make it loop", async () => {
  const { t } = await stuck(61_000);
  t.wa.sendText = () => new Promise(() => {});
  t.view.alarmAt = null;
  void t.core.alarm();
  await vi.waitFor(() => expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "sent" }]));
  expect(t.state().reminder_due).toBeNull();
});

test("a reminder whose send fails ends skipped, logged without the text; the outbound row is failed", async () => {
  const t = setup({ reply: remind("call the dentist", "2026-11-04 10:30") });
  t.clock.t = ny("2026-11-04 10:00");
  const log = vi.fn();
  t.deps.log = log;
  await t.say("remind me at 10:30 to call the dentist");
  await t.run();
  t.wa.failNext = new WaError(0, 502, "bad gateway");
  await t.run(ny("2026-11-04 10:30"));
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "skipped" }]);
  expect(outs(t).at(-1)).toMatchObject({ text: "Reminder: call the dentist", status: "failed" });
  expect(log).toHaveBeenCalledWith({ event: "reminder_skipped", reason: "send", id: 1 });
  expect(JSON.stringify(log.mock.calls)).not.toContain("dentist");
  expect(t.view.alarmAt).toBeNull();
});

test("set_reminder refuses a time already past with an error the model can relay; nothing is stored or armed", async () => {
  const t = setup({ reply: remind("x", "2026-11-04 09:59") });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("remind me at 9:59");
  await t.run();
  expect(texts(t)[0].body).toContain("already past");
  expect(t.db.all("SELECT 1 FROM reminders")).toEqual([]);
  expect(t.view.alarmAt).toBeNull();
});

test("a reminder and a follow-up due the same day each fire once at their own time", async () => {
  const t = setup({ features: { memory: true }, object: planOps("2026-11-04 14:00"), reply: (c) => (c.job === "followup" ? "react: none\nhow did it go?" : remind("call the dentist", "2026-11-04 17:00")(c)) });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("interview at two today, remind me at 5 to call the dentist");
  await t.run(t.clock.t + 60_000);
  expect(t.state()).toMatchObject({ followup_due: ny("2026-11-04 16:00"), reminder_due: ny("2026-11-04 17:00") });
  await t.run(ny("2026-11-04 18:00"));
  expect(texts(t).map((s) => [s.body, s.at])).toEqual([[expect.stringContaining('"id":1'), ny("2026-11-04 10:00") + 3000], ["how did it go?", ny("2026-11-04 16:00")], ["Reminder: call the dentist", ny("2026-11-04 17:00")]]);
  expect(t.state()).toMatchObject({ followup_due: null, reminder_due: null });
  expect(t.view.alarmAt).toBeNull();
});

test("a reminder due more than 24 h after their last message is skipped and logged without the text, not sent; set_reminder warned about the window", async () => {
  const t = setup({ reply: remind("water the plants", "2026-11-06 09:00") });
  t.clock.t = ny("2026-11-04 10:00");
  const log = vi.fn();
  t.deps.log = log;
  await t.say("remind me the day after tomorrow at 9 to water the plants");
  await t.run(ny("2026-11-06 09:00"));
  expect(texts(t).map((s) => s.body)).toEqual(['{"id":1,"at":"2026-11-06 09:00","note":"on WhatsApp this will only arrive if you message me within the 24 hours before it"}']);
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "skipped" }]);
  expect(log).toHaveBeenCalledWith({ event: "reminder_skipped", reason: "window", id: 1 });
  expect(JSON.stringify(log.mock.calls)).not.toContain("plants");
  expect(t.state().reminder_due).toBeNull();
  expect(t.view.alarmAt).toBeNull();
});

test("pending reminders are listed in the prompt in local time; cancel_reminder clears the row and the alarm", async () => {
  const t = setup({ reply: (c) => (t.llm.calls.length === 1 ? remind("call the dentist", "2026-11-05 09:00")(c) : t.llm.calls.length === 2 ? "react: none\none" : call(c, "cancel_reminder", { id: 1 })) });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("remind me tomorrow at 9 to call the dentist");
  await t.run();
  t.clock.t += 60_000;
  await t.say("what reminders do I have?");
  await t.run();
  expect(t.llm.calls[1].system[1].content).toContain("reminders (pending, local time):\n- 2026-11-05 09:00 call the dentist (id 1)");
  t.clock.t += 60_000;
  await t.say("cancel the dentist one");
  await t.run();
  expect(texts(t).at(-1)?.body).toBe('{"cancelled":true}');
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "cancelled" }]);
  expect(t.state().reminder_due).toBeNull();
  expect(t.view.alarmAt).toBeNull();
});

// Telegram has no 24-hour window: the router asks the Telegram client (window24h false), so timers send and set_reminder adds no note.
const TG = { id: "tg:123456789:1", from: "tg:123456789" };
const onTelegram = (t: ReturnType<typeof setup>) => { const tg = new FakeWa(t.clock); tg.window24h = () => false; t.deps.wa = routeTransports(t.wa, tg); return tg; };
const utc = (s: string) => Date.parse(s.replace(" ", "T") + ":00Z");

test("a reminder due after 47 h of silence fires on a Telegram contact, and set_reminder returns no window note there", async () => {
  const t = setup({ reply: remind("water the plants", "2026-11-06 09:00") });
  const tg = onTelegram(t);
  t.clock.t = utc("2026-11-04 10:00"); // a tg: contact starts in UTC
  await t.say("remind me the day after tomorrow at 9 to water the plants", TG);
  await t.run(utc("2026-11-06 09:00"));
  expect(tg.sent.filter((s) => s.kind === "text").map((s) => [s.body, s.at])).toEqual([['{"id":1,"at":"2026-11-06 09:00"}', utc("2026-11-04 10:00") + 3000], ["Reminder: water the plants", utc("2026-11-06 09:00")]]);
  expect(t.wa.sent).toEqual([]);
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "sent" }]);
  expect(t.view.alarmAt).toBeNull();
});

test("a follow-up due after 25 h of silence fires on a Telegram contact and is skipped on a WhatsApp contact", async () => {
  for (const telegram of [true, false]) {
    const t = followupT(["2026-11-05 14:00"]); // 10:00 New York = 15:00 UTC; the plan resolves in the contact's zone
    const out = telegram ? onTelegram(t) : t.wa;
    await t.say("interview tomorrow at two", telegram ? TG : {});
    await t.run(t.clock.t + 60_000);
    await t.run(ny("2026-11-05 16:00") + 1);
    expect(out.sent.filter((s) => s.kind === "text").map((s) => s.body), `telegram=${telegram}`).toEqual(telegram ? ["ok", "how did it go?"] : ["ok"]);
    expect(t.db.all("SELECT followup_done FROM facts")).toEqual([{ followup_done: 1 }]);
    expect(t.view.alarmAt).toBeNull();
  }
});

test("after a search, view_page opens only links from the thread and the results, never a URL a result page suggests", async () => {
  const snapshot = vi.fn(async (_u: string) => PAGE);
  const out: unknown[] = [];
  const viewPage = (c: StreamCall, url: string) => c.tools!.view_page.execute!({ url }, { toolCallId: "v", messages: [] } as never);
  const t = setup({
    snapshot, search: async () => [{ title: "A", url: "https://a.example/hours", text: "hours" }],
    reply: async (c) => {
      out.push(null);
      await searchCall(c);
      out.push(await viewPage(c, "https://evil.example/x?u=1"), await viewPage(c, "https://a.example/hours"), await viewPage(c, "https://mine.example/"));
      return "react: none\nok";
    },
  });
  await t.say("look at https://mine.example/ and the louvre hours");
  await t.run();
  expect(out[1]).toEqual({ error: "could not open the page" });
  expect(out[2]).toMatchObject({ status: expect.anything() });
  expect(out[3]).toMatchObject({ status: expect.anything() });
  expect(snapshot.mock.calls.map((a) => a[0])).not.toContain("https://evil.example/x?u=1");
  expect(snapshot.mock.calls.map((a) => a[0])).toContain("https://a.example/hours");
});

test("a voice request in text works in a turn that ran search_web: the say line goes out as text, the answer as one voice note", async () => {
  const t = setup({ reply: async (c) => { await searchCall(c); return "react: none\nvoice: yes\nopen 9 to 6 today"; } });
  t.deps.tts = async () => ({ bytes: new Uint8Array([7]), mime: "audio/ogg" });
  await t.say("look up the louvre hours and send me a voice note");
  await t.run();
  expect(t.wa.sent.map((s) => s.kind).filter((k) => k !== "typing")).toEqual(["text", "audio"]);
});

test("a failed view_page open is not cached: the next call asks for the page again", async () => {
  let n = 0;
  const snapshot = vi.fn(async () => (++n === 1 ? null : PAGE));
  const res: unknown[] = [];
  const t = setup({ snapshot, reply: async (c) => { for (let i = 0; i < 2; i++) res.push(await c.tools!.view_page.execute!({ url: "https://mine.example/" }, { toolCallId: "v", messages: [] } as never)); return "react: none\nok"; } });
  await t.say("see https://mine.example/");
  await t.run();
  expect(res[0]).toEqual({ error: "could not open the page" });
  expect(res[1]).toMatchObject({ status: expect.anything() });
});

test("a reset during the fallback send leaves turn_attempts at 0", async () => {
  const t = setup({ reply: () => { throw new Error("upstream 500"); } });
  await t.say("the movie was great");
  await t.fire();
  expect(t.state().turn_attempts).toBe(1);
  t.wa.sendText = () => new Promise(() => {});
  void t.fire();
  await new Promise((r) => setTimeout(r, 20));
  expect(t.state().turn_attempts).toBe(0);
});

test("a reminder whose send returns an empty id counts as sent in both the reminder row and the message row", async () => {
  const t = setup({ reply: remind("call the dentist", "2026-11-04 10:30") });
  t.clock.t = ny("2026-11-04 10:00");
  await t.say("remind me at 10:30 to call the dentist");
  await t.run();
  const send = t.wa.sendText.bind(t.wa);
  t.wa.sendText = async (...a) => ({ ...(await send(...a)), id: "" });
  await t.run(ny("2026-11-04 10:30"));
  expect(t.db.all("SELECT status FROM reminders")).toEqual([{ status: "sent" }]);
  expect(outs(t).at(-1)).toMatchObject({ text: "Reminder: call the dentist", status: "sent" });
});

// make_page: the say line first, then the page model, then the link in the reply model's own bubble.
const pageCall = (c: StreamCall, input = { say: "give me a minute, putting that together", title: "Lisbon plan", brief: "three days in Lisbon" }) => c.tools!.make_page.execute!(input, { toolCallId: "p", messages: [] } as never);

test("make_page sends `say` before the page model runs; the link comes back in a normal bubble and a row lands in pages", async () => {
  const order: string[] = [];
  const t = setup({
    text: () => { order.push("generate"); return STUB_PAGE; },
    reply: async (c) => {
      const out = (await pageCall(c)) as { url: string; title: string };
      order.push("result");
      return `react: none\nhere: ${out.url}`;
    },
  });
  const send = t.wa.sendText.bind(t.wa);
  t.wa.sendText = async (...a) => { order.push(`send:${a[1].slice(0, 20)}`); return send(...a); };
  await t.say("plan me three days in lisbon");
  await t.run();
  const id = t.db.all<{ id: string }>("SELECT id FROM pages")[0].id;
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(order).toEqual(["send:give me a minute, pu", "generate", "result", `send:here: https://wapp-a`]);
  const texts = t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body);
  expect(texts).toEqual(["give me a minute, putting that together", `here: https://wapp-agent.test/p/test/${id}`]);
  expect(t.llm.textCalls[0].messages[0].content).toBe("Title: Lisbon plan\n\nBrief:\nthree days in Lisbon");
  expect(t.turns()[0].bubbles).toBe(2);
});

test("make_page: one page per turn, and the repeated say line is not sent twice", async () => {
  const t = setup({ reply: async (c) => `react: none\n${JSON.stringify([Object.keys((await pageCall(c)) as object), await pageCall(c)])}` });
  await t.say("plan it");
  await t.run();
  expect(t.llm.textCalls).toHaveLength(1);
  expect(t.db.all("SELECT 1 FROM pages")).toHaveLength(1);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["give me a minute, putting that together", '[["url","title"],{"error":"one page per turn"}]']);
});

test("make_page: the 11th page in 24 hours is refused with no say line and no model call; a day later it works again", async () => {
  let out: unknown;
  const t = setup({ reply: async (c) => { out = await pageCall(c); return "react: none\nok"; } });
  for (let i = 0; i < 10; i++) t.db.run("INSERT INTO page_builds(at) VALUES (?)", t.clock.t - 3_600_000 * i); // edits of one page count as much as new pages
  await t.say("plan it");
  await t.run();
  expect(out).toEqual({ error: expect.stringContaining("10 pages") });
  expect(t.llm.textCalls).toHaveLength(0);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["ok"]);
  t.clock.t += 24 * 3_600_000;
  await t.say("again");
  await t.run();
  expect(out).toMatchObject({ title: "Lisbon plan" });
});

test("make_page passes page_id to the builder and the prompt lists pages; an id with no source is refused before the say line", async () => {
  let out: unknown;
  const t = setup({ reply: async (c) => { out = await c.tools!.make_page.execute!({ say: "one sec", title: "L", brief: "add x", page_id: id }, { toolCallId: "p", messages: [] } as never); return "react: none\nok"; } });
  const id = "A".repeat(22);
  t.db.run("INSERT INTO pages(id, title, html, bytes, created_at, source, state) VALUES (?, 'L', '<input type=\"checkbox\"> socks', 1, ?, '- [ ] socks', '[]')", id, t.clock.t);
  await t.say("add x to my list");
  await t.run();
  expect(out).toMatchObject({ title: "L", url: expect.stringContaining(id) });
  expect(t.llm.textCalls[0].messages[0].content).toContain("Here is the current page");
  expect(t.llm.calls[0].system[1].content).toContain(`- L (id ${id}, 0 of 1 ticked; left: socks)`);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["one sec", "ok"]);
  t.db.run("UPDATE pages SET source=NULL"); // an old page: not editable
  t.clock.t += 60_000;
  out = undefined;
  await t.say("again");
  await t.run();
  expect(out).toEqual({ error: expect.stringContaining("before edits") });
  expect(t.llm.textCalls).toHaveLength(1);
  expect(t.llm.calls.at(-1)!.system[1].content).toContain("- L (not editable");
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["one sec", "ok", "ok"]);
});

test("make_page: a page model failure is relayed as an error and logged; the say line still counts as sent", async () => {
  const t = setup({ text: () => { throw new Error("boom"); }, reply: async (c) => `react: none\n${JSON.stringify(await pageCall(c))}` });
  const log = vi.fn();
  t.deps.log = log;
  await t.say("plan it");
  await t.run();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "page_failed", error: "boom" }));
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["give me a minute, putting that together", '{"error":"could not build the page"}']);
  expect(t.db.all("SELECT 1 FROM pages")).toHaveLength(0);
  expect(t.db.all("SELECT 1 FROM page_builds")).toHaveLength(1); // a failed call still counts against the cap
});

test("make_page stays offered after a search ran (a sandboxed page cannot delete anything)", async () => {
  let after: string[] = [];
  const t = setup({ reply: async (c) => { await searchCall(c); after = c.activeTools!(); return "react: none\nok"; } });
  await t.say("no link here");
  await t.run();
  expect(after).toContain("make_page");
});

// send_screenshot: the cached snapshot's JPEG goes out as an image through the transport.
const shotCall = (c: StreamCall, input: { url: string; caption?: string }) => c.tools!.send_screenshot.execute!(input, { toolCallId: "s", messages: [] } as never);

test("send_screenshot sends the snapshot's JPEG with the caption and stores an outbound image row; one snapshot serves both tools", async () => {
  const snapshot = vi.fn(async () => PAGE);
  let out: unknown;
  const t = setup({ snapshot, reply: async (c) => { out = await shotCall(c, { url: "https://a.com/x", caption: "the page" }); return "react: none\nthere"; } });
  await t.say("show me https://a.com/x");
  await t.run();
  expect(out).toEqual({ sent: true });
  expect(snapshot).toHaveBeenCalledTimes(1);
  const img = t.wa.sent.find((s) => s.kind === "image")!;
  expect(img).toMatchObject({ to: FROM, mime: "image/jpeg", caption: "the page", bytes: PAGE.jpeg });
  expect(t.rows("kind = 'image'").map((r) => [r.text, r.status])).toEqual([["[screenshot of https://a.com/x] the page", "sent"]]);
  expect(t.turns()[0].bubbles).toBe(2);
});

test("send_screenshot retakes a cached snapshot that has no picture, and says so when there is still none", async () => {
  const snapshot = vi.fn(async () => ({ ...PAGE, jpeg: new Uint8Array() }));
  let out: unknown;
  const t = setup({ snapshot, reply: async (c) => { out = await shotCall(c, { url: "https://a.com/x" }); return "react: none\nsorry"; } });
  await t.say("show me https://a.com/x");
  await t.run();
  expect(out).toEqual({ error: "could not take a screenshot" });
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(t.wa.sent.some((s) => s.kind === "image")).toBe(false);
});

test("send_screenshot after a search only takes thread links and results; any other URL is refused", async () => {
  const outs: unknown[] = [];
  const t = setup({
    snapshot: async () => PAGE, search: async () => [{ title: "R", url: "https://r.example/", text: "x" }],
    reply: async (c) => { await searchCall(c); for (const url of ["https://evil.example/", "https://r.example/"]) outs.push(await shotCall(c, { url })); return "react: none\nok"; },
  });
  await t.say("is the louvre open");
  await t.run();
  expect(outs).toEqual([{ error: "could not open the page" }, { sent: true }]);
  expect(t.wa.sent.filter((s) => s.kind === "image")).toHaveLength(1);
});

test("send_screenshot reports a transport without sendImage and a failed send", async () => {
  const outs: unknown[] = [];
  const t = setup({ snapshot: async () => PAGE, reply: async (c) => { outs.push(await shotCall(c, { url: "https://a.com/x" })); return "react: none\nok"; } });
  (t.deps.wa as { sendImage?: unknown }).sendImage = async () => { throw new WaError(0, 500, "nope"); };
  await t.say("see https://a.com/x");
  await t.run();
  (t.deps.wa as { sendImage?: unknown }).sendImage = undefined;
  t.clock.t += 60_000;
  await t.say("again https://a.com/x");
  await t.run();
  expect(outs).toEqual([{ error: "could not send the screenshot" }, { error: "images cannot be sent here" }]);
});

test("a voice-note turn whose bubble holds a link sends the link as text, not as speech", async () => {
  const t = setup({ reply: () => "react: none\nhere: https://wapp-agent.test/p/k/abc" });
  await voiceNote(t);
  await t.run();
  expect(t.wa.sent.filter((s) => s.kind === "audio")).toHaveLength(0);
  expect(t.wa.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["here: https://wapp-agent.test/p/k/abc"]);
});
