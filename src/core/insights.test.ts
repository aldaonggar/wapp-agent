import { expect, test, vi } from "vitest";
import { FakeClock, FakeWa, hashEmbed, makeEvalDeps, stubLlm } from "../../evals/harness";
import { blobToVec, vecToBlob } from "./db";
import { INSIGHT_PROMPT, deriveInsights } from "./insights";
import { cascadeInsights, recall, remember } from "./memory";
import { buildPrompt } from "./prompt";
import type { ObjectCall } from "./types";

type Ins = { text: string; confidence: number; evidence_fact_ids: number[] };
function setup(object: (c: ObjectCall<unknown>) => unknown) {
  const clock = new FakeClock();
  const llm = stubLlm({ object });
  const deps = makeEvalDeps({ clock: clock.forContact("a"), wa: new FakeWa(clock), llm, embed: vi.fn(hashEmbed), features: { memory: true } });
  const { db } = deps;
  db.run("INSERT INTO contact(id, wa_id, timezone) VALUES (1, '15550000001', 'UTC')");
  const addFact = async (text: string, at = clock.t) => db.all<{ id: number }>("INSERT INTO facts(text, kind, signal, created_at, source_message_ids, embedding) VALUES (?, 'plan', 4, ?, '[]', ?) RETURNING id", text, at, vecToBlob((await hashEmbed([text]))[0]))[0].id;
  const rows = () => db.all<{ text: string; confidence: number; evidence_fact_ids: string; embedding: Uint8Array; status: string }>("SELECT * FROM insights ORDER BY id");
  return { clock, llm, deps, db, addFact, rows };
}
const two = (a: number, b: number): { insights: Ins[] } => ({ insights: [
  { text: "Trip clashes with the sister's birthday", confidence: 0.9, evidence_fact_ids: [a, b] },
  { text: "Maybe likes travel", confidence: 0.3, evidence_fact_ids: [a, b] },
] });

test("deriveInsights stores insights with confidence >= 0.5 and evidence ids", async () => {
  let ids: [number, number] = [0, 0];
  const t = setup(() => two(...ids));
  const old = await t.addFact("Sister Aru birthday on 2026-12-12", t.clock.t - 1000);
  t.db.run("UPDATE state SET last_insights_run=?", t.clock.t - 500);
  const fresh = await t.addFact("Flight to Almaty on 2026-12-10");
  ids = [old, fresh];
  expect(await deriveInsights(t.deps, "sess")).toBe(1);
  const [r, ...rest] = t.rows();
  expect(rest).toEqual([]);
  expect(r).toMatchObject({ text: "Trip clashes with the sister's birthday", confidence: 0.9, evidence_fact_ids: JSON.stringify([old, fresh]), status: "active" });
  expect(blobToVec(r.embedding)).toHaveLength(64);
  expect(t.db.all("SELECT last_insights_run AS t FROM state")).toEqual([{ t: t.clock.t }]);
  const call = t.llm.objectCalls[0];
  expect(call).toMatchObject({ job: "derive", modelId: t.deps.models.derive, sessionId: "sess", system: INSIGHT_PROMPT });
  expect(call.reasoning).toEqual({ effort: "medium" }); // EFFORT.derive: insights run offline, so thinking is cheap here
  const text = (call.messages[0].content as string);
  expect(text).toContain(`New facts:\n[${fresh}] Flight to Almaty`);
  expect(text).toContain(`Related older facts:\n[${old}] Sister Aru birthday`);
});

test("deriveInsights without new facts makes no call; foreign evidence ids are dropped", async () => {
  let a = 0;
  const t = setup(() => ({ insights: [
    { text: "Bogus", confidence: 0.9, evidence_fact_ids: [1, 99] },
    { text: "Twice the same", confidence: 0.8, evidence_fact_ids: [a, a] },
    { text: "Only one", confidence: 0.8, evidence_fact_ids: [a] },
  ] }));
  expect(await deriveInsights(t.deps)).toBe(0);
  expect(t.llm.objectCalls).toHaveLength(0);
  a = await t.addFact("Flight on 2026-12-10");
  t.db.run("UPDATE state SET last_insights_run=?", t.clock.t - 1);
  expect(await deriveInsights(t.deps)).toBe(0);
  expect(t.rows()).toEqual([]);
});

test("insight is removed when its evidence fact is superseded", async () => {
  const t = setup(() => ({ insights: [] }));
  const a = await t.addFact("Flight on 2026-12-10"), b = await t.addFact("Birthday on 2026-12-12");
  t.db.run("INSERT INTO insights(text, confidence, evidence_fact_ids, created_at) VALUES ('x', 0.9, ?, 0)", JSON.stringify([a, b]));
  cascadeInsights(t.db, [b]);
  expect(t.rows()).toEqual([]);
});

test("recall labels insights as derived with confidence", async () => {
  const t = setup(() => ({ insights: [] }));
  const a = await t.addFact("Flight to Almaty on 2026-12-10"), b = await t.addFact("Sister Aru birthday on 2026-12-12");
  const llm = stubLlm({ object: () => two(a, b) });
  const deps = { ...t.deps, llm };
  await deriveInsights(deps);
  const { hits } = await recall(t.deps, "Almaty trip");
  const hit = hits.find((h) => h.kind === "insight")!;
  expect(hit).toMatchObject({ kind: "insight", confidence: 0.9 });
  const base = { profile: "", history: [], pending: [], nowLocal: "2026-11-04 09:00", tz: "UTC", tzConfirmed: true, snapshots: [] };
  expect(buildPrompt({ ...base, memories: hits, memory: true }).system[1].content).toContain("Trip clashes with the sister's birthday (derived, confidence 0.9)");
});

test("superseding an evidence fact through remember removes the insight that cited it", async () => {
  let a = 0;
  const t = setup(() => ({ ops: [{ op: "UPDATE", target_id: a, text: "Flight to Almaty on 2026-12-11", kind: "plan", signal: 5 }] }));
  a = await t.addFact("Flight to Almaty on 2026-12-10");
  const b = await t.addFact("Sister Aru birthday on 2026-12-12");
  t.db.run("INSERT INTO insights(text, confidence, evidence_fact_ids, created_at) VALUES ('Trip meets birthday', 0.9, ?, 0)", JSON.stringify([a, b]));
  const turn = { messages: [{ role: "user" as const, text: "Flight to Almaty on 2026-12-10", id: "w1" }], images: [], nowLocal: "2026-11-04 09:00", tz: "UTC", sessionId: "s" };
  expect(await remember(t.deps, turn)).toMatchObject({ updated: 1 });
  expect(t.rows()).toEqual([]);
});
