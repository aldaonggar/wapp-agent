import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { makeLlm, type Usage } from "./llm";

const enc = new TextEncoder();
type Chunk = Record<string, unknown>;
const chunk = (delta: Chunk, finish: string | null = null): Chunk => ({ id: "gen-1", choices: [{ index: 0, delta, finish_reason: finish }] });
const usageChunk = (prompt: number, completion: number, cached: number, cost: number, finish: string): Chunk => ({
  id: "gen-1",
  provider: "DeepInfra",
  choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: finish }],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: 0 } },
});
const sse = (chunks: Chunk[]) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), {
    headers: { "Content-Type": "text/event-stream" },
  });

const textResponse = () => sse([
  chunk({ role: "assistant", content: "hel" }),
  chunk({ content: "lo" }),
  usageChunk(1000, 20, 400, 0.002, "stop"),
]);

function fake(responses: Array<() => Response>) {
  const bodies: any[] = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return responses[bodies.length - 1]!();
  }) as unknown as typeof fetch;
  return { f, bodies };
}

const base = { messages: [{ role: "user" as const, content: "hi" }], maxOutputTokens: 400, reasoning: { effort: "none" as const }, sessionId: "sess-1" };

async function drain(it: AsyncIterable<string>) { const out: string[] = []; for await (const t of it) out.push(t); return out; }

describe("llm.stream", () => {
  it("streams text and reports usage; request carries provider.ignore and session_id", async () => {
    const { f, bodies } = fake([textResponse]);
    const logged: Usage[] = [];
    const llm = makeLlm("k", { fetch: f, log: (u) => logged.push(u) });
    const r = llm.stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "be brief" }] });
    expect(await drain(r.text)).toEqual(["hel", "lo"]);
    const d = await r.done;
    expect(d).toMatchObject({ input: 1000, output: 20, cached: 400, costReported: 0.002, ttftMs: expect.any(Number), finishReason: "stop", provider: "DeepInfra", job: "reply" });
    expect(d.ttftMs).toBeGreaterThanOrEqual(0);
    expect(d.costTable).toBeCloseTo((600 * 0.045 + 400 * 0.018 + 20 * 0.5) / 1e6, 12);
    expect(logged).toHaveLength(1);
    expect(bodies[0].provider.ignore).toContain("deepseek");
    expect(bodies[0].session_id).toBe("sess-1");
    expect(bodies[0].reasoning).toEqual({ effort: "none" });
    expect(JSON.stringify(bodies[0].messages[0])).not.toContain("cache_control");
  });

  it("sends enabled:false for kimi with the host filter", async () => {
    const { f, bodies } = fake([textResponse]);
    const r = makeLlm("k", { fetch: f }).stream({ ...base, reasoning: { enabled: false }, job: "reply", modelId: "moonshotai/kimi-k2.6", system: [{ role: "system", content: "s" }] });
    await drain(r.text);
    await r.done;
    expect(bodies[0].reasoning).toEqual({ enabled: false });
    expect(bodies[0].provider.ignore).toContain("moonshotai");
  });

  it("puts cache_control on the first system part for anthropic ids", async () => {
    const { f, bodies } = fake([textResponse]);
    const llm = makeLlm("k", { fetch: f });
    const r = llm.stream({ ...base, job: "reply", modelId: "anthropic/claude-sonnet-5.5", system: [{ role: "system", content: "sys" }] });
    await drain(r.text);
    await r.done;
    expect(bodies[0].provider).toBeUndefined();
    expect(JSON.stringify(bodies[0].messages[0])).toContain("cache_control");
  });

  it("sums usage and cost across tool steps and logs once", async () => {
    const { f, bodies } = fake([
      () => sse([
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }),
        usageChunk(500, 10, 0, 0.001, "tool_calls"),
      ]),
      textResponse,
    ]);
    const logged: Usage[] = [];
    const llm = makeLlm("k", { fetch: f, log: (u) => logged.push(u) });
    const tools = { ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const r = llm.stream({ ...base, job: "followup", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }], tools });
    await drain(r.text);
    const d = await r.done;
    expect(bodies).toHaveLength(2);
    expect(d.input).toBe(1500);
    expect(d.costReported).toBeCloseTo(0.003, 12);
    expect(logged).toHaveLength(1);
  });

  it("starts the text of a step after a tool call on a new line", async () => {
    const { f } = fake([
      () => sse([
        chunk({ role: "assistant", content: "react: none" }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }),
        usageChunk(500, 10, 0, 0.001, "tool_calls"),
      ]),
      textResponse,
    ]);
    const tools = { ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const r = makeLlm("k", { fetch: f }).stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }], tools });
    expect((await drain(r.text)).join("")).toBe("react: none\nhello");
    await r.done;
  });

  it("asks activeTools before every step: a tool opened up by the first step's call is offered in the second", async () => {
    const { f, bodies } = fake([
      () => sse([
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] }),
        usageChunk(500, 10, 0, 0.001, "tool_calls"),
      ]),
      textResponse,
    ]);
    let pinged = false;
    const tools = {
      ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => { pinged = true; return { ok: true }; } }),
      pong: tool({ description: "pong", inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
    };
    const r = makeLlm("k", { fetch: f }).stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }], tools, activeTools: () => (pinged ? ["ping", "pong"] : ["ping"]) });
    await drain(r.text);
    await r.done;
    expect(bodies.map((b) => b.tools.map((t: { function: { name: string } }) => t.function.name))).toEqual([["ping"], ["ping", "pong"]]);
  });

  it("forces a text answer on the last allowed step: tool_choice none on step 3 only", async () => {
    const call = (n: number) => () => sse([chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "ping", arguments: "{}" } }] }), usageChunk(500, 10, 0, 0.001, "tool_calls")]);
    const { f, bodies } = fake([call(1), call(2), textResponse]);
    const tools = { ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const r = makeLlm("k", { fetch: f }).stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }], tools });
    await drain(r.text);
    await r.done;
    expect(bodies.map((b) => b.tool_choice)).toEqual(["auto", "auto", "none"]);
  });

  it("handles an in-stream error part: text yields the delta then throws, done rejects", async () => {
    const { f } = fake([() => sse([chunk({ role: "assistant", content: "par" }), { id: "gen-1", error: { code: 500, message: "boom" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }])]);
    const r = makeLlm("k", { fetch: f }).stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }] });
    const got: string[] = [];
    await expect((async () => { for await (const t of r.text) got.push(t); })()).rejects.toBeTruthy();
    expect(got).toEqual(["par"]);
    await expect(r.done).rejects.toBeTruthy();
  });

  it("leaves costReported undefined when no cost is reported", async () => {
    const { f } = fake([() => sse([chunk({ role: "assistant", content: "a" }), { id: "g", choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }])]);
    const r = makeLlm("k", { fetch: f }).stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }] });
    await drain(r.text);
    expect((await r.done).costReported).toBeUndefined();
  });

  it("rejects done on an upstream error", async () => {
    const { f } = fake([() => new Response("nope", { status: 400 })]);
    const llm = makeLlm("k", { fetch: f });
    const r = llm.stream({ ...base, job: "reply", modelId: "deepseek/deepseek-v4.1-flash", system: [{ role: "system", content: "s" }] });
    await expect(drain(r.text)).rejects.toBeTruthy();
    await expect(r.done).rejects.toBeTruthy();
  });
});

describe("llm.object", () => {
  const json = (v: string) => () => new Response(JSON.stringify({ id: "gen-2", provider: "X", choices: [{ index: 0, message: { role: "assistant", content: v }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.0005 } }), { headers: { "Content-Type": "application/json" } });
  const call = { job: "extract" as const, modelId: "deepseek/deepseek-v4.1-flash", system: "s", messages: base.messages, schema: z.object({ a: z.number() }), sessionId: "s" };

  it("retries once on invalid output", async () => {
    const { f, bodies } = fake([json("not json"), json('{"a":1}')]);
    const logged: Usage[] = [];
    const r = await makeLlm("k", { fetch: f, log: (u) => logged.push(u) }).object(call);
    expect(r.value).toEqual({ a: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format.json_schema.strict).toBe(false);
    expect(r.usage).toMatchObject({ input: 50, output: 5, costReported: 0.0005 });
    expect(logged).toHaveLength(2);
  });

  it("gives up after the retry", async () => {
    const { f, bodies } = fake([json("x"), json("y")]);
    await expect(makeLlm("k", { fetch: f }).object(call)).rejects.toBeTruthy();
    expect(bodies).toHaveLength(2);
  });

  it("does not retry transport errors", async () => {
    const { f, bodies } = fake([() => new Response("bad", { status: 400 }), json('{"a":1}')]);
    await expect(makeLlm("k", { fetch: f }).object(call)).rejects.toBeTruthy();
    expect(bodies).toHaveLength(1);
  });

  it("puts cache_control on the system message for anthropic ids only", async () => {
    const { f, bodies } = fake([json('{"a":1}'), json('{"a":1}')]);
    const llm = makeLlm("k", { fetch: f });
    await llm.object({ ...call, modelId: "anthropic/claude-haiku-5.5" });
    expect(bodies[0].messages[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(bodies[0].messages[0])).toContain("cache_control");
    await llm.object(call);
    expect(JSON.stringify(bodies[1].messages[0])).not.toContain("cache_control");
  });
});
