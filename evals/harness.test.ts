import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Llm, StreamCall } from "../src/core/types";
import { cosineRerank, evalConfig, evalEmbedders, hashEmbed, loadScenarios, parseAt, runScenario, stubLlm, type EvalConfig, type Scenario } from "./harness";

const cfg: EvalConfig = { memory: false, retrieval: "hybrid", tag: "test" };
const local = { embed: hashEmbed, rerank: cosineRerank }; // never the REST clients, whatever the env
const run = (steps: Scenario["steps"], llm: Llm, c = cfg, embedders = local) => runScenario({ name: "t", category: "short-term", steps }, c, llm, embedders);
const pendingText = (c: StreamCall) => JSON.stringify(c.messages.at(-1));
const echo = (c: StreamCall) => `react: none\necho ${[...pendingText(c).matchAll(/\] ([^"\\]+)/g)].map((m) => m[1]).join(" + ")}`;

afterEach(() => { vi.unstubAllEnvs(); });

test("loadScenarios parses every step kind and filters by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "scenarios-"));
  writeFileSync(join(dir, "one.yaml"), `
name: every-kind
category: long-term
steps:
  - seed_facts: 30
  - { at: +0s, say: "A: pizza" }
  - { at: +1s, contact: b, image: photo.jpg, caption: look }
  - { at: +2s, url: "https://example.com" }
  - fill: 45
  - { at: day 4, ask: how about this one?, gold: pizza, quote: 2, expect_contains: [pizza], expect_not_contains: [sushi] }
  - expect_facts: { count: 1, gold: [Likes pizza] }
  - expect_facts_not_contains: [Almaty]
  - expect_insights: { min: 1, evidence_count: 2 }
  - { at: +2h, expect_sent: [mum] }
`);
  writeFileSync(join(dir, "two.yaml"), "name: other\ncategory: short-term\nsteps: []\n");
  const [s] = loadScenarios(dir, "every");
  expect(loadScenarios(dir)).toHaveLength(2);
  expect(s.name).toBe("every-kind");
  expect(s.steps).toHaveLength(10);
  expect(s.steps[0]).toEqual({ seed_facts: 30 });
  expect(s.steps[2]).toEqual({ at: "+1s", contact: "b", image: "photo.jpg", caption: "look" });
  expect(s.steps[5]).toMatchObject({ ask: "how about this one?", quote: 2, expect_contains: ["pizza"] });
  expect(s.steps[8]).toEqual({ expect_insights: { min: 1, evidence_count: 2 } });

  writeFileSync(join(dir, "bad.yaml"), "name: bad\ncategory: short-term\nsteps:\n  - { at: +0s, say: hi, fill: 2 }\n");
  expect(() => loadScenarios(dir)).toThrow(/bad\.yaml: step 1/);
});

test.each([
  ["a misspelt key", "{ at: +1s, ask: x, gold: y, qoute: 1 }", /step 2: unknown key "qoute" for ask/],
  ["a scalar expect_contains", "{ at: +1s, ask: x, gold: y, expect_contains: pizza }", /step 2: expect_contains must be a non-empty list of strings/],
  ["an empty expect_not_contains", "{ at: +1s, ask: x, gold: y, expect_not_contains: [] }", /step 2: expect_not_contains must be a non-empty list of strings/],
  ["a forward quote", "{ at: +1s, say: x, quote: 2 }", /step 2: quote must be an earlier step number/],
  ["a non-ISO at", "{ at: 10, say: x }", /step 2: bad at "10"/],
  ["a zero max_turns", "{ at: +1s, ask: x, gold: y, max_turns: 0 }", /step 2: max_turns must be a positive integer/],
  ["a scalar expect_recalled", "{ at: +1s, ask: x, gold: y, expect_recalled: Almaty }", /step 2: expect_recalled must be a non-empty list of strings/],
  ["an empty expect_sent", "{ at: +2h, expect_sent: [] }", /step 2: expect_sent must be a non-empty list of strings/],
])("loadScenarios rejects %s", (_name, step, error) => {
  const dir = mkdtempSync(join(tmpdir(), "scenarios-"));
  writeFileSync(join(dir, "bad.yaml"), `name: bad\ncategory: short-term\nsteps:\n  - { at: +0s, say: first }\n  - ${step}\n`);
  expect(() => loadScenarios(dir)).toThrow(error);
});

test("parseAt reads offsets from the scenario start, day numbers and ISO times", () => {
  const t0 = Date.UTC(2026, 10, 4, 15, 0);
  expect(parseAt("+0s", t0)).toBe(t0);
  expect(parseAt("+31 min", t0)).toBe(t0 + 31 * 60_000);
  expect(parseAt("+1d 2h 3s", t0)).toBe(t0 + 86_400_000 + 7_200_000 + 3000);
  expect(parseAt("day 4", t0)).toBe(t0 + 3 * 86_400_000);
  expect(parseAt("2026-11-10T14:00:00Z", t0)).toBe(Date.UTC(2026, 10, 10, 14, 0));
  expect(() => parseAt("+3 fortnights", t0)).toThrow(/bad at/);
  expect(() => parseAt("10", t0)).toThrow(/bad at/); // Date.parse would take it as a year
});

test("runScenario on a 2-step scenario returns one probe answered by the stub", async () => {
  const r = await run([{ at: "+0s", say: "good morning" }, { at: "+1min", ask: "you there?", gold: "ok", expect_contains: ["ok"] }], stubLlm());
  expect(r.probes).toHaveLength(1);
  expect(r.probes[0]).toMatchObject({ ask: "you there?", gold: "ok", answer: "ok", label: "correct" });
  expect(r.probes[0].totalMs).toBeTypeOf("number");
  expect(r.passed).toBe(true);
  expect(r.turns).toHaveLength(2);
  expect(r.transcript).toEqual([
    "[2026-11-04 15:00:00] a: good morning",
    "[2026-11-04 15:00:03] bot → a: ok",
    "[2026-11-04 15:01:00] a: you there?",
    "[2026-11-04 15:01:03] bot → a: ok",
  ]);
});

test("a failing string check labels the probe wrong and names the string", async () => {
  const r = await run([{ at: "+0s", ask: "pizza or sushi?", gold: "pizza", expect_contains: ["pizza"], expect_not_contains: ["ok"] }], stubLlm());
  expect(r.probes[0].label).toBe("wrong");
  expect(r.probes[0].reason).toContain('"pizza"');
  expect(r.probes[0].reason).toContain('"ok"');
  expect(r.passed).toBe(false);
});

test("step at values must be non-decreasing", async () => {
  await expect(run([{ at: "+1min", say: "a" }, { at: "+30s", say: "b" }], stubLlm())).rejects.toThrow(/step 2/);
});

test("a burst before the ask is drained only up to each step, so it gets one reply", async () => {
  const llm = stubLlm({ reply: echo });
  const r = await run([
    { at: "+0s", say: "need eggs" }, { at: "+1s", say: "flour" }, { at: "+2s", ask: "and milk", gold: "", expect_contains: ["eggs", "flour", "milk"], max_turns: 1 },
  ], llm);
  expect(llm.calls).toHaveLength(1);
  expect(r.turns).toHaveLength(1);
  expect(r.probes[0]).toMatchObject({ answer: "echo need eggs + flour + and milk", label: "correct" });
});

test("max_turns fails the probe when the contact took more turns", async () => {
  const r = await run([{ at: "+0s", say: "need eggs" }, { at: "+5s", say: "flour" }, { at: "+6s", ask: "and milk", gold: "", expect_contains: ["ok"], max_turns: 1 }], stubLlm());
  expect(r.probes[0]).toMatchObject({ label: "wrong", reason: "turns=2 > max_turns=1" });
});

test("a turn that fails twice shows up in the transcript and leaves ttfb undefined", async () => {
  const r = await run([{ at: "+0s", ask: "you there?", gold: "ok", expect_contains: ["ok"] }], stubLlm({ reply: () => ({ chunks: [], error: new Error("provider down") }) }));
  expect(r.transcript).toContain("[2026-11-04 15:00:33] bot → a: (turn error: provider down)");
  expect(r.probes[0]).toMatchObject({ answer: "", label: "wrong", ttfbMs: undefined });
  expect(r.probes[0].totalMs).toBeTypeOf("number");
});

test("a scenario ending with a say still runs that turn", async () => {
  const r = await run([{ at: "+0s", say: "good morning" }], stubLlm());
  expect(r.transcript).toEqual(["[2026-11-04 15:00:00] a: good morning", "[2026-11-04 15:00:03] bot → a: ok"]);
});

test("the ask drain extends past the first window to collect a retried turn", async () => {
  const llm = stubLlm({ reply: () => (llm.calls.length === 1 ? { chunks: [], error: new Error("provider down") } : "react: none\nok") });
  const r = await run([{ at: "+0s", ask: "hello?", gold: "ok", expect_contains: ["ok"] }], llm);
  expect(llm.calls).toHaveLength(2);
  expect(r.probes[0].answer).toBe("ok");
});

test("fill: 3 inserts 6 handled rows 60 s apart and advances the clock", async () => {
  const llm = stubLlm();
  const r = await run([{ fill: 3 }, { at: "+0s", ask: "hi", gold: "ok", expect_contains: ["ok"] }], llm);
  expect(llm.calls).toHaveLength(1); // the filled rows are history, not pending
  const history = llm.calls[0].messages.slice(0, -1);
  expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  expect(JSON.stringify(history)).toContain("2026-11-04 10:06"); // last filled row, New York time
  expect(r.transcript).toContain("[2026-11-04 15:06:00] a: hi");
});

test("quote: k sends the step's wamid as the quoted message", async () => {
  const llm = stubLlm();
  await run([{ at: "+0s", say: "A: pizza" }, { at: "+1min", ask: "how about this one?", gold: "pizza", quote: 1, expect_contains: ["ok"] }], llm);
  expect(pendingText(llm.calls[1])).toContain('(replying to #1: \\"A: pizza\\")');
});

test("an image step hands the fixture JPEG to the reply model", async () => {
  const llm = stubLlm();
  const r = await run([{ at: "+0s", image: "photo.jpg", caption: "look" }, { at: "+1s", ask: "what colour is it?", gold: "red", expect_contains: ["ok"] }], llm);
  const parts = llm.calls[0].messages.at(-1)!.content as { type: string; mediaType?: string; data?: Uint8Array }[];
  const file = parts.find((p) => p.type === "file")!;
  expect(file.mediaType).toBe("image/jpeg");
  expect(file.data!.length).toBe(readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)).length);
  expect(r.transcript[0]).toBe("[2026-11-04 15:00:00] a: [photo photo.jpg] look");
});

test("each contact gets its own core and sender", async () => {
  const r = await run([{ at: "+0s", say: "canary-zebra" }, { at: "+1min", contact: "b", ask: "what's the word?", gold: "", expect_not_contains: ["zebra"] }], stubLlm({ reply: echo }));
  expect(r.probes[0]).toMatchObject({ answer: "echo what's the word?", label: "correct" });
  expect(r.transcript).toContain("[2026-11-04 15:00:03] bot → a: echo canary-zebra");
  expect(r.turns.map((t) => t.contact)).toEqual(["a", "b"]);
});

test("a judged probe asks Opus at low effort with the conversation so far", async () => {
  const llm = stubLlm({ object: () => ({ label: "partial", reason: "half of it" }) });
  const r = await run([{ at: "+0s", say: "meet at 6" }, { at: "+1min", ask: "when are we meeting?", gold: "6" }], llm);
  expect(r.probes[0]).toMatchObject({ label: "partial", reason: "half of it" });
  expect(r.passed).toBe(false);
  expect(llm.objectCalls).toHaveLength(1);
  const call = llm.objectCalls[0];
  expect(call).toMatchObject({ job: "judge", modelId: "anthropic/claude-opus-5.5", reasoning: { effort: "low" } });
  expect(JSON.stringify(call.messages)).toContain("a: meet at 6");
});

test("ask at +10 s does not derive insights (they are 30 min out)", async () => {
  const llm = stubLlm({ object: () => ({ ops: [] }) });
  const r = await run([{ at: "+10s", ask: "hi", gold: "ok", expect_contains: ["ok"] }, { at: "+1min", say: "still here" }], llm, { ...cfg, memory: true });
  expect(r.passed).toBe(true);
  expect(llm.objectCalls.map((c) => c.job)).toEqual(["extract", "extract"]); // one per turn; Task 10's derive call must not appear
  expect(r.transcript).toContain("[2026-11-04 15:01:00] a: still here"); // a drain past insights_due would have jumped to 15:30
});

test("a counting embed passed to runScenario is called for a say step (memory on)", async () => {
  const embed = vi.fn(hashEmbed);
  await run([{ at: "+0s", say: "my sister lives in Almaty" }], stubLlm(), { ...cfg, memory: true }, { embed, rerank: cosineRerank });
  expect(embed).toHaveBeenCalled();
});

test("expect_recalled fails when the ask turn recalled nothing matching and passes when it did", async () => {
  const steps: Scenario["steps"] = [{ seed_facts: 2 }, { at: "+0s", ask: "do I like espresso?", gold: "yes", expect_contains: ["ok"], expect_recalled: ["ESPRESSO"] }];
  const off = await run(steps, stubLlm()); // memory off: the turn's recalled is []
  expect(off.probes[0]).toMatchObject({ label: "wrong", reason: 'not recalled: "ESPRESSO"' });
  const on = await run(steps, stubLlm({ object: () => ({ ops: [] }) }), { ...cfg, memory: true });
  expect(on.probes[0]).toMatchObject({ label: "correct" });
  expect(on.passed).toBe(true);
});

test("seed_facts embeds through the passed embed and the checks read the tables", async () => {
  const embed = vi.fn(hashEmbed);
  const llm = stubLlm({ object: () => ({ matched: 2, junk: 0 }) });
  const r = await run([
    { seed_facts: 2 },
    { expect_facts: { count: 2, gold: ["Likes espresso", "Has a colleague Dana in sales"] } },
    { expect_facts_not_contains: ["ESPRESSO", "Almaty"] },
    { expect_insights: { min: 1 } },
  ], llm, cfg, { embed, rerank: cosineRerank });
  expect(embed).toHaveBeenCalledTimes(1);
  expect(embed.mock.calls[0][0]).toHaveLength(2);
  expect(JSON.stringify(llm.objectCalls[0].messages)).toContain("Likes espresso");
  expect(r.checks.map((c) => [c.name, c.passed])).toEqual([["expect_facts", true], ["expect_facts_not_contains", false], ["expect_insights", false]]);
  expect(r.checks[1].detail).toContain("ESPRESSO");
  expect(r.passed).toBe(false);
});

test("expect_facts_not_contains also reads the profile", async () => {
  const llm = stubLlm({ object: () => ({ ops: [{ op: "ADD", text: "Has a sister", kind: "person", signal: 5 }], profile: "Sister: lives in Almaty" }) });
  const r = await run([{ at: "+0s", say: "my sister lives in Almaty" }, { expect_facts_not_contains: ["Almaty"] }], llm, { ...cfg, memory: true });
  expect(r.checks).toMatchObject([{ name: "expect_facts_not_contains", passed: false, detail: expect.stringContaining('"Almaty"') }]);
});

test("judge calls are summed into judgeCostUsd, apart from costUsd", async () => {
  const stub = stubLlm({ object: (c) => (JSON.stringify(c.messages).includes("Gold facts") ? { matched: 1, junk: 0 } : { label: "correct", reason: "ok" }) });
  const llm: Llm = { ...stub, object: async (c) => { const r = await stub.object(c); return { ...r, usage: { ...r.usage, costTable: 0.125 } }; } };
  const r = await run([{ seed_facts: 1 }, { expect_facts: { count: 1, gold: ["Likes espresso"] } }, { at: "+0s", ask: "do I like coffee?", gold: "yes" }], llm);
  expect(r.passed).toBe(true);
  expect(r.judgeCostUsd).toBe(0.25);
  expect(r.costUsd).toBe(0);
  expect(r.probes[0]).not.toHaveProperty("usage");
});

test("costUsd sums the calls ledger", async () => {
  const stub = stubLlm();
  const llm: Llm = { ...stub, stream: (c) => { const s = stub.stream(c); return { text: s.text, done: s.done.then((u) => ({ ...u, costTable: 0.25 })) }; } };
  const r = await run([{ at: "+0s", say: "hi" }, { at: "+1min", ask: "there?", gold: "ok", expect_contains: ["ok"] }], llm);
  expect(r.costUsd).toBe(0.5);
});

test("expect_sent checks the bot's messages since the previous step: a reminder fired by the clock jump passes, a later empty window fails", async () => {
  const llm = stubLlm({ reply: async (c) => `react: none\n${JSON.stringify(await c.tools!.set_reminder.execute!({ text: "call mum", at: "2026-11-04 12:00" }, { toolCallId: "t", messages: [] } as never))}` });
  const r = await run([
    { at: "+0s", ask: "remind me in 2 hours to call mum", gold: "", expect_contains: ["12:00"] },
    { at: "+2h", expect_sent: ["MUM"] },
    { at: "+3h", expect_sent: ["mum"] },
  ], llm);
  expect(r.probes[0].label).toBe("correct");
  expect(r.checks).toMatchObject([{ name: "expect_sent", passed: true, detail: "found: Reminder: call mum" }, { name: "expect_sent", passed: false, detail: 'no message since the previous step contains "mum": (nothing sent)' }]);
  expect(r.transcript).toContain("[2026-11-04 17:00:00] bot → a: Reminder: call mum");
  expect(llm.calls).toHaveLength(1);
});

test("the repo's scenarios all validate", () => {
  expect(loadScenarios("evals/scenarios").map((s) => s.name)).toContain("reminder-exact-time");
});

test("evalConfig() builds the tag from the EVAL_* env", () => {
  for (const k of ["REPLY", "EXTRACT", "DERIVE", "EFFORT", "MEMORY", "RETRIEVAL", "FILTER"]) vi.stubEnv(`EVAL_${k}`, ""); // npm run eval sets them
  expect(evalConfig()).toMatchObject({ memory: true, retrieval: "hybrid", tag: "reply=deepseek_deepseek-v4.1-flash,memory=1,retrieval=hybrid" });
  vi.stubEnv("EVAL_REPLY", "z-ai/glm-5.2");
  vi.stubEnv("EVAL_EXTRACT", "openai/gpt-6-luna");
  vi.stubEnv("EVAL_EFFORT", "medium");
  vi.stubEnv("EVAL_MEMORY", "0");
  vi.stubEnv("EVAL_RETRIEVAL", "cosine");
  vi.stubEnv("EVAL_FILTER", "short");
  expect(evalConfig()).toEqual({
    reply: "z-ai/glm-5.2", extract: "openai/gpt-6-luna", derive: undefined, effort: "medium", memory: false, retrieval: "cosine", filter: "short",
    tag: "reply=z-ai_glm-5.2,memory=0,retrieval=cosine,extract=openai_gpt-6-luna,effort=medium",
  });
  vi.stubEnv("EVAL_EFFORT", "max");
  expect(() => evalConfig()).toThrow(/EVAL_EFFORT/);
});

test("evalEmbedders picks the hash pair offline and REST bge-m3 when the account env is set", async () => {
  expect(evalEmbedders({})).toEqual({ embed: hashEmbed, rerank: cosineRerank });
  const urls: string[] = [];
  const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ result: { data: [[1, 0]] }, success: true })); }) as unknown as typeof fetch;
  const e = evalEmbedders({ CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y" }, f);
  expect(e.embed).not.toBe(hashEmbed);
  await e.embed(["hi"]);
  expect(urls).toEqual(["https://api.cloudflare.com/client/v4/accounts/x/ai/run/@cf/baai/bge-m3"]);
});
