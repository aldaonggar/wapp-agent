# AI SDK v7 + `@openrouter/ai-sdk-provider` v3 + OpenRouter API: reference note

Researched 2026-11-04. Sources: npm registry metadata; installed `ai@7.0.162`, `@openrouter/ai-sdk-provider@3.1.0`, `@ai-sdk/provider@4.0.35` type declarations and compiled JS (read directly); provider README/CHANGELOG (github.com/OpenRouterTeam/ai-sdk-provider, main); ai-sdk.dev docs for `ai@7.0.0` (context7 + migration guide); openrouter.ai/docs pages; live `GET https://openrouter.ai/api/v1/models`, `/models/{a}/{s}/endpoints`, `/providers` responses on 2026-11-04.

Legend: **[src]** = read from installed package code/types (ground truth for behaviour); **[docs]** = official docs page; **[live]** = live OpenRouter public API response; **UNCONFIRMED** = not found in any official source.

---

## 1. Versions, install, runtime

| Package | Latest (2026-11-04) | Notes |
|---|---|---|
| `ai` | **7.0.162** (dist-tag `latest`; 7.0.0 shipped 2026-06-25) | other tags: `ai-v6` 6.0.322, `ai-v5` 5.0.285. `engines.node >= 22`. **ESM-only**. peer `zod ^3.25.76 \|\| ^4.1.8`. deps `@ai-sdk/provider 4.0.35`, `@ai-sdk/provider-utils 5.0.74`, `@ai-sdk/gateway 4.0.135`. |
| `@openrouter/ai-sdk-provider` | **3.1.0** (2026-09-19) | peer `ai ^7.0.0`, `zod ^3.25.76 \|\| ^4.1.8`; `engines.node >= 22`; ESM-only; implements `@ai-sdk/provider` **V4** interfaces. Legacy lines: README says `2.9.1` for ai v6 / `1.5.4` for ai v5, but npm's newest 2.x is `2.10.0` (2026-06-26, images endpoint change only). |
| `zod` | 4.6.7 installed | v4 is fine; `z.object()` schemas pass straight into `inputSchema` / `Output.object({ schema })`. |

```bash
npm i ai@^7 @openrouter/ai-sdk-provider@^3 zod@^4
```

**Cloudflare Workers** [src + docs]
- Scan of the shipped `.js` in `ai`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@ai-sdk/gateway`, `@openrouter/ai-sdk-provider`: **no static `node:` imports**. The only builtin loads are dynamic `process.getBuiltinModule(...)` calls (`ai`: `node:diagnostics_channel`, `node:async_hooks` for telemetry; provider-utils + OpenRouter provider: `node:dns`, `node:module` for the SSRF-safe download fetch), each gated by an `isNodeRuntime()` check that returns **false** when `process.title === "workerd"` or `EdgeRuntime` is set. The provider calls OpenRouter with global `fetch` (`postJsonToApi`) and accepts a custom `fetch` option. So nothing in these packages *requires* `nodejs_compat`.
- Cloudflare: for `compatibility_date >= 2026-08-04`, `nodejs_compat` + `nodejs_compat_v2` are on by default anyway (https://developers.cloudflare.com/workers/runtime-apis/nodejs/). For dates 2024-09-23..2026-08-03 add `compatibility_flags = ["nodejs_compat"]`.
- Cloudflare's own AI SDK page targets `ai@^7` + `@ai-sdk/provider@^4` (https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/), i.e. v7 is the expected pairing on Workers.
- UNCONFIRMED: actual execution under workerd was not smoke-tested here; do a `wrangler dev` call on day one.
- Node 24 (Vitest evals) satisfies `>= 22`.

---

## 2. Provider setup

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

const openrouter = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,          // default: process.env.OPENROUTER_API_KEY (not available on Workers; pass explicitly)
  baseURL: 'https://openrouter.ai/api/v1', // default
  appUrl: 'https://your.app',              // -> HTTP-Referer header (app attribution)
  appName: 'wapp-agent',                   // -> X-OpenRouter-Title header
  headers: { /* merged last, can override */ },
  compatibility: 'compatible',             // default for createOpenRouter; 'strict' adds stream_options.include_usage (OpenRouter ignores it now, see 9)
  fetch,                                   // optional custom fetch
  extraBody: { /* lowest-precedence body fields */ },
});
const model = openrouter.chat('anthropic/claude-sonnet-5.5', { /* OpenRouterChatSettings */ });
```
`OpenRouterProviderSettings` [src d.ts]: `baseURL, baseUrl (deprecated), decisionsBaseURL, apiKey, headers, compatibility: 'strict'|'compatible', fetch, extraBody, api_keys (BYOK, sent as X-Provider-API-Keys), appName, appUrl`.

**`openrouter(modelId)` vs `openrouter.chat(modelId)`** [src d.ts line 967-978, JS 6286-6300]: the callable has two overloads (completion settings / chat settings); `chat()` and `completion()` are explicit. At runtime the bare call returns the **chat** model for every id except the hard-coded `openai/gpt-3.5-turbo-instruct` (completion model), and throws if used with `new`. Use **`openrouter.chat(id, settings)`** for `/chat/completions` to get the chat settings type.

### Model-level settings (`OpenRouterChatSettings`) [src d.ts]
Sent in every request body by `getArgs()`:

| Setting | Body field | Notes |
|---|---|---|
| `models?: string[]` | `models` | fallback list (see 8) |
| `reasoning?: { enabled?, exclude? } & ({ max_tokens } \| { effort })` | `reasoning` | d.ts effort union in 3.1.0 is `'xhigh'\|'high'\|'medium'\|'low'\|'minimal'\|'none'` — **`'max'` is missing from the type** though OpenRouter accepts it; cast or use `extraBody` |
| `provider?: { order, allow_fallbacks, require_parameters, data_collection, only, ignore, quantizations, sort, max_price, zdr }` | `provider` | typed subset; extra keys (`preferred_max_latency`, …) via `extraBody` |
| `usage?: { include: boolean }` | `usage` | deprecated server-side, harmless |
| `user?: string` | `user` | stable per-end-user id |
| `plugins?: [{id:'web'...}\|{id:'file-parser'...}\|{id:'moderation'}\|{id:'response-healing'}\|{id:'auto-router'...}]` | `plugins` | |
| `cache_control?: { type:'ephemeral', ttl?: '5m'\|'1h' }` | root `cache_control` | Anthropic automatic caching (see 10) |
| `structuredOutputs?: { strict?: boolean }` | `response_format.json_schema.strict` | default `true` |
| `debug?: { echo_upstream_body?: boolean }` | `debug` | streaming only |
| `web_search_options`, `logitBias`, `logprobs`, `parallelToolCalls` | `web_search_options`, `logit_bias`, `logprobs`/`top_logprobs`, `parallel_tool_calls` | |
| `temperature, topP, topK, frequencyPenalty, presencePenalty, maxTokens` | defaults, overridden by call options | |
| `extraBody?: Record<string, unknown>` | spread into body | |
| `includeReasoning` | `include_reasoning` | deprecated |

### Call-level `providerOptions.openrouter` [src JS `doGenerate`/`doStream`]
```js
const { cacheControl, ...rest } = providerOptions.openrouter ?? {};
body = { ...getArgs(options), ...rest, ...(cacheControl && !('cache_control' in rest) ? { cache_control: cacheControl } : {}) };
```
Consequences:
- **Any** key you put under `providerOptions.openrouter` is sent verbatim as a top-level body field (`reasoning`, `provider`, `models`, `user`, `session_id`, `transforms`, `plugins`, …). The TypeScript type only lists `models | reasoning | user`; cast for the rest.
- Call-level keys **replace** model-level keys wholesale (shallow spread). `providerOptions.openrouter.provider = { allow_fallbacks:false }` drops a model-level `provider.order`. (The README's "shallow merge of `provider`" note applies to the embeddings model, not chat.)
- `cacheControl` at call level becomes the root `cache_control` (automatic caching), not a per-message breakpoint.
- Body precedence, lowest to highest: typed model settings -> factory `extraBody` -> model `extraBody` -> call `providerOptions.openrouter`.

Per-message / per-part `providerOptions.openrouter` (handled in message conversion): `cacheControl` (or `cache_control`; also reads `providerOptions.anthropic.cacheControl`), `imageDetail: 'auto'|'low'|'high'` on image file parts (-> `image_url.detail`), `filename` on file parts, `videoProcessing` on video parts, `reasoning_details`/`annotations` on assistant messages (round-trip), `eager_input_streaming` on a tool's `providerOptions`.

---

## 3. `streamText` (ai 7.0.x)

Options we need (from `StreamTextOptions` = `Prompt & LanguageModelCallOptions & RequestOptions & …`) [src d.ts]:

```ts
import { streamText, isStepCount, tool, Output } from 'ai';
// stepCountIs is still exported as an alias of isStepCount [src: `isStepCount as stepCountIs`]

const result = streamText({
  model,
  instructions,            // string | SystemModelMessage | SystemModelMessage[]  ('system' still works, deprecated)
  messages,                // ModelMessage[]  (system role inside messages is REJECTED unless allowSystemInMessages: true)
  maxOutputTokens, temperature, topP, topK, stopSequences, seed,
  tools, toolChoice, activeTools,
  stopWhen: isStepCount(4),            // also hasToolCall('name'), isLoopFinished(); evaluated only when the last step has tool results
  abortSignal,                          // RequestOptions
  timeout,                              // number (totalMs) | { totalMs, stepMs, firstChunkMs, chunkMs, toolMs, tools: { viewPageMs } }
  maxRetries: 2,                        // default 2; set 0 to disable
  headers,
  providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
  output: Output.object({ schema }),    // optional structured output while streaming
  onError: ({ error }) => {},          // errors are stream parts, not throws
  onEnd: (event) => {},                // 'onFinish' kept as deprecated alias; NOT called on abort
  onAbort: ({ steps }) => {},
  onStepEnd: (step) => {},             // 'onStepFinish' deprecated alias
  onChunk: ({ chunk }) => {},          // receives ALL stream parts in v7; switch on chunk.type
  include: { requestBody: true },      // bodies excluded by default in v7
});
```
Top-level `reasoning: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'provider-default'` exists on `LanguageModelCallOptions` in v7, **but provider 3.1.0 `getArgs()` does not read it** [src JS 4266-4279] — it is silently dropped. Use `providerOptions.openrouter.reasoning`.

Result (`StreamTextResult`) [src d.ts 2757-3015]: `textStream` (AsyncIterable<string>, errors not surfaced), `stream` (all parts; `fullStream` deprecated alias), `usage` (**total across steps** in v7; `totalUsage` deprecated), `finalStep` (= `steps.at(-1)`: `.usage`, `.performance`, `.providerMetadata`, `.response`, `.request`), `steps`, `text`, `content`, `toolCalls`, `toolResults`, `finishReason`, `rawFinishReason`, `responseMessages` (full multi-step history to persist), `warnings`, `output`/`partialOutputStream` (with `output:`), `consumeStream()`. `result.providerMetadata/response/request` still exist but are deprecated in favour of `finalStep.*`.

**Stream part shapes** [src d.ts 3016-3139]:
```ts
{ type:'text-delta', id, text, providerMetadata? }                 // field is `text` (not `delta`)
{ type:'reasoning-delta', id, text }
{ type:'tool-input-start', id, toolName, dynamic?, providerExecuted? } / { type:'tool-input-delta', id, delta } / { type:'tool-input-end', id }
{ type:'tool-call', toolCallId, toolName, input, providerExecuted?, dynamic?, providerMetadata? }
{ type:'tool-result', toolCallId, toolName, input, output, dynamic? }
{ type:'tool-error', toolCallId, toolName, input, error }
{ type:'start' } / { type:'start-step', request, warnings }
{ type:'finish-step', response, usage, performance, finishReason, rawFinishReason, providerMetadata }
{ type:'finish', finishReason, rawFinishReason, totalUsage }
{ type:'error', error } / { type:'abort', reason? } / { type:'raw', rawValue }
// also text-start/text-end, reasoning-start/end, source, file, reasoning-file, custom, tool-output-denied, tool-approval-*
```

**Usage shape (`LanguageModelUsage`, v7)** [src d.ts 344-394]:
```ts
{
  inputTokens: number|undefined,
  inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens },   // each number|undefined
  outputTokens: number|undefined,
  outputTokenDetails: { textTokens, reasoningTokens },
  totalTokens: number|undefined,
  raw?: JSONObject   // provider's usage object verbatim (OpenRouter: includes cost etc.)
}
```
v5's `cachedInputTokens` / `reasoningTokens` top-level fields are **gone** in v7 (migration guide). OpenRouter mapping [src JS 3346-3359]: `inputTokens = prompt_tokens`, `cacheReadTokens = prompt_tokens_details.cached_tokens ?? 0`, `cacheWriteTokens = prompt_tokens_details.cache_write_tokens`, `noCacheTokens = prompt_tokens - cached`, `outputTokens = completion_tokens`, `reasoningTokens = completion_tokens_details.reasoning_tokens ?? 0`.

**Time to first token**: `step.performance` (`StepResultPerformance`) has `timeToFirstOutputMs` (set when the first output chunk of the step arrives), `timeBetweenOutputChunksMs {min,p10,median,avg,p90,max}`, `outputTokensPerSecond`, `effectiveOutputTokensPerSecond`, `inputTokensPerSecond`, `effectiveTotalTokensPerSecond` [docs ai 7 generating-text + src d.ts 1528]. Available on `finish-step` parts and `finalStep.performance`. For a wall-clock TTFT measured from your own `Date.now()` before the call, stamp the first `text-delta` (or first `tool-input-start`) in `for await (const part of result.stream)`.

---

## 4. Structured output

Current, non-deprecated [docs ai 7 migration + cookbook]:
```ts
import { generateText, Output } from 'ai';
const { output } = await generateText({
  model,
  output: Output.object({ schema: z.object({ ... }), name?: 'reply', description?: '...' }),
  messages,
});
// also Output.text(), Output.array({ element }), Output.choice({ options }), Output.json()
```
- `generateObject` / `streamObject` still exported but **deprecated**; `experimental_output` option/result **removed** in v7 (use `output` / `result.output`).
- `streamText({ output })` gives `partialOutputStream` and `output` promise.
- Tools + `output` can be combined on `generateText`/`streamText` (same options object); the output is parsed from the final step text.

OpenRouter provider implementation [src JS 4299-4308]: `Output.object` arrives as `responseFormat: { type:'json', schema, name?, description? }` and is sent as
```json
"response_format": { "type": "json_schema", "json_schema": { "name": "response", "strict": true, "schema": { ... }, "description": "..." } }
```
(`name` defaults to `"response"`; `strict` defaults to `true`, override with model setting `structuredOutputs: { strict: false }`). No schema -> `{ "type": "json_object" }`. It does **not** use a tool for objects (the `defaultObjectGenerationMode: 'tool'` field is legacy V1 metadata).

Caveats:
- `strict:true` can empty the eligible endpoint set for open-weight models: CHANGELOG 2.9.0 reports `moonshotai/kimi-k2.6` via Parasail/Venice/Io Net returning **HTTP 404 "No endpoints available matching your guardrail restrictions and data policy"**; fix with `structuredOutputs: { strict: false }`.
- Support is **per endpoint**: check `supported_parameters` contains `structured_outputs` (strict schema) and/or `response_format` on `/endpoints` [live]. Set `provider: { require_parameters: true }` to route only to endpoints supporting every requested param (https://openrouter.ai/docs/features/structured-outputs). Even without it, `response_format` (incl. structured outputs), `tools` and `verbosity` act as a *soft* routing preference among a model's endpoints (provider-routing docs, "Default parameter preferences").
- Streaming json_schema is supported by OpenRouter; "exact compliance is not guaranteed on every endpoint" (docs).
- Optional repair: model setting `plugins: [{ id: 'response-healing' }]` (non-streaming only).

---

## 5. Multimodal input (user messages)

v7 user content parts [docs prompts + provider-utils d.ts]:
```ts
{ type: 'text', text }
{ type: 'file', data, mediaType: 'image/jpeg', filename?, providerOptions? }   // canonical in v7
{ type: 'image', image, mediaType? }                                           // deprecated in v7, still accepted
// data / image: base64 string | data: URL string | Uint8Array | ArrayBuffer | Buffer | URL | http(s) URL string
```
OpenRouter provider conversion [src JS 3740-3797]:
- `mediaType` `image/*` -> `{ "type":"image_url", "image_url": { "url": "<data:image/..;base64,.. or http URL>", "detail"? } }` (default media type `image/jpeg` if bytes given with a bare type).
- `video/*` -> `video_url`; `audio/*` -> `{ "type":"input_audio", "input_audio": { "data": base64, "format": "mp3|wav|ogg|flac|aac|webm|mp4..." } }`; anything else -> `{ "type":"file", "file": { "filename", "file_data": "<data URL or http URL>" } }` (default `application/pdf`).
- `supportedUrls` [src JS 4254-4261]: `image/*` passes through as URL only if `data:image/...;base64,` or `https?://....(jpg|jpeg|png|gif|webp)[?#...]`; `application/*` any `http(s)`. Other URLs are **downloaded by the AI SDK and inlined as base64**. WhatsApp media URLs need an `Authorization` header and have no extension, so download them yourself and pass bytes (`Uint8Array`) with the right `mediaType`.
- OpenRouter accepted image types: `image/png`, `image/jpeg`, `image/webp`, `image/gif` (https://openrouter.ai/docs/guides/overview/multimodal/image-understanding). Count/size limits "vary per provider and per model" — UNCONFIRMED numbers.
- Only models whose `architecture.input_modalities` includes `image` accept image parts [live `/models` field].

---

## 6. Tools

```ts
import { tool } from 'ai';
const viewPage = tool({
  description: 'Fetch a web page as markdown plus a screenshot',
  inputSchema: z.object({ url: z.string().url() }),       // v5+/v7: inputSchema (v4 was `parameters`)
  execute: async ({ url }, { toolCallId, messages, abortSignal }) => {   // ToolExecutionOptions (renamed from ToolCallOptions)
    return { markdown, screenshotBase64 };                              // JSON by default -> { type:'json', value }
  },
  toModelOutput: ({ output }) => ({
    type: 'content',
    value: [
      { type: 'text', text: output.markdown },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: output.screenshotBase64 } }, // base64 string or Uint8Array
    ],
  }),
});
```
- `toModelOutput` return union [src provider d.ts 1336-1400]: `{type:'text', value}` | `{type:'json', value}` | `{type:'error-text', value}` | `{type:'error-json', value}` | `{type:'execution-denied', reason?}` | `{type:'content', value: Array<{type:'text', text} | {type:'file', mediaType, filename?, data: {type:'data', data} | {type:'url', url: URL} | {type:'reference', reference} | {type:'text', text}}>}`. The v6 `{ type:'media' }` part is **removed**; `image-*`/`file-*` aliases are deprecated but auto-migrated.
- OpenRouter provider maps `content` tool results [src JS 3913-3960] to a `role:"tool"` message whose `content` is an array: text -> `{type:'text'}`, `image/*` -> `{ type:'image_url', image_url:{ url: dataUrl } }`, audio -> `input_audio`, video -> `video_url`. Whether the **upstream** model accepts image parts inside tool messages is model/host dependent: AI SDK docs call multimodal tool results "experimental, supported by Anthropic, OpenAI and Google". UNCONFIRMED for DeepSeek V4 / Kimi K2.6 / GLM-5.2 hosts. Safe fallback: return markdown text from the tool and append the screenshot as a `file` part in the next **user** message.
- Multi-step loop: `stopWhen: isStepCount(n)`; the SDK runs `execute`, appends tool results, and calls the model again until no tool calls or the condition hits. Stream order per step: `start-step` -> (`tool-input-start`/`-delta`/`-end`) -> `tool-call` -> `tool-result` | `tool-error` -> `finish-step` -> next `start-step` ... -> `finish`.
- Errors: tool `execute` throwing -> `tool-error` part (not a throw); `NoSuchToolError` / `InvalidToolInputError` -> `error` part in `streamText`, thrown in `generateText`. `repairToolCall` option exists.
- Persist `await result.responseMessages` as the assistant/tool history so OpenRouter `reasoning_details` (Anthropic signatures, DeepSeek V4's required empty array) round-trip; the provider re-attaches them from message `providerOptions.openrouter.reasoning_details` [src JS 3845-3884, CHANGELOG 2.8.1].
- Provider >= 2.9.0 fixed duplicate `tool-call` emission seen with `moonshotai/kimi-k2.6` (CHANGELOG) — 3.1.0 includes it.

---

## 7. Reasoning control (OpenRouter `reasoning` object)

Docs: https://openrouter.ai/docs/use-cases/reasoning-tokens
```json
"reasoning": { "effort": "low", "max_tokens": 2000, "exclude": false, "enabled": true }
```
- `effort` values: `"max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none"`. `effort` and `max_tokens` are mutually exclusive. `enabled: true` alone = default (medium). `exclude: true` = reason but don't return it (Chat Completions only). `effort: "none"` disables; models flagged `mandatory` **reject** `none`. Legacy `include_reasoning: true/false` == `reasoning: {}` / `{exclude:true}`.
- For max_tokens-style models, effort maps to a share of `max_tokens`: max/xhigh ~95%, high ~80%, medium ~50%, low ~20%, minimal ~10%. Anthropic: `budget_tokens = max(min(max_output_tokens * ratio, 128000), 1024)`; `max_tokens` must be strictly higher than the budget; `reasoning.max_tokens` minimum 1024. Models that only accept effort derive an effort level from a given `reasoning.max_tokens`; models that only accept `max_tokens` derive a budget from effort via the percentages above.
- Unsupported effort values: docs say OpenRouter "will map your requested effort to the nearest supported level" (stated in the Gemini 3 section but phrased for any model); Claude specifically: `minimal` is sent as `low`, `none` is rejected; `mandatory` models reject `none`; an unsupported effort in a mid-conversation effort update returns a 400. Still safest to send only values listed in the per-model `reasoning` descriptor.
- Reasoning tokens count against `max_tokens`; if exhausted you get `finish_reason: "length"` with empty content (retrying does not help; raise `max_tokens` or lower effort).
- Response: `choices[].message.reasoning` (string) + `reasoning_details[]` of `{type:'reasoning.text'|'reasoning.summary'|'reasoning.encrypted', text?|summary?|data?, signature?, id?, format?, index?}`; streaming in `delta.reasoning_details`. Provider emits `reasoning-delta` parts and `providerMetadata.openrouter.reasoning_details`.

**Per-model descriptor** (`GET /api/v1/models` `reasoning` field: `{ mandatory, default_enabled, supported_efforts, default_effort, supports_max_tokens }`) [live 2026-11-04]:

| Model id | mandatory | supported_efforts | default | Lowest you can send |
|---|---|---|---|---|
| `openai/gpt-6-sol`, `gpt-6-sol-pro`, `gpt-6-luna`, `gpt-6-luna-pro`, `gpt-6.1-terra` | false | max, xhigh, high, medium, low, **none** | medium | `none` |
| `openai/gpt-6.1-sol`, `gpt-6.1-sol-pro`, `gpt-6.1-terra-pro`, `gpt-6-astra(-pro)` | **true** | max, xhigh, high, medium, low | medium | `low` |
| `openai/gpt-5.6-*` | false | max..low, none | medium | `none` |
| `anthropic/claude-sonnet-5.5`, `claude-opus-5.5`, `claude-fable-5.1`, `claude-fable-5` | **true** | max, xhigh, high, medium, low | high | `low` (cannot disable) |
| `anthropic/claude-haiku-5.5` | false | max, xhigh, high, medium, low, none | medium | `none` |
| `deepseek/deepseek-v4-pro`, `deepseek-v4-flash` | false | xhigh, high, **none** | high | `none` |
| `deepseek/deepseek-v4.1-flash` | false | max, high, low, none | high | `none` |
| `z-ai/glm-5.2` | false | xhigh, high, **none** | high | `none` |
| `moonshotai/kimi-k2.6` | false | *(no `supported_efforts`; `default_enabled: true`; `reasoning_effort` absent from its `supported_parameters`)* | - | `reasoning: { enabled: false }` to turn thinking off. UNCONFIRMED whether `effort:'none'` is accepted. |

Note: **no `minimal` anywhere** in the candidate set; `gpt-6.x` lowest is `low` or `none`. Always set `maxOutputTokens` when sending effort on Anthropic (budget derives from it).

---

## 8. Provider routing

Docs: https://openrouter.ai/docs/features/provider-routing
```json
"provider": {
  "order": ["deepinfra/fp8", "parasail"],
  "allow_fallbacks": true,
  "require_parameters": false,
  "data_collection": "deny",
  "zdr": true,
  "only": ["deepinfra", "together"],
  "ignore": ["chutes"],
  "quantizations": ["fp8", "bf16"],
  "sort": "latency",
  "max_price": { "prompt": 1, "completion": 2 },
  "preferred_min_throughput": 50,
  "preferred_max_latency": { "p90": 2 }
}
```
| Field | Type / values | Default |
|---|---|---|
| `order` | slug[] tried in sequence | - |
| `allow_fallbacks` | boolean | `true` |
| `require_parameters` | boolean (only endpoints supporting every request param) | `false` |
| `data_collection` | `"allow"` \| `"deny"` | `"allow"` |
| `zdr` | boolean (Zero Data Retention endpoints only) | - |
| `enforce_distillable_text` | boolean | - |
| `only` / `ignore` | slug[] | - |
| `quantizations` | `int4, int8, fp4, mxfp4, nvfp4, fp6, fp8, mxfp8, fp16, bf16, fp32, unknown` | - |
| `sort` | `"price"` \| `"throughput"` \| `"latency"` or `{ by, partition: "model"\|"none" }` | - |
| `preferred_min_throughput` | tok/s number (p50) or `{p50,p75,p90,p99}` (never blocks) | - |
| `preferred_max_latency` | seconds number or percentile object (never blocks) | - |
| `max_price` | `{ prompt, completion, request, image }` USD per 1M tokens (can block) | - |

Slug format: **`provider[/variant][/region][/tier]`** (tier spelled as the provider does: `priority`, `fast`, `turbo`, `flex`, always last); a base slug (`deepinfra`) matches all of that provider's endpoints; the full slug equals the endpoint `tag`. Base slugs do not select service-tier endpoints like `openai/fast`. Shortcuts: `model:nitro` (sort throughput **and** makes priority-tier endpoints eligible), `model:floor` (sort price). Default routing is weighted by effective price, throughput, TTFT, 429 rate, reliability and tool-call quality, and **sticky to the provider with a warm prompt cache**; `order`/`sort`/`:nitro`/`:floor`/BYOK bypass it, and sticky routing is **not** applied when `provider.order` is set.

Provider slugs [live `GET /api/v1/providers`, fields `name, slug, headquarters, datacenters, privacy_policy_url, terms_of_service_url, status_page_url`]: `openai`, `anthropic`, `google-vertex`, `azure`, `amazon-bedrock`, `deepinfra` (US), `together` (US), `fireworks` (US), `parasail` (US), `novita` (US), `baseten` (US), `groq` (US), `cerebras` (US), `venice` (US, dc US), `gmicloud` (US, dc US), `chutes` (US), `atlas-cloud` (US), `friendli` (US), `crusoe` (US), `inference-net` (US), `siliconflow` (HQ SG, dc US), `nebius` (NL), `deepseek` (CN), `moonshotai` (SG, dc SG), `z-ai` (SG, dc SG), `alibaba` (SG, dc SG+CN), `io-net`, `sambanova`, `baidu`, `streamlake`, `relace`, `wafer`, `mistral`, `coreweave`, `cloudflare`, `digitalocean`, `morph`, `ambient`, `inceptron`, `phala`, `mancer`, `claude-on-aws`.

**Endpoint discovery** `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints` [live shape]:
```json
{ "data": { "id": "z-ai/glm-5.2", "name": "...", "created": 0, "description": "...", "architecture": {...},
  "endpoints": [ {
    "name": "DeepInfra | z-ai/glm-5.2-20260616", "model_id": "...", "model_name": "...",
    "provider_name": "DeepInfra", "tag": "deepinfra/fp4",
    "quantization": "fp4", "context_length": 1048576, "max_completion_tokens": 163840, "max_prompt_tokens": null,
    "pricing": { "prompt": "0.0000005625", "completion": "0.0000018", "input_cache_read": "0.000000105", "discount": 0.25 },
    // Anthropic/OpenAI endpoints add "input_cache_write", "input_cache_write_1h" (Anthropic), "web_search"; "overrides" exists only in /models pricing
    "status": 0, "uptime_last_5m": 100, "uptime_last_30m": 100, "uptime_last_1d": 99.8,
    "latency_last_30m": 1.2, "throughput_last_30m": 80,   // both nullable
    "supported_parameters": ["reasoning","tools","tool_choice","response_format","structured_outputs", "..."],
    "supports_implicit_caching": true, "supports_tool_choice": true, "native_tools": true, "service_tier": null
  } ] } }
```
Prices are USD per token (strings). `status` 0 = healthy; negative values (`-2`, `-5`) observed on degraded endpoints — exact semantics UNCONFIRMED. **No region field**: region is only encoded in `tag` suffixes (`azure/us`, `azure/eu`, `amazon-bedrock/eu-west-1`, `google-vertex/europe`, `wafer/us`, `baseten/fp8/us`, `mistral/eu`, `alibaba/fp8/us-east-1`) plus the provider's `headquarters`/`datacenters`. The `/generation` record has `data_region: global|europe|us` after the fact.

Live US/EU-hosted options for the Chinese open-weight candidates (snapshot 2026-11-04 evening, `status 0` unless noted; status values move hour to hour, re-query before pinning):
- `moonshotai/kimi-k2.6`: `parasail/int4`, `deepinfra/fp4` (max_completion 16384), `novita`, `coreweave/fp4`, `crusoe/bf16`, `siliconflow/fp8`, `cloudflare`, `gmicloud/fp8`, `atlas-cloud/int4`, `inceptron/int4`, `venice/int4`, `digitalocean`, `streamlake/fp8`, `chutes/int4` (no `response_format`), `phala`; first-party `moonshotai` (SG); `baidu/fp4` (CN). No `together`/`fireworks` endpoint. All list `input_cache_read` + `supports_implicit_caching: true`.
- `deepseek/deepseek-v4-flash`: `deepinfra/fp8`, `parasail/fp8`, `gmicloud/fp8`, `siliconflow/fp8`, `atlas-cloud/fp4`, `venice`, `digitalocean`, `azure/us`, `relace/fp4`, `wafer/mxfp4`, `streamlake/fp8`, `baidu/fp8`, `mancer/fp8` (no implicit caching); `fireworks` (status -2), `alibaba/fp8/us-east-1` (status -5); **no first-party `deepseek` endpoint listed**. `gmicloud/fp8`, `siliconflow/fp8`, `azure/us`, `relace/fp4` lack `structured_outputs`.
- `z-ai/glm-5.2`: `deepinfra/fp4` (+ `deepinfra/fp4/flex` tier), `together`, `baseten/fp8` + `baseten/fp8/us`, `parasail/fp4`, `novita/fp8`, `mistral/eu`, `mistral/zdr`, `friendli`, `gmicloud/fp8`, `venice/fp8`, `cloudflare`, `wafer/us`, `coreweave/fp4`, `morph/fp8`, `digitalocean`, `inceptron/fp4`, `alibaba/fp8/us-east-1`; priority tiers `baidu/fast`, `alibaba/fast` (`baseten/us/fast`, `baseten/fast` degraded); `nebius/fp4` (NL, status -5); first-party `z-ai/fp8` (SG, no `structured_outputs`).

**Which endpoint served the request**: Chat Completions responses carry a top-level `provider` string (e.g. `"DeepInfra"`) and `model`; the provider SDK reads `response.provider` into `providerMetadata.openrouter.provider` (non-streaming) and from stream chunks into the `finish` part's metadata [src JS 4520, 5021]. The current API-reference page documents it only under `openrouter_metadata.endpoints.available[].{model, provider, selected}` / `attempts[]` (`RouterAttempt {model, provider, status}`), which is opt-in via request header `X-OpenRouter-Metadata: enabled`; treat the top-level field as de-facto (SDK-relied-on) and UNCONFIRMED: not in the formal response schema. Read it via `(await result.finalStep).providerMetadata?.openrouter?.provider` or the `finish-step` part.

**Model fallbacks** (https://openrouter.ai/docs/guides/routing/model-fallbacks): `"models": ["primary/model", "backup/model"]` (model setting `models` or `providerOptions.openrouter.models`); any error triggers the next model (context length, moderation, rate limit, downtime); billed at the model that answered; read the response `model` (`finalStep.response.modelId`). No documented limit on list length.

---

## 9. Usage accounting

Docs: https://openrouter.ai/docs/use-cases/usage-accounting
- **`"usage": {"include": true}` and `stream_options.include_usage` are deprecated and have no effect** — usage is always returned (non-streaming: in `usage`; streaming: in an extra final chunk before `[DONE]` whose `choices[0].delta` is `{"content":"","role":"assistant"}` and repeats `finish_reason` — OpenRouter deliberately deviates from OpenAI's empty `choices` array there). Keeping the provider's `usage.include` setting is harmless.
- Chat Completions usage shape:
```json
"usage": {
  "prompt_tokens": 194, "completion_tokens": 2, "total_tokens": 196,
  "cost": 0.00095, "is_byok": false,
  "prompt_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 100, "audio_tokens": 0, "video_tokens": 0 },
  "completion_tokens_details": { "reasoning_tokens": 0, "audio_tokens": 0, "accepted_prediction_tokens": 0, "rejected_prediction_tokens": 0 },
  "cost_details": { "upstream_inference_cost": null, "upstream_inference_prompt_cost": 0, "upstream_inference_completions_cost": 0 }
}
```
`cost` = USD credits charged; `cached_tokens` = cache reads; `cache_write_tokens` only for explicit-caching models; `upstream_inference_cost` only for BYOK. The `cost_details` sub-field names above are from the API reference; the usage-accounting guide shows them as `upstream_inference_input_cost` / `upstream_inference_output_cost` — docs disagree, so read them defensively.
- AI SDK exposure [src d.ts 686-692, JS 4518-4540, 5018-5042]:
```ts
const step = await result.finalStep;              // or the 'finish-step' / 'finish' part
step.usage                                         // LanguageModelUsage (see 3); step.usage.raw = OpenRouter usage object (includes cost)
step.providerMetadata?.openrouter === {
  provider: 'DeepInfra',
  usage: { promptTokens, completionTokens, totalTokens, cost?, promptTokensDetails?: { cachedTokens }, completionTokensDetails?: { reasoningTokens }, costDetails?: { upstreamInferenceCost } },
  reasoning_details?: [...], annotations?: [...]
}
```
Per step; sum `cost` over `await result.steps` for a multi-step reply. `is_byok` is **not** mapped into chat `providerMetadata.openrouter.usage` by 3.1.0 (only `cost`, `cachedTokens`, `reasoningTokens`, `upstreamInferenceCost` are; the README's `usage.isByok` example does not match the chat code) — read it from `step.usage.raw.is_byok`, which carries the OpenRouter usage object verbatim on both streaming and non-streaming paths. `result.usage` (total) has no cost; use metadata or `usage.raw`.
- Audit later: `GET /api/v1/generation?id=<gen-...>` -> `data: { id, model, provider_name, latency, generation_time, moderation_latency, total_cost, usage, cache_discount, upstream_inference_cost, tokens_prompt, tokens_completion, native_tokens_prompt, native_tokens_completion, native_tokens_reasoning, native_tokens_cached, finish_reason, native_finish_reason, is_byok, streamed, cancelled, created_at, data_region, provider_responses[], session_id, external_user, … }` (https://openrouter.ai/docs/api-reference/get-a-generation). Response `id` is the generation id (`finalStep.response.id`). Availability delay UNCONFIRMED (typically needs a short wait).

---

## 10. Prompt caching through OpenRouter

Docs: https://openrouter.ai/docs/features/prompt-caching

| Family | Mechanism | Write | Read | Min prefix |
|---|---|---|---|---|
| OpenAI (pre-GPT-5.6) | automatic | free | 0.25x-0.5x | 1024 tokens |
| OpenAI GPT-5.6+ (incl. gpt-6.x, which list `input_cache_write` 1.25x and `input_cache_read` 0.05-0.1x [live]) | automatic, or explicit `prompt_cache_breakpoint` + `prompt_cache_options.mode:"explicit"` (30 min 1.25x / 12 h 2.5x) | 1.25x | model rate | 1024 tokens |
| Anthropic | automatic (root `cache_control`) **or** per-block `cache_control` | 5m: 1.25x, 1h: 2x | docs say 0.1x; live `/models` pricing: 0.1x Haiku 5.5 / Fable 5, **0.05x** Sonnet 5.5 / Opus 5.5, **0.025x** Fable 5.1 — read `input_cache_read` per model | **512 tokens** for Fable 5.1 / Fable 5 / Opus 5.5 / Opus 5 / Sonnet 5.5 / Haiku 5.5; 1024 for Sonnet 5 / 4.6 / 4.5, Opus 4.8 / 4.1 / 4, Sonnet 4; 2048 Opus 4.7, Haiku 3.5; 4096 Opus 4.6 / 4.5, Haiku 4.5 |
| DeepSeek | automatic | = input price | 0.1x | UNCONFIRMED |
| Moonshot AI | automatic | free | 0.25x | UNCONFIRMED |
| Z.AI | automatic (session affinity by account + `session_id`) | free (promo) | ~0.2x | UNCONFIRMED |
| Groq (Kimi) | automatic | free | 0.5x | UNCONFIRMED |

- Anthropic breakpoints: **max 4**; TTL `{"type":"ephemeral"}` (5 min) or `{"type":"ephemeral","ttl":"1h"}` — 1h **is** supported via OpenRouter (pricing field `input_cache_write_1h` present on `anthropic/*` endpoints [live]). Automatic caching: root-level `"cache_control": {"type":"ephemeral"}` (supported on Anthropic, Vertex, Azure, Bedrock, Claude Platform on AWS endpoints).
- Third-party hosts of open-weight models cache only if the endpoint has `supports_implicit_caching: true` and an `input_cache_read` price [live]; pin `provider.order` to such endpoints or caching silently does nothing.
- Sticky routing: with caching, OpenRouter keeps routing to the same provider for 10 min of inactivity (each success resets the timer); it only activates when the endpoint's cache-read price is below its prompt price, and it is **skipped entirely when `provider.order` is set**. Default key = hash of first system + first non-system message; pass **`session_id`** (body, <= 256 chars; or `x-session-id` header, body wins) to override -> use the contact's phone-number hash per Durable Object: `providerOptions: { openrouter: { session_id } }`. So: either pin `order` (deterministic endpoint, no stickiness needed) or leave routing free and rely on `session_id`.

**AI SDK placement** [README + src JS 3689-3806, 3886, 3901]:
```ts
// system prompt breakpoint (instructions accepts a SystemModelMessage)
instructions: { role: 'system', content: SYSTEM, providerOptions: { openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } },
// user text part breakpoint
{ role: 'user', content: [
    { type: 'text', text: BIG_CONTEXT, providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } } },
    { type: 'text', text: 'question' } ] }
// message-level providerOptions on a user message -> applied to its LAST text part; also honoured on file parts, assistant and tool messages
// automatic (Anthropic): model setting  cache_control: { type: 'ephemeral' }   or call-level providerOptions.openrouter.cacheControl
```
Serialised as `{ "type":"text", "text":"...", "cache_control": { "type":"ephemeral", "ttl":"1h" } }` inside `content` arrays (system is always sent as a content array by the provider).
- Cache reads surface as `usage.inputTokenDetails.cacheReadTokens` (`prompt_tokens_details.cached_tokens`); writes as `cacheWriteTokens` (`cache_write_tokens`, explicit-caching models only). `cache_discount` is **not** in the chat `usage`; it is on the `/generation` record (negative for Anthropic writes, positive for reads).
- Gotcha for all families: keep the prefix byte-identical (system prompt, tool definitions, earliest messages); put the per-turn dynamic context last. Tool JSON schemas are part of the prefix for most providers.

---

## 11. Errors, limits, headers

Docs: https://openrouter.ai/docs/api-reference/errors, https://openrouter.ai/docs/api-reference/limits, https://openrouter.ai/docs/app-attribution
```json
{ "error": { "code": 402, "message": "...", "metadata": { "...": "..." } } }
```
HTTP status == `error.code` for request-level failures.

| Code | Meaning | metadata |
|---|---|---|
| 400 | bad params / CORS | |
| 401 | bad or disabled key | |
| 402 | insufficient credits; also in-flight budget: `reason:"in_flight_budget_exhausted"` + `limit_source:"openrouter_in_flight_budget"` (transient, honour `Retry-After`) or `reason:"weight_exceeds_budget"` + `limit_source:"openrouter_credits"` (lower `max_tokens`/prompt; retry useless). No SDK auto-retries 402 — catch it yourself | `reason, limit_source, remedy_hint` |
| 403 | moderation / guardrail / org budget spent (`limit_source:"openrouter_guardrail_budget"`, `resets_at`) | moderation: `{ reasons[], flagged_input (<=100 chars), provider_name, model_slug }` |
| 404 | no endpoint matches restrictions (seen with strict json_schema / data policy) | |
| 408 | request timed out | |
| 429 | rate limited (OpenRouter free-model caps/DDoS, or upstream) | `{ error_type:"rate_limit_exceeded", provider_code? }`; `X-RateLimit-Limit/Remaining/Reset` headers only on OpenRouter platform-limit 429s (never on successes); `Retry-After` may appear on 429/503 and in-flight-budget 402 |
| 502 | model down / invalid upstream response (`error_type:"provider_unavailable"`) | provider errors carry typed `error_type` + `provider_code`; a 500 gets a generic message and `error_type:"server"`; 503 overload is `provider_overloaded` |
| 503 | no provider meets routing requirements | |

- **Mid-stream errors** arrive inside a `200` stream: an SSE event with top-level `error` and `choices[].finish_reason:"error"`, then the stream ends. Non-streaming can also return `200` with a body that holds only `error` — the provider turns that into an `APICallError` [src JS 4373-4379]. In `streamText` these reach `onError` / `error` parts (fatal transport errors throw).
- Empty content with `finish_reason:"length"` = reasoning ate `max_tokens`; cold-start/no-content cases may still bill prompt tokens.
- AI SDK retries [src ai JS 362, 2325-2339]: `maxRetries` default 2; retries when `APICallError.isRetryable`, which defaults to status **408, 409, 429 or >= 500**; delay 2 s doubling, but honours `retry-after-ms` / `retry-after` headers when 0-60 s; `RetryError` wraps the failures. 402 and mid-stream `error` parts are not retried.
- Rate limits: paid models have no fixed RPM; they are credit/budget bound. Free (`:free`) models: 20 req/min; 50 req/day (< 10 credits bought all-time) or 1000/day. Negative balance -> errors. Check a key with `GET https://openrouter.ai/api/v1/key` -> `data: { label, limit, limit_reset, limit_remaining, usage, usage_daily, usage_weekly, usage_monthly, is_free_tier, free_model_daily_requests: { used, limit, remaining }, ... }`.
- Attribution headers: `HTTP-Referer: <app url>` (required for attribution) and `X-OpenRouter-Title: <name>` (`X-Title` legacy, still accepted). Provider: `createOpenRouter({ appUrl, appName })`.

---

## 12. Timeouts and retries (code-ready)

```ts
const result = streamText({
  model: openrouter.chat(modelId, { provider: { order: [...], allow_fallbacks: true }, structuredOutputs: { strict: false } }),
  instructions, messages, tools,
  stopWhen: isStepCount(4),
  maxOutputTokens: 1024,
  maxRetries: 1,                                   // reply path; default is 2
  abortSignal: AbortSignal.timeout(45_000),        // passed straight to fetch by the provider [src JS 4370, 4574]
  timeout: { firstChunkMs: 15_000, chunkMs: 20_000, totalMs: 60_000, tools: { viewPageMs: 20_000 } },  // v7 RequestOptions.timeout
  providerOptions: { openrouter: { reasoning: { effort: 'low' }, session_id: contactKey, user: contactKey } },
  onError: ({ error }) => log(error),
  onAbort: ({ steps }) => persistPartial(steps),
});
```
- `timeout` fields [src d.ts 777-784]: `totalMs`, `stepMs` (model + retries + local tools per step), `firstChunkMs` (streaming, until first content chunk), `chunkMs` (gap between chunks), `toolMs`, `tools: { [toolName + 'Ms']: n }`. `abortSignal` and `timeout` compose; `onEnd` is skipped on abort, `onAbort` fires.
- On a Durable Object, wrap the whole call in the request/alarm handler; keep `totalMs` below your DO budget.

---

## Gotchas checklist (implementer)
1. Pin `ai@^7` + provider `^3`; provider 2.x only pairs with ai 6, 1.x with ai 5. ESM-only; Node >= 22.
2. v7 renames: `system` -> `instructions`; `stepCountIs` -> `isStepCount` (alias kept); `onFinish` -> `onEnd`; `fullStream` -> `stream`; `usage` now totals all steps (`finalStep.usage` for last step); `cachedInputTokens` -> `usage.inputTokenDetails.cacheReadTokens`; `reasoningTokens` -> `usage.outputTokenDetails.reasoningTokens`; `experimental_output` -> `output`; `{type:'image'}` user part deprecated for `{type:'file'}`; tool `media` output removed (`file` with tagged `data`).
3. System messages inside `messages` throw unless `allowSystemInMessages: true`; pass the system prompt via `instructions` (object form to attach `cacheControl`).
4. The v7 top-level `reasoning` call option is ignored by provider 3.1.0 — use `providerOptions.openrouter.reasoning`. The provider's effort type lacks `'max'`.
5. `providerOptions.openrouter.*` is spread over the body and **replaces** same-named model settings (whole `provider` object included).
6. `Output.object` sends `response_format.json_schema` with `strict:true` by default; for Kimi/GLM/DeepSeek third-party hosts set `structuredOutputs: { strict: false }` or `provider.require_parameters: true`, or you get 404 "No endpoints available".
7. `usage.include` is a no-op; usage always comes back; cost is in `providerMetadata.openrouter.usage.cost` (per step) or `usage.raw.cost`; `is_byok` only in `usage.raw`.
8. Anthropic 5.5 models cannot disable thinking (lowest `effort:'low'`); `gpt-6.1-sol` is also mandatory; `gpt-6-sol`/`gpt-6-luna`, DeepSeek V4, GLM-5.2 accept `none`; Kimi K2.6 uses `enabled:false`. No model in the set lists `minimal`.
9. Caching on open-weight hosts depends on the endpoint (`supports_implicit_caching`); send `session_id` for sticky routing (ignored once `provider.order` is set); Anthropic min cacheable prefix is 512 tokens on the 5.x line, 4 breakpoints max, `ttl:'1h'` works, cache-read ratio varies per model (0.025x-0.1x).
10. WhatsApp media URLs are auth-gated and extension-less: download bytes yourself and pass `Uint8Array` + `mediaType`; otherwise the SDK will try (and fail) to download them.
11. Multimodal tool results are converted to `image_url` parts in `role:"tool"` messages; acceptance by DeepSeek/Kimi/GLM hosts is unverified — have the text-only fallback ready.
12. Mid-stream OpenRouter errors come as `error` stream parts under HTTP 200; always wire `onError` and check `finishReason === 'error'`.

---

## Verification (2026-11-04)

Checked ~200 concrete claims (versions, option/field names, JS types, numbers, prices, behaviours) against: npm registry; a fresh install of `ai@7.0.162` + `@openrouter/ai-sdk-provider@3.1.0` (+ `@ai-sdk/provider@4.0.35`, `provider-utils@5.0.74`, `gateway@4.0.135`, `zod@4.6.7`) read directly; provider README/CHANGELOG on GitHub main; OpenRouter docs served as markdown (reasoning-tokens, provider-selection, usage-accounting, prompt-caching, errors-and-debugging, limits, structured-outputs, app-attribution, model-fallbacks, image-understanding, get-a-generation, chat-completion OpenAPI, streaming); Cloudflare `nodejs` and `workers-ai/ai-sdk` pages; live `GET /api/v1/models`, `/providers`, `/models/{kimi-k2.6,deepseek-v4-flash,glm-5.2,claude-sonnet-5.5}/endpoints`. Everything not listed below matched its source, including the full per-model `reasoning` descriptor table, all `provider` routing fields and defaults, the quantization list, the 4-breakpoint / 512-token / 1h-TTL Anthropic caching facts, free-model rate limits, the v7 rename list, stream-part shapes, `LanguageModelUsage`, `StepResultPerformance`, `TimeoutConfiguration` and the `toModelOutput` union.

Corrections made (before -> after, source):
1. "no `node:` imports at runtime" -> no *static* `node:` imports; `ai` loads `node:diagnostics_channel`/`node:async_hooks` and provider-utils + provider load `node:dns`/`node:module` via `process.getBuiltinModule`, gated by `isNodeRuntime()` which is false under workerd/EdgeRuntime (installed `ai/dist/index.js` L4046-4115, `@openrouter/ai-sdk-provider/dist/index.js` L1130-1167). Conclusion unchanged.
2. Legacy line "2.9.1 for ai v6 (README)" -> README says 2.9.1 but npm's newest 2.x is 2.10.0, 2026-06-26 (https://registry.npmjs.org/@openrouter/ai-sdk-provider).
3. Bare `openrouter(id)` overload UNCONFIRMED -> resolved: chat model unless id is `openai/gpt-3.5-turbo-instruct` (provider JS L6286-6300).
4. Reasoning: "Gemini maps unsupported effort to nearest" + general behaviour UNCONFIRMED -> docs state nearest-supported mapping generally; Claude sends `minimal` as `low` and rejects `none`; effort-only models derive effort from `max_tokens` and vice versa (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md L104, L124, L357, L584).
5. Endpoint JSON example showed `input_cache_write`, `input_cache_write_1h`, `overrides` on a DeepInfra GLM endpoint -> open-weight endpoint pricing is `{prompt, completion, input_cache_read, discount}`; write prices only on Anthropic/OpenAI endpoints; `overrides` only in `/models` (live `/endpoints` 2026-11-04).
6. Live endpoint snapshot statuses -> `fireworks` for deepseek-v4-flash is -2 (was -5), `alibaba/fp8/us-east-1` -5, `nebius/fp4` for glm-5.2 -5; added endpoints that exist (digitalocean, streamlake, baidu, phala, chutes, morph, coreweave, tier variants) and which lack `structured_outputs` (live `/endpoints` 2026-11-04).
7. Routing: added that `:nitro` also admits priority-tier endpoints and that sticky routing is skipped when `provider.order` is set (provider-selection.md L139; prompt-caching.md L25).
8. Structured outputs: added that `response_format`/`tools`/`verbosity` are soft routing preferences even without `require_parameters` (provider-selection.md L1058).
9. Streaming final usage chunk "delta is empty" -> delta is `{"content":"","role":"assistant"}` (https://openrouter.ai/docs/api_reference/streaming.md L86-91).
10. `cost_details` names -> API reference uses `upstream_inference_prompt_cost`/`upstream_inference_completions_cost`, usage guide uses `_input_cost`/`_output_cost`; flagged the disagreement (chat-completion OpenAPI L2760-2762; usage-accounting.md L48-50).
11. `is_byok` exposure UNCONFIRMED -> not mapped into chat `providerMetadata.openrouter.usage` (provider JS L4523-4540, L5018-5042); available as `usage.raw.is_byok` (provider JS L3361, L5034). README `usage.isByok` example is wrong for chat.
12. Anthropic cache read "0.1x" -> docs say 0.1x, live per-model pricing is 0.1x Haiku 5.5 / Fable 5, 0.05x Sonnet 5.5 / Opus 5.5, 0.025x Fable 5.1 (live `/models` 2026-11-04; prompt-caching.md L352).
13. Sticky routing: added 10-min timer reset, cache-read-cheaper-than-prompt precondition, default key = first system + first non-system message hash, body `session_id` wins over header (prompt-caching.md L21-41).
14. 402/403/429/502 rows: added `limit_source` values, org-budget 403, that `X-RateLimit-*` headers appear only on OpenRouter platform-limit errors, that no SDK auto-retries 402, and that `error_type:"server"` is specific to 500 (limits.md L84-100, L241; errors-and-debugging.md L51-58, L86-95, L200, L330).
15. AI SDK retry predicate UNCONFIRMED -> resolved: 408/409/429/>=500, 2 s base, x2, honours `retry-after(-ms)` 0-60 s (installed `ai/dist/index.js` L362, L2325-2339).
16. `toModelOutput` file `data` union -> added the fourth variant `{type:'text', text}` (`@ai-sdk/provider` d.ts L1393-1402).
17. Tool-result/tool tweaks in gotchas 7 and 9 to match 11 and 13.

Still UNCONFIRMED after this pass:
- Execution under workerd not smoke-tested (section 1).
- Image count/size limits per provider (section 5): image-understanding page gives none.
- Whether DeepSeek V4 / Kimi K2.6 / GLM-5.2 hosts accept `image_url` parts inside `role:"tool"` messages (section 6).
- Whether `moonshotai/kimi-k2.6` accepts `reasoning.effort:'none'` (section 7): no `supported_efforts` in its descriptor and no API key to test.
- Exact semantics of negative endpoint `status` values -2 / -5 (section 8): not documented.
- Top-level `provider` string on chat responses (section 8): relied on by the SDK, absent from the formal OpenAPI response schema, which only documents `openrouter_metadata` (opt-in header).
- `/generation` availability delay after a request (section 9).
- Minimum cacheable prefix for DeepSeek / Moonshot / Z.AI / Groq (section 10): docs do not state one.
