import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, isStepCount, NoObjectGeneratedError, Output, streamText, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import { CHINA_HOSTS, costUsd, needsHostFilter, type ReasoningSetting } from "./models";

export interface Usage { job: string; model: string; provider?: string; input: number; output: number; cached: number; reasoning: number; costTable: number; costReported?: number; ms: number }
export interface StreamCall { job: "reply" | "followup"; modelId: string; system: SystemModelMessage[]; messages: ModelMessage[]; tools?: ToolSet; maxOutputTokens: number; reasoning: ReasoningSetting; sessionId: string; abortSignal?: AbortSignal }
export interface ObjectCall<T> { job: "extract" | "derive" | "judge"; modelId: string; system: string; messages: ModelMessage[]; schema: z.ZodType<T>; reasoning?: ReasoningSetting; sessionId: string }
export interface Llm {
  // On a stream error `text` throws after the last delta and `done` rejects (pre-handled, but `await done` still throws).
  stream(call: StreamCall): { text: AsyncIterable<string>; done: Promise<Usage & { ttftMs: number; finishReason: string }> };
  object<T>(call: ObjectCall<T>): Promise<{ value: T; usage: Usage }>;
}

type RawUsage = { raw?: Record<string, unknown> } | undefined;
const rawCost = (u: RawUsage) => (u?.raw?.cost == null ? undefined : Number(u.raw.cost));

export function makeLlm(apiKey: string, opts: { fetch?: typeof fetch; log?: (u: Usage) => void } = {}): Llm {
  const openrouter = createOpenRouter({ apiKey, appName: "wapp-agent", fetch: opts.fetch });
  const model = (id: string, reasoning: ReasoningSetting | undefined) =>
    openrouter.chat(id, {
      provider: needsHostFilter(id) ? { ignore: CHINA_HOSTS } : undefined,
      structuredOutputs: { strict: false },
      // d.ts requires `effort` or `max_tokens`; OpenRouter accepts a bare { enabled: false } (Kimi).
      reasoning: (reasoning ?? undefined) as { effort: "none" } | undefined,
    });
  // The provider types list only models|reasoning|user at call level; session_id is sent verbatim.
  const callOptions = (sessionId: string) => ({ openrouter: { session_id: sessionId, user: sessionId } }) as never;

  type Tokens = { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number }; outputTokenDetails?: { reasoningTokens?: number } };
  const usageOf = (job: string, modelId: string, t: Tokens, provider: string | undefined, costReported: number | undefined, t0: number): Usage => {
    const input = t.inputTokens ?? 0, output = t.outputTokens ?? 0, cached = t.inputTokenDetails?.cacheReadTokens ?? 0;
    const u: Usage = { job, model: modelId, provider, input, output, cached, reasoning: t.outputTokenDetails?.reasoningTokens ?? 0, costTable: costUsd(modelId, { input, output, cached }), costReported, ms: performance.now() - t0 };
    opts.log?.(u);
    return u;
  };

  return {
    stream(call) {
      const t0 = performance.now();
      const system = call.system.map((m, i) =>
        i === 0 && call.modelId.startsWith("anthropic/") ? { ...m, providerOptions: { ...m.providerOptions, openrouter: { ...m.providerOptions?.openrouter, cacheControl: { type: "ephemeral" } } } } : m);
      const result = streamText({
        model: model(call.modelId, call.reasoning),
        instructions: system,
        messages: call.messages,
        tools: call.tools,
        stopWhen: call.tools ? isStepCount(3) : undefined,
        maxOutputTokens: call.maxOutputTokens,
        maxRetries: 1,
        timeout: { firstChunkMs: 15000, totalMs: 60000 },
        abortSignal: call.abortSignal,
        providerOptions: callOptions(call.sessionId),
      });

      const queue: string[] = [];
      let finished = false, wake: (() => void) | undefined;
      const notify = () => { wake?.(); wake = undefined; };
      let resolveDone!: (v: Usage & { ttftMs: number; finishReason: string }) => void, rejectDone!: (e: unknown) => void;
      const done = new Promise<Usage & { ttftMs: number; finishReason: string }>((res, rej) => { resolveDone = res; rejectDone = rej; });

      done.catch(() => {});
      let error: unknown;
      void (async () => {
        let ttftMs = 0, first = true;
        try {
          for await (const part of result.stream) {
            if (part.type === "text-delta") {
              if (first) { ttftMs = performance.now() - t0; first = false; }
              queue.push(part.text); notify();
            } else if (part.type === "start-step" && !first) { queue.push("\n"); notify(); } // text after a tool call starts a new line
            else if (part.type === "error") { error = part.error; break; }
          }
          if (error === undefined) {
            const [total, steps, final] = await Promise.all([result.usage, result.steps, result.finalStep]);
            const costs = steps.map((s) => rawCost(s.usage) ?? (s.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined)?.usage?.cost);
            const costReported = costs.some((c) => c != null) ? costs.reduce<number>((s, c) => s + Number(c ?? 0), 0) : undefined;
            const provider = (final.providerMetadata?.openrouter as { provider?: string } | undefined)?.provider;
            resolveDone({ ...usageOf(call.job, call.modelId, total, provider, costReported, t0), ttftMs, finishReason: final.finishReason });
          }
        } catch (e) { error = e; }
        if (error !== undefined) rejectDone(error);
        finished = true; notify();
      })();

      async function* text() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (finished) {
            if (error !== undefined) throw error; // a cut-off stream must not look complete to the parser
            return;
          }
          await new Promise<void>((r) => { wake = r; });
        }
      }
      return { text: text(), done };
    },

    async object<T>(call: ObjectCall<T>) {
      const t0 = performance.now();
      // Same cache marker as stream(): Anthropic caches only a prefix that carries it, and the extraction prompt is 2k tokens on every turn.
      const instructions: string | SystemModelMessage[] = call.modelId.startsWith("anthropic/")
        ? [{ role: "system", content: call.system, providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } } }]
        : call.system;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await generateText({
            model: model(call.modelId, call.reasoning),
            instructions,
            messages: call.messages,
            output: Output.object({ schema: call.schema }),
            maxRetries: 1,
            timeout: 60000,
            providerOptions: callOptions(call.sessionId),
          });
          const provider = (r.providerMetadata?.openrouter as { provider?: string } | undefined)?.provider;
          return { value: r.output as T, usage: usageOf(call.job, call.modelId, r.usage, provider, rawCost(r.usage), t0) };
        } catch (e) {
          if (!NoObjectGeneratedError.isInstance(e)) throw e;
          if (e.usage) usageOf(call.job, call.modelId, e.usage, undefined, rawCost(e.usage), t0); // failed attempt still costs
          lastErr = e;
        }
      }
      throw lastErr;
    },
  };
}
