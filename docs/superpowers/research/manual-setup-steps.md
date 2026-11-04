# Manual dashboard setup (human steps) — reference note

Researched 2026-11-04 against official docs; re-verified 2026-11-04 (see §Verification). Doc versions seen: Meta Graph API examples use v23.0 (Get Started) through v27.0 (reference pages); changelog: "The latest Graph API version is: v27.0" (v26.0 = 2026-07-29) → use `v27.0`. Cloudflare docs dated Apr–Oct 2026; "Browser Rendering" is now called **Browser Run** in docs and dashboard ("Browser Run, formerly known as Browser Rendering"; API paths accept both `/browser-rendering/` and `/browser-run/` — both answer 401 unauthenticated, an unknown path answers 404 `No route for that URI`). OpenRouter docs are undated; public JSON endpoints were queried live on 2026-11-04. OpenRouter settings URLs now redirect into a workspace (`/settings/keys` → `/workspace-redirect/keys`); the `/settings/...` links below still resolve.

Legend: **UNCONFIRMED** = not stated in current official docs; the step is given as "what to look for".

---

## 0. Secrets the Worker needs (summary; details in §7)

| Name | Comes from | Section |
|---|---|---|
| `WHATSAPP_TOKEN` | Meta Business settings → System users → Generate token (never-expiring) | §2 |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta App Dashboard → WhatsApp → API Setup (test number's "Phone number ID") | §1.3 |
| `WHATSAPP_APP_SECRET` | Meta App Dashboard → App settings → Basic → App Secret → Show | §1.5 |
| `WHATSAPP_VERIFY_TOKEN` | We generate; human pastes into Meta webhook config | §3 |
| `OPENROUTER_API_KEY` | openrouter.ai/settings/keys | §6 |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens | §5 |
| `CLOUDFLARE_ACCOUNT_ID` | `ca2eab2f1e6412d4da10548be926c8fa` (known) | §5 |
| `ALLOWED_PHONES` | Owner + reviewer numbers, digits only, comma-separated | §4, §7 |

---

## 1. Meta: developer account, app, WhatsApp test number

Source: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started (current, use-case wizard) · https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case · https://developers.facebook.com/docs/development/create-an-app

### 1.1 Developer account
- Go to https://developers.facebook.com → **Get Started** (top right) → log in with a Facebook account → accept terms → verify email/phone. UNCONFIRMED: exact registration screen wording (doc: https://developers.facebook.com/docs/development/register).

### 1.2 Create the app (current wizard, 6 steps: Start, App details, Use cases, Business, Requirements, Overview)
1. https://developers.facebook.com/apps → **Create App**.
2. **App details**: app name + contact email → **Next**.
3. **Use cases**: pick **"Connect with customers through WhatsApp"** (shown in the dashboard afterwards as **"Connect on WhatsApp"**). Do NOT pick "Other" / "Business"; the generic wizard also lists "Manage everything on your Page", "Access Threads API", "Authenticate and request data from users with Facebook Login", "Other" — ignore those. → **Next**.
4. **Business**: "Select an existing business portfolio or create a new one." Options on this step: a verified portfolio / an unverified portfolio / **Create a business portfolio** (pop-up asks business name, your name, email) / "I don't want to connect a business portfolio yet". For WhatsApp, create or select one here — the system user in §2 lives inside this portfolio. Verification is NOT required for test numbers.
5. **Requirements**: review (usually empty) → **Next**.
6. **Overview**: "Review your app's details, use cases, connected business, and requirements" → **Go to dashboard** (doc wording; older wizard said "Create app"). You land on **Customize use case → Connect on WhatsApp → Quickstart**.

The app starts in **Development mode** and stays there.

### 1.3 API Setup page (test number, IDs, temporary token)
Left menu of the use case (doc list): **Permissions and features**, **Quickstart**, **API Setup**, **Configuration**, Resources, Tech Provider onboarding, Partner Solutions, Embedded Signup Builder. (Older/other apps: **WhatsApp → API Setup**.)

1. Quickstart → **Start using the API** → opens **API Setup**.
2. "Connect your app to a Messaging account": pick one from the dropdown or **Create a WhatsApp Business account**. Doc: "Once connected, you will see your **Messaging account ID** displayed in the API Setup panel." Messaging account ID = WhatsApp Business Account (WABA) ID. Copy it (needed for `subscribed_apps`, §3).
3. **Generate access token** → a temporary user token. Docs say only that it "expires quickly and is not suitable for development purposes" / user tokens "expire quickly, so you have to keep generating a new one every few hours"; the panel shows the expiry next to the token. UNCONFIRMED in docs: the 24-hour figure. Use it only for the first curl test; the Worker gets the system-user token (§2).
4. **From**: dropdown with the auto-created **test business phone number** (format `+1 555 …`). Its **Phone number ID** is displayed in the same panel next to the test number (doc: "retain both your test phone number ID and Messaging account ID"). Copy it → `WHATSAPP_PHONE_NUMBER_ID`. UNCONFIRMED: exact label placement; look for "Phone number ID" directly under/next to the From dropdown.
5. **To**: add the owner's own WhatsApp number (see §1.4).
6. **Send message** sends the pre-approved `hello_world` template (the only template on a test number). The page shows the equivalent curl:

```bash
curl -i -X POST \
  "https://graph.facebook.com/v27.0/<PHONE_NUMBER_ID>/messages" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "messaging_product": "whatsapp", "to": "<RECIPIENT_E164_DIGITS>", "type": "template", "template": { "name": "hello_world", "language": { "code": "en_US" } } }'
```
7. **Reply to that message from your phone** — this opens the 24-hour customer-service window and lets you send free-form text (doc §6 example):

```bash
curl 'https://graph.facebook.com/v27.0/<TEST_BUSINESS_PHONE_NUMBER_ID>/messages' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer <SYSTEM_USER_ACCESS_TOKEN>' \
-d '{ "messaging_product": "whatsapp", "recipient_type": "individual", "to": "<WHATSAPP_USER_PHONE_NUMBER>", "type": "text", "text": { "body": "Hello!" } }'
```

Test-number facts (doc: business-phone-numbers/phone-numbers): "a **test** business phone number is generated and registered for you automatically". UNCONFIRMED: the sentence "relaxed messaging limits and don't require a payment method on file in order to send template messages" is not on that page today (only in third-party mirrors of an older Meta "About" page); practical reading: no card is needed for test traffic.

### 1.4 Recipient list of the test number ("To" field)
- UI: **API Setup → To dropdown → Manage phone number list → Add phone number** → enter number with country code → Meta sends a verification code to that phone → enter the code → number appears in the To list.
- Max recipients: **5** per test number. Source: older version of Meta's Get Started page (search-engine snippet: "send free messages to up to 5 recipient numbers … select the To field and choose Manage phone number list … The recipient number will receive a confirmation code in WhatsApp"). The current page no longer prints the number. UNCONFIRMED: that the cap is still exactly 5 and whether the code arrives as a WhatsApp message or SMS/voice — the dialog says which; the dashboard enforces the cap.
- Sending to a number not on the list fails with HTTP 400, error **131030** "Recipient phone number is not in allowed list" — "Only occurs when using public test numbers (PTNs)" — fix: "Add a recipient phone number to recipient list and try again." (https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting/)

### 1.5 App Secret
- App Dashboard → left menu **App settings → Basic** → **App Secret** → **Show** (Facebook may ask you to re-enter your password). Doc: "The app secret can be found in your app dashboard in Settings > Basic." (https://developers.facebook.com/docs/facebook-login/security). UNCONFIRMED in docs: the "Show" button / password prompt (standard UI).
- Resetting it: same page; cannot be rotated via API; a reset invalidates the old secret immediately (webhook signature checks would start failing until the Worker secret is updated).
- `App ID` is on the same page (not needed by the Worker).

### 1.6 Development mode / App Review — confirmed: neither is a blocker
- Leave the app in **Development mode**. The whole Get Started flow (test number, token, webhook) runs in Dev mode; docs never ask to go Live.
- Dev mode limits (https://developers.facebook.com/docs/development/build-and-test/app-modes): "Apps in Development mode can only request permissions from role users" — irrelevant, the system user token is generated in Business settings, not via login.
- Use-case page: required permissions `public_profile`, `whatsapp_business_management`, `whatsapp_business_messaging` are pre-attached and "cannot be removed"; **App Review is only needed for Tech Provider onboarding** (serving other businesses) or publishing. Standard Access is enough for assets your own portfolio owns.
- Webhooks in Dev mode: webhooks overview warns "some webhooks aren't sent in Dev mode"; the echo-bot troubleshooting page states **"messages test webhooks work in both"** modes. `messages` is the only field we need.
- Going Live would require app icon, privacy policy URL, data deletion URL (use-case page "Publish") — skip.

---

## 2. Permanent token: Business settings → System user

Source (current): https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens · Get Started step 5.

Token types: App-Dashboard token = short-lived user token ("expires quickly", regenerated on each visit). **System user access token** = "long-lived … suited to automated services that need no user input" — this is `WHATSAPP_TOKEN`. (Business Integration System User tokens are for Embedded Signup / partners — not us.)

Prerequisite: a **business portfolio** that owns both the app and the WABA. The wizard in §1.2 step 4 created/selected it. If the user somehow has none: https://business.facebook.com → **Create a business** (name, your name, email), then in App Dashboard → App settings → Basic → "Business verification / Business portfolio" connect the app to it. UNCONFIRMED: exact label of that connect control.

Steps (doc wording):
1. Open **Business settings**: https://business.facebook.com/settings/ (also reachable as https://business.facebook.com/latest/settings). If you have several portfolios, pick the one from §1.2.
2. Left menu **Users → System users** → **+ Add**. Enter a name (e.g. `wapp-agent`), role **Admin** (Employee is allowed by docs; Admin avoids asset-permission surprises; an admin system user token is also what Meta requires for user-management calls).
3. Click the new system user → **Assign assets** (older UI: "Add assets"):
   - **Apps** → select your app → turn on **Manage app** (under *Full control*) → **Assign assets**.
   - **WhatsApp accounts** → select the (test) WABA → turn on **Manage WhatsApp Business accounts** (*Full control*) → **Assign assets**.
   - Doc: "Reload the page and confirm the system user has **Full control** of your app. Permissions can take a few minutes to appear."
4. **Generate token** (older label "Generate new token") → select your **app** → "choose a token expiration preference". UNCONFIRMED in docs: the option labels; third-party guides (hints) show **60 days / Never** → choose **Never**.
5. Permissions: tick `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging` (doc tip: search "business"). → **Generate token** → **copy it now** → `WHATSAPP_TOKEN`. UNCONFIRMED: whether Meta shows it again later; treat as shown once.
6. Verify (reads the test number's details; proves token + assets):

```bash
curl "https://graph.facebook.com/v27.0/<PHONE_NUMBER_ID>" -H "Authorization: Bearer <WHATSAPP_TOKEN>"
# → {"verified_name":"…","display_phone_number":"+1 555 …","id":"<PHONE_NUMBER_ID>", …}
```

Gotcha: "permanent" means no expiry; Meta can still invalidate it (app secret reset does NOT invalidate it, but removing the system user's asset access or regenerating does).

---

## 3. Webhook configuration

Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint · …/webhooks/overview · …/webhooks/set-up-whatsapp-echo-bot · https://developers.facebook.com/docs/graph-api/webhooks/getting-started · …/solution-providers/manage-webhooks

Deploy the Worker first; the URL must answer the GET below at the moment you click save.

1. App Dashboard → **WhatsApp → Configuration**. For use-case apps (ours): **Use cases → Customize → Configuration**. (Echo-bot page labels it **WhatsApp → Webhooks → Configuration**.)
2. **Webhook** card → **Edit**: **Callback URL** = `https://<worker>.<subdomain>.workers.dev/webhook` (whatever route we expose; must be HTTPS with a valid cert — "Self-signed certificates are not supported"; workers.dev is fine). **Verify token** = the value of `WHATSAPP_VERIFY_TOKEN`. → **Verify and save** (UNCONFIRMED button label; doc: "If your endpoint passes verification, the panel saves your changes and displays the fields you can subscribe to").
   - At that instant Meta sends: `GET <callback>?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<string>`. Worker must reply **200** with body = `hub.challenge` exactly (plain text); on a token mismatch "respond with a 400-level status or any status other than 200". Any non-200 → dashboard error "The callback URL or verify token couldn't be validated", nothing is saved.
3. After success the panel lists **Webhook fields** → **Manage** → subscribe **`messages`** (version dropdown at the top of that dialog = Graph API version used for payloads; pick the latest, e.g. v27.0. UNCONFIRMED: presence/label of the version dropdown in the current dialog). `messages` requires `whatsapp_business_messaging` (granted).
4. Optional: in the Configuration panel scroll to **messages** → **Test** sends a sample payload to the URL.
5. **Subscribe the app to the WABA** (webhooks are delivered per WABA). Doc (solution-providers/manage-webhooks): "You must individually subscribe to every Messaging account" you want webhooks for; `POST /<WABA_ID>/subscribed_apps` → `{"success": true}`, `GET` lists, `DELETE` unsubscribes. UNCONFIRMED whether the dashboard does this for the test WABA created in §1.3; the call is idempotent, so run it anyway. (The generic Graph API reference page for `subscribed_apps` claims POST/DELETE are unsupported — ignore it, the WhatsApp docs document them.)

```bash
curl -X POST 'https://graph.facebook.com/v27.0/<WABA_ID>/subscribed_apps' -H 'Authorization: Bearer <WHATSAPP_TOKEN>'
# → {"success": true}
curl 'https://graph.facebook.com/v27.0/<WABA_ID>/subscribed_apps' -H 'Authorization: Bearer <WHATSAPP_TOKEN>'
# → {"data":[{"whatsapp_business_api_data":{"id":"<APP_ID>","link":"https://www.facebook.com/games/?app_id=<APP_ID>","name":"<app name>"}}]}
```

Delivery contract (for the implementer; the human needs none of it):
- POST headers `Content-Type: application/json`, `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 over the raw request body, key = App Secret>`. Compare constant-time.
- Respond **200** quickly; any non-200 or timeout → retries "with decreasing frequency … for up to 7 days", duplicates possible (dedupe on message id). Payloads up to **3 MB**; one POST can batch up to **1000 updates** (iterate `entry[].changes[]`, never assume one message per POST).

---

## 4. Numbers outside the recipient list; reviewer onboarding

- **Outbound** to a number not in the test number's list: HTTP 400, error `131030` (see §1.4). The bot cannot reply to them.
- **Inbound** from a number not in the list: UNCONFIRMED in official docs whether Meta delivers the `messages` webhook at all. Either way the Worker drops anything not in `ALLOWED_PHONES`, and a reply would fail with 131030, so the behaviour is "silence". Put this in the README's known limits.
- **Reviewer flow (5 slots total, owner included):**
  1. Reviewer sends the owner their WhatsApp number in international format (e.g. `+44 7700 900123`).
  2. Owner: App Dashboard → API Setup → **To → Manage phone number list → Add phone number** → enters it → **Next/Send code**.
  3. Meta sends a one-time code **to the reviewer's phone** (WhatsApp message per older docs; dialog may offer SMS/voice — UNCONFIRMED).
  4. Reviewer relays the code to the owner (any channel); owner types it into the dialog → **Verify**. Number now appears in the To list.
  5. Owner appends the digits-only number (`447700900123`) to `ALLOWED_PHONES` (`wrangler secret put ALLOWED_PHONES` with the full list) — doc: "`wrangler secret put` creates a new version of the Worker and deploys it immediately"; no code redeploy needed, new value applies to new requests only.
  6. Reviewer must **text first** (any message) — the bot can only send free-form text inside the 24 h window that their message opens; a test number cannot initiate with anything but `hello_world`.
- Freeing a slot: remove a number from the same dialog (UNCONFIRMED that removal is allowed/instant; one third-party package doc claims added numbers cannot be removed — plan the 5 slots up front).

---

## 5. Cloudflare

Sources: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ · https://developers.cloudflare.com/browser-run/quick-actions/ (…/screenshot-endpoint, …/markdown-endpoint) · https://developers.cloudflare.com/browser-run/pricing/ · https://developers.cloudflare.com/browser-run/limits/ · https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/workers-ai/platform/pricing/ · https://developers.cloudflare.com/workers-ai/get-started/rest-api/ · https://developers.cloudflare.com/workers/platform/pricing/

### 5.1 Plan: Free works for a demo, Paid ($5/mo) recommended
| Product | Workers Free | Workers Paid ($5/mo min) |
|---|---|---|
| Durable Objects | **SQLite-backed DOs available** ("Workers Free plan can only create and access SQLite-backed Durable Objects"); 100k requests/day, 13k GB-s/day, 5M rows read/day, 100k rows written/day (each `setAlarm` = 1 row written), 5 GB | 1M req/mo, 400k GB-s/mo, 25B reads, 50M writes included |
| Workers AI (bge-m3, whisper) | 10,000 Neurons/day, then **requests fail** until 00:00 UTC | same free 10k/day, then $0.011/1k Neurons |
| Browser Run REST (`/screenshot`, `/markdown`) | **10 browser-minutes/day** and **Quick Actions: 1 request every 10 seconds**; 60 s browser timeout | 10 browser-hours/mo then $0.09/h; 30 Quick Actions requests/s |
| Workers | 100k req/day, 10 ms CPU | 10M req/mo, 30M CPU-ms |

Gotcha: the Free-plan Quick Actions limit of **1 request / 10 s** means the brief's parallel `/screenshot` + `/markdown` pair returns `429 Too many requests` (`Retry-After` header) for the second call. On Paid this disappears. Upgrade: dashboard → **Workers & Pages → Plans** page (deep link https://dash.cloudflare.com/?to=/:account/workers/plans) → **Workers Paid** → add card. Doc note: after upgrading, **redeploy the Worker** or Browser Run may keep applying the 10-minute cap. No opt-in/enable step for Browser Run or Workers AI is documented; usage page: https://dash.cloudflare.com/?to=/:account/workers/browser-run.

### 5.2 Account ID
Known: `ca2eab2f1e6412d4da10548be926c8fa`. Where shown: Workers & Pages overview (right column "Account ID"), or Workers AI page → **Use REST API** → "Get Account ID". Not a secret; put it in `wrangler.jsonc` `vars`.

### 5.3 API token (`CLOUDFLARE_API_TOKEN`)
Used by the Node eval harness (Workers AI REST) and by the Worker for Browser Run REST. Steps (doc wording):
1. https://dash.cloudflare.com/profile/api-tokens (**My Profile → API Tokens**) → **Create Token** → scroll to **Create Custom Token → Get started**.
2. **Token name**: `wapp-agent`.
3. **Permissions** (each row = group / item / level):
   - `Account` / **Workers AI** / **Read**
   - `Account` / **Workers AI** / **Edit** — the Workers AI REST doc: a custom token "will need permissions for both `Workers AI - Read` and `Workers AI - Edit`" (the one-click template on the Workers AI page grants the same).
   - `Account` / **Browser Run** / **Edit** — Quick Actions docs: "create a custom API Token with … `Browser Run - Edit`". Older pages still say `Browser Rendering - Edit`. UNCONFIRMED which of the two names the dropdown shows today; it is one permission — type "Browser" in the item search. (The fundamentals permissions reference page does not list it at all.)
4. **Account Resources**: Include → **Specific account** → your account. Leave Zone Resources empty.
5. Optional **Client IP Address Filtering** (leave empty; Workers egress IPs vary) and **TTL** (leave empty).
6. **Continue to summary** → **Create Token** → copy. "The token secret is only shown once." New tokens start with `cfut_`.
7. Verify both scopes:

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer <TOKEN>"
# → {"result":{"id":"…","status":"active"},"success":true,"errors":[],"messages":[{"code":10000,"message":"This API Token is valid and active","type":null}]}

curl -X POST "https://api.cloudflare.com/client/v4/accounts/ca2eab2f1e6412d4da10548be926c8fa/ai/run/@cf/baai/bge-m3" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"text":["hello"]}'
# → {"success":true,"result":{…}}  UNCONFIRMED exact result envelope: the model page's own curl uses {"text":[…]},
#   but its published input schema lists only {"contexts":[{"text":…}], "query"?, "truncate_inputs"?} and no output schema;
#   bge-m3 vectors are 1024-dim (model fact, not stated on the page). Check the first real response before writing the parser.

curl -X POST "https://api.cloudflare.com/client/v4/accounts/ca2eab2f1e6412d4da10548be926c8fa/browser-run/markdown" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
# → {"success":true,"result":"# Example Domain\n\n…"}
```
(`/browser-rendering/markdown` is the same endpoint under the old name; docs show both.) Each Quick Actions response carries `X-Browser-Ms-Used`.

Alternative that needs no token inside the Worker: the `browser` binding (`env.BROWSER.quickAction("screenshot", {...})`, compatibility date ≥ `2026-03-24`, `wrangler dev --remote` only). The brief specifies the REST API, so the token stays; the binding is a fallback.

---

## 6. OpenRouter

Sources: https://openrouter.ai/docs/api-reference/authentication · https://openrouter.ai/docs/faq · https://openrouter.ai/docs/guides/privacy/provider-logging · https://openrouter.ai/docs/guides/features/zdr · https://openrouter.ai/docs/guides/routing/provider-selection · https://openrouter.ai/docs/guides/privacy/data-collection · live: `GET https://openrouter.ai/api/v1/models/{id}/endpoints`, `GET https://openrouter.ai/api/v1/endpoints/zdr`

### 6.1 Account, credits, key
1. Sign up at https://openrouter.ai (Sign in → Google/GitHub/email; UNCONFIRMED exact provider list).
2. **Credits**: https://openrouter.ai/settings/credits → **Add credits** ("all major credit cards, AliPay and cryptocurrency payments in USDC"). A purchase fee applies (percentage is an unrendered placeholder in the docs → UNCONFIRMED; it is printed on the checkout). Optional **auto top-up** below a threshold. OpenRouter "reserve[s] the right to expire unused credits after one year of purchase". Without credits only `:free` models work (20 req/min, 50 req/day; 1000/day once ≥ $10 of credits were ever bought). $10 is plenty for the evals plus demo traffic at the live prices in §6.3.
3. **Keys**: https://openrouter.ai/settings/keys (docs link `/keys` redirects there) → **Create Key** → name `wapp-agent`, **Credit limit** (docs: "We recommend setting a credit limit on every key"; set e.g. $25; a key past its limit is rejected until raised) → **Create** → copy → `OPENROUTER_API_KEY`. (Keys auto-created during onboarding get a $100 limit and expire after 180 days — make your own.) Header: `Authorization: Bearer <key>`; optional `HTTP-Referer` / `X-OpenRouter-Title` for rankings.

### 6.2 Privacy settings — https://openrouter.ai/settings/privacy
Docs describe these controls by function; exact toggle labels are UNCONFIRMED (the settings page is behind login):
| Control (docs' description) | Effect on routing | Recommended |
|---|---|---|
| "allow routing to providers that may train on your data" — **separate settings for paid and free models** | OFF → "OpenRouter will not route to providers that train" (and to providers whose policy OpenRouter cannot confirm: "assumes the endpoint retains and trains"). FAQ implies OFF is the default. | **OFF** (both) |
| Data-policy filter (account-wide version of request `provider.data_collection: "deny"`) | `deny` → only providers that "do not collect user data" | leave default (`allow`); use `deny` only if a model still has non-training hosts |
| **ZDR enforcement** per model group (Anthropic, OpenAI, Google, SpaceXAI, All other models) with **"ZDR only"** vs **"Allow Safety Retention"** | restricts to zero-data-retention endpoints; some models become unavailable; self-serve default when enabled = Allow Safety Retention | **OFF** — see gotcha below |
| Account-wide **ignored providers** / **allowed providers** | merged with per-request `ignore`; `only` narrows within allowed; no match → 404 | optional: ignore the China-hosted first-party slugs below |
| "OpenRouter Use of Inputs/Outputs" (opt-in, off by default, "1% discount on all model usage") — docs link https://openrouter.ai/workspaces/default/settings | OpenRouter may use prompts to improve product | OFF |
| Observability → "Private Input & Output Logging" (off by default; docs link https://openrouter.ai/workspaces/default/observability, older link /settings/preferences) | prompts/completions kept in your OpenRouter logs | OFF (or ON only while debugging evals) |

Gotcha: **ZDR is not a geography filter.** The live `/api/v1/endpoints/zdr` list (2026-11-04) includes **Moonshot AI** and **Z.AI** first-party endpoints, so "ZDR only" would still route Kimi/GLM to their own (China) hosts. It also shrinks the provider pool and hurts the speed comparison. The training toggle OFF is likewise policy-based, not region-based.

### 6.3 Routing Kimi / GLM / DeepSeek to non-China hosts
Do it per request (`provider` object in the body; the AI SDK provider exposes it as extra body / provider options) or account-wide in the ignored-providers setting. Slug shape per docs: `provider[/variant][/region][/tier]`; a base slug "matches all eligible endpoints for that provider, including any variants or regions" (copy button next to the provider name on each model page; also the prefix of the `tag` field in `GET /api/v1/models/{id}/endpoints`). Defaults: `allow_fallbacks: true`, `data_collection: "allow"`; `only`/`ignore` reduce fallback options; account "allowed providers" is a ceiling and a request `only` outside it → 404.

```json
{ "provider": { "ignore": ["moonshotai", "z-ai", "deepseek", "alibaba", "baidu", "siliconflow", "streamlake"], "allow_fallbacks": true } }
```
or pin a host and stop fallbacks (deterministic latency numbers for the eval table; `deepinfra` and `parasail` serve all five open models below today, Fireworks does not serve kimi-k2.6 or glm-5.2):
```json
{ "provider": { "order": ["deepinfra", "parasail"], "allow_fallbacks": false } }
```
Observed endpoints 2026-11-04 (status 0 = healthy; re-check before shipping): `moonshotai/kimi-k2.6` → Baidu, Chutes, DigitalOcean, StreamLake, CoreWeave, Crusoe, DeepInfra, Venice, Parasail, SiliconFlow, Inceptron, Novita, GMICloud, AtlasCloud, Cloudflare, **Moonshot AI**, Phala. `z-ai/glm-5.2` → Wafer, Relace, Cloudflare, DeepInfra, StreamLake, Baidu, CoreWeave, Novita, DigitalOcean, SiliconFlow, AtlasCloud, Alibaba, Mistral (zdr/eu), BaseTen, Together, Venice, GMICloud, Parasail, Friendli, **Z.AI** (no Fireworks). `z-ai/glm-5.3` → 40+ incl. Fireworks, Together, DeepInfra, Novita, BaseTen, Nebius, Crusoe, Amazon Bedrock, Mistral (zdr/eu), **Z.AI**, Alibaba, Baidu. `deepseek/deepseek-v4-flash` → Relace, Baidu, StreamLake, DeepInfra, GMICloud, Venice, DigitalOcean, SiliconFlow, AtlasCloud, Parasail, Azure (us), Wafer (Fireworks degraded) — no `deepseek` first-party endpoint for that id. Region-tagged slugs exist (`baseten/fp4/us`, `alibaba/fp8/us-east-1`, `mistral/nvfp4/eu`). Business/Enterprise plans get `https://us.openrouter.ai` / `https://eu.openrouter.ai` in-region routing — not available on self-serve.

Aside for the design step (live `GET /api/v1/models`, 2026-11-04, $/M tokens prompt / completion / cache-read; list price = cheapest endpoint, per-provider prices differ): the brief's ids **do** exist: `openai/gpt-6.1-terra` 1 / 5 / 0.05, `openai/gpt-6.1-sol` 2 / 10 / 0.10, `openai/gpt-6-luna` 0.10 / 0.50 / 0.01, `anthropic/claude-sonnet-5.5` 2 / 10 / 0.10, `anthropic/claude-haiku-5.5` 0.10 / 0.50 / 0.01, `anthropic/claude-opus-5.5` 4 / 20 / 0.20, `deepseek/deepseek-v4.1-flash` 0.045 / 0.50 / 0.018, `deepseek/deepseek-v4-flash` 0.091 / 0.182 / 0.018, `deepseek/deepseek-v4-pro` 1.6 / 3.2 / 0.135, `moonshotai/kimi-k2.6` 0.65 / 3.41 / 0.15, `moonshotai/kimi-k2.7-code` 0.60 / 3.50 / 0.15, `z-ai/glm-5.3` 0.07 / 1.40 / 0.07, `z-ai/glm-5.2` 0.006 / 6.8 / 0.005. `:batch` variants are half price. Compare the brief's prices against these, not against memory.

---

## 7. Secret-by-secret: name, source, format, how to set

| Secret | Copy from | Format / check |
|---|---|---|
| `WHATSAPP_TOKEN` | §2 step 5 (system user, never-expiring) | long opaque string starting `EAA…`; test with §2 step 6 curl |
| `WHATSAPP_PHONE_NUMBER_ID` | §1.3 API Setup, next to the test number | 15–16 digits; NOT the phone number itself |
| `WHATSAPP_APP_SECRET` | §1.5 App settings → Basic → Show | 32 hex chars |
| `WHATSAPP_VERIFY_TOKEN` | we generate: `openssl rand -hex 24`; human pastes the same string into §3 step 2 | any ASCII without spaces |
| `OPENROUTER_API_KEY` | §6.1 step 3 | starts `sk-or-v1-` |
| `CLOUDFLARE_API_TOKEN` | §5.3 step 6 | starts `cfut_`; verify curl in §5.3 |
| `CLOUDFLARE_ACCOUNT_ID` | known `ca2eab2f1e6412d4da10548be926c8fa` | 32 hex; a `var`, not a secret |
| `ALLOWED_PHONES` | owner + each verified reviewer (§4) | comma-separated E.164 **digits without `+`**, e.g. `4915112345678,447700900123` — matches the `wa_id` / `from` field Meta sends |

Also needed but not secrets: `WABA_ID` (Messaging account ID) only for the one-off `subscribed_apps` curl in §3.

Setting them: `npx wrangler secret put <NAME>` (prompts for the value; each put "creates a new version of the Worker and deploys it immediately") for each secret; `CLOUDFLARE_ACCOUNT_ID` in `wrangler.jsonc` → `"vars"`. Local dev and the Vitest eval harness read the same names from a git-ignored `.dev.vars` / `.env`.

Order for the human (after I deploy with placeholders): Meta app + test number (§1) → add own number (§1.4) → App Secret (§1.5) → system user token (§2) → send me / set the four WhatsApp values → I redeploy → webhook URL + verify token into Meta (§3) → `subscribed_apps` curl (§3.5) → Cloudflare Paid + token (§5) → OpenRouter credits + key + privacy toggles (§6) → reviewers one by one (§4).

---

## UNCONFIRMED list (collected)
1. Temporary App-Dashboard token = 24 h (docs: "expires quickly" / "every few hours").
2. Test-number recipient cap still exactly 5 (only in an older Get Started revision, still quoted by search engines; current page silent); verification code channel (older text: "confirmation code in WhatsApp"); whether removing a recipient frees a slot.
3. Whether Meta delivers inbound `messages` webhooks from numbers not on the recipient list.
4. Exact placement/label of "Phone number ID" in the API Setup panel; "Show"/password prompt for App Secret; "Generate token" expiration option labels (60 days / Never) and whether the token is viewable later; "Verify and save" button label.
5. Whether the dashboard auto-subscribes the app to the test WABA (doc says subscribe every WABA yourself → run the POST regardless); presence of a version dropdown in the webhook fields dialog.
6. Cloudflare permission item label today: "Browser Run" vs "Browser Rendering" (current docs say `Browser Run - Edit`; permissions reference lists neither); any dashboard enable step for Browser Run (none documented).
7. OpenRouter: exact toggle labels on /settings/privacy; purchase-fee percentage; default state of the training toggle (FAQ implies off); sign-in provider list.
8. Meta's "relaxed messaging limits / no payment method" sentence about test numbers (not on the cited page today).
9. bge-m3 REST response envelope (`shape`/`data`) and whether `{"text":[…]}` is still accepted alongside the published `contexts` schema — check on the first call.
10. Brief's prices vs the live OpenRouter list in §6.3 (ids confirmed to exist).

---

## Verification (2026-11-04)

Checked ~90 concrete claims (URLs, menu labels, endpoints, methods, headers, limits, prices, versions, slugs) against the cited official pages (Cloudflare pages fetched as `index.md`; Meta and OpenRouter docs fetched live; OpenRouter `/api/v1/models`, `/models/{id}/endpoints`, `/endpoints/zdr` queried live; Cloudflare API paths probed unauthenticated). Confirmed as written: all Cloudflare numbers in §5 (Browser Run 10 min/day, 1 req/10 s, 60 s, 10 h/mo + $0.09/h, 30 req/s, `429`+`Retry-After`, redeploy-after-upgrade note, `X-Browser-Ms-Used`, `Browser Run - Edit`, `quickAction` compat date `2026-03-24` + `--remote`; DO free/paid rows; Workers AI 10k Neurons/day + $0.011/1k; Workers 100k/day, 10 ms, 10M/mo, 30M CPU-ms; `cfut_` prefix; Workers AI Read+Edit; `/user/tokens/verify` output), Meta §1.5/§1.6/§2 steps and permissions, webhook verify handshake, `X-Hub-Signature-256`, 3 MB, 7-day retries, error 131030 text, OpenRouter auth headers (`HTTP-Referer`, `X-OpenRouter-Title`), onboarding keys ($100 / 180 days), ZDR groups and default, provider-object fields, allowed/ignored merge rule, 404 rule, us./eu. endpoints, Moonshot AI and Z.AI present in the ZDR list.

Corrections made (before -> after, source):
- §6.3 aside: "the brief's `gpt-6.1-*` / `gpt-6-luna` ids … did not match" -> those ids exist (`openai/gpt-6.1-terra|sol`, `openai/gpt-6-luna`, plus `gpt-6-sol|astra`, `gpt-5.6-*`); replaced with a live price table (https://openrouter.ai/api/v1/models).
- §6.3 pin example: `"order": ["fireworks", "deepinfra"]` -> `["deepinfra", "parasail"]`; Fireworks has no endpoint for `moonshotai/kimi-k2.6` or `z-ai/glm-5.2` and is degraded for `deepseek/deepseek-v4-flash` (https://openrouter.ai/api/v1/models/{id}/endpoints).
- §6.3 observed endpoint lists refreshed to today's data; glm-5.2 and glm-5.3 split (they differ) (same source).
- §6.3 slug rule "a base slug matches all its regions" was an observation -> now the doc's statement: base slug "matches all eligible endpoints for that provider, including any variants or regions"; slug shape `provider[/variant][/region][/tier]` (https://openrouter.ai/docs/guides/routing/provider-selection).
- §6.1 free-model limit "50 req/day" -> "20 req/min, 50 req/day; 1000/day once ≥ $10 credits bought"; added credits-may-expire-after-one-year (https://openrouter.ai/docs/api-reference/limits, https://openrouter.ai/docs/faq).
- §6.2 logging row: "/settings/preferences" -> docs now link https://openrouter.ai/workspaces/default/observability (and privacy opt-in at /workspaces/default/settings); both off by default (https://openrouter.ai/docs/guides/privacy/data-collection).
- §1.2 step 6: "confirm → Create app" -> "Go to dashboard"; dropped "No app type is asked" (not in doc) (https://developers.facebook.com/docs/development/create-an-app).
- §1.3 left menu: 4 items -> doc's 8 items (https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case).
- §1.3 test-number quote "relaxed messaging limits … payment method" -> marked UNCONFIRMED; the cited page only says the number "is generated and registered for you automatically" (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers).
- §3 step 2: doc quote "Any other response means Meta won't send webhooks" (not on the page) -> doc's actual wording on 400-level/non-200 and "panel saves your changes"; "Verify and save" marked UNCONFIRMED (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint).
- §3 step 5: "UNCONFIRMED whether dashboard auto-subscribes" -> doc: "You must individually subscribe to every Messaging account"; POST/GET/DELETE and `{"success": true}` confirmed; added warning that the generic Graph reference page wrongly says POST unsupported (https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks, https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/).
- §3 delivery contract: added "one POST can batch up to 1000 updates" (create-webhook-endpoint page).
- §4 step 5 / §7: "no redeploy needed … takes effect without redeploy" -> "`wrangler secret put` creates a new version of the Worker and deploys it immediately" (https://developers.cloudflare.com/workers/configuration/secrets/).
- §5.3 bge-m3 verify: asserted `{"shape":[1,1024],"data":…}` -> UNCONFIRMED envelope; published input schema is `contexts`/`query`, page curl uses `text` (https://developers.cloudflare.com/workers-ai/models/bge-m3/, …/sync-input.json, …/sync-output.json).
- Header: added Graph API changelog statement (latest = v27.0, v26.0 released 2026-07-29) and the unauthenticated path probe showing `/browser-rendering/` and `/browser-run/` both route (https://developers.facebook.com/docs/graph-api/changelog, https://api.cloudflare.com/client/v4/accounts/<id>/browser-rendering/markdown vs …/browser-run/markdown).
- §1.3 step 3 and §1.4: added the docs' exact token wording ("every few hours") and the older Get Started wording for the recipient cap/code channel (https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens; search-engine copies of the older Get Started page).

Remaining UNCONFIRMED: items 1–10 in the list above.
