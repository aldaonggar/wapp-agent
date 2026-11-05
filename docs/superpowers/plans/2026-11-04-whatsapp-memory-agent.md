# WhatsApp Memory Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A WhatsApp agent on Cloudflare Workers that replies like a person (one reply per burst, 1–3 bubbles, streamed), remembers across days with judgement, derives insights, views web pages, follows up on plans, and proves it with evals.

**Architecture:** A Worker verifies Meta webhooks and forwards each inbound message to one Durable Object per contact (`ContactAgent`, SQLite + one alarm). The DO is a thin shell around `ContactCore`, plain TypeScript with injected dependencies (`Db`, `Clock`, `WaClient`, `Llm`, embed/rerank/transcribe/snapshot), so the eval harness runs the identical pipeline in Node on `node:sqlite` with a fake clock. All model calls go through the Vercel AI SDK v7 with the OpenRouter provider; memory is in-house (facts table, bge-m3 embeddings, cosine + FTS5 + rerank).

**Tech Stack:** TypeScript (ESM), Cloudflare Workers + Durable Objects (SQLite, alarms), `wrangler@^4.157`, `ai@^7`, `@openrouter/ai-sdk-provider@^3`, `zod@^4`, `yaml@^2`, Workers AI (`@cf/baai/bge-m3`, `@cf/openai/whisper-large-v3-turbo`), Browser Rendering REST (`/snapshot`), WhatsApp Cloud API `v26.0`, Vitest 5, Node 24 (`node:sqlite`, `process.loadEnvFile`).

**Spec:** `docs/superpowers/specs/2026-11-04-whatsapp-memory-agent-design.md` (design), `init.md` (brief). API facts: `docs/superpowers/research/*.md`. Implementers code API shapes from the research notes, not from memory.

## Global Constraints

- Node ≥ 22 locally (24.18 installed); ESM only (`"type": "module"`); TypeScript strict; no `any` in exported signatures.
- Dependencies: exactly `ai`, `@openrouter/ai-sdk-provider`, `zod`, `yaml` at runtime; `wrangler`, `vitest`, `typescript`, `@types/node` as dev. Nothing else without a plan change.
- No file imported by a `src/**/*.test.ts` or `evals/**` file may import `cloudflare:workers` (Node cannot resolve it). Only `src/contact-agent.ts` imports it, and only `src/worker.ts` (the wrangler entry) imports `src/contact-agent.ts`.
- Graph API base `https://graph.facebook.com/v26.0`. Send bodies, webhook shapes, error codes: `research/whatsapp-cloud-api.md`.
- OpenRouter model ids and prices (USD per 1M tokens, in / out / cached-in) are the table in design §4.1; `anthropic/claude-opus-5.5` is the judge and never a candidate.
- Reply and follow-up calls: `maxOutputTokens` = `maxOutputTokensFor(model, effort)`: 400, except 2048 for `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5.5` and any `--effort=medium|high` run (reasoning tokens count against the cap; Anthropic rejects a cap below its thinking budget). Thinking: per-model lowest setting (design §4.1) as a model setting; never the AI SDK top-level `reasoning` option (the provider ignores it).
- DeepSeek / Moonshot / Z.ai models always carry `provider: { ignore: ["deepseek","moonshotai","z-ai","alibaba","baidu","siliconflow","streamlake"] }`.
- Prompt order: stable system prompt (cache breakpoint for Anthropic) → dynamic system block (profile, memories, date/time in the person's timezone) → history (≤40 messages and ≤6,000 tokens at 4 chars/token, every row stamped `YYYY-MM-DD HH:mm` local) → pending messages. Memory lines carry `(said YYYY-MM-DD)`; superseded ones `(superseded on YYYY-MM-DD)`; insights `(derived, confidence 0.8)`.
- Cadence: quiet 3,000 ms; 8,000 ms if the last message looks unfinished; never later than 15,000 ms after the first message of the burst. Bubble pause `min(2000, 400 + 15 × chars)` ms via `clock.sleep`. At most 3 bubbles, ≤4,096 chars each.
- Timing: `wait_ms` is computed from message `ts` and `clock.now()` (fake-clock safe); `retrieval_ms`, `ttft_ms`, `ttfb_ms`, `total_ms` are wall-clock deltas from `performance.now()` (available in workerd and Node), never from `clock.now()`.
- Alarm invariants (`ContactCore.alarm`): every timer whose time has come is set to NULL or moved strictly into the future before any `await`, whatever the feature flags; each timer's work runs in its own try/catch and never throws out of `alarm()`; `scheduleNext()` runs in `finally`.
- Shared SQL rules (design §4.2): `?` placeholders (≤100), single-quoted strings, no PRAGMA, no BEGIN/COMMIT inside `run`, booleans as 0/1, ms timestamps as INTEGER, embeddings as BLOB of `Float32Array` bytes bound as `Uint8Array`. Never send an empty string to bge-m3 (`minLength 1`).
- Secrets: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `ALLOWED_PHONES`; var `CLOUDFLARE_ACCOUNT_ID` = `ca2eab2f1e6412d4da10548be926c8fa`; optional vars `MODEL_REPLY`, `MODEL_VISION`, `MODEL_EXTRACT`, `MODEL_DERIVE`. Phone numbers never appear in committed files.
- Style rules the system prompt carries in substance (brief "Reply style"): short bubbles under ~300 chars; no markdown headings/lists/tables/links; WhatsApp `*bold*`/`_italic_` rarely; match language and register; emojis follow the person; at most one question per turn; use memory silently (never "I remember", "according to my notes", "you told me"); never ask for something already known; check lightly if an old fact may have changed; first contact is a short human hello; learn name and timezone naturally; never say "I transcribed your voice note"; use insights tentatively and never as something the person said; the `[voice note could not be transcribed]` marker means the voice note did not come through, say so and ask them to type it.
- Cost ledger: the `calls` table is the only ledger, written by the `makeLlm` log hook for every call (reply, followup, extract, derive, judge); `turns.usage` is a denormalised copy for latency joins and is never summed for cost.
- Commits: conventional messages on branch `feat/wapp-agent`; commit after every task; push the branch to `aldaonggar/wapp-agent` (public) at the end of Tasks 1, 6, 9 and 14. Never commit to `main` directly.

## Review Focus

1. One webhook POST carrying several contacts' messages plus status updates: every inbound message reaches its own contact's object exactly once, statuses are logged, Meta gets one 200. (Task 2 `parseWebhook mixed payload`; Task 6 `src/index.test.ts` routing tests.)
2. The reply model omits the `react:` header, writes `---` mid-sentence, or emits four bubbles: the parser yields at most three sane bubbles and never drops the first line. (Task 5 parser tests.)
3. Meta redelivers the same wamid, or a send or model call fails mid-turn: one stored message, one turn, no duplicate bubbles, no alarm storm. (Task 6 `ingest same wamid twice`, `a WaError on send marks the outbound row failed`, `an llm error ends the turn cleanly`, `timers are consumed with memory off`.)
4. A follow-up falls due at 23:30 local or more than 24 h after the person's last message: deferred to 09:00 or skipped, never sent. (Task 12 tests.)
5. A voice note whose transcription fails: the reply says the voice note did not come through and asks them to type it; no crash. (Task 8 test.)

---

## File map

```
package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  .gitignore  .dev.vars (ignored)
src/worker.ts             wrangler entry: re-exports the Worker default from index.ts and ContactAgent (the only importer of contact-agent.ts)
src/index.ts              Worker: /webhook GET+POST, allowlist, fan-out, /health; temporary /__cpu probe
src/env.d.ts              Env augmentation: secret names, CONTACT binding typed by its RPC surface
src/contact-agent.ts      DurableObject shell + makeDeps(env, ctx, db)   (imports cloudflare:workers)
src/core/types.ts         Db, Clock, Inbound, WaClient, Deps, Features, Snapshot, MemoryHit; re-exports Llm/Usage (llm.ts), ReasoningSetting/ModelChoice (models.ts)
src/core/db.ts            SCHEMA, migrate(), fromDO(), fromNode(), vec helpers, formatLocal()
src/core/cadence.ts       looksUnfinished(), turnDue(), bubblePauseMs()
src/core/stream.ts        parseReply() line-format parser
src/core/prompt.ts        SYSTEM_PROMPT, windowHistory(), buildPrompt()
src/core/contact.ts       ContactCore: ingest(), alarm(), runTurn(), scheduleNext()
src/core/memory.ts        remember(), recall(), forget(), profileText(), cascadeInsights()
src/core/insights.ts      deriveInsights()
src/core/followups.ts     scheduleFollowup(), followupDecision()
src/core/timezone.ts      tzFromPhone()
src/models.ts             MODELS, JOBS, CHINA_HOSTS, pickModels(), replyModelFor(), costUsd(), maxOutputTokensFor(), reasoningFor(), needsHostFilter()
src/llm.ts                makeLlm(): stream() and object() over AI SDK + OpenRouter
src/whatsapp.ts           parseWebhook(), makeWaClient(), verifySignature(), WaError
src/browser.ts            makeSnapshot(), extractUrls()
src/workers-ai.ts         embed/rerank/transcribe via binding and via REST, toBase64()
evals/run.ts              CLI: flags → env → vitest
evals/harness.ts          FakeClock, FakeWa, stubLlm, hashEmbed, makeEvalDeps, drain, loadScenarios, runScenario, evalConfig
evals/judge.ts            judge(), judgeFacts()
evals/report.ts           results/*.json → EVALS.md
evals/cadence.test.ts     deterministic cadence checks (stub LLM, memory off)
evals/harness.test.ts     harness unit tests (stub LLM)
evals/scenarios.test.ts   one test per YAML (real models; skipped without keys)
evals/scenarios/*.yaml    ~21 scenarios
evals/fixtures/photo.jpg  one small JPEG with an obvious dominant colour
README.md  SETUP.md  EVALS.md
```

Unit tests live next to code as `src/**/*.test.ts`. `npm test` runs `vitest run src`; `npm run eval` runs `evals/` (cadence and harness tests always; scenario tests only with `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set).

---

### Task 1: Scaffold, Worker skeleton with webhook verification, first deploy

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `src/worker.ts`, `src/index.ts`, `src/env.d.ts`, `src/whatsapp.ts` (only `verifySignature`), `src/whatsapp.test.ts`
- Existing: `.gitignore`, `.dev.vars`, `SETUP.md`, `init.md`, `docs/`

**Interfaces:**
- Produces: `verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean>` in `src/whatsapp.ts` (HMAC-SHA256 hex over the raw string via `crypto.subtle`, constant-time compare, header must start with `sha256=`).
- Produces: Worker default export in `src/index.ts` handling `GET /webhook` (returns `hub.challenge` as `text/plain` 200 when `hub.mode === "subscribe"` and `hub.verify_token === env.WHATSAPP_VERIFY_TOKEN`, else 403), `POST /webhook` (401 when the signature is invalid; 200 `ok` otherwise; body handling comes in Task 6), `GET /health` → 200 `ok`, `GET /__cpu?ms=50` (temporary: busy-loops `ms` of CPU in the Worker and returns the measured ms).
- Produces: `src/worker.ts` = `export { default } from "./index";` (Task 6 adds the `ContactAgent` re-export). `src/env.d.ts` augments `Env` with the seven secret names as `string` and, from Task 6, `CONTACT: DurableObjectNamespace<{ ingest(m: Inbound): Promise<void>; burn(ms: number): Promise<number> }>`.

- [x] **Step 1: GitHub repo** (the repo is already initialised: `main` holds the docs, work happens on branch `feat/wapp-agent`, already checked out)

```bash
cd /Users/nur/projects/random/wapp-agent && gh repo create aldaonggar/wapp-agent --public --source=. --remote=origin --description "WhatsApp agent with memory on Cloudflare Workers" && git push -u origin main && git push -u origin feat/wapp-agent
```

- [x] **Step 2: package.json, tsconfig, vitest config**

`package.json`: `"type": "module"`, scripts `dev: wrangler dev`, `deploy: wrangler deploy`, `types: wrangler types`, `typecheck: tsc --noEmit`, `test: vitest run src`, `eval: node evals/run.ts`, `eval:report: node evals/report.ts`. `npm i ai@^7 @openrouter/ai-sdk-provider@^3 zod@^4 yaml@^2 && npm i -D wrangler@^4.157 vitest@^5 typescript @types/node`.
`tsconfig.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `strict`, `noEmit`, `types: ["./worker-configuration.d.ts", "node"]`, `include: ["src", "evals", "worker-configuration.d.ts"]`.
`vitest.config.ts`: `test: { include: ["src/**/*.test.ts", "evals/**/*.test.ts"], environment: "node", testTimeout: 120000 }`.

- [x] **Step 3: wrangler.jsonc**

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "wapp-agent",
  "main": "src/worker.ts",
  "compatibility_date": "2026-11-04",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "ai": { "binding": "AI", "remote": true },
  "vars": { "CLOUDFLARE_ACCOUNT_ID": "ca2eab2f1e6412d4da10548be926c8fa" }
}
```
(The Durable Object binding and `exports` entry are added in Task 6.) Run `npx wrangler types`.

- [x] **Step 4: Write the failing tests** in `src/whatsapp.test.ts`

```ts
test("verifySignature accepts the HMAC of the raw body", async () => {
  const body = '{"object":"whatsapp_business_account"}';
  const sig = "sha256=" + (await hmacHex("secret", body)); // helper in the test using crypto.subtle
  expect(await verifySignature(body, sig, "secret")).toBe(true);
});
test("verifySignature rejects a wrong secret, a missing header and a re-serialised body", async () => { /* three expects, all false */ });
test("GET /webhook echoes hub.challenge only with the right token", async () => {
  const res = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=t&hub.challenge=123"), { WHATSAPP_VERIFY_TOKEN: "t" } as Env, ctx);
  expect(res.status).toBe(200); expect(await res.text()).toBe("123");
  // wrong token → 403
});
test("POST /webhook with a bad signature is 401; with a good one 200", ...);
```
(`worker` is the default export of `src/index.ts`, never `src/worker.ts`.)

- [x] **Step 5: Run tests to verify they fail**  `npx vitest run src/whatsapp.test.ts` → FAIL (module not found).
- [x] **Step 6: Implement** `verifySignature`, the routes, `src/worker.ts`, `src/env.d.ts`.
- [x] **Step 7: Run tests, typecheck**  `npx vitest run src && npx tsc --noEmit` → PASS.
- [x] **Step 8: Upload secrets and deploy**

```bash
grep -vE '^(#|CLOUDFLARE_ACCOUNT_ID=|\s*$)' .dev.vars | npx wrangler secret bulk   # stdin; CLOUDFLARE_ACCOUNT_ID stays a var (a secret with a var's name is rejected); empty values upload as empty strings for now
npx wrangler deploy
curl -s https://wapp-agent.alda-onggar.workers.dev/health          # → ok
curl -s "https://wapp-agent.alda-onggar.workers.dev/webhook?hub.mode=subscribe&hub.verify_token=$(grep WHATSAPP_VERIFY_TOKEN .dev.vars | cut -d= -f2)&hub.challenge=42"   # → 42
curl -s "https://wapp-agent.alda-onggar.workers.dev/__cpu?ms=50"  # Worker-level probe; informational
```

- [x] **Step 9: Commit and push**  `git add -A && git commit -m "feat: worker skeleton with webhook verification" && git push -u origin feat/wapp-agent`

Tell the owner: the webhook URL `https://wapp-agent.alda-onggar.workers.dev/webhook` is live for SETUP.md section 6 (messages are received and ignored until Task 6).

---

### Task 2: WhatsApp webhook parsing and Graph API client

**Files:**
- Create: `src/core/types.ts`
- Modify: `src/whatsapp.ts`, `src/whatsapp.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
```ts
export type InboundKind = "text" | "image" | "video" | "audio" | "sticker" | "document" | "location" | "contacts" | "reaction" | "unsupported";
export interface Inbound { id: string; from: string; name?: string; ts: number; kind: InboundKind; text?: string; mediaId?: string; mime?: string; voice?: boolean; quotedId?: string; reaction?: { messageId: string; emoji?: string } }
export interface WaStatus { id: string; status: string; recipientId: string; ts: number; pricingType?: string; errorCode?: number }
export interface WaClient {
  sendText(to: string, body: string, opts?: { quote?: string; previewUrl?: boolean }): Promise<{ id: string }>;
  sendReaction(to: string, messageId: string, emoji: string): Promise<void>;
  markReadTyping(messageId: string): Promise<void>;
  fetchMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }>;
}
```
- Produces (`src/whatsapp.ts`): `GRAPH = "https://graph.facebook.com/v26.0"`; `parseWebhook(body: unknown): { inbound: Inbound[]; statuses: WaStatus[] }`; `makeWaClient(cfg: { token: string; phoneNumberId: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): WaClient`; `class WaError extends Error { code: number; status: number }`.
- Parsing rules: `ts = Number(timestamp) * 1000`; `quotedId = context.id` when `context.id` exists and `context.referred_product` does not; `name = contacts[0].profile.name`; `text` is: the body for text; `caption ?? "[photo]"` for images; `((caption ?? "") + " [a video]").trim()` for video; `"a sticker"`; `"document: <filename> (<mime>)"`; `"location: <name>, <address>"` or `"location: <lat>, <lng>"`; `"contact card: <formatted_name> <phone>"` (one line per card); `audio.voice` → `voice: true`; `mediaId`/`mime` set for image, video, audio, sticker, document; `type: "unsupported"` (including `unsupported.type: "edit"`) → kind `unsupported`; reaction removal (no emoji) → `reaction.emoji` undefined. Statuses: `pricingType = pricing.type`, `errorCode = errors[0].code`.
- Client rules: `to` is sent as `"+" + digits`; text body `{ messaging_product:"whatsapp", recipient_type:"individual", to, type:"text", text:{ preview_url, body }, context?:{ message_id } }`; reaction body per research §5.3; `markReadTyping` body `{ messaging_product:"whatsapp", status:"read", message_id, typing_indicator:{ type:"text" } }`; `fetchMedia` does `GET ${GRAPH}/${id}?phone_number_id=…` then GETs `url` with the bearer token, one retry of the whole sequence on 404. Non-2xx or a 2xx body with `error` → throw `WaError(code, status)`. On `code === 131056` `sendText` retries after 1 s, 4 s, 16 s (`cfg.sleep`), then throws.

- [x] **Step 1: Write the failing tests** (payloads copied from `research/whatsapp-cloud-api.md` §3.4)

```ts
test("parseWebhook: text with quoted reply", () => { const { inbound } = parseWebhook(TEXT_WITH_CONTEXT); expect(inbound[0]).toMatchObject({ kind:"text", from:"16505551234", name:"Sheena Nelson", text:"Does it come in another color?", quotedId:"wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA", ts: 1749416383000 }); });
test("parseWebhook: image with caption, caption-less image, video, voice note, reaction, status, unsupported edit", ...)  // one expect per kind; caption-less image text === "[photo]"; video text ends with "[a video]"
test("parseWebhook mixed payload: two senders + one status in one POST", () => { expect(inbound.map(m => m.from)).toEqual(["16505551234","16505559999"]); expect(statuses).toHaveLength(1); });
test("sendText posts the documented body and returns the wamid", ...);
test("sendText retries 131056 with 1s/4s/16s then succeeds", ...);
test("sendText throws WaError(131047) without retry", ...);
test("markReadTyping sends status read + typing_indicator", ...);
test("fetchMedia resolves the url then downloads with the token; retries once on 404", ...);
```

- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run tests, typecheck** → PASS.
- [x] **Step 5: Commit** `git commit -am "feat: whatsapp webhook parsing and graph api client"`

---

### Task 3: Model table and the LLM wrapper

**Files:**
- Create: `src/models.ts`, `src/models.test.ts`, `src/llm.ts`, `src/llm.test.ts`
- Modify: `src/core/types.ts` (re-export `type { Usage, Llm, StreamCall, ObjectCall } from "../llm"` and `type { ReasoningSetting, ModelChoice } from "../models"`)

**Interfaces:**
- Produces (`src/models.ts`):
```ts
export type ReasoningSetting = { effort: "none" | "low" | "medium" | "high" } | { enabled: false } | null;
export interface ModelSpec { id: string; in: number; out: number; cachedIn: number; vision: boolean; lowest: ReasoningSetting; mandatoryThinking: boolean }
export const MODELS: Record<string, ModelSpec>;      // the 10 ids of design §4.1
export const JOBS: { reply: { default: string; candidates: string[]; compareByDefault: string[] }; vision: { default: string; candidates: string[] }; extract: { default: string; candidates: string[] }; derive: { default: string; candidates: string[] }; judge: { default: "anthropic/claude-opus-5.5" } };
export const CHINA_HOSTS = ["deepseek","moonshotai","z-ai","alibaba","baidu","siliconflow","streamlake"];
export interface ModelChoice { reply: string; vision: string; extract: string; derive: string; judge: string }
export function pickModels(env: Partial<Record<"MODEL_REPLY"|"MODEL_VISION"|"MODEL_EXTRACT"|"MODEL_DERIVE", string>>): ModelChoice;
export function replyModelFor(choice: ModelChoice, needsVision: boolean): string;
export function costUsd(id: string, u: { input: number; output: number; cached: number }): number;  // ((input-cached)*in + cached*cachedIn + output*out)/1e6
export function maxOutputTokensFor(id: string, effort?: "low"|"medium"|"high"): number;   // 2048 if mandatoryThinking or effort in (medium, high); else 400
export function reasoningFor(id: string, effort?: "low"|"medium"|"high"): ReasoningSetting; // effort override → {effort}; else MODELS[id].lowest
export function needsHostFilter(id: string): boolean;   // /^(deepseek|moonshotai|z-ai)\//
```
Defaults: reply `deepseek/deepseek-v4.1-flash`, compareByDefault `[deepseek/deepseek-v4.1-flash, moonshotai/kimi-k2.6, z-ai/glm-5.2]`, vision `openai/gpt-6.1-terra`, extract `deepseek/deepseek-v4.1-flash`, derive `deepseek/deepseek-v4-pro`. `lowest`: `{effort:"none"}` for deepseek-v4.1-flash, gpt-6.1-terra, glm-5.2, gpt-6-luna, claude-haiku-5.5; `{effort:"low"}` for gpt-6.1-sol, claude-sonnet-5.5; `{enabled:false}` for kimi-k2.6; `null` for deepseek-v4-pro and claude-opus-5.5. `mandatoryThinking` true for gpt-6.1-sol, claude-sonnet-5.5, claude-opus-5.5. `vision` true for all except glm-5.2 and deepseek-v4-pro.
- Produces (`src/llm.ts`):
```ts
export interface Usage { job: string; model: string; provider?: string; input: number; output: number; cached: number; reasoning: number; costTable: number; costReported?: number; ms: number }
export interface StreamCall { job: "reply" | "followup"; modelId: string; system: SystemModelMessage[]; messages: ModelMessage[]; tools?: ToolSet; maxOutputTokens: number; reasoning: ReasoningSetting; sessionId: string; abortSignal?: AbortSignal }
export interface ObjectCall<T> { job: "extract" | "derive" | "judge"; modelId: string; system: string; messages: ModelMessage[]; schema: z.ZodType<T>; reasoning?: ReasoningSetting; sessionId: string }
export interface Llm {
  stream(call: StreamCall): { text: AsyncIterable<string>; done: Promise<Usage & { ttftMs: number; finishReason: string }> };
  object<T>(call: ObjectCall<T>): Promise<{ value: T; usage: Usage }>;
}
export function makeLlm(apiKey: string, opts?: { fetch?: typeof fetch; log?: (u: Usage) => void }): Llm;
```
Implementation decisions: `createOpenRouter({ apiKey, appName: "wapp-agent", fetch })`; model = `openrouter.chat(id, { provider: needsHostFilter(id) ? { ignore: CHINA_HOSTS } : undefined, structuredOutputs: { strict: false }, reasoning: setting ?? undefined })`; `instructions` = the `system` array, with the first entry carrying `providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } }` when the id starts with `anthropic/`; call-level `providerOptions: { openrouter: { session_id: sessionId, user: sessionId } }` (nothing else at call level: call-level keys replace model-level ones); `maxRetries: 1`; `timeout: { firstChunkMs: 15000, totalMs: 60000 }`; `stopWhen: isStepCount(3)` when tools are present. `text` iterates `result.stream` and yields `part.text` for `text-delta`; an `error` part rejects `done` and ends `text`; `ttftMs` = `performance.now()` delta at the first `text-delta`. Usage: tokens from `const total = await result.usage` (`inputTokens`, `outputTokens`, `inputTokenDetails.cacheReadTokens`, `outputTokenDetails.reasoningTokens`; totals across steps); `costReported = (await result.steps).reduce((s, st) => s + Number(st.usage.raw?.cost ?? st.providerMetadata?.openrouter?.usage?.cost ?? 0), 0)`; `provider` and `finishReason` from `await result.finalStep`; `costTable = costUsd(id, ...)`; `ms` = wall-clock from call start to `done`. `object()` uses `generateText({ output: Output.object({ schema }) })`, one retry on a parse/validation error; usage from `result.usage` and `result.usage.raw?.cost`. Every `Usage` goes to `opts.log` before being returned.

- [x] **Step 1: Write the failing tests**

`src/models.test.ts`: `costUsd("deepseek/deepseek-v4.1-flash", {input:10000, output:1000, cached:4000})` equals `((6000*0.045)+(4000*0.018)+(1000*0.5))/1e6` within 1e-9; `maxOutputTokensFor("anthropic/claude-sonnet-5.5")===2048`, `("deepseek/deepseek-v4.1-flash")===400`, `("deepseek/deepseek-v4.1-flash","medium")===2048`; `reasoningFor("moonshotai/kimi-k2.6")` deep-equals `{enabled:false}`; `pickModels({MODEL_REPLY:"z-ai/glm-5.2"}).reply==="z-ai/glm-5.2"`; `replyModelFor({...reply:"z-ai/glm-5.2", vision:"openai/gpt-6.1-terra"}, true)==="openai/gpt-6.1-terra"`.
`src/llm.test.ts` with a fake `fetch` serving SSE: (a) single-step fixture (two `text-delta` chunks, final usage chunk with `prompt_tokens_details.cached_tokens` and `cost`): `stream()` yields `"hel"`,`"lo"`; `done` has `input/cached/costReported` from the chunk and `ttftMs >= 0`; the request body contains `provider.ignore` for a DeepSeek id and `session_id`; for `anthropic/claude-sonnet-5.5` the first system part has `cache_control`. (b) two-step fixture (first response: a tool call; second: text), tool `execute` returns `{ ok: true }`: `input` equals the sum of both steps' `prompt_tokens` and `costReported` the sum of both `cost` values; `opts.log` called once.

- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement** `src/models.ts`, `src/llm.ts`.
- [x] **Step 4: Run tests, typecheck** → PASS.
- [x] **Step 5 (only if `OPENROUTER_API_KEY` is set): live smoke** with `deepseek/deepseek-v4.1-flash`; record first-chunk latency and usage in the commit body.
- [x] **Step 6: Commit** `git commit -am "feat: model table and openrouter llm wrapper"`

---

### Task 4: Database adapter, schema, migrations

**Files:**
- Create: `src/core/db.ts`, `src/core/db.test.ts`
- Modify: `src/core/types.ts` (add `Db`, `Param`, `Row`)

**Interfaces:**
- Produces:
```ts
export type Param = string | number | null | Uint8Array;
export type Row = Record<string, string | number | null | Uint8Array>;
export interface Db { all<T = Row>(sql: string, ...p: Param[]): T[]; run(sql: string, ...p: Param[]): void; batch(sql: string): void }
export const SCHEMA: string;
export function migrate(db: Db): void;             // db.batch(SCHEMA); idempotent; seeds state row
export function fromDO(sql: SqlStorage): Db;       // binds Uint8Array as ArrayBuffer slice; converts ArrayBuffer results to Uint8Array
export function fromNode(db: import("node:sqlite").DatabaseSync): Db;   // prepare().all/run; exec for batch
export function vecToBlob(v: Float32Array): Uint8Array;  export function blobToVec(b: Uint8Array): Float32Array;
export function formatLocal(ts: number, tz: string): string;  // "YYYY-MM-DD HH:mm" in tz via Intl.DateTimeFormat
```
Schema (all `IF NOT EXISTS`): `messages(id TEXT PRIMARY KEY, direction TEXT, kind TEXT, text TEXT, ts INTEGER, quoted_id TEXT, media_id TEXT, mime TEXT, media_note TEXT, voice INTEGER DEFAULT 0, reactions TEXT, turn_id INTEGER, status TEXT DEFAULT 'pending')` + index on `ts`; `facts(id INTEGER PRIMARY KEY AUTOINCREMENT, text, kind, signal INTEGER, created_at INTEGER, event_date TEXT, source_message_ids TEXT, status TEXT DEFAULT 'active', superseded_by INTEGER, followup_done INTEGER DEFAULT 0, embedding BLOB)`; `CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, fact_id UNINDEXED)`; `insights(id INTEGER PRIMARY KEY AUTOINCREMENT, text, confidence REAL, evidence_fact_ids TEXT, created_at INTEGER, status TEXT DEFAULT 'active', embedding BLOB)`; `profile(id INTEGER PRIMARY KEY CHECK(id=1), text, updated_at)`; `contact(id INTEGER PRIMARY KEY CHECK(id=1), wa_id, name, timezone, timezone_confirmed INTEGER DEFAULT 0, last_inbound_ts INTEGER, last_proactive_date TEXT)`; `state(id INTEGER PRIMARY KEY CHECK(id=1), turn_due INTEGER, insights_due INTEGER, followup_due INTEGER, followup_fact_id INTEGER, burst_started_at INTEGER, generation INTEGER DEFAULT 0, turn_attempts INTEGER DEFAULT 0, last_insights_run INTEGER DEFAULT 0)` seeded with `INSERT OR IGNORE INTO state(id) VALUES (1)`; `turns(id INTEGER PRIMARY KEY AUTOINCREMENT, started_at, wait_ms, retrieval_ms, ttft_ms, ttfb_ms, total_ms, model, provider, bubbles, regenerated INTEGER DEFAULT 0, error TEXT, usage TEXT)`; `calls(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, job TEXT, model TEXT, usage TEXT)`.

- [x] **Step 1: Write the failing tests** (`node:sqlite` in-memory)

```ts
test("migrate is idempotent and creates all tables", () => { migrate(db); migrate(db); expect(names).toEqual(expect.arrayContaining(["messages","facts","facts_fts","insights","profile","contact","state","turns","calls"])); expect(db.all("SELECT generation FROM state")[0].generation).toBe(0); });
test("blob round trip keeps float32 values", () => { ... vecToBlob/blobToVec on [0.1, -2, 3.5] ... });
test("fts5 match finds the fact", () => { db.run("INSERT INTO facts_fts(text, fact_id) VALUES ('Job interview at Monzo on 2026-11-12', 7)"); expect(db.all("SELECT fact_id FROM facts_fts WHERE facts_fts MATCH 'Monzo'")[0].fact_id).toBe(7); });
test("INSERT OR IGNORE ... RETURNING id yields no row on a duplicate", () => { ... two inserts of the same message id; second `all` returns [] ... });
test("formatLocal formats in the timezone", () => { expect(formatLocal(Date.UTC(2026,10,4,9,5), "Asia/Almaty")).toBe("2026-11-04 14:05"); });
```

- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement `src/core/db.ts`.**
- [x] **Step 4: Run tests, typecheck** → PASS.
- [x] **Step 5: Commit** `git commit -am "feat: sqlite schema and db adapter for durable object and node"`

---

### Task 5: Cadence rules and the reply stream parser (pure functions)

**Files:**
- Create: `src/core/cadence.ts`, `src/core/cadence.test.ts`, `src/core/stream.ts`, `src/core/stream.test.ts`

**Interfaces:**
- Produces (`cadence.ts`): `QUIET_MS = 3000`, `UNFINISHED_MS = 8000`, `MAX_WAIT_MS = 15000`; `looksUnfinished(text: string): boolean` = trimmed text ends with `...`, `…`, `:` or `,`; or its last word (lower-cased, punctuation stripped) is one of `and|so|but|or|because`; or the text is ≤3 words and its first word is one of `hey|hi|hello|yo|wait|hold|quick|hmm|btw|one`; `turnDue(now: number, burstStartedAt: number, lastText: string): number` = `min(now + (unfinished ? 8000 : 3000), burstStartedAt + 15000)`; `bubblePauseMs(chars: number): number` = `min(2000, 400 + 15 * chars)`.
- Produces (`stream.ts`): `type ReplyEvent = { type: "react"; target: string; emoji: string } | { type: "bubble"; text: string; quote?: string }`; `parseReply(chunks: AsyncIterable<string>, maxBubbles = 3): AsyncGenerator<ReplyEvent>`. Rules: lines split on `\n`; the first complete line matching `/^react:\s*(none|(\S+)\s+(\S+))\s*$/i` is consumed (emit `react` unless `none`); if the first line is not a react line it is content; a line whose trimmed value is exactly `---` closes a bubble; inside a bubble a first line matching `/^quote:\s*(\S+)\s*$/i` sets `quote`; bubbles 1 to `maxBubbles − 1` are emitted (trimmed, only if non-empty) as soon as their `---` arrives; the last allowed bubble collects everything that remains (further `---` lines become blank lines) and is emitted when the stream ends; a bubble longer than 4,096 chars is split at the last paragraph or sentence boundary before the limit.

- [x] **Step 1: Write the failing tests**

cadence: `looksUnfinished("so basically...")===true`, `("hey")===true`, `("quick q")===true`, `("so")===true`, `("see you at 7")===false`, `("I think it's fine")===false`, `("ok thanks")===false`, `("okay")===false`; `turnDue(10_000, 10_000, "ok")===13_000`; `turnDue(10_000, 10_000, "and")===18_000`; `turnDue(24_000, 10_000, "and")===25_000` (cap); `bubblePauseMs(300)===2000`, `(40)===1000`.
stream (feed each input both whole and one character at a time; expect identical events): `"react: none\nhello\n---\nsecond"` → `[bubble hello, bubble second]`; `"react: #3 ❤️"` → `[react #3 ❤️]`; `"react: none\nquote: #2\nanswer"` → `[bubble answer quote #2]`; `"hello there"` → `[bubble hello there]`; `"react: none\na\n---\nb\n---\nc\n---\nd"` → 3 bubbles, third is `"c\n\nd"`; `"react: none\nwait --- no\n"` → one bubble `"wait --- no"`; the first bubble is emitted before the stream ends (never-resolving tail after the first `---`, `Promise.race`).

- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement both modules.**
- [x] **Step 4: Run tests** → PASS.
- [x] **Step 5: Commit** `git commit -am "feat: cadence rules and reply stream parser"`

---

### Task 6: ContactCore v1 (short-term memory, cadence, streaming bubbles), Durable Object, fan-out, deploy

**Files:**
- Create: `src/core/prompt.ts`, `src/core/prompt.test.ts`, `src/core/timezone.ts`, `src/core/timezone.test.ts`, `src/core/contact.ts`, `src/core/contact.test.ts`, `src/index.test.ts`, `src/contact-agent.ts`, `src/workers-ai.ts` (binding `embed` only; rest in Task 8), `src/browser.ts` (`extractUrls(text: string): string[]` only: http/https URLs, first 2; `makeSnapshot` comes in Task 11), `src/browser.test.ts` (`extractUrls` finds two and ignores `ftp://`), `evals/harness.ts` (FakeClock, FakeWa, stubLlm, hashEmbed, makeEvalDeps, drain), `evals/cadence.test.ts`
- Modify: `src/index.ts`, `src/worker.ts`, `src/env.d.ts`, `src/core/types.ts` (add `Clock`, `Deps`, `Features`, `Snapshot`, `MemoryHit`), `wrangler.jsonc`

**Interfaces:**
- Produces (`types.ts`):
```ts
export interface Clock { now(): number; sleep(ms: number): Promise<void>; setAlarm(at: number): Promise<void> | void }
export interface Snapshot { url: string; finalUrl: string; title: string; status: number; markdown: string; jpeg: Uint8Array }
export interface Features { memory: boolean; retrieval: "cosine" | "hybrid"; replyEffort?: "low" | "medium" | "high" }
export interface MemoryHit { id: number; kind: "fact" | "insight"; text: string; date: string; score: number; confidence?: number; status: "active" | "superseded" }
export interface Deps { db: Db; clock: Clock; wa: WaClient; llm: Llm; embed(texts: string[]): Promise<Float32Array[]>; rerank(query: string, docs: string[]): Promise<number[]>; transcribe(bytes: Uint8Array, mime: string): Promise<string>; snapshot(url: string): Promise<Snapshot | null>; models: ModelChoice; features: Features; log(event: Record<string, unknown>): void }
```
- Produces (`timezone.ts`): `tzFromPhone(digits: string): string`, longest calling-code prefix match over a table of at least 40 entries (`1`→`America/New_York`, `7`→`Europe/Moscow`, `77`→`Asia/Almaty`, `44`→`Europe/London`, `49`→`Europe/Berlin`, `34`→`Europe/Madrid`, `91`→`Asia/Kolkata`, `86`→`Asia/Shanghai`, `81`→`Asia/Tokyo`, `971`→`Asia/Dubai`, `998`→`Asia/Tashkent`, `996`→`Asia/Bishkek`, `380`→`Europe/Kyiv`, `90`→`Europe/Istanbul` …), default `UTC`.
- Produces (`prompt.ts`): `SYSTEM_PROMPT: string` (stable; the style rules from Global Constraints, the line format, the `#n` alias convention "inbound messages are tagged `#n`; use that tag in `react:` and `quote:` lines", reaction-only replies, one question per turn, the voice-note marker rule); `interface HistoryRow { id: string; direction: "in"|"out"; text: string | null; ts: number; alias?: string; quotedText?: string; reactions?: string; kind: string; mediaNote?: string | null; media?: { bytes: Uint8Array; mime: string } }`; `windowHistory(rows: HistoryRow[], maxMessages = 40, maxTokens = 6000): HistoryRow[]` (newest-first budget, tokens = ceil(chars/4), returns chronological); `buildPrompt(input: { profile: string; memories: MemoryHit[]; history: HistoryRow[]; pending: HistoryRow[]; nowLocal: string; tz: string; tzConfirmed: boolean; name?: string; snapshots: Snapshot[] }): { system: SystemModelMessage[]; messages: ModelMessage[] }` — `system[0]` is `SYSTEM_PROMPT`; `system[1]` is the dynamic block (profile, memory lines with their date labels, "now: 2026-11-04 14:05 (Asia/Almaty, unconfirmed guess from the phone number)" or "(Asia/Almaty)" when confirmed); history rows become alternating user/assistant messages, text prefixed `[#12 2026-11-04 14:03]` for inbound and `[2026-11-04 14:03]` for outbound (`formatLocal`), `(replying to #9: "…")` for quotes, `(reacted ❤️)` suffixes, `(photo: <mediaNote>)` for image rows with a note; pending rows form the final user message: text parts plus `{ type: "file", mediaType, data }` parts for images and for snapshot JPEGs (snapshot text goes in as `page <title> (<finalUrl>, status <n>):\n<markdown>`).
- Produces (`contact.ts`):
```ts
export class ContactCore {
  constructor(deps: Deps);
  ingest(m: Inbound): Promise<void>;
  alarm(): Promise<void>;
}
```
  Instance fields (lost on a DO reset by design, never persisted): `turnRunning: boolean`, `media: Map<string /*wamid*/, Promise<{ bytes: Uint8Array; mime: string } | null>>`, `pages: Map<string /*url*/, Promise<Snapshot | null>>`, `recallCache: { generation: number; promise: Promise<{ hits: MemoryHit[]; ms: number }> } | null`, `abort: AbortController | null`.
  `ingest(m)`: reactions → update `messages.reactions` JSON on the target row, return (no turn). `INSERT OR IGNORE INTO messages(... media_id, mime ...) RETURNING id` → return if no row. Upsert `contact` (`timezone = tzFromPhone(from)` on first sight, `name`, `last_inbound_ts`). `unsupported` → `status='handled'`, return. Burst: if `burst_started_at` is NULL set it to `now`; `generation += 1`; `turn_due = turnDue(now, burst_started_at, text)`; `insights_due = now + 30 min` only when `features.memory`; `scheduleNext()`. Start work (never awaited here): for `image`/`audio` set `media.set(id, fetchMedia(...).then(...))` (audio chains `transcribe` → `UPDATE messages SET text=?, voice=1` on success, `text='[voice note could not be transcribed]'` on failure; every promise ends with `.catch(() => null)`); for `extractUrls(text)[0]`, `pages.set(url, snapshot(url).catch(() => null))` if absent; `recallCache = { generation, promise: recall(...) }` when `features.memory` (Task 9; until then a placeholder resolving `{ hits: [], ms: 0 }`).
  `alarm()`: read `state`, `now = clock.now()`. Timer 1 (turn): if `turn_due !== null && now >= turn_due`: pending = inbound rows with `status='pending'`; if none → `turn_due = NULL`; else if `turnRunning` → `turn_due = now + 1000`; else if the newest pending is younger than its quiet period and `now < burst_started_at + 15000` → `turn_due = turnDue(now, burst_started_at, newest.text)`; else `runTurn(pending)`. Timer 2 (insights): if due → set NULL, then `deriveInsights` only when `features.memory` (Task 10; no-op before). Timer 3 (follow-up): if due → consume per Task 12 (no-op before). Each timer's body is wrapped in try/catch that logs and continues; `scheduleNext()` = `setAlarm(min non-null timer)` in `finally`.
  `runTurn(pending)`: `turnRunning = true`; `t0 = performance.now()`; snapshot the pending ids; set `burst_started_at = NULL` and `turn_due = NULL` so a message arriving mid-turn opens a fresh burst; `markReadTyping(newest.id).catch(log)` (not awaited); `gen = state.generation`; await `media` entries for the pending ids (refilling missing ones from `media_id`, e.g. after a reset) and `pages` entries for pending URLs; `hits/retrieval_ms` from `recallCache` if its generation is `gen`, else recompute `recall` (only recall is ever recomputed); history = `windowHistory` of all handled rows; `buildPrompt`; `model = replyModelFor(models, pending has image)`; `llm.stream({ ..., maxOutputTokens: maxOutputTokensFor(model, features.replyEffort), reasoning: reasoningFor(model, features.replyEffort), tools, abortSignal })`; iterate `parseReply(text)`; before the first send of any kind (reaction or bubble), re-read `state.generation`: if changed and `regenerated < 2`, `abort.abort()`, `regenerated++`, restart with the enlarged pending set; sends: `sendReaction(to, resolve(#n), emoji)` (unknown alias → skip), bubbles via `sendText(to, text, { quote: resolve(quote), previewUrl: /https?:\/\//.test(text) })` with `await clock.sleep(bubblePauseMs(prevChars) - elapsedSinceLastSend)` before each bubble after the first and `markReadTyping(newest.id).catch(log)` before each extra bubble; every send is wrapped: a `WaError` is logged and the outbound row is inserted with `status='failed'`, then the loop continues; after the stream, `await done` inside the same try. Success path: mark pending `handled`, insert outbound rows (`status='sent'`), write the `turns` row (`wait_ms = clock.now() at turn start − newest pending ts`, `retrieval_ms`, `ttft_ms = done.ttftMs`, `ttfb_ms` = first bubble send − t0, `total_ms` = end − t0, `bubbles`, `regenerated`, `usage` JSON), `turn_attempts = 0`, clear the `media`/`pages` entries of the handled ids, then (Task 9) `remember()`, then (Task 12) `scheduleFollowup()`. Failure path (LLM error or thrown abort beyond the regeneration budget): if anything was sent → treat as success for bookkeeping with `turns.error` set; if nothing was sent and `turn_attempts === 0` → `turn_attempts = 1`, `turn_due = now + 30 s`, log; else mark pending `handled`, write the `turns` row with `error`, log. `finally`: `turnRunning = false`. `turn_due` stays NULL after a successful turn unless new pending rows exist (then `turn_due = turnDue(now, burst_started_at ?? now, newest.text)`).
- Produces (`contact-agent.ts`): `export class ContactAgent extends DurableObject<Env>` (constructor: `db = fromDO(ctx.storage.sql)`, `ctx.blockConcurrencyWhile(async () => migrate(db))`, `core = new ContactCore(makeDeps(env, ctx, db))`) with `ingest(m)`, `alarm()`, `burn(ms: number): number` (CPU probe; removed in Task 14) and `makeDeps(env: Env, ctx: DurableObjectState, db: Db): Deps`: clock `{ now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), setAlarm: at => ctx.storage.setAlarm(at) }`; `log = e => console.log(JSON.stringify(e))`; `llm = makeLlm(env.OPENROUTER_API_KEY, { log: u => { log(u); db.run("INSERT INTO calls(at, job, model, usage) VALUES (?,?,?,?)", Date.now(), u.job, u.model, JSON.stringify(u)); } })`; `wa = makeWaClient({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID })`; `embed = embedViaBinding(env.AI)`; `rerank`, `transcribe`, `snapshot` = functions that reject with `not implemented` until Tasks 8/11; `models = pickModels(env)`; `features = { memory: true, retrieval: "hybrid" }`.
- Produces (`index.ts`): `POST /webhook` parses, drops senders not in `ALLOWED_PHONES` (comma-separated digits; log the drop), awaits `env.CONTACT.getByName(m.from).ingest(m)` per inbound, logs statuses (warn once per isolate when `pricingType === "regular"`), returns 200. `GET /__cpu?ms=50` now calls `env.CONTACT.getByName("probe").burn(ms)`. `src/worker.ts` adds `export { ContactAgent } from "./contact-agent";`.
- Produces (`evals/harness.ts`): `class FakeClock { t: number; forContact(id: string): Clock & { alarmAt: number | null } }` — each view has its own `alarmAt`; `now()` returns the shared `t`; `sleep(ms)` advances the shared `t` by `ms` and resolves; `setAlarm(at)` sets the view's `alarmAt`. `class FakeWa implements WaClient { sent: { at: number; kind: "text"|"reaction"|"typing"; to: string; body?: string; quote?: string; target?: string; emoji?: string; id: string }[]; media: Map<string, { bytes: Uint8Array; mime: string }>; failNext?: WaError }` (stamps `at` with the shared fake time; `sendText` throws `failNext` once when set). `stubLlm(o?: { reply?: (call: StreamCall) => string | Promise<string>; object?: (call: ObjectCall<unknown>) => unknown }): Llm & { calls: StreamCall[]; objectCalls: ObjectCall<unknown>[] }` (default reply `"react: none\nok"`; `object()` throws when no hook). `hashEmbed(texts: string[]): Promise<Float32Array[]>` (deterministic: hash each word into a 64-dim bag, L2-normalised) and `cosineRerank(query, docs)` built on it. `makeEvalDeps(o: { clock: Clock; wa: FakeWa; llm: Llm; features?: Partial<Features>; models?: Partial<ModelChoice>; embed?: Deps["embed"]; rerank?: Deps["rerank"]; transcribe?: Deps["transcribe"]; snapshot?: Deps["snapshot"] }): Deps` (node:sqlite `:memory:` + `migrate`; defaults: `embed = hashEmbed`, `rerank = cosineRerank`, `transcribe = async () => "(voice)"`, `snapshot = async () => null`, `features = { memory: false, retrieval: "hybrid" }`, the `calls` ledger hook as in `makeDeps`). `drain(core: ContactCore, view: Clock & { alarmAt: number | null }, clock: FakeClock, until: number): Promise<void>` — at most 10 passes of: if `view.alarmAt !== null && view.alarmAt <= until` then `clock.t = Math.max(clock.t, view.alarmAt); view.alarmAt = null; await core.alarm()`, else stop.

- [x] **Step 1: Write the failing unit tests**

`timezone.test.ts`: `tzFromPhone("77011234567")==="Asia/Almaty"`, `("79161234567")==="Europe/Moscow"`, `("447700900123")==="Europe/London"`, `("15551234567")==="America/New_York"`, `("99999")==="UTC"`.
`prompt.test.ts`: `windowHistory` keeps the newest 40 of 60 rows; with 50 rows of 1,000 chars keeps the newest 24; `buildPrompt` puts `SYSTEM_PROMPT` first, the dynamic block second containing `"now: 2026-11-04 14:05"` and a memory line ending in `(said 2026-10-12)`, stamps history rows `[#12 2026-11-04 14:03]`, tags the pending inbound row `#1`, renders an image history row as `(photo: a red bike)`, and emits a `file` part with `mediaType: "image/jpeg"` when a pending row has media.
`contact.test.ts` (FakeClock, FakeWa, stubLlm, `features.memory=false` unless stated):
 - `ingest same wamid twice stores one row and arms one alarm` (`messages` count 1; `view.alarmAt === t + 3000`).
 - `unfinished last message arms 8 s`; `third message at +14 s is capped at burst + 15 s`.
 - `a reaction webhook never arms an alarm and lands in reactions JSON`.
 - `runTurn sends reaction then bubbles with the pacing and marks pending handled` (stub reply `"react: #1 👍\nhi\n---\nsecond"`; `wa.sent` kinds `[typing, reaction, text, typing, text]`; the two `text` entries differ in `at` by exactly `bubblePauseMs(2)`; all pending rows `handled`; one `turns` row with `ttfb_ms >= 0` and `total_ms > 0` when the stub's stream awaits a real 20 ms timer).
 - `quote: #1 becomes opts.quote with the real wamid`; `alias resolution ignores an unknown #n`.
 - `regenerates when a message arrives before the first bubble` (stub awaits a deferred promise; a second message is ingested mid-stream; one reply, `turns.regenerated === 1`, the second stub call's messages contain both texts).
 - `a WaError on send marks the outbound row failed and the turn completes` (`wa.failNext = new WaError(131047, 400)`; pending handled, one outbound row `failed`, `alarm()` resolves).
 - `an llm error ends the turn cleanly` (stub stream rejects before any send: first alarm → `turn_due === now + 30000`, `turn_attempts === 1`; second → pending handled, `turns.error` set, `view.alarmAt === null`).
 - `timers are consumed with memory off` (after a turn, `view.alarmAt === null`; with `features.memory=true` and a stub `object`, `view.alarmAt === lastInbound + 30 min`).
 - `a message arriving mid-turn opens a fresh burst` (second message ingested during the stream after the first bubble was sent: after the turn `turn_due === itsTs + 3000`, not capped by the old burst).
 - `image at t, text at t+1 s: fetchMedia called once and the model gets one file part`.
`src/index.test.ts`: `routes one POST with two senders to two objects` (fake `env.CONTACT.getByName` records names; a signed mixed payload → `ingest` once per sender, statuses not routed, 200); `drops a sender not in ALLOWED_PHONES` (no `ingest`, 200); `logs a status with pricingType regular once`.
`evals/cadence.test.ts` (through `ingest` + `drain`, memory off): burst of 3 messages 1 s apart → one `text` send and one `turns` row; `"so basically..."` → `view.alarmAt − t === 8000`; message arriving mid-generation → one reply whose stub prompt included all messages.

- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement.** Add to `wrangler.jsonc`: `"durable_objects": { "bindings": [{ "name": "CONTACT", "class_name": "ContactAgent" }] }` and `"exports": { "ContactAgent": { "type": "durable-object", "storage": "sqlite" } }` (if the deploy rejects `exports`, use `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ContactAgent"] }]` and note it). Re-run `npx wrangler types`.
- [x] **Step 4: Run all tests, typecheck** → PASS (`npm test`, `npx vitest run evals/cadence.test.ts`).
- [x] **Step 5: Deploy and probe**

```bash
npx wrangler deploy
curl -s "https://wapp-agent.alda-onggar.workers.dev/__cpu?ms=50"   # DO-level CPU probe
```
If the probe is cut off (error, or a number far below 50): tell the owner the Free plan caps Durable Object CPU; the $5 Workers Paid upgrade is pre-approved, so ask for the dashboard click, then redeploy and re-probe. If it returns ≈50: continue.

- [x] **Step 6: Live check** (needs the owner's Meta webhook configured): text the number; `npx wrangler tail --format pretty` shows the turn log line; 1–3 bubbles arrive. If Meta is not ready, note it and continue.
- [x] **Step 7: Commit and push** `git commit -am "feat: contact core with cadence, streaming bubbles, durable object and fan-out" && git push`

---

### Task 7: Eval harness, runner, judge, reporter, short-term scenarios

**Files:**
- Create: `evals/run.ts`, `evals/judge.ts`, `evals/report.ts`, `evals/scenarios.test.ts`, `evals/harness.test.ts`, `evals/scenarios/short-*.yaml` (7), `evals/fixtures/photo.jpg`
- Modify: `evals/harness.ts` (scenarios, `runScenario`, config)

**Interfaces:**
- Produces (`harness.ts`):
```ts
export interface EvalConfig { reply?: string; extract?: string; derive?: string; effort?: "low"|"medium"|"high"; memory: boolean; retrieval: "cosine"|"hybrid"; filter?: string; tag: string }
export function evalConfig(): EvalConfig;   // from env EVAL_REPLY, EVAL_EXTRACT, EVAL_DERIVE, EVAL_EFFORT, EVAL_MEMORY ("0" → false), EVAL_RETRIEVAL, EVAL_FILTER; tag = e.g. "reply=deepseek_deepseek-v4.1-flash,memory=1,retrieval=hybrid"
export type Step =
  | { at: string; contact?: string; say?: string; image?: string; caption?: string; url?: string; quote?: number }
  | { fill: number }
  | { seed_facts: number }
  | { at: string; contact?: string; ask: string; gold: string; quote?: number; expect_contains?: string[]; expect_not_contains?: string[] }
  | { expect_facts: { count: number; gold: string[] } }
  | { expect_facts_not_contains: string[] }
  | { expect_insights: { min: number; evidence_count?: number } };
export interface Scenario { name: string; category: "short-term"|"long-term"|"derived"|"judgement"|"forget"|"isolation"; steps: Step[] }
export interface ProbeResult { ask: string; gold: string; answer: string; label: "correct"|"partial"|"wrong"|"hallucinated"; reason: string; ttftMs?: number; ttfbMs?: number; totalMs?: number }
export interface ScenarioResult { name: string; category: string; probes: ProbeResult[]; checks: { name: string; passed: boolean; detail: string }[]; transcript: string[]; turns: Record<string, unknown>[]; costUsd: number; passed: boolean }
export function loadScenarios(dir: string, filter?: string): Scenario[];
export function runScenario(sc: Scenario, cfg: EvalConfig, realLlm: Llm): Promise<ScenarioResult>;
```
  Runner rules: one `ContactCore` and one `FakeWa` per `contact` id (default `a`), all on one `FakeClock` with per-contact views; `deps.embed`/`rerank` are `embedViaRest`/`rerankViaRest` (Task 8) when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set, else `hashEmbed`/`cosineRerank`; `features = { memory: cfg.memory, retrieval: cfg.retrieval, replyEffort: cfg.effort }`; models from `cfg` over `pickModels({})`. Step `at` values must be non-decreasing (throw otherwise). Before applying a step at `T`: for every core `drain(core, view, clock, T)`, then `clock.t = Math.max(clock.t, T)`. `say`/`ask` → `ingest` with wamid `wamid.<stepIndex>`, `ts = clock.t`, `quotedId = "wamid.<quote>"` when `quote` is set; `image` → `FakeWa.media.set(mediaId, fixture bytes)` + `ingest({ kind:"image", mediaId, mime:"image/jpeg", text: caption ?? "[photo]" })`; `url` → `say` of the URL. After `ask`: `drain(core, view, clock, clock.t + MAX_WAIT_MS + 1)`, repeated (≤5 times, extending `until` by 15 s) while pending inbound rows remain; answer = `text` sends of that contact's `FakeWa` since the ask, joined by `"\n"`; latency from the newest `turns` row. `fill: N` → insert N pairs (`user "ok"` / `assistant "sure"` style canned lines, 60 s apart from `clock.t`, `status='handled'`) straight into `messages` and advance `clock.t` to the last inserted `ts`. `seed_facts: N` → insert N canned facts (`"Likes espresso"`, `"Colleague Dana works in sales"`, …) with embeddings from `deps.embed` into `facts` and `facts_fts`. `expect_facts` → active facts → `judgeFacts`; `expect_facts_not_contains` → fails if any fact or insight text contains a string case-insensitively; `expect_insights` → counts active insights with `evidence_fact_ids.length === evidence_count` (when given) ≥ `min`. `passed` = every probe `correct` (deterministic probes skip the judge) and every check passed. `costUsd` = sum of `calls.usage.costTable` across the scenario's databases.
- Produces (`judge.ts`): `judge(llm: Llm, p: { question: string; gold: string; answer: string }): Promise<{ label: ProbeResult["label"]; reason: string }>` via `llm.object` on `anthropic/claude-opus-5.5` with `reasoning: { effort: "low" }`, schema `z.object({ label: z.enum([...]), reason: z.string() })`; `correct` when the answer conveys the gold fact, `partial` when part of it, `wrong` when it contradicts or claims not to know while the gold exists, `hallucinated` when it asserts a specific fact not in the gold; `judgeFacts(llm, p: { gold: string[]; stored: string[] }): Promise<{ matched: number; junk: number }>`.
- Produces (`run.ts`): parses `--reply= --extract= --derive= --effort= --no-memory --retrieval= --filter=` into `EVAL_*` env vars, loads `.dev.vars` via `process.loadEnvFile(".dev.vars")`, spawns `npx vitest run evals --reporter=verbose --testTimeout=1200000`, exit code passthrough.
- Produces (`scenarios.test.ts`): `describe.skipIf(!OPENROUTER_API_KEY || !CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID)`; one `test(sc.name, { timeout: 20 * 60_000 }, ...)` per scenario; `afterAll` writes `evals/results/<tag>.json` = `{ tag, config, at: ISO, scenarios: ScenarioResult[] }`.
- Produces (`report.ts`): reads `evals/results/*.json`, writes `EVALS.md`: results table (category × baseline × this agent, % passed), model comparison per job (accuracy on the job's categories, p50/p95 ttft/ttfb/total, cost per 1,000 replies = sum of reply-job `calls` cost in the run ÷ `turns` rows × 1000), latency per candidate and effort, candidates not run, retrieval cosine vs hybrid, then every scenario transcript under `<details>`.

Short-term scenarios (7): `short-burst-of-three` (3 messages at +0/+1/+2 s; `expect_contains` the three nouns), `short-second-one` ("give me 3 names" → "the second one"), `short-correction` ("meet at 6" … "actually make it 7" → "when are we meeting" → `7`), `short-quoted-reply` (step 1 "A: pizza", step 2 "B: sushi", ask "how about this one?" with `quote: 1` → `pizza`), `short-like-i-said` (colour stated 10 messages earlier), `short-that-place` ("the cafe on Abay street" … "how do I get to that place" → `Abay`), `short-photo-then-question` (`image: photo.jpg`, caption "look" at +0 s; ask "what colour is it?" at +1 s; gold = the fixture's dominant colour; judged).

- [x] **Step 1: Write the failing tests** (`evals/harness.test.ts`, stub LLM): `loadScenarios` parses a YAML string with every step kind including `quote` and `seed_facts`; `runScenario` on a 2-step scenario returns one probe with `answer === "ok"` and `expect_contains: ["ok"]` → `passed === true`; `fill: 3` inserts 6 rows with `status: "handled"` and advances the clock; `ask at +10 s does not call llm.object` (memory on, stub `object` hook counts calls → 0 because insights are 30 min out); `a counting embed passed to runScenario is called for a say step` (memory on); `evalConfig()` builds the tag.
- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement** harness extensions, `run.ts`, `judge.ts`, `report.ts`, `scenarios.test.ts`, the seven YAML files, a 20 KB JPEG fixture of one flat colour.
- [ ] **Step 4: Run** `npx vitest run evals/harness.test.ts` → PASS. With the keys: `npm run eval -- --filter=short` and `npm run eval:report`; EVALS.md shows the seven short-term results with non-zero `ttfbMs`. (pending: key)
- [x] **Step 5: Commit** `git commit -am "feat: eval harness, judge, reporter and short-term scenarios"`

---

### Task 8: Media: images, voice notes, other types; Workers AI module

**Files:**
- Create: `src/workers-ai.test.ts`
- Modify: `src/workers-ai.ts` (complete), `src/core/contact.ts`, `src/contact-agent.ts` (wire), `evals/harness.ts` (REST embed/rerank when env set), `src/core/contact.test.ts`

**Interfaces:**
- Produces (`workers-ai.ts`): `embedViaBinding(ai: Ai): Deps["embed"]` (`ai.run("@cf/baai/bge-m3", { text, truncate_inputs: true })` → `data`, batches of ≤100, drop empty strings (return `[]` for an empty batch), L2-normalise, `Float32Array`); `embedViaRest(accountId: string, token: string, fetchFn?: typeof fetch): Deps["embed"]` (`POST /accounts/{id}/ai/run/@cf/baai/bge-m3` → `result.data`); `rerankViaBinding(ai)` / `rerankViaRest(...)`: `Deps["rerank"]` (`{ query, contexts: docs.map(text => ({ text })) }` → scores ordered by input index from `response[].id`; empty query or docs → zeros); `transcribeViaBinding(ai): Deps["transcribe"]` (`toBase64` in 32 KB `String.fromCharCode` chunks, `{ audio, task: "transcribe", vad_filter: true }` → `text`; throws on empty text); `toBase64(bytes: Uint8Array): string`.
- Contact behaviour (already specified in Task 6 `ingest`): images over 5 MB or not `image/jpeg|png|webp` get `text = (caption + " [an image that could not be read]").trim()` and no file part.

- [x] **Step 1: Write the failing tests**: `toBase64(new Uint8Array([104,105]))==="aGk="` and a 70,000-byte buffer round-trips through `atob`; `embedViaRest` posts the documented body and returns normalised vectors (fake fetch `{result:{data:[[3,4]]}}` → `[0.6,0.8]`); `embedViaRest([])` returns `[]` without fetching; `rerankViaRest` maps `response:[{id:1,score:0.9},{id:0,score:0.2}]` to `[0.2,0.9]`; `contact.test.ts`: `voice note with failing transcribe leaves the marker and the stub prompt contains it`; `image on a text-only reply model switches to the vision model` (`models.reply = "z-ai/glm-5.2"`, stub records `modelId === "openai/gpt-6.1-terra"`); `oversized image gets the could-not-read text and no file part`.
- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement.** Wire real `embed`, `rerank`, `transcribe` in `makeDeps`; in `evals/harness.ts` `runScenario` uses `embedViaRest`/`rerankViaRest` when both env vars are set.
- [ ] **Step 4: Run tests, typecheck, deploy.** Send a photo and a voice note from the phone; `wrangler tail` shows the transcript in the turn log, never in the reply. Record whether Whisper accepted `audio/ogg; codecs=opus`. (pending: phone)
- [x] **Step 5: Commit** `git commit -am "feat: images, voice notes and other message types"`

---

### Task 9: Long-term memory: extraction, hybrid retrieval, profile, forget, timezone confirmation; memory evals

**Files:**
- Create: `src/core/memory.ts`, `src/core/memory.test.ts`, `evals/scenarios/long-*.yaml` (6), `evals/scenarios/judgement-*.yaml` (2), `evals/scenarios/forget-never-returns.yaml`, `evals/scenarios/isolation-canary.yaml`
- Modify: `src/core/contact.ts`, `src/core/prompt.ts` (control-phrase instructions), `evals/harness.ts` (if helpers move)

**Interfaces:**
- Produces (`memory.ts`):
```ts
export const KINDS = ["identity","person","preference","plan","routine","work","place","other"] as const;
export const ExtractSchema = z.object({
  ops: z.array(z.object({ op: z.enum(["ADD","UPDATE","DELETE","NONE"]), text: z.string(), kind: z.enum(KINDS), signal: z.number().int().min(1).max(5), event_date: z.string().nullable().optional(), target_id: z.number().int().nullable().optional() })),
  profile: z.string().nullable().optional(),
  media_note: z.string().nullable().optional(),   // one line about an image in this turn, when it matters
  timezone: z.string().nullable().optional(),     // IANA id, only when the person stated their city or zone in this turn
});
export interface TurnForMemory { messages: { role: "user"|"assistant"; text: string; id: string }[]; images: { messageId: string; bytes: Uint8Array; mime: string }[]; nowLocal: string; tz: string }
export function remember(deps: Deps, turn: TurnForMemory): Promise<{ added: number; updated: number; deleted: number }>;
export function recall(deps: Deps, query: string, k?: number): Promise<{ hits: MemoryHit[]; ms: number }>;
export function forget(deps: Deps, query: string): Promise<number>;
export function profileText(db: Db): string;
export function cosineTopN(db: Db, q: Float32Array, n: number, table: "facts"|"insights"): { id: number; score: number }[];
export function cascadeInsights(db: Db, factIds: number[]): void;
```
  `remember`: no-op when `features.memory` is false. Input: the turn's messages, `profileText`, the 10 most similar active facts (embedding of the joined user text; skipped when that text is empty) listed as `[id] text (kind, YYYY-MM-DD)`, and the turn's image file parts (all three extraction candidates take images). System prompt adapted from mem0's `FACT_RETRIEVAL_PROMPT` + `DEFAULT_UPDATE_MEMORY_PROMPT` (fetch `mem0/configs/prompts.py` from github.com/mem0ai/mem0 at implementation time; keep their few-shot structure, replace categories with `KINDS`, add the brief's signal scale and noise list, require absolute dates computed from `nowLocal`, forbid storing the assistant's suggestions, ask for `profile` only when ops changed something and keep it ≤300 tokens, `media_note` only when an image was sent and it matters, `timezone` only when stated). Persist `signal ≥ 3`: `ADD` inserts (one batch `embed`), `UPDATE` inserts the new fact and sets the target `status='superseded', superseded_by=new`, `DELETE` hard-deletes; mirror `facts_fts`; `cascadeInsights` on UPDATE/DELETE targets; upsert `profile`; write `media_note` to the image row; validate `timezone` with `new Intl.DateTimeFormat(undefined, { timeZone })` in try/catch and `UPDATE contact SET timezone=?, timezone_confirmed=1`. The `calls` ledger is written by the `makeLlm` hook; `remember` adds nothing to it.
  `recall` (design §4.8): empty trimmed query → `{ hits: [], ms: 0 }` without calling `embed`. `cosine` → cosine over facts (`status != 'deleted'`, superseded included) and active insights, `score = cos + 0.05 × recency`, top k. `hybrid` → cosine top 30 ∪ FTS hits (query = capitalised words and numbers from the text, each double-quoted, OR-joined; skipped when none) → `deps.rerank(query, texts)` → `score = rerank + 0.05 × recency` → top k. `date` = `created_at` as `YYYY-MM-DD`; recency = `max(0, 1 − ageDays/365)`; `ms` = wall-clock.
  `forget`: embed query → facts with cosine ≥ 0.6 ∪ facts whose text contains the query case-insensitively → hard delete + `facts_fts` rows + `cascadeInsights`; return count.
- Contact changes: `recallCache` runs `recall(deps, pendingText + the last two messages)`; `buildPrompt` receives `profile` and `hits`; `retrieval_ms` from `recall`; the reply call always carries the `forget` tool when `features.memory` (`tool({ description: "Delete stored facts matching the query; call when the person asks to forget something", inputSchema: z.object({ query: z.string() }), execute })` returning `{ deleted: n }`); the dynamic block says "what do you know about me" is answered with a short plain summary of the profile and the most relevant facts, and that after `forget` the reply confirms in one line. After a successful turn: `remember({ messages: pending + sent bubbles, images, nowLocal, tz })`.

Scenarios: `long-recall-sister-city` (`seed_facts: 30`, say on day 1, `fill: 45`, ask on day 4 → `Almaty`), `long-update-moved` (day 1 "sister lives in Almaty", day 5 "she moved to Astana", `fill: 45`, ask "where does my sister live" → `Astana`; ask "where did she live before" → `Almaty`), `long-dates` ("interview at Monzo next Thursday 2pm" said on a Tuesday → `fill: 45` → "when is my interview" → the absolute date), `long-dont-know` (ask about a pet never mentioned → judge gold "says it doesn't know"), `long-preference` (vegetarian → `fill: 45` → "what should I cook tonight" → no meat; judge), `long-work` (`seed_facts: 30`, project name → `fill: 45` → "what was that project called"). `judgement-smalltalk-50` (50 chit-chat lines as separate steps 2 min apart with 3 facts spread in; `expect_facts: { count: 3, gold: [...] }`), `judgement-assistant-suggestions` (assistant proposes restaurants in its replies; `expect_facts` excludes them). `forget-never-returns` (say, ask, "forget my sister's city", `fill: 45`, `expect_facts_not_contains: ["Almaty"]`, ask → `expect_not_contains: ["Almaty"]`). `isolation-canary` (contact `a` says the canary word; `fill: 5`; contact `b` asks → `expect_not_contains: [canary]`).

- [x] **Step 1: Write the failing unit tests** (`memory.test.ts`; stub `object` returning fixed ops; `hashEmbed`/`cosineRerank`):
  - `remember persists only signal >= 3 and embeds in one batch` (ops with signals 2, 3, 5 → 2 facts; `embed` called once with 2 texts).
  - `UPDATE supersedes and keeps the old fact retrievable` (`status === "superseded"`, `superseded_by === new id`; `recall` returns both, old marked superseded).
  - `DELETE and UPDATE cascade to insights`.
  - `recall hybrid merges an FTS hit that cosine missed` (fact "Interview at Monzo" with a far-away vector; query "Monzo?" → present).
  - `recall("") returns [] without calling embed`.
  - `forget removes by substring and returns the count`; `profile upsert`.
  - `media_note is written to the image row`; `timezone "Europe/Lisbon" updates the contact row, "Mars/Olympus" is ignored`.
- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement** `memory.ts`; wire into `contact.ts` and `prompt.ts`; write the 10 YAML scenarios.
- [ ] **Step 4: Run unit tests, typecheck** → PASS. With the keys: `npm run eval -- --filter=long`, `--filter=judgement`, `--filter=forget`, `--filter=isolation`; then the baseline `npm run eval -- --no-memory`; `npm run eval:report`. Iterate on the extraction prompt until the judgement scenarios pass; record what changed in the commit body. (pending: key)
- [x] **Step 5: Deploy, commit, push** `git commit -am "feat: long-term memory with extraction, hybrid retrieval, profile and forget" && git push`

---

### Task 10: Derived insights

**Files:**
- Create: `src/core/insights.ts`, `src/core/insights.test.ts`, `evals/scenarios/derived-*.yaml` (4)
- Modify: `src/core/contact.ts` (alarm branch), `src/core/contact.test.ts`

**Interfaces:**
- Produces: `export const InsightSchema = z.object({ insights: z.array(z.object({ text: z.string(), confidence: z.number().min(0).max(1), evidence_fact_ids: z.array(z.number().int()) })).max(3) })`; `deriveInsights(deps: Deps): Promise<number>` — active facts with `created_at > state.last_insights_run` plus, per new fact, the 5 most similar older active facts; one `llm.object` call on `models.derive` asking for up to 3 connections or implications the person never stated together, each citing evidence ids, with confidence; store those with `confidence ≥ 0.5` whose evidence ids are all active facts (embedding via `embed`); set `last_insights_run = now`; return the count.
- Contact: timer 2 in `alarm()` (Task 6) now calls `deriveInsights` when `features.memory` after setting `insights_due = NULL`.

- [x] **Step 1: Write the failing tests**: `deriveInsights stores insights with confidence >= 0.5 and evidence ids` (stub returns 0.9 and 0.3 → one stored); `insight is removed when its evidence fact is superseded`; `recall labels insights as derived with confidence` (`MemoryHit.kind === "insight"`, prompt line contains `(derived, confidence 0.9)`); contact test: `insights alarm fires 30 min after the last message and not before` (`view.alarmAt === lastInbound + 30 min`; drain to +31 min → stub `object` called once; `view.alarmAt === null` afterwards).
- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement.** Scenarios, each `say A` → `say B` → next step `at: +31 min` → `fill: 45` → `expect_insights: { min: 1, evidence_count: 2 }` → `ask` (judged): `derived-almaty-birthday` (flight to Almaty on a date + sister's birthday two days later → "anything I should plan for that trip?"), `derived-lisbon-vegetarian`, `derived-early-flight-routine` ("I run every morning at 7" + "flight at 6am Friday" → "should I run Friday?"), `derived-allergy-dinner` ("allergic to peanuts" + "dinner at a Thai place Saturday" → "anything to watch out for Saturday?").
- [ ] **Step 4: Run tests; with the keys `npm run eval -- --filter=derived`.** Deploy. (pending: key)
- [x] **Step 5: Commit** `git commit -am "feat: derived insights after 30 minutes of quiet"`

---

### Task 11: Web pages: snapshot prefetch and the view_page tool

**Files:**
- Modify: `src/browser.ts` (add `makeSnapshot`), `src/browser.test.ts`, `src/core/contact.ts`, `src/contact-agent.ts` (wire), `evals/harness.ts` (real snapshot when env set), `src/core/contact.test.ts`

**Interfaces:**
- Produces (`browser.ts`): `makeSnapshot(cfg: { accountId: string; token: string; fetch?: typeof fetch }): Deps["snapshot"]` — `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/browser-rendering/snapshot?cacheTTL=0` with body `{ url, formats: ["screenshot","markdown"], viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, screenshotOptions: { type: "jpeg", quality: 80 }, gotoOptions: { waitUntil: "networkidle2", timeout: 20000 }, bestAttempt: true }`, `AbortSignal.timeout(25000)`; decode `result.screenshot` (base64 → `Uint8Array`), `result.markdown` (strip leading YAML front matter, trim to 12,000 chars), `title: meta?.title ?? ""`, `status: meta?.status ?? 0`, `finalUrl: meta?.finalUrl ?? url`; returns `null` on any non-2xx (log status and `Retry-After` on 429) or timeout. `extractUrls` already exists from Task 6.
- Contact: `pages` prefetch is already in Task 6 `ingest`; when the thread (pending + last 5 history rows) contains a URL the reply call also gets the `view_page` tool (`inputSchema: z.object({ url: z.string().url() })`, execute → `pages.get(url) ?? snapshot(url)` → `{ title, status, finalUrl, markdown }` text only, or `{ error: "could not open the page" }`); after the turn `remember()` receives `(shared a link: <title> <finalUrl>)` appended to the user text.

- [x] **Step 1: Write the failing tests**: `makeSnapshot posts the documented body and decodes the result` (fake fetch; `formats`, viewport; returns `{ success:true, result:{ screenshot: base64 of 3 bytes, markdown: "---\ntitle: X\n---\n# Hi" }, meta:{status:200,title:"X",finalUrl:"https://x/"} }` → `jpeg.length===3`, `markdown==="# Hi"`); `falls back to the request url when meta has no finalUrl`; `returns null on 429`; `extractUrls` finds two and ignores `ftp://`; contact tests: `URL at t, text at t+1 s: snapshot called once and the model gets the page text and a file part`; `view_page tool is attached only when the thread has a URL`; `an outbound bubble with a URL is sent with previewUrl`.
- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement.** Wire `snapshot` in `makeDeps` and in `runScenario` (real REST when `CLOUDFLARE_API_TOKEN` is set).
- [ ] **Step 4: Run tests, deploy, send a link from the phone; the reply talks about what the page shows.** (pending: phone)
- [x] **Step 5: Commit** `git commit -am "feat: web page snapshots and view_page tool"`

---

### Task 12: Proactive follow-ups

**Files:**
- Create: `src/core/followups.ts`, `src/core/followups.test.ts`
- Modify: `src/core/contact.ts`, `src/core/contact.test.ts`

**Interfaces:**
- Produces:
```ts
export function scheduleFollowup(db: Db, now: number, tz: string): void;  // rescans facts WHERE kind='plan' AND status='active' AND event_date IS NOT NULL AND followup_done = 0; each candidate's due = eventDate (parsed in tz, date-only → 12:00) + 2h, except the fact currently in state.followup_fact_id, whose due stays state.followup_due (so a deferral is kept); picks the smallest due that is > now − 24h (older plans are marked followup_done = 1 and dropped); sets followup_due/followup_fact_id, or clears both when nothing qualifies
export type FollowupDecision = { kind: "send"; factId: number; text: string } | { kind: "skip"; reason: "window" | "messaged" | "no-fact" } | { kind: "defer"; to: number };
export function followupDecision(db: Db, now: number, tz: string): FollowupDecision;
```
  Rules (design §4.10): `no-fact` if the fact is not active; `window` if `now − contact.last_inbound_ts > 24 h`; `messaged` if any inbound `ts > eventDate`; `defer` to the next 09:00 local if the local hour is < 9 or ≥ 22, or if `contact.last_proactive_date` equals today in `tz` (one proactive message per day) — in both cases only when that moment is still inside the 24 h window, else `window`; else `send`.
- Contact: after `remember()` → `scheduleFollowup(db, now, tz)`; timer 3 in `alarm()`: set `followup_due = NULL` first, then `followupDecision`: `send` → one-bubble call `llm.stream({ job: "followup", maxOutputTokens: maxOutputTokensFor(models.reply, features.replyEffort), reasoning: reasoningFor(...), system: [SYSTEM_PROMPT, dynamic block + "write one short check-in about this plan: <fact text>; no reaction line; one bubble"] })` parsed with `parseReply(text, 1)`, sent with the same error wrapping as `runTurn`, outbound row inserted, `last_proactive_date = today`; `defer` → `followup_due = to` (same `followup_fact_id`); `send` and `skip` → `UPDATE facts SET followup_done = 1` for that fact and clear `followup_fact_id`; in every case finish with `scheduleFollowup(db, now, tz)`, which keeps a deferred fact's `to` and otherwise moves on to the next plan or leaves the timer clear.

- [x] **Step 1: Write the failing tests**: `scheduleFollowup picks the soonest future plan and adds 2h`; `scheduleFollowup keeps a deferred due for the tracked fact and skips followup_done facts`; `followupDecision` table: 23:30 local → `defer` to 09:00 next day; 10:00 local with last inbound 30 h ago → `skip window`; inbound after the event → `skip messaged`; already sent today → `defer` to 09:00 tomorrow; otherwise `send`; contact tests: `follow-up fires after the alarm and sends exactly one bubble, marks the fact followup_done, and the alarm is clear afterwards`; `a skipped plan is not re-picked (no alarm storm)`; `two plans: after the first fires, followup_due === D2 + 2h`.
- [x] **Step 2: Run tests to verify they fail** → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run tests, typecheck, deploy.**
- [x] **Step 5: Commit** `git commit -am "feat: proactive follow-ups inside the 24h window"`

---

### Task 13: Model comparison and EVALS.md

> Deferred: needs OPENROUTER_API_KEY; see README › Evals.

**Files:**
- Modify: `evals/report.ts` (comparison tables), `src/models.ts` (winners), `EVALS.md` (generated)

- [ ] **Step 1: Run the matrix** (needs the keys; each run writes `evals/results/<tag>.json`):

```bash
npm run eval                                        # defaults, all scenarios
npm run eval -- --no-memory                         # baseline
npm run eval -- --retrieval=cosine --filter="long-recall|long-work"   # what hybrid buys (the seeded scenarios)
for m in moonshotai/kimi-k2.6 z-ai/glm-5.2; do npm run eval -- --reply=$m --filter=short; done
for m in openai/gpt-6-luna anthropic/claude-haiku-5.5; do npm run eval -- --extract=$m --filter="long|judgement"; done
for m in openai/gpt-6.1-sol anthropic/claude-sonnet-5.5; do npm run eval -- --derive=$m --filter=derived; done
npm run eval -- --reply=<best> --effort=medium --filter=short
npm run eval:report
```
- [ ] **Step 2: Pick per job** (accuracy first; a reply candidate that misses the 5 s p95 first-bubble target loses regardless; then cost). Set winners as defaults in `src/models.ts`; EVALS.md states which candidates were not run (OpenAI/Anthropic reply candidates and the vision comparison, owner's spend decision; the photo scenario ran on the default and, via the fallback, on GLM-5.2), and the host that served each Chinese-lab model.
- [ ] **Step 3: Verify** `npm test && npx tsc --noEmit`; EVALS.md has the tables and all transcripts.
- [ ] **Step 4: Commit** `git commit -am "docs: eval results and model picks"`

---

### Task 14: README, cleanup, final deploy

**Files:**
- Create: `README.md`
- Modify: `src/index.ts`, `src/contact-agent.ts`, `src/env.d.ts` (remove `/__cpu` and `burn`), `SETUP.md` (point at the README's known limits), the plan (tick boxes)

- [x] **Step 1: README.md** sections, in this order: what it does and how to text it (the test number, that reviewers must be added first, what to try: a burst of three, a photo, a voice note, a link, "what do you know about me", "forget …", come back tomorrow); architecture diagram (Mermaid: phone → Meta → Worker → ContactAgent DO → OpenRouter / Workers AI / Browser Rendering, with the alarm loop); repo map (one line per file from the File map); the eval results table copied from EVALS.md with a link; model picks with numbers and hosts; known limits (24 h window, test-number recipient list, Free-plan browser and AI quotas, 1,000 free messages/month, no voice replies, follow-ups skipped outside the window, timezone guessed from the phone until the person states it); what I'd build next (follow-ups outside the 24 h window via templates, voice replies); credits (mem0 prompts, Apache-2.0).
- [ ] **Step 2: Remove the CPU probe route and `burn`; `npm test && npx tsc --noEmit`; `npx wrangler deploy`; text the number once more.** (pending: phone; everything before "text the number" ran)
- [x] **Step 3: Commit and push** `git commit -am "docs: readme, remove probe route" && git push`
- [x] **Step 4: Hand over**: the repo URL, the Worker URL, the SETUP.md steps still open on the owner's side (reviewer numbers), and the EVALS.md headline numbers.
