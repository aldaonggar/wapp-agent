import { expect, test, vi } from "vitest";
import { FakeClock, FakeWa, hashEmbed, makeEvalDeps, stubLlm } from "../../evals/harness";
import { vecToBlob } from "./db";
import { EXTRACT_PROMPT, cascadeInsights, forget, profileText, recall, remember, type TurnForMemory } from "./memory";
import type { Features, ObjectCall } from "./types";

const DAY = 86_400_000;
type Op = { op: "ADD" | "UPDATE" | "DELETE" | "NONE"; text: string; kind: string; signal: number; event_date?: string | null; target_id?: number | null };
const op = (o: Partial<Op>): Op => ({ op: "ADD", text: "", kind: "person", signal: 4, ...o });
const vec = (...xs: number[]) => { const v = new Float32Array(64); xs.forEach((x, i) => (v[i] = x)); return v; };

function setup(object: (c: ObjectCall<unknown>) => unknown = () => ({ ops: [] }), features: Partial<Features> = {}) {
  const clock = new FakeClock(); // 2026-11-04 09:00 UTC
  const llm = stubLlm({ object });
  const embed = vi.fn(hashEmbed);
  const deps = makeEvalDeps({ clock: clock.forContact("a"), wa: new FakeWa(clock), llm, embed, features: { memory: true, ...features } });
  const log = vi.fn();
  deps.log = log;
  const { db } = deps;
  db.run("INSERT INTO contact(id, wa_id, timezone) VALUES (1, '15550000001', 'UTC')");
  const turn = (text: string, extra: Partial<TurnForMemory> = {}): TurnForMemory => ({
    messages: [{ role: "user", text, id: "wamid.1" }, { role: "assistant", text: "ok", id: "wamid.out.1" }],
    images: [], nowLocal: "2026-11-04 09:00", tz: "UTC", sessionId: "sess", ...extra,
  });
  const facts = () => db.all<{ id: number; text: string; kind: string; signal: number; status: string; superseded_by: number | null; event_date: string | null; source_message_ids: string }>("SELECT * FROM facts ORDER BY id");
  const fts = () => db.all<{ text: string; fact_id: number }>("SELECT text, fact_id FROM facts_fts ORDER BY fact_id");
  const addFact = async (text: string, o: { kind?: string; v?: Float32Array; at?: number; status?: string } = {}) => {
    const v = o.v ?? (await hashEmbed([text]))[0];
    const id = db.all<{ id: number }>("INSERT INTO facts(text, kind, signal, created_at, source_message_ids, status, embedding) VALUES (?, ?, 4, ?, '[]', ?, ?) RETURNING id",
      text, o.kind ?? "person", o.at ?? clock.t, o.status ?? "active", vecToBlob(v))[0].id;
    db.run("INSERT INTO facts_fts(text, fact_id) VALUES (?, ?)", text, id);
    return id;
  };
  const addInsight = (text: string, evidence: number[] | null, v = vec(1)) =>
    db.run("INSERT INTO insights(text, confidence, evidence_fact_ids, created_at, embedding) VALUES (?, 0.8, ?, ?, ?)", text, evidence && JSON.stringify(evidence), clock.t, vecToBlob(v));
  const insights = () => db.all<{ text: string }>("SELECT text FROM insights ORDER BY id").map((r) => r.text);
  const input = (i = 0) => llm.objectCalls[i].messages[0].content as { type: string; text?: string; mediaType?: string; data?: Uint8Array }[];
  return { clock, llm, embed, deps, db, log, turn, facts, fts, addFact, addInsight, insights, input };
}

test("remember persists only signal >= 3 and embeds in one batch", async () => {
  const t = setup(() => ({ ops: [
    op({ text: "Had pasta for lunch", kind: "other", signal: 2 }),
    op({ text: "Dentist appointment on 2026-11-12 09:30", kind: "plan", signal: 3, event_date: "2026-11-12T09:30:00" }),
    op({ text: "Sister Aru lives in Almaty", signal: 5, event_date: "someday" }),
  ] }));
  expect(await remember(t.deps, t.turn("dentist thursday next week 9:30, had pasta btw. oh and my sister Aru lives in Almaty"))).toEqual({ added: 2, updated: 0, deleted: 0 });
  expect(t.facts().map((f) => [f.text, f.kind, f.signal, f.event_date, f.status, f.source_message_ids])).toEqual([
    ["Dentist appointment on 2026-11-12 09:30", "plan", 3, "2026-11-12 09:30", "active", '["wamid.1"]'],
    ["Sister Aru lives in Almaty", "person", 5, null, "active", '["wamid.1"]'],
  ]);
  expect(t.embed).toHaveBeenCalledTimes(1); // no stored facts yet, so no similarity lookup
  expect(t.embed.mock.calls[0][0]).toEqual(["Dentist appointment on 2026-11-12 09:30", "Sister Aru lives in Almaty"]);
  expect(t.fts().map((r) => r.text)).toEqual(["Dentist appointment on 2026-11-12 09:30", "Sister Aru lives in Almaty"]);
  const call = t.llm.objectCalls[0];
  expect(call).toMatchObject({ job: "extract", modelId: t.deps.models.extract, sessionId: "sess", system: EXTRACT_PROMPT });
  const text = t.input()[0].text!;
  expect(text).toContain("Now: Wednesday 2026-11-04 09:00 (UTC)");
  expect(text).toContain("Wed 2026-11-04 (today), Thu 2026-11-05");
  expect(text).toContain("user: dentist thursday next week 9:30");
  expect(text).toContain("assistant: ok");
  expect(t.db.all("SELECT * FROM calls")).toHaveLength(1); // the eval ledger hook only; remember adds nothing
});

test("remember shows the extractor the profile, the 10 most similar active facts and the images", async () => {
  const t = setup();
  t.db.run("INSERT INTO profile(id, text, updated_at) VALUES (1, 'Name: Nur', 0)");
  for (let i = 1; i <= 12; i++) await t.addFact(`Friend number ${i} plays chess`);
  await t.addFact("Sister Aru lived in Almaty", { status: "superseded" });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  await remember(t.deps, t.turn("my friend plays chess with my sister in Almaty", { images: [{ messageId: "wamid.1", bytes: jpeg, mime: "image/jpeg" }] }));
  expect(t.embed).toHaveBeenCalledTimes(1);
  expect(t.embed.mock.calls[0][0]).toEqual(["my friend plays chess with my sister in Almaty"]);
  const [part, file] = t.input();
  expect(part.text).toContain("Current profile:\nName: Nur");
  const listed = part.text!.split("\n").filter((l) => /^\[\d+\] /.test(l));
  expect(listed).toHaveLength(10);
  expect(listed[0]).toMatch(/^\[\d+\] Friend number \d+ plays chess \(person, 2026-11-04\)$/);
  expect(part.text).not.toContain("lived in Almaty");
  expect(file).toEqual({ type: "file", mediaType: "image/jpeg", data: jpeg });
  expect(t.facts()).toHaveLength(13);
});

test("remember is a no-op with memory off", async () => {
  const t = setup(undefined, { memory: false });
  expect(await remember(t.deps, t.turn("my sister lives in Almaty"))).toEqual({ added: 0, updated: 0, deleted: 0 });
  expect(t.llm.objectCalls).toHaveLength(0);
  expect(t.embed).not.toHaveBeenCalled();
});

test("UPDATE supersedes and keeps the old fact retrievable", async () => {
  const t = setup(() => ({ ops: [op({ op: "UPDATE", text: "Sister Aru lives in Astana", signal: 5, target_id: 1 })] }));
  await t.addFact("Sister Aru lives in Almaty");
  t.clock.t += 4 * DAY;
  expect(await remember(t.deps, t.turn("Aru moved to Astana"))).toEqual({ added: 0, updated: 1, deleted: 0 });
  expect(t.facts().map((f) => [f.id, f.status, f.superseded_by])).toEqual([[1, "superseded", 2], [2, "active", null]]);
  const { hits } = await recall(t.deps, "where does sister Aru live");
  expect(hits.map((h) => [h.text, h.status, h.date])).toEqual(expect.arrayContaining([
    ["Sister Aru lives in Astana", "active", "2026-11-08"],
    ["Sister Aru lives in Almaty", "superseded", "2026-11-08"], // the day it stopped being true
  ]));
  expect(t.fts()).toHaveLength(2); // superseded facts stay searchable
});

test("a target_id the extractor was not shown is never touched", async () => {
  const t = setup(() => ({ ops: [op({ op: "UPDATE", text: "Brother Tom is a doctor", target_id: 99 }), op({ op: "DELETE", text: "x", target_id: 1 })] }));
  await t.addFact("Has a dog named Biscuit");
  // An empty user text skips the similarity lookup, so fact 1 is not shown and cannot be deleted.
  expect(await remember(t.deps, { ...t.turn(""), messages: [{ role: "assistant", text: "hi", id: "o" }] })).toEqual({ added: 1, updated: 0, deleted: 0 });
  expect(t.facts().map((f) => [f.text, f.status])).toEqual([["Has a dog named Biscuit", "active"], ["Brother Tom is a doctor", "active"]]);
});

test("DELETE and UPDATE cascade to insights", async () => {
  const t = setup(() => ({ ops: [op({ op: "UPDATE", text: "Sister Aru lives in Astana", target_id: 1 }), op({ op: "DELETE", text: "Has a dog named Biscuit", target_id: 2 })] }));
  await t.addFact("Sister Aru lives in Almaty");
  await t.addFact("Has a dog named Biscuit");
  await t.addFact("Likes espresso");
  t.addInsight("Visits Almaty for the sister", [1, 3]);
  t.addInsight("Needs a dog sitter when travelling", [2]);
  t.addInsight("Coffee lover", [3]);
  t.addInsight("No evidence", null);
  expect(await remember(t.deps, t.turn("Aru moved to Astana and Biscuit is gone, forget the dog"))).toEqual({ added: 0, updated: 1, deleted: 1 });
  expect(t.facts().map((f) => [f.text, f.status])).toEqual([["Sister Aru lives in Almaty", "superseded"], ["Likes espresso", "active"], ["Sister Aru lives in Astana", "active"]]);
  expect(t.fts().map((r) => r.text)).not.toContain("Has a dog named Biscuit");
  expect(t.insights()).toEqual(["Coffee lover", "No evidence"]);
  cascadeInsights(t.db, []);
  expect(t.insights()).toHaveLength(2);
});

test("recall hybrid merges an FTS hit that cosine missed", async () => {
  const t = setup();
  const seeds = ["Likes espresso", "Plays chess", "Drinks oat milk", "Reads at night", "Bakes bread", "Runs in the park"];
  for (let i = 0; i < 30; i++) await t.addFact(`${seeds[i % seeds.length]} ${i}`);
  const [q] = await hashEmbed(["Monzo?"]);
  await t.addFact("Interview at Monzo", { v: q.map((x) => -x) }); // the farthest vector there is
  expect((await recall(t.deps, "Monzo?")).hits.map((h) => h.text)).toContain("Interview at Monzo");
  t.deps.features.retrieval = "cosine";
  expect((await recall(t.deps, "Monzo?")).hits.map((h) => h.text)).not.toContain("Interview at Monzo");
});

test('recall("") returns [] without calling embed', async () => {
  const t = setup();
  await t.addFact("Sister Aru lives in Almaty");
  expect(await recall(t.deps, "")).toEqual({ hits: [], ms: 0 });
  expect(await recall(t.deps, " \n ")).toEqual({ hits: [], ms: 0 });
  expect(t.embed).not.toHaveBeenCalled();
});

test("a failing recall returns no hits and logs recall_failed", async () => {
  const t = setup();
  await t.addFact("Sister Aru lives in Almaty");
  t.deps.embed = async () => { throw new Error("workers-ai down"); };
  const r = await recall(t.deps, "where does my sister live");
  expect(r.hits).toEqual([]);
  expect(r.ms).toBeTypeOf("number");
  expect(t.log).toHaveBeenCalledWith({ event: "recall_failed", error: "workers-ai down" });
});

test("recall cosine scores cos + 0.05 x recency, labels insights and keeps the top k", async () => {
  const t = setup(undefined, { retrieval: "cosine" });
  t.deps.embed = async (texts) => texts.map(() => vec(1));
  await t.addFact("Old fact", { v: vec(1), at: t.clock.t - 365 * DAY }); // recency 0
  await t.addFact("New fact", { v: vec(1) }); // recency 1
  await t.addFact("Half fact", { v: vec(0.5, Math.sqrt(0.75)) });
  t.addInsight("Derived thing", [2], vec(0.8, 0.6));
  const { hits } = await recall(t.deps, "anything", 3);
  expect(hits.map((h) => [h.text, h.kind, h.score.toFixed(3)])).toEqual([["New fact", "fact", "1.050"], ["Old fact", "fact", "1.000"], ["Derived thing", "insight", "0.850"]]);
  expect(hits[2]).toMatchObject({ confidence: 0.8, status: "active", date: "2026-11-04" });
  expect(hits[1].date).toBe("2025-11-04");
});

test("forget removes by substring and returns the count", async () => {
  const t = setup();
  t.embed.mockImplementation(async (texts) => texts.map((_, i) => (i ? vec(0, 0, 1) : vec(0, 1)))); // orthogonal to everything: substring only
  await t.addFact("Sister Aru lives in Almaty", { v: vec(1) });
  await t.addFact("Sister Aru lived in Almaty before Astana", { status: "superseded", v: vec(1) });
  await t.addFact("Has a dog named Biscuit", { v: vec(1) });
  t.addInsight("Visits ALMATY often", [1]);
  t.db.run("INSERT INTO profile(id, text, updated_at) VALUES (1, ?, 0)", "Name: Nur\nSister: Aru, lives in Almaty");
  expect(await forget(t.deps, "almaty")).toBe(2);
  expect(t.facts().map((f) => f.text)).toEqual(["Has a dog named Biscuit"]);
  expect(t.fts().map((r) => r.text)).toEqual(["Has a dog named Biscuit"]);
  expect(t.insights()).toEqual([]);
  expect(profileText(t.db)).toBe("Name: Nur");
  t.embed.mockClear();
  expect(await forget(t.deps, "  ")).toBe(0);
  expect(t.embed).not.toHaveBeenCalled();
});

test("forget by similarity deletes the best match and near ties, never a distant one above 0.6", async () => {
  const t = setup();
  t.deps.embed = async (texts) => texts.map(() => vec(1));
  await t.addFact("Has a dog named Biscuit", { v: vec(1) }); // 1.00
  await t.addFact("Walks the dog every morning", { v: vec(0.97, Math.sqrt(1 - 0.97 ** 2)) }); // 0.97: within 0.05 of the best
  await t.addFact("Uses a standing desk", { v: vec(0.62, Math.sqrt(1 - 0.62 ** 2)) }); // 0.62: above 0.6 but far from the best
  expect(await forget(t.deps, "the pup")).toBe(2);
  expect(t.facts().map((f) => f.text)).toEqual(["Uses a standing desk"]);
});

test("profile upsert", async () => {
  let reply: unknown = { ops: [op({ text: "Name is Nur", kind: "identity", signal: 5 })], profile: "Name: Nur" };
  const t = setup(() => reply);
  await remember(t.deps, t.turn("I'm Nur"));
  expect(profileText(t.db)).toBe("Name: Nur");
  reply = { ops: [op({ text: "Sister Aru lives in Almaty", signal: 5 })], profile: "Name: Nur\nSister: Aru (Almaty)" };
  await remember(t.deps, t.turn("my sister Aru lives in Almaty"));
  expect(t.db.all("SELECT text FROM profile")).toEqual([{ text: "Name: Nur\nSister: Aru (Almaty)" }]);
  reply = { ops: [], profile: null };
  await remember(t.deps, t.turn("haha ok"));
  expect(profileText(t.db)).toBe("Name: Nur\nSister: Aru (Almaty)");
  reply = { ops: [], profile: "x".repeat(5000) };
  await remember(t.deps, t.turn("long"));
  expect(profileText(t.db).length).toBe(1200); // ~300 tokens
});

test("media_note is written to the image row", async () => {
  const t = setup(() => ({ ops: [], media_note: "photo of a red road bike" }));
  for (const id of ["wamid.1", "wamid.2"]) t.db.run("INSERT INTO messages(id, direction, kind, text, ts) VALUES (?, 'in', 'image', '[photo]', 0)", id);
  const img = (messageId: string) => ({ messageId, bytes: new Uint8Array([1]), mime: "image/jpeg" });
  await remember(t.deps, t.turn("my new bike!", { images: [img("wamid.1"), img("wamid.2")] }));
  expect(t.db.all("SELECT id, media_note FROM messages ORDER BY id")).toEqual([{ id: "wamid.1", media_note: "photo of a red road bike" }, { id: "wamid.2", media_note: null }]);
  await expect(remember(t.deps, t.turn("no image here"))).resolves.toBeTruthy(); // a note without an image is dropped
});

test('timezone "Europe/Lisbon" updates the contact row, "Mars/Olympus" is ignored', async () => {
  let tz = "Europe/Lisbon";
  const t = setup(() => ({ ops: [], timezone: tz }));
  const contact = () => t.db.all("SELECT timezone, timezone_confirmed FROM contact")[0];
  await remember(t.deps, t.turn("I live in Lisbon now"));
  expect(contact()).toEqual({ timezone: "Europe/Lisbon", timezone_confirmed: 1 });
  tz = "Mars/Olympus";
  await remember(t.deps, t.turn("off to Olympus Mons"));
  expect(contact()).toEqual({ timezone: "Europe/Lisbon", timezone_confirmed: 1 });
});
