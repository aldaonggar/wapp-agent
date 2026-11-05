# Manual setup (owner)

Everything here happens in web dashboards and cannot be scripted. Do the sections in order; sections 1 to 7 and 9 each end with a value you paste into `.dev.vars` (git-ignored, already created with the key names), and the optional section 8 uses its own file. When the values are filled in, tell Claude and it uploads them to the Worker.

| Value | From |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | section 1, API Setup page |
| `WHATSAPP_APP_SECRET` | section 2 |
| `WHATSAPP_TOKEN` | section 3, system user token |
| `WHATSAPP_VERIFY_TOKEN` | already generated in `.dev.vars`; you paste it into Meta in section 6 |
| `CLOUDFLARE_API_TOKEN` | section 4 |
| `CLOUDFLARE_ACCOUNT_ID` | already filled in |
| `OPENROUTER_API_KEY` | section 5 |
| `ALLOWED_PHONES` | your number now, reviewers' numbers later (section 7) |
| `TELEGRAM_BOT_TOKEN` | section 9, BotFather (optional: only for Telegram) |
| `TELEGRAM_WEBHOOK_SECRET` | section 9, generated with `openssl rand -hex 24` |
| `ALLOWED_TELEGRAM` | section 9; empty means anyone who finds the bot can talk to it |

Where a button label below might differ from what you see, the text says what to look for.

## 1. Meta app and test number (about 15 minutes)

1. Go to https://developers.facebook.com, click **Get Started**, log in with a Facebook account, accept the terms, verify your email.
2. https://developers.facebook.com/apps → **Create App**.
   - App details: any name (for example `wapp-agent`), your email → Next.
   - Use cases: pick **Connect with customers through WhatsApp** (not "Other", not "Business") → Next.
   - Business: **Create a business portfolio** (business name, your name, email). It does not need to be verified. → Next.
   - Requirements → Next. Overview → **Go to dashboard**.
3. In the dashboard open the WhatsApp use case → **Quickstart** → **Start using the API** (or the left-menu item **API Setup**).
4. On API Setup, connect or create a Messaging account when asked. Note the **Messaging account ID** (also called WhatsApp Business Account ID) shown there; you need it once in section 6.
5. The **From** dropdown shows the auto-created test number (`+1 555 ...`). Next to it is **Phone number ID**: copy it into `.dev.vars` as `WHATSAPP_PHONE_NUMBER_ID`. It is a 15-16 digit id, not the phone number itself.
6. **To** dropdown → **Manage phone number list** → **Add phone number** → your own WhatsApp number with country code → Meta sends a code to your phone → enter it. Put your number in `.dev.vars` as `ALLOWED_PHONES` as digits only, no plus sign (for example `77011234567`).
7. Click **Send message** on that page. You receive a "hello world" template on WhatsApp. **Reply to it from your phone** with anything; that opens the 24-hour window the bot needs to answer you.

The app stays in Development mode. No App Review is needed. The access token shown on this page expires within hours; do not use it. Section 3 makes the permanent one.

## 2. App secret

App dashboard → left menu **App settings → Basic** → **App secret** → **Show** (Facebook may ask for your password). Copy the 32-character hex string into `.dev.vars` as `WHATSAPP_APP_SECRET`.

## 3. Permanent access token (system user)

1. Open https://business.facebook.com/settings/ for the portfolio you created in section 1.
2. Left menu **Users → System users** → **Add**. Name `wapp-agent`, role **Admin** → create.
3. Click the new system user → **Assign assets** (older UI: "Add assets").
   - **Apps** → your app → turn on **Manage app** (full control) → assign.
   - **WhatsApp accounts** → the test WhatsApp Business account → turn on **Manage WhatsApp Business accounts** (full control) → assign.
   - Reload and confirm the user shows **Full control** on both. Permissions can take a few minutes to appear.
4. **Generate token** → choose your app → token expiration **Never** → tick these three permissions: `business_management`, `whatsapp_business_management`, `whatsapp_business_messaging` (type "whatsapp" in the search box) → **Generate token** → copy it now; it is shown once. Paste into `.dev.vars` as `WHATSAPP_TOKEN`.
5. Check it works (replace the two placeholders):

```bash
curl "https://graph.facebook.com/v27.0/<WHATSAPP_PHONE_NUMBER_ID>" -H "Authorization: Bearer <WHATSAPP_TOKEN>"
```

A JSON object with `display_phone_number` means the token and the asset assignments are right. An error with code `200` means step 3 is incomplete.

## 4. Cloudflare API token (2 minutes)

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token** → scroll down to **Create Custom Token → Get started**.
2. Token name `wapp-agent`. Permissions, three rows, all under **Account**:
   - **Workers AI → Read**
   - **Workers AI → Edit**
   - **Browser Run → Edit** (older dashboards call it **Browser Rendering → Edit**; type "Browser" in the search box, it is one permission)
3. Account Resources: Include → your account. Leave zone resources, IP filtering and TTL empty.
4. **Continue to summary → Create Token** → copy (starts with `cfut_`) into `.dev.vars` as `CLOUDFLARE_API_TOKEN`.
5. Check:

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer <CLOUDFLARE_API_TOKEN>"
```

`"status":"active"` means it is good.

## 5. OpenRouter (5 minutes)

1. Sign up at https://openrouter.ai.
2. https://openrouter.ai/settings/credits → **Add credits**. $10 covers the eval runs (under $5 with the default candidates) and demo traffic.
3. https://openrouter.ai/settings/keys → **Create Key** → name `wapp-agent`, set a credit limit (for example $25) → copy (starts with `sk-or-v1-`) into `.dev.vars` as `OPENROUTER_API_KEY`.
4. https://openrouter.ai/settings/privacy: leave "allow providers that may train on your data" **off** for both paid and free models. Leave ZDR enforcement **off** (it would route the Chinese-lab models to their own hosts in China and Singapore, which is the opposite of what we want; the code excludes those hosts itself).
5. Same page, **Allowed providers**: leave it empty (every provider) unless you want a restriction; the code already excludes China- and Singapore-hosted providers on every call. Troubleshooting: a restricted list blocks every model with no host on it, and each call then fails with "No allowed providers are available for the selected model ... your account's allowed-providers setting permits only: ..." (for insights this shows up only as `insights_failed` in the logs). The first eval key of 2026-11-05 allowed only `google-vertex`, `openai` and `anthropic`, which blocked `deepseek-v4-pro`, `kimi-k2.6` and `glm-5.2` until a dedicated key replaced it.

## 6. Webhook (after Claude's first deploy; 3 minutes)

Claude tells you when the Worker is live. Then:

1. App dashboard → WhatsApp use case → **Configuration** (for use-case apps: **Use cases → Customize → Configuration**).
2. Webhook card → **Edit**. Callback URL: `https://wapp-agent.alda-onggar.workers.dev/webhook`. Verify token: the `WHATSAPP_VERIFY_TOKEN` value from `.dev.vars`. → **Verify and save**. If it fails, the Worker is not up yet or the token differs; nothing is saved until it succeeds.
3. In **Webhook fields** → **Manage**, subscribe to **messages**. If the dialog has a version dropdown, pick the newest.
4. Subscribe the app to the Messaging account (idempotent; run it once). Replace the two placeholders:

```bash
curl -X POST "https://graph.facebook.com/v27.0/<MESSAGING_ACCOUNT_ID>/subscribed_apps" -H "Authorization: Bearer <WHATSAPP_TOKEN>"
```

Expected: `{"success":true}`.

5. Text the test number from your phone. The bot should answer within a few seconds.

Publishing: Meta's dashboard says an unpublished app only receives test webhooks sent from the dashboard itself, so real messages reach the Worker only once the app is published. Before switching: App settings → **Basic** → **Privacy policy URL** and **Terms of service URL** both `https://github.com/aldaonggar/wapp-agent/blob/main/PRIVACY.md` → **Save changes**. Then the **App mode** toggle in the top bar → **Live**. No business verification is needed for the test number.

## 7. Adding a reviewer (2 minutes each, needs the reviewer on the phone)

Meta's test number only talks to numbers on its recipient list, and the list is small (historically 5 including you). For each reviewer:

1. Ask for their WhatsApp number in international format.
2. API Setup → **To** → **Manage phone number list** → **Add phone number** → enter it → Meta sends a one-time code **to the reviewer's phone**.
3. The reviewer sends you the code; you enter it.
4. Add their digits-only number to `ALLOWED_PHONES` in `.dev.vars` (comma-separated) and tell Claude, or run it yourself:

```bash
npx wrangler secret put ALLOWED_PHONES   # paste the full comma-separated list when prompted
```

5. The reviewer must text first. The bot can only send free-form messages within 24 hours of a person's last message; it cannot start a conversation.

## 8. Braintrust (optional, 3 minutes)

Only for the eval dashboard; the Worker never needs it, and `npm run eval -- --braintrust` runs locally without it.

1. https://www.braintrust.dev → sign up (free tier) → create an organization if asked.
2. In the app's settings, open **API keys** → create one → copy it.
3. Put it in a new file `.env.braintrust` in the project root (git-ignored) as one line: `BRAINTRUST_API_KEY=<key>`. Do not add it to `.dev.vars`; it is not a Worker secret.
4. `npm run eval -- --braintrust` → the run appears as an experiment under the project `wapp-agent`, named after the configuration (a rerun gets a derived name).

## 9. Telegram bot (5 minutes)

A second way to reach the same agent; it needs nothing from Meta. Three values and one webhook call. Do it after Claude has deployed the Telegram code: an earlier deploy has no `/telegram` route and answers 404 to every update, and `getWebhookInfo` shows a `last_error_message` only after the first delivery attempt, so re-check it after pressing Start if nothing arrives.

1. In Telegram open **@BotFather** → `/newbot` → a display name (for example `wapp agent`) → a username ending in `bot` (for example `wapp_agent_bot`). BotFather answers with the token (`123456789:AA...`). Put it in `.dev.vars` as `TELEGRAM_BOT_TOKEN`.
2. Generate the webhook secret and put it in `.dev.vars` as `TELEGRAM_WEBHOOK_SECRET`:

```bash
openssl rand -hex 24
```

3. Decide who may talk to the bot and put it in `.dev.vars` as `ALLOWED_TELEGRAM`: comma-separated Telegram usernames (with or without `@`, any case) or numeric user ids, for example `@alda, 123456789`. **Empty means anyone who finds the bot can talk to it.** Someone without a username gets their id from `@userinfobot`. Anyone else is dropped and logged as `dropped_sender`.
4. Upload the values to the Worker (each command prompts; paste the value). Skip the third one if the list is empty.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ALLOWED_TELEGRAM
```

Until `TELEGRAM_WEBHOOK_SECRET` is uploaded, `/telegram` answers 404.

5. Register the webhook once, from the project root (the values are read from `.dev.vars` so they never land in your shell history):

```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' .dev.vars | cut -d= -f2-)
SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' .dev.vars | cut -d= -f2-)
curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d url=https://wapp-agent.alda-onggar.workers.dev/telegram -d "secret_token=$SECRET" \
  -d 'allowed_updates=["message","message_reaction"]' -d drop_pending_updates=true
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`. Check it:

```bash
curl -s "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

`url` must be the Worker's and there must be no `last_error_message`. `allowed_updates` must include `message_reaction`, or reactions never arrive.

6. Open `https://t.me/<bot username>`, press **Start**. The bot answers within a few seconds. To add a reviewer: send them that link; if `ALLOWED_TELEGRAM` is set, add their username or id to it first and re-run `npx wrangler secret put ALLOWED_TELEGRAM`. To open the bot to anyone again, delete the secret (`npx wrangler secret delete ALLOWED_TELEGRAM`); wrangler refuses an empty value.

A bot has one webhook at a time: pointing it at a staging Worker takes it away from production until step 5 is run again. A new secret also means running step 5 again.

## Known limits

See the README's [Known limits](README.md#known-limits).
