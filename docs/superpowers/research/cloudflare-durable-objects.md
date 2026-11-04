# Cloudflare Workers + Durable Objects (SQLite) + alarms + wrangler + node:sqlite — reference note

Researched 2026-11-04 from official docs (developers.cloudflare.com `index.md` pages, nodejs.org v24 API docs, npm registry). Doc "last updated" dates are noted where relevant. Versions seen today: wrangler 4.157.0 (engines node >=22), @cloudflare/workers-types 5.20261104.1, vitest 5.1.0, @cloudflare/vitest-plugin 1.5.1 (peer vitest ^4.1 || ^5.0), @cloudflare/vitest-pool-workers 0.23.0 (peer vitest ^4.1 only; superseded), tsx 4.23.15, Node 24 latest v24.22.2 (LTS "Krypton"), local machine node v24.18.0.

Anything marked **UNCONFIRMED** was not found in official docs; do not rely on it without testing.

---

## 1. wrangler.jsonc

Source: https://developers.cloudflare.com/workers/wrangler/configuration/ (keys), https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ (`exports`, updated 2026-09-28), https://developers.cloudflare.com/durable-objects/get-started/ (updated 2026-10-18).

### Recommended config (new `exports` form)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "wapp-agent",                 // becomes <name>.<subdomain>.workers.dev; alphanumeric + dashes (<=255); for workers.dev <=63 chars, no leading/trailing dash
  "main": "src/index.ts",
  "compatibility_date": "2026-11-04",   // docs: "set this to today's date"
  // nodejs_compat (+v2) is ON BY DEFAULT for compatibility_date >= 2026-08-04; the flag is a harmless no-op here.
  // Keep it only if you might lower the date below 2026-08-04.
  "compatibility_flags": ["nodejs_compat"],
  "upload_source_maps": true,
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "durable_objects": {
    "bindings": [{ "name": "CONTACT", "class_name": "ContactAgent" }]
  },
  "exports": {
    "ContactAgent": { "type": "durable-object", "storage": "sqlite" }
  },
  "ai": { "binding": "AI" },            // exactly one AI binding per Worker
  "vars": { "LOG_LEVEL": "info" },      // plain text/JSON, NOT secrets; non-inheritable per env
  "limits": { "cpu_ms": 30000 }         // optional; paid plan only; max 300000; ignored in local dev
}
```

### Legacy `migrations` form (what the task text asked for)

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "CONTACT", "class_name": "ContactAgent" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ContactAgent"] }]
}
```

Facts (durable-objects-migrations page):
- `exports` and Durable Object `migrations` are **mutually exclusive**; a config with both is rejected. Wrangler configuration page (`migrations` entry): "For new Workers, prefer `exports`." Once deployed with `exports` you cannot go back to `migrations`.
- `exports` entry fields: `type: "durable-object"` (required), `state` one of `"created"` (default, omit) | `"deleted"` | `"renamed"` | `"transferred"` | `"expecting-transfer"`, `storage: "sqlite"` (required for live entries; `"legacy-kv"` only for pre-existing KV namespaces), `renamed_to`, `transferred_to`, `transfer_from`, `container`.
- A class only in code is ignored until declared in `exports`; a provisioned namespace with no entry fails deploy with `orphaned_provisioned_namespace`.
- `"state": "deleted"` destroys all data (no trash). Requires the class removed from code first (`tombstone_delete_class_still_in_code`).
- Lifecycle changes apply only via `wrangler deploy`, not `wrangler versions upload`; no gradual deployments; rollbacks cannot cross a lifecycle change.
- Storage backend is immutable per namespace (`storage_type_mismatch`).
- Minimum wrangler version for Durable Object `exports`: **4.107.0** (wrangler CHANGELOG; also wired into `wrangler dev`, `wrangler types` and the vitest plugin from that release). 4.157.0 is current.

### Key semantics
- `compatibility_date` is required; runtime supports old dates forever. (https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
- `workers_dev` defaults `true` when no `route`/`routes`. URL after `wrangler deploy`: `https://<WORKER_NAME>.<ACCOUNT_SUBDOMAIN>.workers.dev` (https://developers.cloudflare.com/workers/configuration/routing/workers-dev/). `wrangler deploy` prints it.
- `observability.enabled` defaults to `true` for new Workers; `head_sampling_rate` 0..1 default 1. Workers Logs: Free 200,000 events/day, 3-day retention; Paid 20M/month included (+$0.60/M after), 7 days (https://developers.cloudflare.com/workers/platform/pricing/#workers-logs). From 2026-12-01 Workers Logs moves to Observability pricing.
- `limits.cpu_ms` max 300,000; `limits.subrequests` (free max 50, paid max 10,000,000). Only enforced when deployed.
- `vars` and `durable_objects` are **non-inheritable** keys: redeclare per `env.<name>`.
- `ai` binding: "Using Workers AI always accesses your Cloudflare account ... and will incur usage charges even in local development." Bindings-per-env table: AI has no local simulation (remote only).
- Compat flags worth knowing (https://developers.cloudflare.com/workers/configuration/compatibility-flags/): RPC on DO stubs needs date >= `2024-04-03`; `nodejs_compat_populate_process_env` (process.env from vars/secrets) default >= `2025-04-01`; `delete_all_deletes_alarm` default >= `2026-02-24`; `enhanced_error_serialization` default >= `2026-04-21`; `web_socket_auto_reply_to_close` default >= `2026-04-07`; `durable_object_io_tasks_prevent_eviction` default >= `2026-10-01`; nodejs_compat default >= `2026-08-04`; `enable_ctx_exports` default >= `2025-11-17` (loopback bindings via `ctx.exports`, not needed here).

### Types: `wrangler types`
Source: https://developers.cloudflare.com/workers/wrangler/commands/workers/#types, https://developers.cloudflare.com/workers/languages/typescript/
- `npx wrangler types` writes `worker-configuration.d.ts` (overwritten each run; do not edit) containing `Env` (from bindings) + runtime types for your compat date/flags. Add to `tsconfig.json`: `"compilerOptions": { "types": ["./worker-configuration.d.ts"] }`. Install `@types/node` when using nodejs_compat. Re-run after any config change. Flags: `--env`, `--env-interface Env`, `--strict-vars=false` (vars as `string`), `--check` (exit 1 if stale, for CI), `-c` extra config paths for RPC types of other Workers.
- Generated `Env` types a same-Worker DO binding as `DurableObjectNamespace<...>`; for cross-Worker it is `DurableObjectNamespace<import("../counter/src/index").Counter>` (RPC typescript page). If your binding comes out untyped, declare it yourself: `CONTACT: DurableObjectNamespace<ContactAgent>`.
- `@cloudflare/workers-types` v5 exposes only latest runtime types (dated entrypoints removed); prefer `wrangler types`.

### Secrets / local dev / tail / remote
Source: https://developers.cloudflare.com/workers/configuration/secrets/ (updated 2026-10-15), https://developers.cloudflare.com/workers/wrangler/commands/workers/
- `npx wrangler secret put META_TOKEN` (prompts; also accepts stdin: `echo "$V" | npx wrangler secret put META_TOKEN`). Creates and deploys a new version immediately. `wrangler secret bulk secrets.json` (JSON `{"K":"V","DEL":null}` or .env; <=100 per command; omit FILE to read stdin; `null`-deletion only works in JSON). `wrangler deploy --secrets-file .env.production` uploads secrets with code; omitted secrets are preserved. Secrets are never deleted by deploys.
- Local: `.dev.vars` (dotenv syntax) next to wrangler.jsonc, or `.env` (not both; `.dev.vars` wins). Per-env: `.dev.vars.<env>` replaces `.dev.vars` entirely; `.env.<env>` files merge. Gitignore `.dev.vars*` and `.env*`. Optional `"secrets": { "required": ["META_TOKEN", ...] }` in config: deploy fails if missing; only listed keys are loaded locally.
- Access: `env.X`, or `import { env } from "cloudflare:workers"` anywhere, or `process.env.X` (nodejs_compat).
- `npx wrangler dev`: local workerd at `http://localhost:8787`, runs with `TZ=UTC`; DO runs locally with local SQLite persistence (`--persist-to` dir); AI binding hits the real API. `--test-scheduled` exposes `/cdn-cgi/local/scheduled`. `--var k:v`, `--port`, `--local-protocol https`.
- `npx wrangler dev --remote` (docs now label it **Legacy**): code runs on Cloudflare, all bindings remote. Limit: 50 routes/zone. UNCONFIRMED: whether Durable Objects work inside `--remote` (the current local-development page does not say). Docs recommend local dev + per-binding `remote: true` instead; Durable Objects "currently will always run locally" (remote bindings are not supported for DO; may come later). AI always runs remotely regardless of mode.
- `npx wrangler tail [WORKER] --format pretty|json --status ok|error --search TEXT --sampling-rate N --ip self`: live JSON log stream incl. DO logs; max 10 concurrent tail clients; may enter sampling mode under high volume. Does not persist logs; Workers Logs (observability) does. Log data per request capped at 256 KB.

---

## 2. SQLite storage API in a DO

Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (updated 2026-09-21), https://developers.cloudflare.com/durable-objects/platform/limits/ (updated 2026-10-29), https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ (updated 2026-10-30), https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/.

### `exec`
```ts
this.ctx.storage.sql.exec<T>(query: string, ...bindings: any[]): SqlStorageCursor<T>
```
- `?` placeholders. **Multiple statements separated by `;` are allowed**; bindings apply only to the **last** statement; the returned cursor is for the last statement.
- Synchronous. Cannot run `BEGIN`/`SAVEPOINT`; use `ctx.storage.transactionSync(cb)` (sync callback, rolls back on throw) or `ctx.storage.transaction(async)`. Writes with no intervening `await` are coalesced into one atomic implicit transaction anyway.
- Returns `SqlStorageCursor`: Iterable + Iterator. `next()` -> `{done, value}`; `toArray()`; `one()` (throws unless exactly 1 row); `raw()` -> iterator of arrays (`next()`, `toArray()`); properties `columnNames: string[]`, `rowsRead: number`, `rowsWritten: number` (grow as you iterate; final values are billed).
- **Consume cursors synchronously** before any `await`: a cursor held across `await` has no snapshot isolation and may observe later uncommitted writes. Use `.toArray()` immediately.
- Supported extensions: FTS5 (+fts5vocab), JSON functions/operators, math functions. Full function list: https://github.com/cloudflare/workerd/blob/4c42a4a9d3390c88e9bd977091c9d3395a6cd665/src/workerd/util/sqlite.c%2B%2B#L269
- `ctx.storage.sql.databaseSize: number` (bytes).
- `RETURNING` works (rules page example: `INSERT ... RETURNING id` then `.one().id`).

### Types
- Column value type (from `@cloudflare/workers-types` 5.20261104.1 `index.d.ts`; the docs page does not spell it out): `type SqlStorageValue = ArrayBuffer | string | number | null`; `exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: any[]): SqlStorageCursor<T>`; `raw<U extends SqlStorageValue[]>()`. So **BLOB comes back as `ArrayBuffer`**, INTEGER/REAL as `number`, TEXT as `string`, NULL as `null`.
- Precision: "Any numeric value in a column is affected by JavaScript's 52-bit precision"; int64 beyond 2^53 silently loses precision (no BigInt option). Keep ids/timestamps within safe-integer range.
- Bindings accepted: docs give only `...bindings: any[]`. Safe set by the return-type symmetry: `null | number | string | ArrayBuffer`. **UNCONFIRMED**: whether typed arrays (`Uint8Array`) and booleans bind directly. Portable approach: bind BLOBs as `ArrayBuffer` (`u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)`), booleans as `0/1`, never `undefined`.

### Limits (SQLite-backed DO)
| Limit | Value |
|---|---|
| Max bound parameters per query | 100 |
| Max SQL statement length | 100 KB |
| Max string / BLOB / table row size | 2 MB |
| Max columns per table | 100 |
| Max args per SQL function | 32 |
| Max LIKE/GLOB pattern | 50 bytes |
| Storage per DO | 10 GB (Paid). FAQ on the same page says "1 GB on the Free plan"; table says 10 GB without plan split — treat Free per-object as **1 GB (conflicting docs)** |
| Storage per account | Unlimited (Paid) / 5 GB (Free) |
| KV key+value (ctx.storage.kv / put) | 2 MB combined |
| Rows per table | unlimited |
| DO classes per account | 500 Paid / 100 Free |

When full: writes fail with `database or disk is full: SQLITE_FULL`; reads and DELETEs still work.

### Billing counters (https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend)
- Each index update counts as an extra row written (stated on the sqlite-storage-api page, not the pricing page); deletes count as writes; `setAlarm()` = 1 row written; KV API (`get/put/delete/list`) stored in hidden table `__cf_kv`, billed as rows.
- Empty DB ~12 KB; metadata stays until `deleteAll()`.

### Migration pattern (recommended by docs)
Rules page "Initialize storage and run migrations in the constructor": run schema setup inside `ctx.blockConcurrencyWhile(async () => ...)` in the constructor; `CREATE TABLE IF NOT EXISTS` is the shown pattern. **`PRAGMA user_version` is not supported**; track versions in your own `_sql_schema_migrations(id INTEGER PRIMARY KEY, applied_at TEXT)` table, or use `durable-utils` / `@cloudflare/actors` storage utils (third-party/reference). Other PRAGMAs: **UNCONFIRMED** (avoid them so SQL stays portable to node:sqlite).

```ts
export class ContactAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.migrate(); }); // sync body is fine; 30 s timeout; throw => object reset
  }
  private migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    const v = sql.exec<{ version: number }>("SELECT COALESCE(MAX(id),0) AS version FROM _sql_schema_migrations").one().version;
    if (v < 1) sql.exec(`CREATE TABLE IF NOT EXISTS messages(...); CREATE INDEX IF NOT EXISTS ...; INSERT INTO _sql_schema_migrations(id) VALUES (1);`);
  }
}
```

`blockConcurrencyWhile`: blocks all other events until the callback resolves; 30 s deadlock timeout (object reset); exception => object terminated and reset (wrap in try/catch to avoid); docs: do not use per request, only init/migrations; never hold it across `fetch()`.

### Other storage calls
- `ctx.storage.deleteAll()` wipes SQL + KV data (atomic on SQLite backend) and, for compat date >= 2026-02-24, the alarm too. A DO ceases to exist only if storage is empty when it shuts down; after any write (incl. setAlarm) you must `deleteAll()` to stop storage billing.
- `ctx.storage.sync()` resolves when pending writes are on disk. `put()`/`delete()` support `allowUnconfirmed`, `noCache`.
- Sync KV: `ctx.storage.kv.get/put/delete/list` (structured-clone values).
- PITR: `getCurrentBookmark()`, `getBookmarkForTime(ts)`, `onNextSessionRestoreBookmark(bm)` + `ctx.abort()`; 30-day window. UNCONFIRMED: behaviour in local dev (docs do not say).

---

## 3. Alarms

Source: https://developers.cloudflare.com/durable-objects/api/alarms/ (updated 2026-04-21), sqlite-storage-api "Alarms" section, base-class page, pricing/limits pages.

- `ctx.storage.setAlarm(scheduledTime: Date | number, options?)`: ms since epoch or Date. **One alarm per object; calling again overrides.** Options same as `put()` minus `noCache` (`allowUnconfirmed`).
- `ctx.storage.getAlarm(options?)`: `Promise<number | null>`. While the `alarm()` handler is running it returns `null` unless `setAlarm` was called since the handler started.
- `ctx.storage.deleteAlarm()`: no-op if none; does not cancel a running handler; inside `alarm()` it "may prevent retries on a best-effort basis, but is not guaranteed".
- Handler: `async alarm(alarmInfo?: AlarmInvocationInfo)` with `{ retryCount: number, isRetry: boolean }`. Only one alarm can be *set* at a time; an `alarm()` handler can run concurrently with other requests/RPCs on the same object (state page, `abort` section), so it is subject to the same input-gate interleaving as any handler. The constructor runs before `alarm()` on a cold object, so a constructor that calls `setAlarm` must first check `getAlarm()`.
- **Past time**: "If `setAlarm()` is called with a time equal to or before `Date.now()`, the alarm will be scheduled for asynchronous execution in the immediate future." A running handler is not cancelled.
- **Precision**: "Alarms can be set to millisecond granularity and will usually execute within a few milliseconds after the set time, but can be delayed by up to a minute due to maintenance or failures while failover takes place." So a 3 s alarm fires at ~3 s normally; design must tolerate the rare +60 s.
- **Retries**: at-least-once; on uncaught exception, exponential backoff starting at 2 s, up to 6 retries; applies only to the most recent `setAlarm()`. Docs recommend catching errors in `alarm()` and re-scheduling yourself if you need indefinite retry; rules page: make handlers idempotent ("in rare cases, alarms may fire more than once").
- Wall time limit for an alarm invocation: **15 minutes**. CPU limit: same as request (30 s default, `limits.cpu_ms`).
- `ctx.abort()` during an alarm: alarm retries by default; `ctx.abort(msg, { retryAlarm: false })` to suppress.
- **Billing**: alarm invocations count as DO requests (pricing table: "Includes HTTP requests, RPC sessions, WebSocket messages, and alarm invocations"); each `setAlarm()` is one row written; the object is active (duration-billed) while the handler runs.
- Wrangler local dev and the vitest plugin run alarms locally.

Debounce pattern (official batching example https://developers.cloudflare.com/durable-objects/examples/alarms-api/ uses "set alarm only if none"; for burst-end detection you want "reset on every message"):

```ts
async ingest(msg: Inbound) {                // RPC from the Worker
  this.ctx.storage.sql.exec("INSERT INTO inbox(...) VALUES (?, ?, ?)", ...); // sync, coalesced
  await this.ctx.storage.setAlarm(Date.now() + QUIET_MS);                   // overrides previous alarm => debounce
}
async alarm() {
  const last = this.ctx.storage.sql.exec<{ t: number }>("SELECT MAX(received_at) t FROM inbox WHERE state='pending'").one().t;
  if (last && Date.now() - last < QUIET_MS) { await this.ctx.storage.setAlarm(last + QUIET_MS); return; } // late alarm or race
  // ...process batch; persist progress before each await; re-check for new rows after the LLM call
}
```

---

## 4. DO lifecycle facts for a 3–15 s "wait for the burst to end" timer

Source: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (updated 2026-10-30), https://developers.cloudflare.com/durable-objects/api/state/, https://developers.cloudflare.com/workers/runtime-apis/context/, limits pages.

- States: active -> idle (hibernatable or not) -> hibernated (after 10 s idle if hibernatable) -> inactive. Non-hibernatable idle objects are evicted after **70–140 s** of no requests/events.
- Hibernation requires: no pending `setTimeout`/`setInterval`, no unfinished I/O or `waitUntil` promise, no standard WebSocket API in use, no request still processing. **A pending `setTimeout` keeps the object in memory (and billed) and blocks hibernation.**
- "Pending operations prevent eviction": outbound `fetch()`, DO RPC calls, service-binding requests, `waitUntil` promises, pending `setTimeout`/`setInterval`, TCP sockets, outbound WebSockets — each for up to **15 minutes** from start (flag `durable_object_io_tasks_prevent_eviction`, default for dates >= 2026-10-01). So a DO is **not** evicted for idleness mid-`await fetch()`; it still **can be reset** by code deploys (`immediate`, or `deferred` after `max_delay`, default deferred 300 s), runtime updates, host moves, `blockConcurrencyWhile` timeout, or uncaught constructor errors. On reset, in-flight requests may finish only if they do not touch storage; a request that touches storage after reset "will be stopped immediately and return an error". No shutdown hooks. Therefore: in-memory timers are best-effort; **persist first, then `setAlarm`**, make the alarm idempotent.
- `ctx.waitUntil` in a DO: exists for API compatibility; "Do not use `waitUntil()` to keep a Durable Object alive during normal request or RPC handling" — the object already stays active while a request/RPC/stream/pending I/O is in flight. A `waitUntil` promise prevents eviction until settled or 15 min.
- Wall-clock: DO RPC/HTTP invocation — **unlimited while the caller stays connected**; alarm — 15 min. CPU: 30 s default per invocation (HTTP request, WebSocket message, or alarm), raise with `limits.cpu_ms` up to 300,000 (Paid). Each incoming request resets the remaining CPU budget to 30 s; burning >30 s CPU between requests raises eviction risk. **UNCONFIRMED**: whether Free-plan DO invocations get 10 ms CPU (Workers Free limit) or the 30 s DO default — the DO limits page says DOs "have the same per invocation CPU limits as any Workers do". Keep CPU per invocation tiny either way (LLM calls are I/O, not CPU).
- Input/output gates (docs glossary + rules page): **input gate** — while a storage op is executing, no other events are delivered (only storage completions); synchronous code never interleaves. `await fetch()` (or any non-storage I/O) **opens** the input gate: other RPCs/alarms can run in the middle. **Output gate** — outgoing network messages (responses, fetches) are held until pending storage writes are durable; if a write fails the object resets and callers get errors. Consequence for this app: while the LLM call is awaited, a new inbound message RPC can run and write to SQLite; use a check-and-set (e.g., `generation` counter / "new rows since I started") before sending the reply; `sql.exec` itself is synchronous and atomic.
- Debounce choice: **alarm** (durable, survives eviction/reset, fires at ~ms precision, counts as a request, 1 row written per set) over `setTimeout` (lost on reset, keeps object billed, blocks hibernation). Rules page: "Only schedule alarms when there is work to do." Overwriting the alarm on each message is one row written per message — negligible.
- Subrequests per invocation: Free 50, Paid 10,000 (configurable up to 10M); redirects count. Simultaneous outbound connections waiting for headers: 6 per invocation (7th queues). Outbound request body to external services from a DO: 100 MiB default.
- Outbound `fetch()` time limit: docs say "There is no set time limit on individual subrequests. As long as the client remains connected, the Worker can continue making subrequests." No documented idle/connect timeout. Hint only (community threads, not docs): users report fetches to slow origins failing around 60–100 s. For LLM calls, use streaming or keep single calls well under ~60 s. **UNCONFIRMED**: exact outbound idle timeout.
- Per-object throughput: soft limit ~1,000 req/s; overloaded errors carry `.overloaded = true` (do not retry). UNCONFIRMED: that "Your account is generating too much load on Durable Objects" (stub-creation rate) is safe to retry after backoff — the error-handling page only documents `.retryable` / `.overloaded` / `.remote`.

---

## 5. Worker -> DO: ids, stubs, RPC, fire-and-forget

Source: https://developers.cloudflare.com/durable-objects/api/namespace/, /api/stub/, /best-practices/create-durable-object-stubs-and-send-requests/, https://developers.cloudflare.com/workers/runtime-apis/rpc/ (updated 2026-10-12), /rpc/error-handling/, /best-practices/error-handling/.

```ts
import { DurableObject } from "cloudflare:workers";

export class ContactAgent extends DurableObject<Env> {
  async ingest(msg: { id: string; from: string; text: string; ts: number }): Promise<void> { /* ... */ }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const stub = env.CONTACT.getByName(waId);          // preferred shorthand; same as env.CONTACT.get(env.CONTACT.idFromName(waId))
    await stub.ingest(msg);                             // RPC; always await (rules page)
    return new Response("ok", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
```

- `idFromName(name)` is deterministic; first access of a named id does a global uniqueness check (up to a few hundred ms), cached afterwards. `newUniqueId()` skips it but must be stored. `get(id, { locationHint })` / `getByName(name, { locationHint })` return a stub immediately; the object is created lazily on first call. `jurisdiction("eu")` subnamespace exists.
- RPC: public methods on a class extending `DurableObject` are callable on the stub (compat date >= 2024-04-03). All calls are async on the client ("custom thenable"), support promise pipelining. E-order: calls on one stub arrive in order; no ordering across stubs. After a stub throws, it is broken; create a new stub (rules: build a new stub per attempt; retry only if `e.retryable`, never if `e.overloaded`; `e.remote === true` means thrown inside your DO code).
- Serialization: "Nearly all types that are Structured Cloneable" (objects, arrays, strings, numbers, Date, Map, Set, ArrayBuffer...), plus functions (become stubs), `RpcTarget` subclasses, `ReadableStream`/`WritableStream` (byte streams only), `Request`/`Response`, other stubs. **Application classes that do not extend `RpcTarget` cannot be passed** (unlike structured clone). Max serialized RPC message **32 MiB** (stream bigger). Errors propagate preserving `name`, `message`, serializable own props (incl. `cause`) with `enhanced_error_serialization` (default >= 2026-04-21); `instanceof` and original stack are not preserved. Use `using`/`Symbol.dispose` for returned stubs (not needed for plain return values).
- `fetch()` fallback: `stub.fetch(request | "http://do/path")` to the class's `async fetch(request)`; URL must be well-formed but need not resolve. Keep for HTTP-shaped flows only.
- Fire-and-forget from the Worker: `ctx.waitUntil(stub.ingest(msg))` then `return new Response("ok")` is allowed; the Worker's `waitUntil` budget is **30 s after the response is sent** (shared across all `waitUntil`s; cancelled with a logged warning after that). Docs discourage un-awaited RPC ("dangling promises, errors swallowed"). Recommended: make `ingest()` do only synchronous SQL + `setAlarm` (returns in ms) and `await` it before returning 200; move LLM/HTTP work to `alarm()`. Once the DO has received the RPC, its handler keeps running even if the Worker caller goes away (pending I/O keeps it alive up to 15 min), but you get no error signal in that case. Billing: each RPC method call = one DO request.
- Durable Objects are reachable only from Workers with a binding (never directly from the Internet).

---

## 6. Plans and limits (as of 2026-11-04)

Workers (https://developers.cloudflare.com/workers/platform/limits/ updated 2026-10-29; https://developers.cloudflare.com/workers/platform/pricing/ updated 2026-10-02):

| | Workers Free | Workers Paid ($5/mo min) |
|---|---|---|
| Requests | 100,000/day (Error 1027 beyond; reset 00:00 UTC) | 10M/month included, +$0.30/M |
| CPU per invocation | 10 ms | 30 s default, up to 5 min via `limits.cpu_ms`; 30M CPU-ms/month included, +$0.02/M |
| Memory per isolate | 128 MB | 128 MB |
| Subrequests per invocation | 50 | 10,000 (configurable to 10M) |
| Simultaneous outbound connections | 6 | 6 |
| Env vars (secrets+text) | 64/Worker, 5 KB each | 128/Worker, 5 KB each |
| Workers per account | 100 | 500 |
| Worker size | 64 MiB uncompressed | 64 MiB |
| Startup | 1 s | 1 s |
| Duration | HTTP unlimited while client connected; `waitUntil` +30 s; cron/queue/DO alarm 15 min | same |

Durable Objects (https://developers.cloudflare.com/durable-objects/platform/pricing/ updated 2026-10-18): **SQLite-backed DOs are available on the Free plan** (KV-backed are not).

| | Free | Paid |
|---|---|---|
| DO requests (HTTP, RPC sessions, WS msgs @20:1, alarms) | 100,000/day | 1M/month, +$0.15/M |
| Duration (active or idle-non-hibernatable, 128 MB charged) | 13,000 GB-s/day | 400,000 GB-s/month, +$12.50/M GB-s |
| SQL rows read | 5M/day | 25B/month, +$0.001/M |
| SQL rows written | 100,000/day | 50M/month, +$1.00/M |
| SQL stored data | 5 GB total | 5 GB-month, +$0.20/GB-month |
| Storage per object | 1 GB (FAQ) / 10 GB (table) — conflicting | 10 GB |

On Free, exceeding any daily limit makes that operation type fail with an error until 00:00 UTC. SQLite storage billing started January 2026.

Workers AI (https://developers.cloudflare.com/workers-ai/platform/pricing/ updated 2026-10-20; limits updated 2026-09-17): $0.011 per 1,000 Neurons; **10,000 Neurons/day free on both Free and Paid**; Free plan cannot exceed it (upgrade required). `@cf/baai/bge-m3`: $0.012 per M input tokens = 1,075 neurons/M tokens. `@cf/openai/whisper-large-v3-turbo`: $0.0005 per audio minute = 46.63 neurons/min. Rate limits: text embeddings 3,000 req/min; automatic speech recognition 720 req/min. Local dev inference counts. Rough free budget: 10,000 neurons/day ≈ 9.3M bge-m3 tokens or ≈ 214 minutes of Whisper per day.

---

## 7. Node 24 `node:sqlite` and the shared adapter

Source: https://nodejs.org/docs/latest-v24.x/api/sqlite.html (v24.x docs), local verification on node v24.18.0.

- Stability: **1.2 Release candidate** (RC since v24.15.0; unflagged since v22.13/23.4). On v24.18.0 **no ExperimentalWarning is printed** when importing/using it (verified). Import only via the `node:` scheme: `import { DatabaseSync } from 'node:sqlite'`.
- `new DatabaseSync(path, options?)`; `':memory:'` for in-memory. Options: `readOnly`, `enableForeignKeyConstraints` (default true), `enableDoubleQuotedStringLiterals` (default false; SQL must use single quotes for strings — same as DO), `timeout` (busy ms, default 0), `readBigInts` (default false), `returnArrays`, `defensive` (default true since v24.14), `limits`.
- `db.exec(sql)`: one or more statements, no results (sqlite3_exec). `db.prepare(sql)` compiles **one** statement (verified: `"select 1 as a; select 2 as b"` returns only `{a:1}`); throws if no statements (v24.21+). `stmt.all(...params)` -> array of row objects; `stmt.get(...)` -> first row or `undefined`; `stmt.run(...)` -> `{ changes, lastInsertRowid }`; `stmt.iterate(...)`; `stmt.close()`/`using`. Positional `?` / `?NNN` and named `$x :x @x` params. Rows are **null-prototype objects** keyed by column name (`[Object: null prototype]`).
- Type mapping (docs table): JS -> SQLite: `null`; `number|bigint|boolean` -> INTEGER (boolean binding added **v24.21.0**; on v24.18.0 `true` throws `ERR_INVALID_ARG_TYPE` — bind `0/1`); `number` -> REAL; `string` -> TEXT; `TypedArray|DataView|ArrayBuffer|SharedArrayBuffer` -> BLOB (ArrayBuffer binding added v24.21.0; verified on 24.18.0: a lone `ArrayBuffer` argument is mistaken for the named-parameters object and the `?` is silently left NULL, while an `ArrayBuffer` in a later position throws `ERR_INVALID_ARG_TYPE`; `Uint8Array` works on 24.18). SQLite -> JS: INTEGER -> `number` (or `bigint` with `readBigInts`); out-of-safe-range INTEGER **throws `ERR_OUT_OF_RANGE`** unless `readBigInts`; REAL -> `number`; TEXT -> `string`; **BLOB -> `Uint8Array`**. `undefined`/objects are rejected with `ERR_INVALID_ARG_TYPE`.
- Verified locally (24.18.0): `sqlite_version()` = **3.53.1**; JSON functions (`json_extract`, `json_object`) available; `RETURNING` works via `prepare(...).get()`; FTS5 available. workerd `main` bundles **sqlite3 3.53.4** (MODULE.bazel downloads `sqlite-src-3530400.zip` and reuses the BCR 3.53.3 build file, plus Cloudflare patches). **UNCONFIRMED**: SQLite version in node v24.22.2 and in production workerd at any given day; both are >= 3.35 (RETURNING) and >= 3.38 (built-in JSON), so no dialect gap for this app.
- Node 24 runs `.ts` files directly (type stripping; verified `node t.ts` works on 24.18.0) for erasable syntax only; `tsx` 4.23.15 remains the drop-in if you use enums/decorators/paths.

### Adapter (~15 lines)

Differences to absorb:
| | DO `ctx.storage.sql` | `node:sqlite` |
|---|---|---|
| Call shape | `exec(sql, ...params)` returns cursor (`toArray()`, `one()`) | `prepare(sql).all/get/run(...params)`; `exec(sql)` for DDL batches |
| Multi-statement | allowed in `exec` (bindings -> last stmt) | `exec()` only; `prepare()` compiles first stmt |
| BLOB read | `ArrayBuffer` | `Uint8Array` |
| Big ints | silently imprecise > 2^53 | throws `ERR_OUT_OF_RANGE` |
| Booleans | UNCONFIRMED as bind | v24.21+ only |
| Transactions | `transactionSync(cb)`; no BEGIN in exec | `BEGIN/COMMIT` via `exec` works |
| PRAGMA | `user_version` unsupported; others UNCONFIRMED | all |

```ts
export type Row = Record<string, string | number | null | Uint8Array>;
export interface Db {
  all<T = Row>(sql: string, ...p: (string | number | null | Uint8Array)[]): T[];
  run(sql: string, ...p: (string | number | null | Uint8Array)[]): void;
  batch(sql: string): void;                       // multi-statement DDL/migrations, no params
}
const toU8 = (r: Row) => { for (const k in r) if (r[k] instanceof ArrayBuffer) r[k] = new Uint8Array(r[k] as ArrayBuffer); return r; };
export const fromDO = (sql: SqlStorage): Db => ({
  all: (q, ...p) => sql.exec(q, ...p.map(v => v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v)).toArray().map(toU8) as any,
  run: (q, ...p) => { sql.exec(q, ...p.map(v => v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v)); },
  batch: (q) => { sql.exec(q); },
});
export const fromNode = (db: import("node:sqlite").DatabaseSync): Db => ({
  all: (q, ...p) => db.prepare(q).all(...p) as any,
  run: (q, ...p) => { db.prepare(q).run(...p); },
  batch: (q) => db.exec(q),
});
```
Rules for shared SQL: only `?` placeholders (<=100), single-quoted string literals, no PRAGMA, no BEGIN/COMMIT inside `run`, booleans as 0/1, ms timestamps as INTEGER, embeddings as BLOB (`Float32Array` bytes) or JSON text, `RETURNING` ok, `json_*` ok, FTS5 ok, keep statements < 100 KB and rows < 2 MB.

---

## 8. `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`) in one paragraph

Source: https://developers.cloudflare.com/workers/testing/vitest-integration/ (+ /configuration, /test-apis updated 2026-10-10, /known-issues updated 2026-08-20, /isolation-and-concurrency updated 2026-10-12).

Config is `defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })] })` from `@cloudflare/vitest-plugin` (1.5.1; peer vitest ^4.1 || ^5.0 — the old `@cloudflare/vitest-pool-workers` 0.23.0 only supports vitest ^4.1, so with vitest 5 use the plugin). Tests run inside workerd via Miniflare with **real SQLite-backed Durable Objects** (`env.CONTACT.getByName(...)`, RPC on stubs works, `runInDurableObject(stub, (instance, state) => ...)` reaches `state.storage.sql`), per-test-file storage isolation, and `runDurableObjectAlarm(stub)` which "immediately runs and removes" a scheduled alarm (returns `true` if one ran) regardless of its scheduled time; `evictDurableObject`, `abortAllDurableObjects`, `reset()`, `listDurableObjectIds` also exist. What it cannot do: drive the runtime clock — known issues: "Vitest's fake timers do not apply to KV, R2 and cache simulators"; nothing lets you advance workerd's alarm scheduler or storage time by days, so "jump 3 days and let the alarm fire" is not possible — you can only force-fire the alarm and mock `Date` (the `main` Worker is documented to run "in the same isolate/context as tests", so `vi.useFakeTimers`/`vi.setSystemTime` should reach your code; **UNCONFIRMED**: the docs never say `vi` time mocks apply inside DO handlers, and no run verified it). It also auto-injects `nodejs_compat` + `no_nodejs_compat_v2` + `export_commonjs_default`, cannot use dynamic `import()` inside DO handlers, has no V8 coverage (Istanbul only), and needs `--max-workers=1 --no-isolate` for DO WebSockets. Conclusion: confirmed — keep the cadence/memory core as plain functions over the `Db` adapter and test them in Node with vitest fake timers; use the plugin only for a thin smoke test of the real DO (schema creation, `ingest` + `runDurableObjectAlarm`).

---

## 9. Vitest / tsx for the Node eval harness

- Current Vitest major: **5** (5.1.0 on npm today; `engines: node ^22.12.0 || ^24.0.0 || >=26.0.0`). `@cloudflare/vitest-plugin` 1.5.1 supports it.
- Minimal `vitest.config.ts` for plain Node TS tests (TypeScript is transpiled by Vite/esbuild, no tsx needed):

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["evals/**/*.test.ts"], environment: "node" },
});
```
Run: `npx vitest run` (one shot) / `npx vitest` (watch). Keep the Workers-plugin tests in a separate config or Vitest project so `cloudflareTest` does not wrap the Node evals.

- Fake clock (vitest `vi` API, from the vitest docs via context7): `vi.useFakeTimers({ now: new Date("2026-11-04T09:00:00Z") })` wraps `setTimeout/setInterval/setImmediate/Date`; `vi.setSystemTime(date)` moves `Date.now()`/`new Date()` without firing timers (5.1 also accepts `Temporal.Instant`/`Temporal.ZonedDateTime` arguments); `await vi.advanceTimersByTimeAsync(ms)` runs pending timers; `vi.useRealTimers()` restores (mocked time does not reset between tests within a file; 5.1.0 resets fake timers after each test file). Vitest 5.1.0 adds fake timers for `node:timers` / `node:timers/promises` (release notes); the switch is `vi.useFakeTimers({ fakeNodeBuiltins: true })` per `packages/vitest/src/integrations/mock/timers.ts`, not yet in the published docs — verify at use. Because our core takes `now()` and `scheduleAlarm(at)` through the adapter, the eval harness can simply pass a fake clock object and call the alarm function directly — no vitest timer mocking required.
- Scripts: `tsx 4.23.15` (`npx tsx scripts/run-evals.ts`), or `node scripts/run-evals.ts` directly on Node 24 (type stripping; erasable syntax only).

---

## Verification (2026-11-04)

Checked ~150 concrete claims (versions, config keys and defaults, compat-flag dates, limits, prices, API signatures, error codes, documented behaviours) against the cited `index.md` pages, the npm registry, the nodejs.org v24 docs, the workerd/workers-sdk/vitest repos and local runs on node v24.18.0. Everything not listed below was confirmed as written.

Corrections (before -> after (source)):
- workerd bundles sqlite3 3.53.3 -> 3.53.4 (`sqlite-src-3530400.zip`, BCR 3.53.3 build file) (https://github.com/cloudflare/workerd/blob/main/MODULE.bazel)
- Worker name "<=63 chars, [a-z0-9-], no leading/trailing dash" -> alphanumeric + dashes up to 255; the 63-char / no-edge-dash rule applies only to workers.dev (https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys)
- "For new Workers, prefer `exports`" attributed to the migrations page -> it is on the wrangler configuration page, `migrations` entry (https://developers.cloudflare.com/workers/wrangler/configuration/#migrations)
- UNCONFIRMED minimum wrangler for `exports` -> 4.107.0 (https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)
- Workers Logs Paid "20M/month included, 7 days" -> added "+$0.60/M after" (https://developers.cloudflare.com/workers/platform/pricing/#workers-logs)
- `enable_ctx_exports` had no date -> default as of 2025-11-17 (https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- `wrangler secret bulk` -> added: omit FILE to read stdin; `null` deletion only in JSON, not `.env` (https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk)
- `wrangler dev --remote` "DO supported" and "`remote: true` on a DO binding errors" -> mode is labelled Legacy; DO bindings "currently will always run locally"; DO-inside-`--remote` marked UNCONFIRMED (https://developers.cloudflare.com/workers/local-development/)
- `SqlStorageValue` sourced to "docs, TypeScript section" -> it comes from `@cloudflare/workers-types` `index.d.ts` (npm tarball 5.20261104.1); docs page has no such section (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- "index update = extra row written" cited to the pricing page -> it is on the sqlite-storage-api page (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- PITR "not in local dev" -> UNCONFIRMED (not stated) (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
- "Only one `alarm()` runs at a time per object" -> not documented; replaced with "one alarm set at a time; a running alarm can overlap other requests" (https://developers.cloudflare.com/durable-objects/api/alarms/, https://developers.cloudflare.com/durable-objects/api/state/#abort)
- "too much load" error "safe to retry after backoff" -> UNCONFIRMED (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
- node:sqlite "ArrayBuffer binding added v24.21.0" -> kept, plus verified pitfall: on 24.18.0 a lone `ArrayBuffer` is treated as the named-parameter object and binds NULL silently; later positions throw `ERR_INVALID_ARG_TYPE` (local run; https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- `vi.setSystemTime` "(and `Temporal.Now`)" -> removed; docs only say Temporal values are accepted as arguments (https://github.com/vitest-dev/vitest/blob/main/docs/api/vi.md)
- "Vitest 5.1 adds `fakeNodeBuiltins`" -> option exists only in source (`packages/vitest/src/integrations/mock/timers.ts`) and the 5.1.0 release note ("fake timers for node:timers and node:timers/promise"); not in published docs. Added: 5.1.0 resets fake timers after each test file (https://github.com/vitest-dev/vitest/releases/tag/v5.1.0)
- vitest-plugin "`vi` mocks are documented to apply to the main Worker" -> softened to "runs in the same isolate/context as tests" (https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)

Also re-verified locally on node v24.18.0: `sqlite_version()` 3.53.1, null-prototype rows, `prepare()` compiles only the first statement, `prepare('')` does not throw (<24.21), boolean bind throws `ERR_INVALID_ARG_TYPE`, out-of-range INTEGER throws `ERR_OUT_OF_RANGE`, BLOB reads as `Uint8Array`, `RETURNING`/FTS5/JSON work, `node t.ts` runs with no ExperimentalWarning.

Still UNCONFIRMED:
- Whether typed arrays / booleans bind directly in `ctx.storage.sql.exec` (types say `any[]`).
- PRAGMAs other than `user_version` inside Durable Objects.
- Free-plan Durable Object CPU per invocation (10 ms Workers Free vs 30 s DO default).
- Exact outbound `fetch()` idle/connect timeout from a Worker/DO.
- SQLite version in node v24.22.2 and in production workerd on a given day.
- `vi.useFakeTimers`/`vi.setSystemTime` reaching DO code paths under `@cloudflare/vitest-plugin`.
- PITR API behaviour in local dev.
- Durable Object support inside legacy `wrangler dev --remote`.
- Retry safety of the account-level "too much load on Durable Objects" error.
