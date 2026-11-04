# Cloudflare Browser Rendering (now "Browser Run") REST API: /screenshot and /markdown

Researched 2026-11-04 from developers.cloudflare.com (pages dated Sep 26 - Oct 30, 2026), the Cloudflare API reference, and the OpenAPI schema at github.com/cloudflare/api-schemas (main). Live probes against api.cloudflare.com on 2026-11-04 are marked "(probe)".

## 0. Naming: read this first

- The product was renamed **Browser Run (formerly Browser Rendering)**. The REST API is now called **Quick Actions**. Old doc URLs `developers.cloudflare.com/browser-rendering/...` 301 to `developers.cloudflare.com/browser-run/...`. Docs index: https://developers.cloudflare.com/browser-run/llms.txt
- Two path segments exist for the same API:
  - `/accounts/{account_id}/browser-run/<action>` (product docs, e.g. https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
  - `/accounts/{account_id}/browser-rendering/<action>` (API reference https://developers.cloudflare.com/api/resources/browser_rendering/ and the OpenAPI schema; also still used in the get-started page)
  - (probe) Both return the identical `401 {"code":10000,"message":"Authentication error"}` without a token, but so do `/browser-rendering/bogus` and `/browser-run/bogus` (an unknown product prefix gives `404 {"code":10404,"message":"No route for that URI"}`), so the 401 only proves both prefixes are recognised, not that every action routes under both. Every current product doc page uses `/browser-run/`; the OpenAPI schema (no `deprecated` flag), the `cloudflare` SDK and the get-started page (updated Oct 15, 2026) use `/browser-rendering/`. UNCONFIRMED: whether `/browser-rendering/` has a sunset date. Recommendation: use `/browser-rendering/` and keep the segment in one constant.
- Default browser is Chrome 152 since 2026-10-30 (https://developers.cloudflare.com/browser-run/changelog/).

## 1. Endpoints, auth, enablement

Base: `https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/` (or `.../browser-run/`). All `POST`, `Content-Type: application/json`.

| Action | Returns | Doc |
| --- | --- | --- |
| `screenshot` | image binary (png/jpeg/webp) or base64 | https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/ |
| `markdown` | `{success, result: "<md>", meta}` | https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/ |
| `content` | `{success, result: "<html>", meta}` rendered HTML string | https://developers.cloudflare.com/browser-run/quick-actions/content-endpoint/ |
| `pdf` | PDF binary; request body cap 50 MB (`Error: request entity too large`); `pdfOptions{...}` | https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/ |
| `snapshot` | `{success, result:{content?, screenshot?(base64), markdown?, accessibilityTree?}, meta}`; `formats` = at least two of `"content" "screenshot" "markdown" "accessibilityTree"`, default `["content","screenshot"]` | https://developers.cloudflare.com/browser-run/quick-actions/snapshot/ |
| `scrape` | `{success, result:[{selector, results:[{text, html, attributes:[{name,value}], top,left,width,height}]}]}`; body `elements:[{selector}]` | https://developers.cloudflare.com/browser-run/quick-actions/scrape-endpoint/ |
| `json` | `{success, result:{...}}` LLM extraction via `prompt` / `response_format`; `custom_ai`; errors carry `rawAiResponse` | https://developers.cloudflare.com/browser-run/quick-actions/json-endpoint/ |
| `links` | `{success, result:["https://..."]}` absolute URLs; `excludeExternalLinks` | https://developers.cloudflare.com/browser-run/quick-actions/links-endpoint/ |
| `accessibilityTree` | `{success, result:{accessibilityTree:{role,name,children...}}, meta}` | https://developers.cloudflare.com/browser-run/quick-actions/accessibility-tree-endpoint/ |
| `crawl` | async job: `{success, result:"<job_id>"}`, then `GET .../crawl/{job_id}`; REST only; results stored 14 days | https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/ |

**Auth** (https://developers.cloudflare.com/browser-run/quick-actions/#before-you-begin):
- Header `Authorization: Bearer <API token>` (API-token scheme preferred; `X-Auth-Email` + `X-Auth-Key` global key also accepted per API reference).
- Token permission name in the dashboard: **`Browser Run - Edit`** (pages updated Sep 2026). The get-started page (updated Oct 15, 2026) still says **`Browser Rendering - Edit`**; the OpenAPI `x-api-token-group` is `Browser Rendering Write`, internal scope `com.cloudflare.api.account.brapi.read`. These are the same permission under different labels. UNCONFIRMED: the exact label shown in the token-creation UI today; the fundamentals permissions reference page (https://developers.cloudflare.com/fundamentals/api/reference/permissions/) does not list it at all. If unsure, list permission groups via `GET /user/tokens/permission_groups` and grep for "Browser".
- Token scope: Account > the account whose id is in the URL.
- **No enablement step.** Prereqs are "a Cloudflare account" and the token (https://developers.cloudflare.com/browser-run/get-started/#prerequisites). OpenAPI `x-cfPlanAvailability`: free, pro, business, enterprise all `true`. Limits follow the account's **Workers plan** (Free vs Paid), see section 4.

**Query parameters** (both endpoints, https://developers.cloudflare.com/api/resources/browser_rendering/subresources/screenshot/methods/create/):
- `cacheTTL` (number, default `5`, min `0`, max `86400`): server-side cache of generated output for the same URL by the same account, seconds. Set `?cacheTTL=0` for fresh renders. Submitted `html` is never cached (FAQ, Security section).
- `browser=kitesurf`: opt into the Kitesurf (beta, free) stateless renderer (https://developers.cloudflare.com/browser-run/kitesurf/); no video/WebGL, no bot-challenge handshake. Not needed.

## 2. /screenshot

`POST .../browser-rendering/screenshot[?cacheTTL=0]`

Request body (OpenAPI schema; `additionalProperties: false`, so unknown keys are rejected; exactly one of `url` / `html` is required):

```jsonc
{
  "url": "https://example.com/",          // string, format uri. XOR with html
  "html": "<h1>Hello</h1>",               // string, minLength 1. XOR with url
  "viewport": {                           // default {"width":1920,"height":1080}
    "width": 390, "height": 844,          // required numbers when viewport is given
    "deviceScaleFactor": 2,               // default 1
    "isMobile": true, "hasTouch": true, "isLandscape": false
  },
  "screenshotOptions": {                  // default {}
    "fullPage": false,
    "type": "jpeg",                       // "png" (default) | "jpeg" | "webp"
    "quality": 80,                        // ONLY with jpeg/webp; with png => 400
    "omitBackground": false,
    "captureBeyondViewport": false,
    "clip": { "x": 0, "y": 0, "width": 390, "height": 844, "scale": 1 },
    "encoding": "binary",                 // "binary" (default) | "base64"
    "fromSurface": true,
    "optimizeForSpeed": false
  },
  "selector": "#main",                    // screenshot only this element
  "scrollPage": false,                    // boolean (undocumented beyond the name)
  "gotoOptions": {                        // default {}
    "waitUntil": "networkidle2",          // "load"|"domcontentloaded"(default)|"networkidle0"|"networkidle2" or array of these
    "timeout": 30000,                     // default 30000, max 60000 (ms)
    "referer": "", "referrerPolicy": ""
  },
  "waitForSelector": { "selector": "main", "visible": true, "timeout": 10000 }, // visible/hidden accept only true, use one; timeout max 120000 in schema, 60 s per timeouts page
  "waitForTimeout": 1000,                 // ms, max 120000 in schema, 60 s per timeouts page
  "actionTimeout": 30000,                 // ms after load for the capture itself; max 120000 in schema, "5 min" per timeouts page
  "bestAttempt": true,                    // proceed when awaited events fail/time out
  "userAgent": "Mozilla/5.0 (...)",       // default: Chrome 152 Windows UA (see below)
  "setExtraHTTPHeaders": { "Accept-Language": "en" }, // map[string]string
  "setJavaScriptEnabled": true,
  "emulateMediaType": "screen",           // string ("screen" | "print" in Puppeteer)
  "authenticate": { "username": "u", "password": "p" }, // HTTP basic, both minLength 1
  "cookies": [ { "name": "sid", "value": "x", "domain": "example.com", "path": "/", "secure": true, "httpOnly": true,
                 "expires": 0, "sameSite": "Lax", "priority": "Medium", "sameParty": false,
                 "sourceScheme": "Secure", "sourcePort": 443, "partitionKey": "", "url": "" } ], // only name+value required
  "rejectResourceTypes": ["image","media","font"],  // enum: document stylesheet image media font script texttrack xhr fetch prefetch eventsource websocket manifest signedexchange ping cspviolationreport preflight other
  "rejectRequestPattern": ["/^.*\\.(css)/"],         // regex strings
  "allowResourceTypes": ["document","script"],       // reject rules are applied first
  "allowRequestPattern": ["/^https:\\/\\/example\\.com/"],
  "addStyleTag": [ { "content": "body{background:#fff}" }, { "url": "https://.../x.css" } ],
  "addScriptTag": [ { "content": "..." }, { "url": "https://.../x.js", "id": "", "type": "module" } ]
}
```

Defaults (OpenAPI + https://developers.cloudflare.com/browser-run/reference/timeouts/): viewport 1920x1080 (raised from 800x600 on 2025-07-29), `deviceScaleFactor` 1, `type` png, `encoding` binary, `gotoOptions.timeout` 30000, `waitUntil` domcontentloaded, `waitForSelector`/`waitForTimeout`/`actionTimeout` null.

Default User-Agent (https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/):
`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`
The docs give **no mobile UA string and no mobile viewport example**. `isMobile`/`hasTouch` follow Puppeteer `page.setViewport` semantics (docs link to https://pptr.dev/api/puppeteer.page.setviewport). UNCONFIRMED: a Cloudflare-recommended mobile viewport; 390x844 @ `deviceScaleFactor` 2, `isMobile: true`, `hasTouch: true` is Puppeteer's iPhone-class preset, not a Cloudflare recommendation. Setting `userAgent` to an iPhone string does not bypass bot protection; requests are always flagged as bots (bot detection ID `119853733`) and carry non-removable headers `cf-brapi-request-id`, `cf-biso-devtools`, `Signature-agent`, `Signature`, `Signature-input`.

Response:
- `200`, body = raw image bytes. OpenAPI lists response content types `image/png` ("PNG binary"), `image/jpg` ("JPEG binary"), `image/webp` ("WebP binary"), and `text/plain` ("Base64 encoded") when `screenshotOptions.encoding = "base64"`. UNCONFIRMED: whether the live header is `image/jpg` (as the schema literally says) or `image/jpeg`; do not branch on it, branch on your own `type`.
- Every Quick Actions response carries `X-Browser-Ms-Used: <ms>` (browser time billed for that request).
- Non-200: JSON `{"success": false, "errors": [{"code": <number>, "message": "<string>"}]}`; see section 6.
- No documented cap on viewport size, output pixel size or image bytes. The blurry-screenshot example uses viewport 3600x2400 with `deviceScaleFactor: 2` without comment. UNCONFIRMED: any max. Blurry output at large viewports is fixed by raising `deviceScaleFactor` (docs).

Gotchas (from docs): `quality` with the default png returns **400**. Default `domcontentloaded` captures SPAs half-rendered; use `waitUntil: "networkidle2"` (or `networkidle0`) or `waitForSelector`. A `waitForSelector` that never appears fails the request (fixed 2026-01-07) unless `bestAttempt: true`.

## 3. /markdown

`POST .../browser-rendering/markdown[?cacheTTL=0]`

Request body: same schema as /screenshot **minus** `screenshotOptions`, `selector`, `scrollPage` (OpenAPI: 20 props vs 23). Same `url` XOR `html`, `additionalProperties: false`. Useful subset:

```json
{
  "url": "https://example.com",
  "gotoOptions": { "waitUntil": "networkidle2", "timeout": 20000 },
  "rejectResourceTypes": ["image", "media", "font", "stylesheet"],
  "rejectRequestPattern": ["/^.*\\.(css)/"],
  "waitForSelector": { "selector": "article", "timeout": 5000 },
  "bestAttempt": true,
  "userAgent": "...", "setExtraHTTPHeaders": {}, "cookies": [], "authenticate": {},
  "setJavaScriptEnabled": true, "viewport": {}, "emulateMediaType": "screen",
  "addScriptTag": [], "addStyleTag": [], "allowRequestPattern": [], "allowResourceTypes": [],
  "waitForTimeout": 0, "actionTimeout": 30000
}
```

Response `200` (API reference https://developers.cloudflare.com/api/resources/browser_rendering/subresources/markdown/methods/create/):

```json
{
  "success": true,
  "result": "# Example Domain\n\nThis domain is for use in illustrative examples in documents. ...\n\n[More information...](https://www.iana.org/domains/example)",
  "meta": {
    "finalUrl": "https://example.com/",
    "status": 200,
    "title": "Example Domain",
    "headers": { "content-type": "text/html; charset=UTF-8" },
    "redirectChain": [ { "url": "http://example.com/", "status": 301, "headers": { "location": "https://example.com/" } } ]
  },
  "errors": []
}
```

- `result`: "Markdown content. Prefixed with YAML frontmatter (e.g. `title`) when the page provides that metadata." So `result` may start with `---\ntitle: ...\n---\n`; strip or keep deliberately. The `html` input example returns plain `"Hello World"` (no frontmatter).
- `meta.headers`: origin response headers, lowercased, repeated headers newline-joined, credential/transport headers omitted. `meta.redirectChain`: omitted on direct navigation; `[]` means redirects happened but could not be read. `meta.status`: origin HTTP status (use it to detect 404/403/challenge pages that still render "successfully").
- Code blocks keep their language tag since 2026-10-30.
- **No readability / main-content option.** The doc lists "Strip styling/scripts and keep readable content + links" as a use case, but there is no `readability`, `onlyMainContent` or similar parameter and no statement about removing nav/footer boilerplate. UNCONFIRMED: whether nav/boilerplate is stripped; assume the whole `<body>` is converted and budget tokens accordingly. `rejectResourceTypes`/`rejectRequestPattern` only block network fetches; they do not remove DOM.
- Typical size: not documented. UNCONFIRMED. No documented max response size (Workers response body size is "No enforced limit").
- Alternatives named in the doc: Workers AI `env.AI.toMarkdown()` (https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) for documents you already hold, and "Markdown for Agents" content negotiation for Cloudflare-proxied zones.

### One call for both: /snapshot

`POST .../browser-rendering/snapshot` with `{"url": "...", "formats": ["screenshot","markdown"], "screenshotOptions": {...}, "viewport": {...}, "gotoOptions": {...}}` returns
`{"success": true, "result": {"screenshot": "<base64 png>", "markdown": "..."}, "meta": {"status": 200, "title": "..."}}` (https://developers.cloudflare.com/browser-run/quick-actions/snapshot/). One page load, one rate-limit slot, one browser-time charge instead of two. `formats` must list at least two values. Screenshot comes back base64 inside JSON (decode before uploading to WhatsApp).

## 4. Limits and pricing (as of 2026-11-04)

Limits https://developers.cloudflare.com/browser-run/limits/ (updated Oct 14, 2026); pricing https://developers.cloudflare.com/browser-run/pricing/ (Apr 21, 2026). Limits key off the account's **Workers plan**.

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Browser hours | **10 minutes per day** (resets per UTC day) | **10 hours / month included, then $0.09 per hour** |
| Quick Actions request rate | **1 request every 10 seconds** | **30 requests per second** |
| Browser timeout (inactivity) | 60 s | 60 s (Browser Sessions can extend to 20 min with `keep_alive`; n/a for Quick Actions) |
| Concurrent browsers | 3 (Browser Sessions only) | 200 default (Browser Sessions only); 10 included then $2.00 per extra browser, averaged monthly |
| /crawl | 5 jobs/day, 100 pages/crawl | higher |

- Quick Actions are billed **browser hours only**; concurrency pricing applies only to Puppeteer/Playwright/CDP sessions.
- Billing rounds the **monthly** total to the nearest whole hour (1,800 s rounds up). A free account doing e.g. 20 renders of ~5 s each per day is well inside 10 min/day.
- Requests that fail with a `waitForTimeout` error are not charged.
- Per-request wall time: `gotoOptions.timeout` max 60 s, plus wait timers, plus `actionTimeout`. There is no single documented "60 s per request" cap for Quick Actions; the 60 s figure in the limits table is browser inactivity. Timer table (https://developers.cloudflare.com/browser-run/reference/timeouts/): `goToOptions.timeout` default 30 s max 60 s; `waitForSelector` max 60 s; `waitForTimeout` max 60 s; `actionTimeout` max 5 min; `PDFOptions.timeout` default 30 s max 5 min. The OpenAPI schema instead says `maximum: 120000` for `waitForSelector.timeout`, `waitForTimeout`, `actionTimeout`. UNCONFIRMED which is enforced; stay at or below 60 000 ms for all three to be safe.
- Separate, cumulative Cloudflare API limit: **1,200 requests per 5 minutes per user/account token**, 200/s per IP (https://developers.cloudflare.com/fundamentals/api/reference/limits/). Responses carry `Ratelimit`, `Ratelimit-Policy`, and on 429 `retry-after`.
- Max response size: not documented for Quick Actions. UNCONFIRMED.
- Local dev (`wrangler dev` without `--remote`) rejects requests larger than 1 MB; irrelevant for the REST path.
- Need more: Paid-plan limit increases via form https://forms.gle/CdueDKvb26mTaepa9. After upgrading Free to Paid, redeploy the Worker or the 10-min/day limit may persist.

## 5. Calling it

### From a Worker / Durable Object with plain `fetch` (our design)

No restriction: `api.cloudflare.com` is an ordinary outbound subrequest. Counts against subrequests per invocation (50 Free / 10,000 Paid, https://developers.cloudflare.com/workers/platform/limits/#subrequests); waiting on it does not consume CPU time. Put the token in a secret (`wrangler secret put CF_API_TOKEN`) and the account id in a var.

```ts
// shared by Worker/DO and the Node eval harness (Node >= 21 has stable global fetch: https://nodejs.org/api/globals.html#fetch)
type BrErr = { success: false; errors: { code: number; message: string }[] };

const BR = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;

async function brPost(env: { CF_ACCOUNT_ID: string; CF_API_TOKEN: string }, action: string, body: unknown, cacheTTL = 0) {
  const res = await fetch(`${BR(env.CF_ACCOUNT_ID)}/${action}?cacheTTL=${cacheTTL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const msUsed = Number(res.headers.get("X-Browser-Ms-Used") ?? 0); // billable browser ms
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 0);   // seconds, set on 429
    const err = (await res.json().catch(() => null)) as BrErr | null;
    throw Object.assign(new Error(err?.errors?.[0]?.message ?? `browser-rendering ${res.status}`),
      { status: res.status, code: err?.errors?.[0]?.code, retryAfter, msUsed });
  }
  return { res, msUsed };
}

export async function screenshot(env, url: string): Promise<Uint8Array> {
  const { res } = await brPost(env, "screenshot", {
    url,
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    screenshotOptions: { type: "jpeg", quality: 80 },           // never quality with png
    gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
    rejectResourceTypes: ["media"],
    bestAttempt: true,
  });
  return new Uint8Array(await res.arrayBuffer());               // content-type image/jpeg (schema says image/jpg)
}

export async function markdown(env, url: string) {
  const { res } = await brPost(env, "markdown", {
    url,
    gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
    rejectResourceTypes: ["image", "media", "font"],
    bestAttempt: true,
  });
  const json = (await res.json()) as { success: true; result: string; meta?: { status?: number; title?: string; finalUrl?: string } };
  return json; // json.result may start with YAML frontmatter
}
```

Alternative inside Workers only: the browser binding `env.BROWSER.quickAction("screenshot" | "markdown" | "snapshot" | ..., body)` returns a `Response` with the same shape, needs **no token**, requires `compatibility_date >= 2026-03-24` and `wrangler dev --remote` (or `"browser": {"binding": "BROWSER", "remote": true}`); otherwise `The RPC receiver does not implement the method "quickAction"` (https://developers.cloudflare.com/browser-run/quick-actions/#workers-binding). Not usable from Node, so the REST path is the one that lets the eval harness share code.

### From Node 24 (eval harness)

Same code; `fetch` is a stable global since Node 21 (undici). No Cloudflare-side restriction on caller location. The SDK alternative is `npm i cloudflare` and `client.browserRendering.screenshot.create({ account_id, url, ... })` / `.markdown.create(...)`; `.asResponse()` exposes `X-Browser-Ms-Used`.

## 6. Errors

JSON envelope on every non-200: `{"success": false, "errors": [{"code": <number>, "message": "<string>"}]}` (OpenAPI; `result: null` and `messages: []` also appear in the live auth error).

| HTTP | When | Body / header |
| --- | --- | --- |
| 400 | "The request contains errors or didn't properly encode content": invalid JSON, unknown key (`additionalProperties: false`), both/neither `url`+`html`, `quality` with png | `{"success":false,"errors":[{"code":<n>,"message":"..."}]}`. UNCONFIRMED: specific codes; invalid/unparseable `url` presumably 400 (not documented) |
| 401 (probe) | missing or bad token | `{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}` |
| 403 | token lacks `Browser Run - Edit` | UNCONFIRMED exact body (standard Cloudflare API 403; not probed) |
| 422 | "site-related issues such as timeouts, SSL errors, or inaccessible content": page crashed, too much memory, any timer exceeded (`gotoOptions.timeout`, `waitForSelector`, `waitForTimeout`, `actionTimeout`), selector never appeared. Most 422s are timeouts; raise `actionTimeout` if the capture itself is slow | `{"success":false,"errors":[...]}`. UNCONFIRMED codes/messages; changelog 2026-10-30 says timeouts "now return a consistent error" without quoting it |
| 429 | Quick Actions rate (Free 1/10 s, Paid 30/s) or global API 1,200/5 min | `{"errors":[{"code":2001,"message":"Rate limit exceeded"}],"success":false}` (the API reference's 429 example; code 2001 not otherwise documented) + `Retry-After: <seconds>` (required on 429 per OpenAPI) |
| 429 | Free daily budget spent | message `Browser time limit exceeded for today` (quoted in docs as `Unable to create new browser: code: 429: message: Browser time limit exceeded for today`), until next UTC day |
| 500 | internal | same envelope |

Not errors but look like them:
- **Blocked / challenged page**: Cloudflare and other bot walls return 200 from Browser Run with the challenge page as content (the request is always identified as a bot; `userAgent` does not help). Detect via `meta.status` (403/503) or `meta.title` on `/markdown`, `/content`, `/snapshot`; `/screenshot` gives no `meta`, so prefer `/snapshot` when you need both the image and a status. UNCONFIRMED: no doc describes the exact behavior on a challenge page; `meta.status` is the only documented signal.
- `robots.txt`: `/crawl` honours it (UA `CloudflareBrowserRenderingCrawler/1.0`, skipped pages get outcome `robots_disallowed`, a Content-Signal mismatch is a 400). The single-page Quick Actions are not documented to check it; the robots page only says the standard is advisory and points site owners to WAF / Web Bot Auth (https://developers.cloudflare.com/browser-run/reference/robots-txt/).
- Empty or partial markdown/screenshot: page not finished loading; see `waitUntil` guidance in section 2.

## 7. Implementer checklist

1. One constant for the path segment (`browser-rendering` today), one for `cacheTTL` (use `0` unless repeated renders of the same URL within seconds are expected).
2. Never send `quality` with png. Never send keys outside the schema.
3. Always send `gotoOptions.waitUntil: "networkidle2"` and a `timeout <= 20000` so the WhatsApp reply stays snappy; `bestAttempt: true` turns slow pages into partial output instead of a 422.
4. On 429 honour `Retry-After` (seconds). On the Free plan serialise calls (1 per 10 s) and budget 10 min/day; log `X-Browser-Ms-Used`.
5. Treat `success:false` + `errors[0].message` as the user-facing failure reason; map 422 to "page could not be loaded", 429 to "try again later".
6. For "screenshot + text of a link" in one turn use `/snapshot` with `formats: ["screenshot","markdown"]` (base64 image, strip YAML frontmatter from `markdown`), halving browser time and rate-limit use.
7. Token permission: `Browser Run - Edit` (a.k.a. `Browser Rendering - Edit` / `Browser Rendering Write`), Account scope; no product enablement needed.

## Verification (2026-11-04)

Re-checked about 75 concrete claims (paths, methods, every request field and default in the OpenAPI schema at github.com/cloudflare/api-schemas main, response shapes, limits, prices, dates, error texts) against the cited developers.cloudflare.com pages fetched as `index.md`, the OpenAPI JSON, nodejs.org, and live probes of api.cloudflare.com. Everything not listed below matched its source.

Corrections made (before -> after, source):

- "Both return the identical 401 ... so both route today" -> 401 proves only that the prefix is recognised; `/browser-rendering/bogus` and `/browser-run/bogus` also return 401, unknown prefix returns 404 code 10404 (live probe of api.cloudflare.com, 2026-11-04).
- "Older pages still say `Browser Rendering - Edit`" -> the get-started page updated Oct 15, 2026 still says it and still uses `/browser-rendering/screenshot` (https://developers.cloudflare.com/browser-run/get-started/).
- `/markdown` body "17 optional props vs 20" -> 20 vs 23 (screenshot has 23 properties, markdown 20; OpenAPI `brapi-post_Screenshot` / `brapi-post_Markdown`).
- `content` "rendered HTML incl. `<head>`" -> "rendered HTML string"; `<head>` not stated anywhere (OpenAPI 200 schema `result: string`; https://developers.cloudflare.com/browser-run/quick-actions/content-endpoint/).
- "The `fullPage` + `deviceScaleFactor: 2` example uses 3600x2400" -> that example is viewport 3600x2400 + `deviceScaleFactor: 2`, no `fullPage` (https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/#improve-blurry-screenshot-resolution).
- `waitForSelector` example with both `visible: true` and `hidden: true` -> one of them; schema enum for each is `[true]` (OpenAPI).
- cookies: added "only `name`+`value` required" (OpenAPI `cookies.items.required`).
- 429 body with code 2001 -> flagged as the API reference's example, not a documented code (https://developers.cloudflare.com/api/resources/browser_rendering/subresources/markdown/methods/create/ 429 example).
- "`robots.txt` is not enforced by Browser Run (advisory only)" -> `/crawl` honours it (own UA, `robots_disallowed` skip outcome, Content-Signal 400); single-page actions not documented to check it (https://developers.cloudflare.com/browser-run/reference/robots-txt/, https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/).
- Kitesurf: added doc link and its stated gaps (https://developers.cloudflare.com/browser-run/kitesurf/).

Author's UNCONFIRMED items now confirmed:

- `cacheTTL` scope "same URL by the same account" and "submitted `html` is never cached": verbatim in FAQ (https://developers.cloudflare.com/browser-run/faq/#is-there-any-temporary-caching-of-submitted-content).
- Node `fetch` stable: "No longer experimental" in v21.0.0 (https://github.com/nodejs/node/blob/main/doc/api/globals.md#fetch).
- `rawAiResponse` on `/json`: present in the OpenAPI 200 schema ("Raw AI response will be returned, if it couldn't be parsed into valid JSON").
- Permissions reference page lists no Browser permission at all: confirmed by grep of https://developers.cloudflare.com/fundamentals/api/reference/permissions/index.md.
- No Cloudflare mobile viewport or mobile UA anywhere in the docs: confirmed by grep of the headers, screenshot and snapshot pages.

Still UNCONFIRMED (no official source found; the ones marked "needs token" need a live authenticated probe):

- Sunset date for the `/browser-rendering/` path segment (OpenAPI has no `deprecated` flag).
- Exact permission label in the token-creation UI today (`Browser Run - Edit` vs `Browser Rendering - Edit`).
- Live `Content-Type` on a JPEG screenshot: `image/jpg` (schema) or `image/jpeg` (needs token).
- Whether `waitForSelector.timeout` / `waitForTimeout` / `actionTimeout` are capped at 120 000 ms (schema) or 60 s / 5 min (timeouts page).
- Any max viewport, output pixel or response-size limit for Quick Actions.
- Whether `/markdown` strips nav/footer boilerplate; typical output size.
- Specific error codes/messages for 400, 403 and 422 (needs token).
- Exact behavior when the target page is a bot challenge (only `meta.status` is documented).
