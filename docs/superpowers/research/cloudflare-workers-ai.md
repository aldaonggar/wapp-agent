# Cloudflare Workers AI: `@cf/baai/bge-m3` + `@cf/openai/whisper-large-v3-turbo`

Researched 2026-11-04 from developers.cloudflare.com (pages dated Apr–Oct 2026), the raw model JSON schemas linked from those pages, `@cloudflare/workers-types@5.20261104.1`, and the AI-binding runtime source in `cloudflare/workerd` (`src/cloudflare/internal/ai-api.ts`, main). Anything not from those is labelled HINT or UNCONFIRMED.

## 0. Platform facts (both models)

| Fact | Value | Source |
|---|---|---|
| Price | **$0.011 per 1,000 Neurons** | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Free allocation | **10,000 Neurons/day**, Free and Paid plans alike; resets 00:00 UTC; on Free plan going over fails with error `3036` (HTTP 429) | same |
| Wrangler binding | `{"ai": {"binding": "AI"}}` (jsonc) / `[ai] binding = "AI"` (toml) → `env.AI` | https://developers.cloudflare.com/workers-ai/configuration/bindings/ |
| `wrangler dev` | AI binding **always hits the real remote service**, no local simulation; usage **is billed / counts against limits** in local dev. Add `"remote": true` to the `ai` block (omitted → warning; `remote: false` → error) | https://developers.cloudflare.com/workers/local-development/ ; https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/ ; https://developers.cloudflare.com/workers-ai/platform/limits/ |
| Vitest | Remote bindings "are supported by Wrangler, the Cloudflare Vite plugin, and the `@cloudflare/vitest-plugin` package" (the doc names `@cloudflare/vitest-plugin`, npm 1.5.1; the older `@cloudflare/vitest-pool-workers` 0.23.0 still exists but is not the one the page cites). No AI-specific vitest note exists. Our Node-24 eval harness should call the **REST API** directly (section 1.5 / 2.5) | https://developers.cloudflare.com/workers/local-development/#remote-bindings |
| Data retention | Both models: "Zero data retention: Yes" | model pages |
| REST base | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model_name}`, header `Authorization: Bearer <token>`, body = model inputs directly ("without a model/input/options wrapper") | https://developers.cloudflare.com/api/resources/ai/methods/run/ |
| REST envelope | `{"result": <model output>, "success": true, "errors": [], "messages": []}` | https://developers.cloudflare.com/workers-ai/get-started/rest-api/ |
| Token permission | API ref: "Accepted Permissions (at least one required): `Workers AI Write`, `Workers AI Read`". Dashboard template is "Create a Workers AI API Token". Get-started note says a hand-made token "will need permissions for both `Workers AI - Read` and `Workers AI - Edit`" (docs contradict; give it both to be safe). Permission names in the permissions table: `Workers AI Read`, `Workers AI Edit` (also shown as `Workers AI Write`) | https://developers.cloudflare.com/api/resources/ai/methods/run/ ; https://developers.cloudflare.com/workers-ai/get-started/rest-api/ ; https://developers.cloudflare.com/fundamentals/api/reference/permissions/ |
| REST API rate limit (whole CF API) | 1200 requests / 5 min per user or account token; 200/s per IP | https://developers.cloudflare.com/fundamentals/api/reference/limits/ |

### wrangler.jsonc

```jsonc
{
  "compatibility_date": "2026-11-04",
  "compatibility_flags": ["nodejs_compat"],   // only needed if you use node:buffer for base64
  "ai": { "binding": "AI", "remote": true }
}
```

`wrangler types` emits `interface Env { AI: Ai; }` (the `Ai` class and all `Ai_Cf_*` types ship in `@cloudflare/workers-types` / the generated `worker-configuration.d.ts`).

## 1. `@cf/baai/bge-m3` (Text Embeddings)

Model page: https://developers.cloudflare.com/workers-ai/models/bge-m3/
Raw schemas: `.../bge-m3/sync-input.json`, `batch-input.json`. Two docs defects: `sync-input.json` only documents the query+contexts variant (the plain `text` variant appears only inside `batch-input.json`'s `oneOf` and in workers-types), and `sync-output.json` / `batch-output.json` both show only the async `{request_id}` shape; the real output shapes come from workers-types, below.

| Fact | Value | Source |
|---|---|---|
| Price | **$0.012 per M input tokens = 1,075 neurons per M input tokens** (model page rounds to $0.0118). Free tier ≈ 9.3M tokens/day | pricing page, "Embeddings model pricing" |
| Rate limit | **Text Embeddings: 3,000 requests/min** (per task type) | https://developers.cloudflare.com/workers-ai/platform/limits/ |
| Context window | Model page table says "Context Window 60,000 tokens" (CF glossary defines context window as total input+output tokens per request, not per text). HINT: the upstream model card (huggingface.co/BAAI/bge-m3) says "long documents of up to 8192 tokens" / Sequence Length 8192. UNCONFIRMED which limit the CF deployment enforces per text; treat 8,192 as the safe per-text ceiling | model page; HF card |
| Dimension | UNCONFIRMED on CF docs (not stated). HINT: HF card lists Dimension 1024. Read it from `shape[1]` at runtime | HF card |
| Normalized? | UNCONFIRMED. Neither CF docs nor the HF card state L2-normalization; HF example scores with a plain dot product. **Use cosine similarity, or normalize yourself** before relying on dot product | HF card |
| Max texts per call | **100** (`text` array `maxItems: 100`) | batch-input.json schema |
| Min text length | `minLength: 1` on every `text`; empty string is a schema violation | sync/batch-input.json |
| Multilingual | CF description: "Multi-Functionality, Multi-Linguality, and Multi-Granularity embeddings model." HINT (HF card): "more than 100 working languages"; Russian/Kazakh not named; "BGE-M3 model no longer requires adding instructions to the queries" (no query prefix needed) | model page; HF card |
| Batch/async | Supported: wrap in `{requests:[...]}` + `queueRequest: true`; poll with `{request_id}`; total payload < 10 MB | https://developers.cloudflare.com/workers-ai/features/batch-api/workers-binding/ |

### 1.1 Input shapes (exact, from workers-types 5.20261104.1 = docs JSON)

There is **no `pooling` input parameter**. `pooling` appears only in the output (reports what was used).

```ts
// Mode A: plain embeddings
interface Ai_Cf_Baai_Bge_M3_Input_Embedding {
  text: string | string[];        // string minLength 1; array maxItems 100
  truncate_inputs?: boolean;      // default false: "When provided with too long context should the model error out or truncate the context to fit?"
}

// Mode B: query + contexts (rerank-style scores), or embeddings-for-contexts when query is omitted
interface Ai_Cf_Baai_Bge_M3_Input_QueryAnd_Contexts {
  query?: string;                 // minLength 1. "If no query is provided the model with respond with embeddings for contexts"
  contexts: { text?: string }[];  // "the index in this array is important, as the response will refer to it"
  truncate_inputs?: boolean;
}

// Mode C: async batch (third arg { queueRequest: true })
{ requests: (Ai_Cf_Baai_Bge_M3_Input_QueryAnd_Contexts | Ai_Cf_Baai_Bge_M3_Input_Embedding)[] }
// poll: env.AI.run("@cf/baai/bge-m3", { request_id: "<uuid>" })
```

### 1.2 Output shapes (exact, workers-types)

```ts
type Ai_Cf_Baai_Bge_M3_Output =
  | Ai_Cf_Baai_Bge_M3_Output_Embedding              // Mode A
  | Ai_Cf_Baai_Bge_M3_Output_EmbeddingFor_Contexts  // Mode B without query
  | Ai_Cf_Baai_Bge_M3_Output_Query                  // Mode B with query
  | Ai_Cf_Baai_Bge_M3_AsyncResponse;                // Mode C

interface Ai_Cf_Baai_Bge_M3_Output_Embedding {
  shape?: number[];               // [n, dim]
  data?: number[][];              // "Embeddings of the requested text values", one per input text, same order
  pooling?: "mean" | "cls";       // "The pooling method used in the embedding process."
}
interface Ai_Cf_Baai_Bge_M3_Output_EmbeddingFor_Contexts {
  response?: number[][];          // NOTE: key is `response`, not `data`
  shape?: number[];
  pooling?: "mean" | "cls";
}
interface Ai_Cf_Baai_Bge_M3_Output_Query {
  response?: { id?: number; score?: number }[];   // id = index into contexts
}
interface Ai_Cf_Baai_Bge_M3_AsyncResponse { request_id?: string; }
```

Every field is optional in the types, so narrow before use. Documented example of query-mode scores (from the batch page): `[{ "id": 0, "score": 0.73974609375 }, { "id": 1, "score": 0.642578125 }, ...]`.

UNCONFIRMED: which pooling the CF deployment reports by default (`cls` vs `mean`); whether `shape`/`data` can ever be absent on a 2xx.

### 1.3 Binding call (code-ready)

```ts
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 100) throw new Error("bge-m3: max 100 texts per call");
  const out = await env.AI.run("@cf/baai/bge-m3", { text: texts, truncate_inputs: true });
  if (!("data" in out) || !out.data) throw new Error("bge-m3: unexpected output " + JSON.stringify(out).slice(0, 200));
  return out.data;   // out.shape ≈ [texts.length, 1024]
}
// self-check once in dev: Math.hypot(...vec) ≈ 1 ? dot product is cosine : normalize first.
```

Query/rerank mode: `env.AI.run("@cf/baai/bge-m3", { query, contexts: candidates.map(text => ({ text })) })` → `out.response` sorted by you (not guaranteed sorted).

### 1.4 Pricing math

Neurons are charged on input tokens: `tokens / 1e6 * 1075`. A 200-token message ≈ 0.2 neurons ≈ $0.0000024. 10,000 free neurons/day ≈ 9.3M tokens/day.

### 1.5 REST (for the Node eval harness)

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/baai/bge-m3 \
  -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "text": ["This is a story about an orange cloud", "This is a story about a llama"], "truncate_inputs": true }'
```
Source: model page curl tab. Response: `{"result": {"shape": [2, 1024], "data": [[...],[...]], "pooling": "..."}, "success": true, "errors": [], "messages": []}` (envelope from the REST get-started page; inner object = 1.2; the literal `shape`/`pooling` values are UNCONFIRMED until first call).

```ts
// Node 24
const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/baai/bge-m3`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text: texts, truncate_inputs: true }),
});
const j = await r.json() as { success: boolean; result?: { data?: number[][]; shape?: number[] }; errors: { code: number; message: string }[] };
if (!r.ok || !j.success) throw new Error(`workers-ai ${r.status}: ${JSON.stringify(j.errors)}`);
```

Alternative (OpenAI-shaped): `POST .../accounts/{account_id}/ai/v1/embeddings` with `{"model": "@cf/baai/bge-m3", "input": "..."|[...]}`; docs show embedding models support the OpenAI Embeddings API (https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/). UNCONFIRMED: response body example not shown in docs (assume standard OpenAI `{data:[{embedding,index}],usage}`).

Async via REST: `POST .../ai/run/@cf/baai/bge-m3?queueRequest=true` with `{"requests":[...]}` → `{"result": {"status":"queued","request_id":"...","model":"@cf/baai/bge-m3"}, "success": true, ...}`; poll with the same URL (keep `?queueRequest=true`) and body `{"request_id":"<uuid>"}` → `{"result": {"responses":[{"id":0,"result":{...},"success":true,"external_reference":"..."}],"usage":{...}}, ...}`. Each request may carry an `external_reference` string that is echoed back (https://developers.cloudflare.com/workers-ai/features/batch-api/rest-api/).

## 2. `@cf/openai/whisper-large-v3-turbo` (Automatic Speech Recognition)

Model page: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
Raw schemas: `.../whisper-large-v3-turbo/schema-input.json`, `schema-output.json`.

| Fact | Value | Source |
|---|---|---|
| Price | Model page: **$0.000513 per audio minute**. Pricing page: "$0.0005 per audio minute / 46.63 neurons per audio minute" (46.63 × $0.011/1000 = $0.000513, consistent). Free tier ≈ 214 audio-minutes/day | model page; pricing page |
| Rate limit | **ASR: 720 requests/min** | limits page |
| Batch | "Batch: Yes" (async queue supported) | model page |
| Supported formats | **UNCONFIRMED: docs list no container/codec list.** Official tutorial feeds `.mp3`. WhatsApp voice notes are `audio/ogg; codecs=opus`: smoke-test before relying on it | tutorial |
| Max size / duration | **UNCONFIRMED.** Tutorial says chunking "helps overcome memory and execution time limitations" and chunks at 1 MB; batch payloads must be < 10 MB; oversize → error `3006` "Request is too large" (HTTP 413) | tutorial; batch page; errors page |
| Latency | **UNCONFIRMED** (not documented) | — |
| Languages | `language` is free-form string "The language of the audio being transcribed or translated"; auto-detected when omitted (output has `language` + `language_probability`) | schema |

### 2.1 Input shape (exact, schema-input.json = workers-types)

```ts
interface Ai_Cf_Openai_Whisper_Large_V3_Turbo_Input {
  audio:                                   // required
    | string                               // "Base64 encoded value of the audio data."
    | { body?: object; contentType?: string }; // raw stream variant, see 2.3
  task?: string;                           // default "transcribe"; "Supported tasks are 'translate' or 'transcribe'."
  language?: string;                       // e.g. "ru", "kk", "en"
  vad_filter?: boolean;                    // default false. "Preprocess the audio with a voice activity detection model."
  initial_prompt?: string;                 // "A text prompt to help provide context to the model on the contents of the audio."
  prefix?: string;                         // "appended to the beginning of the output of the transcription and can guide the transcription result."
  beam_size?: number;                      // default 5
  condition_on_previous_text?: boolean;    // default true; "Setting to false may help prevent hallucination loops."
  no_speech_threshold?: number;            // default 0.6
  compression_ratio_threshold?: number;    // default 2.4
  log_prob_threshold?: number;             // default -1
  hallucination_silence_threshold?: number;// seconds; optional
}
```

NOT the old `@cf/openai/whisper` shape (`audio: number[]` of 0–255 bytes, or a raw binary body). The generic API-reference page still documents that legacy `AutomaticSpeechRecognition {audio: array of number}` variant; ignore it for the turbo model.

### 2.2 Output shape (exact, schema-output.json = workers-types)

```ts
interface Ai_Cf_Openai_Whisper_Large_V3_Turbo_Output {
  text: string;                            // only required field. "The complete transcription of the audio."
  word_count?: number;
  transcription_info?: {
    language?: string;
    language_probability?: number;         // 0..1
    duration?: number;                     // seconds, original audio
    duration_after_vad?: number;           // seconds
  };
  segments?: {
    start?: number; end?: number; text?: string;
    temperature?: number; avg_logprob?: number; compression_ratio?: number; no_speech_prob?: number;
    words?: { word?: string; start?: number; end?: number }[];
  }[];
  vtt?: string;                            // WebVTT
}
```

### 2.3 Binding call (code-ready)

Base64 path (documented, works with AI Gateway):

```ts
export async function transcribe(env: Env, bytes: ArrayBuffer, language?: string): Promise<string> {
  // base64 without nodejs_compat; chunked to avoid String.fromCharCode arg limits
  const u8 = new Uint8Array(bytes); let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: btoa(bin),
    task: "transcribe",
    ...(language ? { language } : {}),
    vad_filter: true,
  });
  return out.text;
}
// With nodejs_compat the tutorial does: Buffer.from(chunkBuffer, "binary").toString("base64")
// (https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/)
```

Raw-stream path (from workerd source `ai-api.ts`, not from docs; label: runtime source, may change):
- If any input value is a `ReadableStream`/`FormData`, or an object `{ body: ReadableStream|FormData, contentType }`, the binding POSTs **that body as the raw request body** with `content-type: contentType` and serialises the *other* inputs as a `userInputs` JSON query param.
- Exactly one stream key allowed (`AiInternalError: Multiple ReadableStreams are not supported`); `contentType` is required (`AiInternalError: Content-Type is required with ReadableStream inputs`); **not supported with `gateway`** (`AI Gateway does not support ReadableStreams yet`).
- So: `env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: { body: resp.body, contentType: "audio/ogg" }, language: "ru" })`. UNCONFIRMED that the model backend accepts this for turbo; it saves the base64 round-trip in memory if it does.

### 2.4 Pricing math

`minutes * 46.63` neurons. A 30-second voice note ≈ 23 neurons ≈ $0.00026.

### 2.5 REST

```bash
# JSON + base64 (safe path)
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/openai/whisper-large-v3-turbo \
  -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"audio\": \"$(base64 -i note.ogg | tr -d '\n')\", \"task\": \"transcribe\", \"vad_filter\": true}"
```
Response: `{"result": {"text": "...", "word_count": n, "segments": [...], "transcription_info": {...}, "vtt": "..."}, "success": true, "errors": [], "messages": []}`.

Binary body via REST: the API reference says the endpoint "Accepts model-specific JSON or binary input", and the legacy whisper schema has a `string, format: binary` variant, but **UNCONFIRMED** for the turbo model (no documented header/example). Use JSON+base64 unless a smoke test proves otherwise.

## 3. TypeScript surface (`@cloudflare/workers-types@5.20261104.1`)

```ts
interface AiModels {
  "@cf/baai/bge-m3": Base_Ai_Cf_Baai_Bge_M3;                                   // { inputs: Ai_Cf_Baai_Bge_M3_Input; postProcessedOutputs: Ai_Cf_Baai_Bge_M3_Output }
  "@cf/openai/whisper-large-v3-turbo": Base_Ai_Cf_Openai_Whisper_Large_V3_Turbo; // { inputs: ..._Input; postProcessedOutputs: ..._Output }
}
type AiOptions = {
  queueRequest?: boolean;      // async batch, supported models only
  websocket?: boolean;
  tags?: string[];             // ≤5 tags, ≤50 chars, chars: letters digits : - . / @
  gateway?: GatewayOptions;    // { id: string; cacheKey?; cacheTtl?; skipCache?; metadata?; collectLog?; eventId?; requestTimeoutMs?; retries?: { maxAttempts?: 1|2|3|4|5; retryDelayMs?; backoff?: "constant"|"linear"|"exponential" } }
  returnRawResponse?: boolean; // resolves to the raw Response
  prefix?: string;
  extraHeaders?: object;
  signal?: AbortSignal;        // cancel the inference fetch
};
// overloads on Ai.run(model, inputs, options?):
//  {queueRequest:true}      -> Promise<{ request_id: string }>
//  {returnRawResponse:true} -> Promise<Response>
//  {websocket:true}         -> Promise<Response>
//  inputs & {stream:true}   -> Promise<ReadableStream>
//  default                  -> Promise<AiModels[Name]["postProcessedOutputs"]>
//  model name not in AiModels -> inputs Record<string, unknown>, Promise<Record<string, unknown>>
interface InferenceUpstreamError extends Error {}   // thrown on non-2xx from the model service
interface AiInternalError extends Error {}          // thrown by the binding itself
```

`rejectIfBusy` is documented as a third-arg option (`env.AI.run(model, inputs, { rejectIfBusy: true })`, https://developers.cloudflare.com/workers-ai/features/reject-if-busy/) but is **not in `AiOptions`** at this types version; cast if you use it. "Do not add `rejectIfBusy` to the model input object." Over REST it goes in the JSON body as `"options": {"rejectIfBusy": true}` next to the model inputs (same page).

## 4. Errors and limits

Errors page: https://developers.cloudflare.com/workers-ai/platform/errors/

| Name | Internal code | HTTP | Message |
|---|---|---|---|
| Invalid data | 5004 | 400 | Invalid data type for base64 input: `${type}` |
| Incomplete request | 3003 | 400 | Request is missing headers or body: `{what}` |
| No such model | 5007 | 400 | No such model `${model}` or task |
| Invalid model ID | 3042 | 404 | The model name is invalid |
| Timeout | 3007 | 408 | Request timeout |
| Aborted | 3008 | 408 | Request was aborted |
| **Request too large** | **3006** | **413** | Request is too large |
| **Account limited** | **3036** | **429** | You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage. |
| **Out of capacity** | **3040** | **429** | Capacity temporarily exceeded, please try again. (also what `rejectIfBusy` returns) |
| Model requires Workers Paid plan | 5035 | 403 | (not our models) |
| Account blocked | 3023 | 403 | Service unavailable for account |

UNCONFIRMED: the specific code returned when a bge-m3 text exceeds the token limit with `truncate_inputs: false` (not in the table); set `truncate_inputs: true` and you never hit it.

How errors surface:
- **Binding** (workerd source): non-2xx → `throw new InferenceUpstreamError(\`${internalCode}: ${description}\`, name)` or, for v4-envelope bodies, `\`${errors[0].code}: ${errors[0].message}\``. So `err.message.startsWith("3036:")` / `"3040:"` / `"3006:"` is the retry/alert key. Treat 3040 and 3007 as retryable with backoff; 3036 as "stop until 00:00 UTC or upgrade"; 3006 as "chunk/shrink input".
- **REST**: standard Cloudflare v4 envelope `{"result": null, "success": false, "errors": [{"code": 3036, "message": "..."}], "messages": []}` with the HTTP status from the table (UNCONFIRMED verbatim example; envelope keys confirmed from the success example, codes/messages from the errors table).

Rate limits (limits page): Text Embeddings 3,000 req/min; ASR 720 req/min; per task type, account-wide; local `wrangler dev` calls count. Whole-API REST limit: 1,200 req / 5 min per token.

Batch API payload limit: total payload under 10 MB (batch workers-binding page).

## 5. Gotchas for the implementer

1. **No `pooling` input** on bge-m3 despite the task brief; it is output-only. Query/contexts mode returns `response` (scores or vectors), plain mode returns `data`. Narrow on `"data" in out`.
2. **Normalization unconfirmed**: compute cosine, or L2-normalize once on write. One `Math.hypot(...vec)` check in a dev script settles it.
3. **Length**: CF says 60k context, upstream model says 8,192 tokens. Always send `truncate_inputs: true`; chunk memories well under 8k tokens anyway.
4. **≤100 texts per call**, no empty strings.
5. **Whisper input is base64 string**, not a byte array (that was the old `@cf/openai/whisper`). `btoa` on a binary string works without `nodejs_compat`; chunk the `String.fromCharCode` call.
6. **Formats/size for whisper are undocumented.** WhatsApp sends `audio/ogg; codecs=opus`; first deploy must smoke-test one real voice note. Keep an eye on `3006` (413).
7. **`wrangler dev` bills real neurons** and uses the real rate limits; put `"remote": true` on the `ai` binding or you get a warning on every start.
8. **Free tier is 10,000 neurons/day on Paid too**; bge-m3 ≈ 1 neuron per ~930 tokens, whisper ≈ 47 neurons/min. Voice notes dominate the budget: ~214 free minutes/day, then $0.0005/min.
9. **Raw-stream audio input and AI Gateway are mutually exclusive** in the binding; base64 JSON works with both.
10. `rejectIfBusy` missing from `AiOptions` types; `lastRequestHttpStatusCode` / `lastRequestInternalStatusCode` / `lastRequestId` exist on the runtime `Ai` object (workerd source) but only `aiGatewayLogId` is in the public types.
11. The REST path from Node needs the account ID plus a token with `Workers AI Read` (API ref) — give it Read + Edit/Write to sidestep the docs' contradiction.
12. Docs page `sync-output.json` for bge-m3 is wrong (shows the async `{request_id}` shape). Trust workers-types.

## Verification (2026-11-04)

Checked about 140 concrete claims (every table row, every field in the four type/schema blocks, every error code, every price/limit number, every quoted doc sentence) against: the `index.md` renderings of the cited developers.cloudflare.com pages, the six raw model JSON schemas, `@cloudflare/workers-types@5.20261104.1` (confirmed as npm `latest`; extracted and diffed against sections 1.1, 1.2, 2.1, 2.2, 3), `cloudflare/workerd` `src/cloudflare/internal/ai-api.ts` (main), the HF `BAAI/bge-m3` README, and the API reference page for `ai/run`. All prices, neuron rates, rate limits, error codes/HTTP statuses/messages, permission names, type shapes and schema fields matched. Arithmetic in 1.4, 2.4 and gotcha 8 re-done and correct.

Corrections made (before -> after):

1. Vitest row: quote named `@cloudflare/vitest-pool-workers` -> the page says `@cloudflare/vitest-plugin` (https://developers.cloudflare.com/workers/local-development/#remote-bindings).
2. bge-m3 raw schemas: "sync-input.json, batch-input.json" -> added that `sync-input.json` omits the plain `text` variant and `batch-output.json` is also just `{request_id}` (https://developers.cloudflare.com/workers-ai/models/bge-m3/sync-input.json, .../batch-input.json, .../batch-output.json).
3. Context-window row: added the glossary definition (total tokens per request) so the 60k figure is not read as a per-text limit (https://developers.cloudflare.com/workers-ai/platform/glossary/).
4. Async REST (1.5): bare `{"status":"queued","request_id"}` -> full v4 envelope with `result.{status,request_id,model}`, poll URL keeps `?queueRequest=true`, poll result shape and `external_reference` added (https://developers.cloudflare.com/workers-ai/features/batch-api/rest-api/).
5. 2.3 tutorial quote: `Buffer.from(chunkBuffer).toString("base64")` -> `Buffer.from(chunkBuffer, "binary").toString("base64")` (https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/).
6. Section 3 overloads: added the `{websocket:true} -> Promise<Response>` overload and the unknown-model fallback overload (workers-types 5.20261104.1 `index.d.ts`, `declare abstract class Ai`).
7. `rejectIfBusy`: added the REST body form `"options": {"rejectIfBusy": true}` (https://developers.cloudflare.com/workers-ai/features/reject-if-busy/).

Confirmed items the author had flagged or that smelled like memory: 10,000 neurons/day on Paid too; `$0.011/1k` neurons; bge-m3 `1075` neurons/M and model-page `$0.0118`; whisper-turbo `46.63` neurons/min and `$0.000513`; 3,000 and 720 req/min; `3036`/`3040`/`3006`/`3007`/`3008`/`5004`/`3042`/`5007`/`3003`/`5035`/`3023` with the exact HTTP codes and messages; "Accepted Permissions (at least one required): `Workers AI Write` `Workers AI Read`" and the get-started "`Workers AI - Read` and `Workers AI - Edit`" wording (both verbatim); "Send the model's inputs directly in the request body, without a model/input/options wrapper" and "Accepts model-specific JSON or binary input" (verbatim from the API ref); the legacy `AutomaticSpeechRecognition {audio: array of number, source_lang, target_lang}` variant on the API ref page and the `{"type":"string","format":"binary"}` variant in `@cf/openai/whisper`'s `schema-input.json`; `remote` omitted -> warning, `remote: false` -> error, AI "always run remotely" and "will incur usage charges even in local development"; local `wrangler dev` inferences count toward rate limits; batch payload < 10 MB; the raw-stream/`userInputs`/single-stream/no-gateway behaviour and the `InferenceUpstreamError` message format in `ai-api.ts`; `lastRequestId`/`lastRequestHttpStatusCode`/`lastRequestInternalStatusCode` on the runtime class but only `aiGatewayLogId` in the public types; HF card: 1024 dims, 8192 tokens, "more than 100 working languages", no query instruction needed, and no normalization statement.

Still UNCONFIRMED (no official source found; a targeted web search on 2026-11-04 returned nothing from developers.cloudflare.com for any of these):

- bge-m3: which per-text token limit CF enforces (60k page figure vs 8,192 upstream); embedding dimension on CF (1024 upstream); whether vectors are L2-normalized; which `pooling` value is reported; whether `shape`/`data` can be absent on a 2xx; the error code for an over-long text with `truncate_inputs: false`.
- OpenAI-compatible `/ai/v1/embeddings` response body (not shown in docs).
- whisper-large-v3-turbo: supported containers/codecs (incl. `audio/ogg; codecs=opus`), max request size / audio duration, latency; whether the raw-stream `{ body, contentType }` input and a binary REST body work for this model (the schema lists the `{body, contentType}` variant, but no doc shows it used).
- Verbatim REST error envelope for a 3036/3040 failure (keys inferred from the success envelope).

All of these are settled by one smoke test each on first deploy; the code in 1.3 and 2.3 is written so that none of them changes the call shape.
