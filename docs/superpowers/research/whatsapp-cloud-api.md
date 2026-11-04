# WhatsApp Cloud API (Meta Graph API) — implementer reference

Researched 2026-11-04 from Meta's official docs. Meta moved the WhatsApp docs to
`https://developers.facebook.com/documentation/business-messaging/whatsapp/...`; every page there serves raw
markdown when you append `.md` (index: `https://developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt`).
Old `developers.facebook.com/docs/whatsapp/cloud-api/...` URLs mostly 404 or redirect. Quotes below are verbatim unless marked.
Anything the docs do not state is marked `UNCONFIRMED:`.

Abbreviations: `WA_DOCS = https://developers.facebook.com/documentation/business-messaging/whatsapp`.

---

## 1. Graph API version and base URL

- Base URL: `https://graph.facebook.com/<API_VERSION>/...`. `<API_VERSION>` is **optional** in every WhatsApp endpoint
  ("Graph API version. Optional." in each request-parameters table) but always pin it.
- Changelog table (https://developers.facebook.com/docs/graph-api/changelog): newest row is **v26.0**, introduced
  July 29, 2026, "Available Until: TBD". v25.0 (Feb 18, 2026, until Jul 29, 2028), v24.0 (Oct 8, 2025, until Feb 18, 2028).
- Current WhatsApp doc examples use **v26.0** (a few older pages still show v17.0/v19.0/v23.0). **Use `v26.0`.**
- UNCONFIRMED: the same changelog page has one line "The latest Graph API version is: v27.0" but v27.0 is absent from the
  table, has no date, and `/docs/graph-api/changelog/version27.0` returns 404 (re-checked 2026-11-04). Treat v27.0 as not yet usable.
- Status-webhook shape changed at v24.0 (see §3.3): the `conversation` object is omitted for v24.0+ webhooks. The webhook
  version is the one set for the app's Webhooks product in the App Dashboard ("You can change your Webhooks subscriptions,
  verify token, or API version at any time using the App Dashboard", Messenger webhooks doc), not the version in your send URL.

```ts
const GRAPH = "https://graph.facebook.com/v26.0";
// send:   POST `${GRAPH}/${PHONE_NUMBER_ID}/messages`
// media:  GET  `${GRAPH}/${MEDIA_ID}`   then GET <url> with the same Bearer token
```

---

## 2. Webhook verification (GET)

Source: `WA_DOCS/webhooks/create-webhook-endpoint`

Request Meta sends whenever Callback URL or Verify token is set/edited in the dashboard:

```
GET <CALLBACK_URL>?hub.mode=subscribe&hub.challenge=<HUB.CHALLENGE>&hub.verify_token=<HUB.VERIFY_TOKEN>
```

| param | doc text | example |
| --- | --- | --- |
| `hub.mode` | always `subscribe` | `subscribe` |
| `hub.challenge` | "A random string that Meta will generate." | `1158201444` |
| `hub.verify_token` | "A verification string of your own choosing. Store this string on your server." | `vibecoding` |

Response: "If the request is valid, respond with HTTP status `200` and the `hub.challenge` value. If the request is
invalid, respond with a 400-level HTTP status code, or anything other than status `200`."
Body is the raw challenge string (`text/plain`), not JSON, not quoted.

```ts
if (url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === env.WA_VERIFY_TOKEN) {
  return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
}
return new Response("forbidden", { status: 403 });
```

Dashboard: App Dashboard > WhatsApp > Configuration (or Use cases > Customize > Configuration), fields **Callback URL**
and **Verify token**, then subscribe to the **messages** field. Permissions needed to receive webhooks:
`whatsapp_business_messaging` for `messages` (and `calls`), `whatsapp_business_management` for all other fields
(`WA_DOCS/webhooks/overview`). Endpoint must have a valid public TLS cert ("Self-signed certificates are not supported").

Troubleshooting note from the overview page: "Make sure your app is in **Live** mode; some webhooks will not be sent if
your app is in **Dev** mode." The same page says to "Send a test payload to your endpoint via the App Dashboard > WhatsApp >
Configurations panel". UNCONFIRMED: that the Test button also sends while the app is in Dev mode (not stated anywhere; hint only).

---

## 3. Webhook POST payload — `messages` field

Sources: `WA_DOCS/webhooks/reference/messages`, `.../messages/text`, `/image`, `/audio`, `/sticker`, `/document`,
`/location`, `/contacts`, `/reaction`, `/status`, `/errors`, `/unsupported`, `/edit`, `/revoke`, `/video`.

### 3.1 Envelope (always)

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "<BUSINESS_DISPLAY_PHONE_NUMBER>",
              "phone_number_id": "<BUSINESS_PHONE_NUMBER_ID>"
            },
            "contacts": [ { "profile": { "name": "<WHATSAPP_USER_PROFILE_NAME>" }, "wa_id": "<WHATSAPP_USER_ID>",
                            "identity_key_hash": "<IDENTITY_KEY_HASH>" } ],
            "messages": [ ... ],
            "statuses": [ ... ],
            "errors":   [ ... ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

- Inbound user messages: `value.messages[]` present (and `value.contacts[]`). Outbound status updates: `value.statuses[]`
  present, no `contacts`. System/app/account errors: `value.errors[]`. Check which array exists; do not assume.
- `identity_key_hash` only if the identity-change-check feature is enabled; ignore.
- All string IDs/timestamps are **strings**. `timestamp` = "Unix timestamp indicating when the webhook was triggered"
  (seconds, as a string, e.g. `"1749416383"`). `latitude`/`longitude` are JSON numbers. `voice`/`animated`/`forwarded`
  are JSON booleans. Error `code` is an integer.
- `entry[].id` = WABA ("Messaging account") ID. `metadata.phone_number_id` = the business number the message hit; filter
  on it if more than one number shares the app.
- Common inbound message fields: `from` (user phone, see §9), `id` (`wamid.` + base64-ish), `timestamp`, `type`, and an
  object named after `type`. Optional: `context`, `referral` (Click-to-WhatsApp ad; ignore), `errors` (only with
  `type: "unsupported"`).
- Payloads can be up to **3 MB**. Batching: "aggregated and sent in a batch with a maximum of 1000 updates. However,
  batching cannot be guaranteed so be sure to adjust your servers to handle each POST request individually." Loop over
  every `entry[]`, `changes[]`, `messages[]`, `statuses[]`.

### 3.2 Inbound `messages[]` objects by `type`

Discriminator values in Meta's OpenAPI spec (`github.com/meta/openapi`, `business-messaging-api_v23.0.yaml`,
`IncomingMessage`): `text, reaction, audio, document, image, sticker, video, location, contacts, unsupported, unknown,
button, interactive, order`. The reference pages additionally document `edit` and `revoke`, but both carry the warning
"only available to WhatsApp Business app users (aka 'Coexistence')". On a plain Cloud API number (our test number) a user
edit arrives as `type: "unsupported"` with `unsupported.type: "edit"` (that is the unsupported page's own example).
UNCONFIRMED: whether a user delete produces any webhook at all on a non-Coexistence number (`revoke` is not in the
`unsupported.type` list).

```jsonc
// text
{ "from", "id", "timestamp", "type": "text", "text": { "body": "<MESSAGE_TEXT_BODY>" } }

// image  (caption optional; url rolling out since Nov 12, 2025, may be absent)
{ "type": "image", "image": { "caption": "<...>", "mime_type": "image/jpeg", "sha256": "<base64>", "id": "<MEDIA_ID>", "url": "<MEDIA_URL>" } }

// audio (voice note when voice:true; mime for voice notes is exactly "audio/ogg; codecs=opus")
{ "type": "audio", "audio": { "mime_type": "audio/ogg; codecs=opus", "sha256": "<base64>", "id": "<MEDIA_ID>", "url": "<MEDIA_URL>", "voice": true } }

// video
{ "type": "video", "video": { "caption": "<...>", "mime_type": "video/mp4", "sha256": "<...>", "id": "<MEDIA_ID>", "url": "<MEDIA_URL>" } }

// sticker
{ "type": "sticker", "sticker": { "mime_type": "image/webp", "sha256": "<...>", "id": "<MEDIA_ID>", "url": "<MEDIA_URL>", "animated": false } }

// document
{ "type": "document", "document": { "caption": "<...>", "filename": "<name.pdf>", "mime_type": "application/pdf", "sha256": "<...>", "id": "<MEDIA_ID>", "url": "<MEDIA_URL>" } }

// location (lat/long are numbers; name/address/url only for shared places)
{ "type": "location", "location": { "address": "<...>", "latitude": 37.4847, "longitude": -122.1477, "name": "<...>", "url": "<...>" } }

// contacts (every sub-property may be omitted by the sender's device)
{ "type": "contacts", "contacts": [ { "addresses": [ { "city","country","country_code","state","street","type","zip" } ],
    "birthday": "<...>", "emails": [ { "email","type" } ],
    "name": { "formatted_name","first_name","last_name","middle_name","suffix","prefix" },
    "org": { "company","department","title" }, "phones": [ { "phone","wa_id","type" } ], "urls": [ { "url","type" } ] } ] }

// reaction to one of OUR messages (emoji OMITTED when the user removes the reaction)
{ "type": "reaction", "reaction": { "message_id": "<OUR_WAMID>", "emoji": "👍" } }

// edit (Coexistence numbers only; user edited within 15 min of sending) — new message id, original in edit.original_message_id
{ "type": "edit", "edit": { "original_message_id": "<ORIGINAL_WAMID>", "message": { "context": { "id": "<CONTEXT_ID>" }, "type": "text|image|...", "text": { "body": "<new>" } } } }

// revoke (Coexistence numbers only; user deleted within 2 days)
{ "type": "revoke", "revoke": { "original_message_id": "<ORIGINAL_WAMID>" } }

// unsupported (polls, pins, group invites, etc.) — also carries errors[]
{ "type": "unsupported", "errors": [ { "code": 131051, "title": "Message type unknown", "message": "Message type unknown",
    "error_data": { "details": "Message type is currently not supported." } } ], "unsupported": { "type": "poll_update" } }
```

`unsupported.type` values: `button, edit, errors, gif, group_invite, hsm, image, interactive, keep_in_chat, link_preview,
list, location, media_placeholder, order, pin, poll_creation, poll_update, product, reaction`. Error code `131051` =
type not supported; `131060` = "This message is currently unavailable." (first message to a Business-app-onboarded number;
not our case).

`context` object on inbound messages (text/image/video refs):

```jsonc
// forwarded: exactly one of the two keys is present
"context": { "forwarded": true }              // forwarded 5 times or less
"context": { "frequently_forwarded": true }   // forwarded more than 5 times

// "Message business" button from a catalog product (documented); carries referred_product
"context": { "from": "<BUSINESS_DISPLAY_PHONE_NUMBER>", "id": "<CONTEXTUAL_WHATSAPP_MESSAGE_ID>",
             "referred_product": { "catalog_id": "<...>", "product_retailer_id": "<...>" } }
```

UNCONFIRMED: the text/media reference pages and the OpenAPI spec document `context.from`/`context.id` only for the catalog
"Message business" case. The `button` and `interactive` webhook references do document the same shape for replies to a
business message: `"context": { "from": "<BUSINESS_DISPLAY_PHONE_NUMBER>", "id": "<CONTEXTUAL_WHATSAPP_MESSAGE_ID>" }`
("WhatsApp message ID of the message containing the button the WhatsApp user tapped"). A plain user quote-reply ("Reply"
in the WhatsApp UI) has historically arrived with the same `{ from, id }` shape (old Webhooks Components page, now gone).
Code defensively: if `context.id` exists and `context.referred_product` does not, treat `context.id` as the quoted
message's wamid (it will be one of our outbound wamids or one of the user's own earlier wamids).

### 3.3 `statuses[]` (outbound message status)

```jsonc
{
  "id": "<OUR_WAMID>",
  "status": "sent" | "delivered" | "read" | "failed" | "played",
  "timestamp": "<unix seconds string>",
  "recipient_id": "<USER_PHONE_NUMBER_OR_GROUP_ID>",          // e.g. "16505551234"
  "recipient_type": "group", "recipient_participant_id": "<...>", // group sends only; ignore
  "recipient_identity_key_hash": "<...>",                      // only if identity change check enabled; ignore
  "biz_opaque_callback_data": "<...>",                         // only if we sent it
  "conversation": { "id": "<...>", "expiration_timestamp": "<unix, sent status only>", "origin": { "type": "service|utility|marketing|..." } },
  "pricing": { "billable": true, "pricing_model": "PMP", "type": "regular|free_customer_service|free_entry_point|...", "category": "service|utility|marketing|...", "subtype": "paid_exempt" }, // subtype only for exempt govt/non-profit orgs (since Oct 12, 2026)
  "errors": [ { "code": 131049, "title": "<...>", "message": "<...>", "error_data": { "details": "<...>" }, "href": "/documentation/business-messaging/whatsapp/support/error-codes" } ]
}
```

- Up to three webhooks per outbound message (`sent`, `delivered`, `read`). "when a user receives a message while in the
  chat screen ... the 'delivered' webhook is not sent because it's implied". Do not wait for `delivered` before `read`.
- `played`: first play of a voice message we sent (live since March 17, 2026).
- `failed`: carries `errors[]`; `recipient_id` present; no `conversation`/`pricing`.
- `conversation`: "Version 24.0 and higher: The conversation object will be omitted entirely, unless the webhook is for a
  message sent within an open free entry point window". Do not depend on it.
- `pricing`: "only included with sent status, and one of either delivered or read status" and appears in only one of
  them. `pricing_model` is `PMP` now (`CBP` only before July 1, 2025). `billable` is being deprecated: use
  `type` + `category`.
- Reaction messages we send trigger **only** a `sent` status.

### 3.4 Full examples

Text message that quotes (replies to) a previous message. Envelope copied from the official text example; `context`
block per the UNCONFIRMED note in §3.2:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "contacts": [{ "profile": { "name": "Sheena Nelson" }, "wa_id": "16505551234" }],
        "messages": [{
          "context": { "from": "15550783881", "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA" },
          "from": "16505551234",
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
          "timestamp": "1749416383",
          "type": "text",
          "text": { "body": "Does it come in another color?" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Image with caption (official example, `WA_DOCS/webhooks/reference/messages/image`):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "contacts": [{ "profile": { "name": "Sheena Nelson" }, "wa_id": "16505551234" }],
        "messages": [{
          "from": "16505551234",
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
          "timestamp": "1744344496",
          "type": "image",
          "image": {
            "caption": "Taj Mahal",
            "mime_type": "image/jpeg",
            "sha256": "SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=",
            "id": "1003383421387256",
            "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133..."
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Voice note (official example, `WA_DOCS/webhooks/reference/messages/audio`):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "contacts": [{ "profile": { "name": "Sheena Nelson" }, "wa_id": "16505551234" }],
        "messages": [{
          "from": "16505551234",
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
          "timestamp": "1744344496",
          "type": "audio",
          "audio": {
            "mime_type": "audio/ogg; codecs=opus",
            "sha256": "wvqXMe6n7n1W0zphvLPoLj+s/NtKqmr3zZ7YzTP7xFI=",
            "id": "1908647269898587",
            "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133...",
            "voice": true
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Reaction (official example, `WA_DOCS/webhooks/reference/messages/reaction`; removal = same payload without `emoji`):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "contacts": [{ "profile": { "name": "Sheena Nelson" }, "wa_id": "16505551234" }],
        "messages": [{
          "from": "16505551234",
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
          "timestamp": "1749419544",
          "type": "reaction",
          "reaction": { "message_id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=", "emoji": "👍" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Status update, v24.0+ shape (official examples, `WA_DOCS/webhooks/reference/messages/status`):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "statuses": [{
          "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
          "status": "sent",
          "timestamp": "1750030073",
          "recipient_id": "16505551234"
        }]
      },
      "field": "messages"
    }]
  }]
}
```

Status `delivered` with pricing for a service message within the free tier (pricing block verbatim from `WA_DOCS/pricing`):

```json
{ "id": "wamid....", "status": "delivered", "timestamp": "1750263773", "recipient_id": "16505551234",
  "pricing": { "billable": false, "pricing_model": "PMP", "type": "free_customer_service", "category": "service" } }
```

Status `failed` (official):

```json
{ "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA", "status": "failed", "timestamp": "1751142888",
  "recipient_id": "16505551234",
  "errors": [{ "code": 131049, "title": "This message was not delivered to maintain healthy ecosystem engagement.",
    "message": "This message was not delivered to maintain healthy ecosystem engagement.",
    "error_data": { "details": "In order to maintain a healthy ecosystem engagement, the message failed to be delivered." },
    "href": "/documentation/business-messaging/whatsapp/support/error-codes" }] }
```

Account-level error webhook (`value.errors`, official example): `{ "code": 130429, "title": "Rate limit hit",
"message": "Rate limit hit", "error_data": { "details": "Message failed to send because there were too many messages sent
from this phone number in a short period of time" }, "href": "..." }`.

---

## 4. Signature verification, response, retries, dedupe

Source: `WA_DOCS/webhooks/create-webhook-endpoint`, `WA_DOCS/webhooks/overview`, `WA_DOCS/throughput`,
https://developers.facebook.com/docs/graph-api/webhooks/getting-started

Request Meta sends:

```
POST <CALLBACK_URL>
Content-Type: application/json
X-Hub-Signature-256: sha256=<SHA256_PAYLOAD_HASH>
Content-Length: <bytes>
<JSON_PAYLOAD>
```

`<SHA256_PAYLOAD_HASH>`: "HMAC-SHA256 hash, calculated using the post body payload and your app secret as the secret
key." Example value `b63bb356dff0f1c24379efea2d6ef0b2e2040853339d1bcf13f9018790b1f7d2` (lowercase hex, 64 chars).
Validation: "Generate an HMAC-SHA256 hash using the JSON payload as the message input and your app secret as the secret
key. Compare your generated hash to the hash assigned to the X-Hub-Signature-256 header (everything after sha256=)."
Use the **raw request bytes** (`await request.text()` once, verify, then `JSON.parse` that same string). Never
re-serialize. Compare constant-time. App Secret = App Dashboard > App settings > Basic > App secret.
UNCONFIRMED: current docs say nothing about unicode escaping of the signed payload; using the raw bytes sidesteps it.

```ts
async function verify(raw: string, header: string | null, secret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
```

Response: "If the request is valid, respond with HTTP status 200. Otherwise, respond with a 400-level HTTP status, or
anything other than status 200." Return 200 **fast** and do the work after (Workers: `ctx.waitUntil`, or hand the
parsed payload to the DO and return). Latency standard (`WA_DOCS/throughput`): "Median latency not to exceed 250ms.
Less than 1% latency exceeds 1s." No explicit timeout is documented (UNCONFIRMED: the exact cutoff).

Retry policy (WhatsApp pages): "If a webhook request to your endpoint receives an HTTP status code other than 200, or if
the webhook cannot be delivered for another reason, Meta retries delivery with decreasing frequency until the request
succeeds, for up to 7 days." / "retried immediately, then a few more times with decreasing frequency over the next 7
days" / "Meta attempts to re-deliver failed webhooks for up to 7 days, with exponential backoff." / "Unacknowledged
responses will be dropped after 7 days." (The generic Graph API webhooks page still says 36 hours; the WhatsApp pages
are newer and specific.) Exact schedule is not published.

Duplicates: "Meta sends retries to all apps that have subscribed to webhooks ... These retries can result in duplicate
webhook notifications." / "Your server should handle deduplication in these cases." Dedupe key: `messages[].id` for
inbound (one wamid per message; `edit`/`revoke`/`reaction` events have their own new wamid) and
`statuses[].id + statuses[].status` for statuses. Keep a `seen(wamid)` table in the per-contact DO.

Also: "There are no APIs for fetching historical webhook data, so capture and store webhook payloads accordingly."
Webhook servers must handle concurrent requests ("Meta attempts to deliver webhooks concurrently"); two webhooks for the
same contact can race into the same DO, so the DO is the serialization point.

Ordering: not guaranteed anywhere in the docs. Sort by `timestamp` only for display; process in arrival order.

mTLS / IP allowlists exist (`WA_DOCS/webhooks/overview`) but the signature check is sufficient for us.

---

## 5. Sending — `POST /{phone_number_id}/messages`

Sources: `WA_DOCS/messages/send-messages`, `.../text-messages`, `.../contextual-replies`, `.../reaction-messages`,
`.../mark-message-as-read`, `WA_DOCS/typing-indicators`.

Headers: `Content-Type: application/json`, `Authorization: Bearer <ACCESS_TOKEN>` (system token).
2026 account model: add `"messaging_account_id": "<WABA_ID>"` to the body only if the token "has messaging access to more
than one Messaging account on this business phone number"; with exactly one, "omit it and Meta resolves the account for you"
(`WA_DOCS/messages/send-messages`). Our setup has one, so omit.

### 5.1 Text

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "text",
  "text": { "preview_url": true, "body": "As requested, here's the link to our latest product: https://www.meta.com/quest/quest-3/" }
}
```

- `text.body`: required, "Maximum 4096 characters." Client auto-links URLs.
- `text.preview_url`: optional boolean; previews only the **first** URL, which must start with `http://`/`https://`.
- `recipient_type`: `individual` (or `group`); include it.

### 5.2 Reply quoting a message (contextual reply)

Add `context.message_id` to any send body (`WA_DOCS/messages/contextual-replies`, example uses v19.0 but the field is
unchanged):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "context": { "message_id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQTdCNTg5RjY1MEMyRjlGMjRGNgA=" },
  "type": "text",
  "text": { "body": "You're welcome, Pablo!" }
}
```

Limits: "You cannot send a reaction message as a contextual reply." The quote bubble is dropped silently if the quoted
message is >30 days old / deleted, or the reply is a template. Sending still succeeds.

### 5.3 Reaction

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "reaction",
  "reaction": { "message_id": "wamid.HBgLMTY0NjcwNDM1OTUVAgASGBQzQUZCMTY0MDc2MUYwNzBDNTY5MAA=", "emoji": "😀" }
}
```

- `emoji`: "Unicode escape sequence of the emoji, or the emoji itself". Response is the normal `messages[].id` shape.
- Target "more than 30 days old, doesn't correspond to any message in the chat thread, has been deleted, or is itself a
  reaction message" => not delivered; you get a `messages` webhook with error `131009` (async, HTTP call still 200).
- Only a `sent` status webhook follows; never `delivered`/`read`.
- UNCONFIRMED: removing a reaction by sending `"emoji": ""`. The current page does not mention removal (the old page did).

### 5.4 Mark as read

```json
{ "messaging_product": "whatsapp", "status": "read", "message_id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA" }
```

Response `{ "success": true }`. "Mark incoming messages as read within 30 days of receipt. When you mark a message as
read, the API also marks earlier messages in the conversation as read." Invalid id => `131009`. Only inbound wamids.

### 5.5 Typing indicator (also marks as read)

```json
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA",
  "typing_indicator": { "type": "text" }
}
```

Response `{ "success": true }`. "The typing indicator will be dismissed once you respond, or after 25 seconds, whichever
comes first. To prevent a poor user experience, only display a typing indicator if you are going to respond." It is tied
to a received message's wamid, so you can only show it after an inbound message, not before a proactive send. For
replies that take >25 s, re-send the same request to re-arm (UNCONFIRMED: docs do not say whether re-sending extends it).
UNCONFIRMED: no restriction for test numbers is documented; none expected.

### 5.6 Success response (all sends)

```json
{
  "messaging_product": "whatsapp",
  "contacts": [ { "input": "+16505551234", "wa_id": "16505551234" } ],
  "messages": [ { "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA", "message_status": "<PACING_STATUS>" } ]
}
```

- "This response only indicates that the API successfully **accepted your request** — it does not indicate successful
  delivery." Delivery/failure arrives via status webhooks (e.g. `failed` + `131049`, `131026`).
- `message_status` is "only included in responses when sending a template message that uses a template that is being
  paced"; values `accepted` / `held_for_quality_assessment` (`WA_DOCS/templates/template-pacing`). Never present for
  text/reaction. Treat as optional. `group_id` appears only for group sends.
- `contacts[].wa_id` is the canonical user ID; store it. `input` echoes what you sent. "May not match."
- Store `messages[].id`: status webhooks reference it, and user reactions/quotes reference it.

### 5.7 Error response and codes to handle

Source: `WA_DOCS/support/error-codes`. Meta: "build your app's error handling logic around `code` values and `details`";
`error_subcode` is deprecated and "Will not be returned in v16.0+ responses"; do not key on HTTP status or `message`.

```json
{
  "error": {
    "message": "(#130429) Rate limit hit",
    "type": "OAuthException",
    "code": 130429,
    "error_data": { "messaging_product": "whatsapp", "details": "Cloud API message throughput has been reached." },
    "error_subcode": 2494055,
    "fbtrace_id": "Az8or2yhqkZfEZ-_4Qn_Bam"
  }
}
```

| code | `details` (verbatim or close) | what to do |
| --- | --- | --- |
| `0` | "We were unable to authenticate the app user." | token expired/invalidated; rotate token, alert |
| `190` | "Your access token has expired." | same; the dashboard temp token dies within ~a day (§7) |
| `10`, `200`-`299`, `131005`, `3` | permission not granted / removed; `200` also = system user lacks asset access (`WA_DOCS/access-tokens`) or no token sent at all ("Provide valid app ID") | fix token permissions / asset access; not retryable |
| `100` | "The request included one or more unsupported or misspelled parameters." | bug in body; log + drop. (HTTP 400 in the one table that lists statuses) |
| `131008` / `131009` | missing / invalid parameter value (bad wamid, bad `to`) | drop; `131009` also arrives async for bad reactions / mark-read |
| `131030` | "Recipient phone number is not in allowed list." HTTP 400. "Only occurs when using public test numbers (PTNs)." "Add a recipient phone number to recipient list and try again." (`WA_DOCS/calling/troubleshooting/`, the only page that lists it) | test-number recipient not added in the dashboard; not retryable |
| `131047` | "More than 24 hours have passed since the recipient last replied to the sender number." | outside the customer service window; only a template may be sent. Do not retry free-form |
| `131026` | "Unable to deliver message." Not a WhatsApp number / ToS not accepted / old client | not retryable |
| `131021` | "Sender and recipient phone number is the same." | drop |
| `130429` | "Cloud API message throughput has been reached." (80 mps per number) | backoff + retry |
| `131056` | "Too many messages sent from the sender phone number to the same recipient phone number in a short period of time." (pair limit, §8) | per-recipient backoff `4^X` s, retry; other recipients unaffected |
| `4` / `80007` | app / WABA API call rate limit | backoff; see §8 |
| `131048` | sending restricted (quality/spam) | stop, alert |
| `131049` | "This message was not delivered to maintain healthy ecosystem engagement." (marketing per-user limit; arrives as a `failed` status) | do not retry for 24 h |
| `131051` | unsupported message type | bug |
| `131052` / `131053` | cannot download user media / cannot upload our media (bad MIME) | tell user / fix MIME |
| `131057` | "Business Account is in maintenance mode" (throughput upgrade, ≤1 min) | retry after a minute |
| `131000`, `1`, `2`, `131016`, `133004` | unknown / server / temporarily unavailable | retry with backoff |
| `368`, `131031` | WABA restricted / disabled for policy | stop, alert |
| `133010`, `131045`, `33` | number not registered / registration error / number deleted | config problem |
| `131042` | payment method problem | relevant once the free tier is used (§7.4) |

HTTP status: the docs deliberately do not document it ("Build your app's error handling around error codes instead of
subcodes or HTTP response status codes"); where shown it is `400`. UNCONFIRMED: whether any Cloud API throttle returns
HTTP `429`. Parse the JSON `error.code` on every non-2xx and also on 2xx bodies that contain `error`.

Errors are "returned either synchronously as a Graph API response, asynchronously via Webhook, or sometimes through both
methods." So a 200 on send can still be followed by a `failed` status webhook.

---

## 6. Media

Source: `WA_DOCS/business-phone-numbers/media`, `WA_DOCS/messages/audio-messages`.

### 6.1 Get URL from a media id

```
GET https://graph.facebook.com/v26.0/<MEDIA_ID>?phone_number_id=<BUSINESS_PHONE_NUMBER_ID>
Authorization: Bearer <ACCESS_TOKEN>
```

`phone_number_id` is optional ("If included, the request will only be processed if the business phone number ID included
in the query matches the ID of the business phone number that the media was uploaded on" — include it as a guard).

```json
{
  "messaging_product": "whatsapp",
  "url": "<MEDIA_URL>",
  "mime_type": "<MEDIA_MIME_TYPE>",
  "sha256": "<SHA_256_HASH>",
  "file_size": "<MEDIA_FILE_SIZE>",
  "id": "<MEDIA_ID>"
}
```

- "Media URLs **expire after 5 minutes**, after which you must query the ID again to get a new URL."
- Inbound webhooks now include `url` directly (rolling out since Nov 12, 2025, "may not be available to you
  immediately"). If present, you can skip this GET; still fall back to the GET when `url` is missing or the download 404s.
- "Media IDs in webhooks expire after 7 days." (API-returned upload IDs: 30 days.) Download promptly.

### 6.2 Download

```
GET <MEDIA_URL>
Authorization: Bearer <ACCESS_TOKEN>
```

"Include your access token in the request. If you omit your token, the request will fail." Response is the binary with a
`content-type` header. "If the download attempt fails, you will receive a `404 Not Found` response code. In that case,
try to get a new media URL and download it again. If doing so doesn't resolve the issue, renew your access token."
URL host is `lookaside.fbsbx.com`. UNCONFIRMED: any User-Agent requirement (none documented; Workers' default fetch is
fine in practice — hint, not doc).

```ts
async function fetchMedia(id: string, env: Env): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const meta = await (await fetch(`${GRAPH}/${id}?phone_number_id=${env.WA_PHONE_NUMBER_ID}`,
    { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } })).json<{ url: string; mime_type: string }>();
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  if (!r.ok) throw new Error(`media ${id}: ${r.status}`); // 404 => re-GET the id once, then give up
  return { bytes: await r.arrayBuffer(), mime: r.headers.get("content-type") ?? meta.mime_type };
}
```

### 6.3 Supported inbound/outbound types and sizes (verbatim table values)

| kind | MIME | max |
| --- | --- | --- |
| audio | `audio/aac`, `audio/amr`, `audio/mpeg`, `audio/mp4`, `audio/ogg` ("OPUS codecs only; base audio/ogg not supported; mono input only") | 16 MB |
| document | `text/plain`, `application/pdf`, `application/msword`, `.docx`, `application/vnd.ms-excel`, `.xlsx`, `application/vnd.ms-powerpoint`, `.pptx` | 100 MB |
| image | `image/jpeg`, `image/png`, `image/webp` (static) — "Images must be 8-bit, RGB or RGBA"; >4096 px on an edge rejected | 5 MB |
| sticker | `image/webp` static 100 KB, animated 500 KB | |
| video | `video/mp4`, `video/3gpp` (H.264 + AAC only) | 16 MB |

- Inbound hard cap: "The maximum supported file size for media messages on Cloud API is 100MB" — larger files arrive as a
  webhook with error `131052` ("Media file size too big...").
- Voice notes: inbound `audio.mime_type` is `audio/ogg; codecs=opus` with `audio.voice: true`. Whisper on Workers AI
  accepts the bytes as-is. Outbound voice note: `"type":"audio","audio":{"id":"<MEDIA_ID>","voice":true}` with an OPUS
  .ogg; "The play icon will only appear if the file is 512KB or smaller".
- Mismatched MIME vs extension is the most common upload error (`131053`).

### 6.4 Upload (only if we ever send media)

`POST /<PHONE_NUMBER_ID>/media`, multipart: `messaging_product=whatsapp`, `file=@path;type=<MIME>`, `type=<MIME>`.
Response `{ "id": "<MEDIA_ID>" }`. Uploaded media "persist for 30 days". Delete: `DELETE /<MEDIA_ID>`.

---

## 7. Test business number, tokens, customer service window, messaging limits

### 7.1 Test resources (what the docs actually say)

`WA_DOCS/about-the-platform` § Test resources: "When you get started with Cloud API, a test WhatsApp account, test
Messaging account, and test business phone number are automatically created for you. Test accounts and test phone
numbers are useful for testing purposes, as they have relaxed messaging limits and don't require a payment method on file
in order to send template messages."

`WA_DOCS/get-started` Step 3: "Select a **From** phone number, or add a new one ... Add a **To** phone number that will
receive the test message ... Once you receive the message you sent, make sure to reply back to keep the conversation
going." The dashboard "To" list is the recipient allow-list.

Recipient not on the list => send fails with `131030` "Recipient phone number is not in allowed list." (§5.7).

UNCONFIRMED (not in any current official page, re-checked 2026-11-04; the retired `docs/whatsapp/cloud-api/get-started`
URL now redirects to the new guide, and its indexed snippet "send free messages to up to 5 recipient phone numbers" /
"recipient will receive a confirmation code in WhatsApp" survives only in search engines and third-party guides):
- the allow-list maximum is **5** recipient numbers;
- each recipient is verified by entering a one-time code the dashboard sends to that phone (WhatsApp/SMS);
- whether the `messages` webhook still fires when a non-listed number texts the test number (hint: it does fire; only the
  reply fails with 131030);
- any throughput/messaging limit specific to the test number beyond "relaxed messaging limits".
Plan for: you + each reviewer added and OTP-verified in App Dashboard > WhatsApp > API Setup > "To" before they text.

### 7.2 Access tokens

`WA_DOCS/access-tokens`, `WA_DOCS/get-started` Step 5, `WA_DOCS/permissions`:
- Dashboard token = User access token ("temporary access token" in `WA_DOCS/get-started`): "expire quickly, so you have to
  keep generating a new one every few hours"; the API Setup panel "always generates a new User access token whenever you
  visit it". UNCONFIRMED: exact lifetime (commonly 24 h — hint). Do not deploy with it.
- Permanent token = **System user access token**: Business Settings > System users > Add (Admin or Employee) >
  Assign assets: the app (**Manage app**, Full control) and the WhatsApp account (**Manage WhatsApp Business accounts**,
  Full control) > Generate token with permissions **`business_management`, `whatsapp_business_messaging`,
  `whatsapp_business_management`**. Choose "never expire" when prompted (expiration preference is offered).
- `whatsapp_business_messaging` — "needed to send any type of message to WhatsApp users, and to receive incoming message
  and message status webhooks". `whatsapp_business_management` — account metadata, templates, phone numbers, analytics,
  other webhooks. Missing asset access => error code `200` ("not to be confused with HTTP status code 200").
- Token is opaque; "Use a variable-length data type without a specific maximum size".

### 7.3 Customer service window (24 h) — free-form vs template

`WA_DOCS/messages/send-messages` § Customer service windows: "When a WhatsApp user messages you or calls you, a 24-hour
timer called a customer service window starts. If the user messages or calls you again before the timer expires, the
timer resets to 24 hours. While the window is open, you can send any of the following service message types to the user.
When the window closes, you can only send pre-approved template messages." Known issue: "In rare cases, you may receive
a message from a WhatsApp user but be unable to respond within the customer service window."

- Inside window: text, reaction, media, location, interactive, etc. (all "service messages"). Reactions/typing/mark-read
  are in-window actions too.
- Outside window: template only; free-form send returns `131047`. For this agent: track `last_inbound_ts` per contact in
  the DO; a proactive check-in after `now - last_inbound_ts > 24h` must be a template (or be skipped). Any user message,
  including a reaction or an unsupported type, reopens the window (UNCONFIRMED whether a bare reaction webhook counts as
  "messages you" — assume no, require a real message).
- Business-initiated = our message outside a window (templates). User-initiated = anything inside the window.

hello_world template (the dashboard's pre-approved test template; name confirmed in `WA_DOCS/get-started`, body shape from
`WA_DOCS/templates/overview` template-send syntax):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "template",
  "template": { "name": "hello_world", "language": { "code": "en_US" } }
}
```

### 7.4 Messaging limits (the "250/day") and pricing

`WA_DOCS/messaging-limits`: "Messaging limits are the maximum number of unique WhatsApp user phone numbers your business
can deliver messages to, outside of a customer service window, within a moving 24-hour period." Set per business
portfolio (since Oct 7, 2025). "Newly created business portfolios have a messaging limit of 250", then 2,000 (verify the
business, or 2,000 delivered templates to unique users in 30 days), 10,000, 100,000, unlimited (automatic).
Check: `GET /<PHONE_NUMBER_ID>?fields=whatsapp_business_manager_messaging_limit` => `"TIER_250"`.
Replies inside a window do **not** count. For ≤5 reviewers this limit is irrelevant.

Pricing (`WA_DOCS/pricing`, live since Oct 1, 2026): service messages (anything free-form inside the window) have "a free
tier of 1,000 delivered service messages per month" per business phone number; "Meta charges as of the 1,001st". "If
businesses do not have a payment method for their Messaging account(s), Meta will deliver service messages within the
free tier but _not_ deliver them after the free tier has been used." Status webhooks show `pricing.type`
`free_customer_service` while in the tier and `regular` once charged. UNCONFIRMED: whether the test number's "relaxed
limits" exempt it from the 1,000/month cap; budget for ≤1,000 outbound messages/month per number or add a payment method.
Templates are billed per **delivered** message whether or not a window is open (marketing always; utility inside an open
window is also charged since Oct 1, 2026; only a free-entry-point window makes them free). Test numbers "don't require a
payment method on file in order to send template messages" (`WA_DOCS/about-the-platform`). UNCONFIRMED: hello_world's
category (utility?).

---

## 8. Rate limits and throughput (single test number)

Sources: `WA_DOCS/throughput`, `WA_DOCS/about-the-platform` § Rate limits, `WA_DOCS/support/error-codes`.

- Throughput: "For each registered business phone number, Cloud API supports up to 80 messages per second (mps) by
  default" (inbound + outbound, all types). Exceeding => `130429` "until you are within your allowed level again".
- **Pair rate limit** (same business number -> same user): "Business phone numbers can send 1 message every 6 seconds to
  the same WhatsApp user (0.17 messages/second), which equals about 10 messages per minute or 600 per hour. Exceeding this
  limit triggers error code 131056 until you are back within the allowed rate. You may send up to 45 messages in a
  6-second burst, but this 'borrows' from your future quota. After a burst, you must wait the equivalent time it would
  take to send those messages at the normal rate (for example, a burst of 20 requires a ~2-minute wait before sending more
  to that user). To manage post-burst throttling, if a send request fails, retry after 4^X seconds (starting with X=0 and
  increasing X by 1 after each failure) until successful." => the per-contact DO should serialize sends and, on
  `131056`, sleep `4^X` s (1, 4, 16, 64 ...) via alarm. Do not split one reply into many bubbles in a tight loop.
- App-level request limit (management endpoints like `/<WABA_ID>/message_templates`, `/subscribed_apps`, `/phone_numbers`;
  **not** `/messages`): 200 requests/hour per app per WABA, 5,000/hour for active WABAs with a registered number.
  Errors `4` (app) / `80007` (WABA). Usage headers: Graph API `X-Business-Use-Case-Usage` with
  `estimated_time_to_regain_access` in minutes.
- Typing indicators and mark-as-read are POSTs to `/messages`; UNCONFIRMED whether they count toward the pair limit
  (docs say throughput "is inclusive of inbound and outbound messages and all message types"; treat read/typing as cheap
  but do not spam them).
- HTTP 429: not documented for Cloud API (UNCONFIRMED). Handle throttling by `error.code` ∈ {4, 80007, 130429, 131056}
  regardless of status; also honor a `Retry-After` header if one ever appears.
- Delivery order: "the order in which messages are delivered is not guaranteed to match the order of your API requests.
  If you need to ensure the sequence of message delivery, confirm receipt of a `delivered` status ... before sending the
  next message." For multi-bubble replies, await the HTTP response of bubble N before sending N+1 at minimum.
- Message TTL: undeliverable messages are retried by Meta for 30 days (non-auth), then dropped without a `failed` status
  guaranteed: "If you do not receive a status messages webhook with status set to delivered before the TTL is exceeded,
  assume the message was dropped."

---

## 9. Identifiers, phone formats, and other gotchas

- `wamid` format: string starting with `wamid.` followed by base64-looking text, e.g.
  `wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=`. Opaque; store as TEXT; unique per message; the same
  wamid identifies the message in later status webhooks, user reactions (`reaction.message_id`), edits
  (`edit.original_message_id`), revokes, and quote-replies.
- `messages[].from`: in every official example payload it is digits without `+` (`"16505551234"`), identical to
  `contacts[].wa_id` and to `statuses[].recipient_id`. The parameter tables describe it as "WhatsApp user phone number.
  This is the same value returned by the API as the `input` value when sending a message" (table example `+16505551234`)
  and warn "a WhatsApp user's phone number and ID may not always match". Key the per-contact DO on `from` for inbound and
  on `recipient_id` for statuses; store `wa_id` from `contacts[]` alongside. For the five reviewers these are the same.
- `to` when sending: "Plus signs (+), hyphens (-), parenthesis and spaces are supported ... We highly recommend that you
  include both the plus sign and country calling code ... If the plus sign is omitted, your business phone number's
  country calling code is prepended to the customer's phone number." The table shows `1 (631) 555-1234` becoming
  `+9116315551234` for an Indian business. Sending bare `wa_id` digits is universal practice and works (hint), but the
  one-character-safe choice is `to: "+" + from`. Brazil/Mexico: Cloud API may normalize the extra prefix digit.
- Profile name: `value.contacts[0].profile.name` on every inbound message webhook (not on statuses). It is the user's
  self-set WhatsApp name; can change; may be empty-ish. Not available for outbound-only contacts until they message.
- `context.forwarded` / `frequently_forwarded`: only one is present, only when forwarded; treat forwarded content as
  not authored by the user.
- Reactions: inbound `reaction.emoji` absent = removal. Users can only react to our messages ≤30 days old.
- On Coexistence numbers only, edits arrive as `type: "edit"` with a **new** wamid plus `edit.original_message_id` and
  revokes as `type: "revoke"`. On our Cloud API test number an edit arrives as `type: "unsupported"` /
  `unsupported.type: "edit"` with no new text (ignore it; do not treat it as a new turn); a delete likely produces nothing.
- `statuses[].status === "read"` can arrive without a prior `delivered`.
- `message_status` in the send response exists only for paced templates; `conversation` in status webhooks is gone in
  v24.0+. Do not require either.
- Webhook JSON is signed over the exact bytes; do not use a framework that re-parses before you can read `request.text()`.
- One webhook request can contain many `entry`/`changes`/`messages`; a single POST may mix several contacts. Fan out per
  `from` to the right DO, then return 200.
- Dedupe both inbound wamids and `(status wamid, status)` pairs; Meta explicitly re-delivers.
- App must be **Live** (not Dev) for all webhooks to flow; the dashboard `messages` Test button works in both modes.
- Payload size ≤3 MB; no historical replay API.

---

## 10. UNCONFIRMED items (collected)

1. Graph API `v27.0` availability (changelog names it as latest but lists no date; its page 404s). Using `v26.0`.
2. Inbound `context: { from, id }` for an ordinary user quote-reply (text/media pages and the spec document `context` only
   for the catalog "Message business" button and for `forwarded`; the `button`/`interactive` pages show the same
   `{ from, id }` shape for taps on our messages).
3. Unicode-escaping caveat for the signed webhook body (not in current docs; verify over raw bytes).
4. Exact webhook response timeout before Meta counts a delivery as failed (only the 250 ms median / 1 s p99 standard is
   published) and the exact retry schedule (only "decreasing frequency / exponential backoff, up to 7 days").
5. Removing a reaction with `"emoji": ""` (old docs; absent from the current page).
6. Whether re-sending the typing-indicator request after 25 s re-arms it; any test-number restriction on typing
   indicators (none documented).
7. Whether any Cloud API throttle returns HTTP 429 (docs say key on `error.code`; examples show 400).
8. Test number: 5-recipient allow-list cap, OTP verification flow, whether webhooks fire for non-listed senders, and any
   test-number-specific throughput/monthly caps (only "relaxed messaging limits" is official; the 5/OTP wording exists
   only as a search-engine snippet of the retired get-started page).
9. Dashboard temporary token lifetime (docs: "expires quickly" / "short-lived"; 24 h is folklore).
10. Whether typing/mark-read POSTs count toward the 1-per-6-s pair limit.
11. Whether the test number's "relaxed limits" exempt it from the 1,000 free service messages/month (live since
    Oct 1, 2026) and what happens past 1,000 with no payment method on a test account.
12. Whether a bare inbound reaction reopens the 24 h customer service window.
13. Any User-Agent requirement when downloading from `lookaside.fbsbx.com` (none documented).
14. Whether a user delete ("revoke") produces any webhook on a non-Coexistence Cloud API number (an edit arrives as
    `unsupported`/`edit`; `revoke` is absent from the `unsupported.type` list).
15. Whether the dashboard Test button sends while the app is in Dev mode (docs only say some webhooks need Live mode).
16. hello_world template category (utility?); only its name is documented.

---

## Verification (2026-11-04)

Checked ~140 concrete claims (paths, methods, field names, JSON types, limits, dates, version numbers, quoted text)
against 40 official sources: 38 pages under `WA_DOCS/*.md` (webhooks overview/create-endpoint/all `messages` sub-references
incl. `button`, `interactive`, `status`, `edit`, `revoke`, `unsupported`, `errors`; send-messages, text, contextual-replies,
reaction, mark-as-read, typing-indicators, error-codes, media, audio-messages, about-the-platform, get-started,
access-tokens, permissions, messaging-limits, pricing, pricing/non-template-messages, throughput, templates/overview,
templates/template-pacing, calling/troubleshooting, upcoming-messaging-limits-changes), the Graph API changelog, the
generic Graph API webhooks getting-started page, the Graph API rate-limiting page, and `meta/openapi`
`business-messaging-api_v23.0.yaml`. Everything not listed below matched the source verbatim or in substance.

Corrections made (before -> after, source):

1. "`edit`/`revoke` are general inbound types" -> both pages warn they are "only available to WhatsApp Business app users
   (aka 'Coexistence')"; on a Cloud API number an edit arrives as `unsupported`/`edit`
   (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/edit.md,
   .../revoke.md, .../unsupported.md). §3.2, §9, §10 updated.
2. "Dashboard Test button works in both modes" -> not stated in any doc; now UNCONFIRMED
   (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview.md).
3. "Templates ... billed per message when outside a window" -> billed per delivered message regardless of window; utility
   inside a window charged since Oct 1, 2026; FEP window is the only free case
   (https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md).
4. "Every WhatsApp doc example uses v26.0" -> current examples use v26.0, some older pages show v17/v19/v23
   (about-the-platform.md, contextual-replies.md, get-started.md).
5. "Status-webhook shape changed at v24.0 (see §3.4)" -> §3.3 (internal cross-reference).
6. Webhook version "is the app's configured Graph API version" -> is the API version set on the app's Webhooks product
   (https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks).
7. §3.3 status shape: added `recipient_type`/`recipient_participant_id` (groups), `recipient_identity_key_hash`,
   `pricing.subtype: paid_exempt` (since Oct 12, 2026), and `expiration_timestamp` is `sent`-only
   (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status.md).
8. §5 send body: added `messaging_account_id` rule (required only with >1 Messaging account on the number)
   (https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages.md).
9. §5.6: `message_status` values confirmed as `accepted` / `held_for_quality_assessment`; added `group_id`
   (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing.md).
10. §5.7 code `200`: also returned when no token is sent ("Provide valid app ID")
    (https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes.md).
11. §3.2 `context` note: `button`/`interactive` references document `context: { from, id }` for taps on business messages
    (.../webhooks/reference/messages/button.md, .../interactive.md); quote-reply case still UNCONFIRMED.
12. §7.2: dashboard token wording aligned to docs ("temporary access token"; panel "always generates a new User access
    token") (https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens.md, get-started.md).
13. §7.1: noted that the 5-recipient/OTP text exists only as an indexed snippet of the retired
    `docs/whatsapp/cloud-api/get-started` URL (which now redirects to the new guide); still UNCONFIRMED.

Confirmed items worth calling out (no change needed): v26.0 (Jul 29, 2026), v25.0 (Feb 18, 2026 -> Jul 29, 2028),
v24.0 (Oct 8, 2025 -> Feb 18, 2028) and the dangling "latest is v27.0" line whose page 404s
(https://developers.facebook.com/docs/graph-api/changelog); 7-day retry on WhatsApp pages vs 36 h on the generic page
(https://developers.facebook.com/docs/graph-api/webhooks/getting-started); `131030` only on
calling/troubleshooting (HTTP 400); media URL 5 min / webhook media ID 7 days / upload 30 days; 1,000 free service
messages per number per month since Oct 1, 2026 and non-delivery past the tier without a payment method; pair limit
1 msg/6 s, 45-burst, `4^X` backoff; `X-Business-Use-Case-Usage` with `estimated_time_to_regain_access`
(https://developers.facebook.com/docs/graph-api/overview/rate-limiting); OpenAPI `IncomingMessage` discriminator list and
`ContextObject` described only for the "Message business" button
(https://raw.githubusercontent.com/meta/openapi/main/business-messaging-api_v23.0.yaml).

Still UNCONFIRMED after this pass: items 1-16 in §10 above. None of them is documented on a current official page; the
generic webhooks page has no unicode-escaping note, no explicit timeout, and no HTTP 429 statement for Cloud API.
