# WhatsApp agent with memory: build brief

## The assignment
Build an agent people text on WhatsApp that passes the "feels like a person with a memory" test.
1. Memory: short-term (this conversation) and long-term (across days), with judgement about what's worth keeping. Bonus: derive non-obvious things from what it has stored.
2. Human reply cadence: if I send three messages in a row, it answers once, to the thread as a whole.
3. Hosted and live: the reviewers will text it from their own phones.
4. Bonus: it can look at web pages and demos people send it.
5. A small set of evals showing short-term, long-term and derived memory working.

UX comes first. Code quality and scale are not judged, and speed to something usable is. The reviewer will read the repo through Claude, so the README must make the repo easy to navigate.

## Stack
- TypeScript on Cloudflare Workers, with one Durable Object per contact (SQLite storage + alarms). The object processes one contact's messages in order, holds their memory, and its alarms drive the reply timing and follow-ups.
- WhatsApp Cloud API (Meta Graph API) directly, using Meta's test business number. No Twilio, no WhatsApp wrapper SDKs.
- Models through the Vercel AI SDK (`ai` + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/deepseek`, `@openrouter/ai-sdk-provider`), so every job is one `streamText`/`generateText` call and swapping a model is a string change. Native provider packages for OpenAI, Anthropic and DeepSeek; OpenRouter for everything else (Kimi, GLM, Qwen). Which model does which job is decided by the model comparison in Evals, not up front; see Models.
- Prompt caching on every call. OpenAI and DeepSeek cache automatically when the prompt prefix is stable; Anthropic needs `cache_control` on the system prompt (via `providerOptions`). Log cached-token counts per call to confirm hits.
- Embeddings: Workers AI `@cf/baai/bge-m3` (multilingual).
- Web pages: Cloudflare Browser Rendering REST API (`/screenshot` and `/markdown`).
- No agent framework, no memory library, no vector DB. The memory system is the work being judged.

## Models
One model per job, each set in `src/models.ts` and overridable by env var. No provider loyalty: the candidates span OpenAI, Anthropic and the Chinese labs, and the comparison picks. Until it has run, the default for each job is the cheapest candidate in its row. Record the winners with their numbers in the README.

| Job | What it needs | Candidates (price per 1M tokens, in / out) |
|---|---|---|
| reply | smart, fast, on the critical path | `deepseek-flash` (DeepSeek V4.1 Flash, $0.30 / $1.20), `gpt-6.1-terra` ($1 / $5), `gpt-6.1-sol` ($2 / $10), `claude-sonnet-5-5` ($2 / $10), Kimi K2.6 ($0.95 / $4), GLM-5.2 ($1.40 / $4.40) |
| vision (images) | sees pictures | the reply model if it supports images; otherwise `gpt-6.1-terra` or `claude-sonnet-5-5`, compared the same way on the image scenarios |
| extraction | judgement, structured output, runs after every message | `gpt-6-luna` ($0.10 / $0.50), `claude-haiku-5-5` ($0.10 / $0.50), `deepseek-flash` |
| derived insights | reasoning, off the critical path | `deepseek-v4-pro` ($1.32 / $3.96), `gpt-6.1-sol`, `claude-sonnet-5-5` |
| eval judge | fixed, never part of the comparison | `claude-opus-5-5` |
| transcription | | `@cf/openai/whisper-large-v3-turbo` |
| embeddings | | `@cf/baai/bge-m3` |

- Thinking: off, or the lowest effort the provider allows, on the reply call (OpenAI `reasoning_effort`, Anthropic `effort`, DeepSeek/Kimi/GLM thinking flag). Default for extraction and derived insights. Same setting for every candidate in a comparison.
- Every call records input, output and cached tokens. A price table in `src/models.ts` with the figures above (peak prices for DeepSeek; it's cheaper off-peak) turns usage into cost per call. Prices change; check each provider's pricing page when filling the table.
- Data residency: DeepSeek, Moonshot and Z.ai's own APIs process data in China. Kimi, GLM and Qwen are open-weight and OpenRouter can route them to US/EU hosts, so if one wins, pick the host deliberately and say so in the README.

## Webhook
- GET handles Meta's verification with a verify token. POST verifies `X-Hub-Signature-256` with the app secret, returns 200 immediately, and forwards the message to the contact's Durable Object.
- Dedupe by WhatsApp message id (Meta retries webhooks). Ignore status webhooks except for logging.
- Allowlist of phone numbers in env; ignore everyone else.
- Store every inbound and outbound message with its WhatsApp id, timestamp and text.

## Reply cadence
WhatsApp doesn't tell us when the person is typing, so cadence comes from timing.
- Wait for the thread to finish. A turn starts when 3s pass with no new message. If the last message looks unfinished (ends with "...", ":", ",", "and", "so", "but", or is a lone opener like "hey", "wait", "quick q"), wait 8s instead. Never wait more than 15s after the first message of the burst.
- If a new message arrives while a reply is being generated and nothing has been sent yet, drop that draft and regenerate with the whole thread.
- When the turn starts, mark the latest message as read and show the typing indicator in the same call (`"status": "read"` with `"typing_indicator": { "type": "text" }`). Meta dismisses the indicator after 25s or when a message is sent, so re-send it for long replies and before each extra bubble.
- Send 1 to 3 bubbles with a pause between them (~400ms + 15ms per character, max 2s). If the next bubble isn't generated yet when the pause ends, send it as soon as it is.

## Speed
Target: first bubble within 2.5s of the end of the wait at p50, 5s at p95. Everything on the reply path is built for that:
- Do the work during the wait. When the first message of a burst lands, start the media download, the embedding and the memory retrieval immediately; if more messages arrive, re-run only the embedding and retrieval (cheap) before the model call.
- Stream the reply (see Reply style) and send bubble 1 as soon as it's complete. Time to first bubble is what the person feels, not total generation time.
- Fire the read receipt and typing indicator without awaiting them.
- Keep the prompt small: 40 messages / ~6k tokens, top 12 memories, ≤300-token profile. `max_tokens` 400 on the reply call.
- Reply call with thinking off or at the lowest effort. Reasoning models pay for their thinking before the first token arrives, so a smarter model can lose the reply job on speed alone. The comparison has to show that per candidate.
- Nothing else on the reply path: extraction, derived insights and fact storage all run after the last bubble is sent. Tool calls (view_page) only when the thread contains a URL.
- Log per turn: wait time, retrieval ms, time to first token, time to first bubble, total ms, and model usage. These feed the evals.
- A reaction alone is a valid reply ("ok thanks" → 👍). React to a specific message when a person would (❤️ on good news).
- When the thread covers several topics, the reply may quote the specific message it answers (`context.message_id`).
- Images and voice notes are part of the thread, and the wait applies to them too (people often send a photo, then the question about it).
  - Images: download via `GET /{media-id}` to get the URL, then fetch it with the access token (URLs expire after 5 minutes, so do this on receipt). Pass the image (JPEG, PNG or WebP, max 5 MB) to the vision model with the caption. Store a one-line fact about what it showed when it matters ("Sent a photo of her new puppy, Boris, on 2026-11-06").
  - Voice notes arrive as `audio/ogg` (Opus). Download the same way and transcribe with Workers AI `@cf/openai/whisper-large-v3-turbo` ($0.000513 per minute). Treat the transcript as the message text, reply in text (people answer voice notes in text all the time), and never say "I transcribed your voice note". If transcription fails, say the voice note didn't come through and ask them to type it.
  - Stickers, documents, locations, contacts: acknowledge naturally and work with what's there (a location is a place; a contact card is a person). Anything it can't read: say so in one line.
- The person's reactions to the bot's messages arrive as `reaction` webhooks. Store them with the message. A reaction on its own never triggers a reply; it's context for the next turn (👍 on a suggestion means it landed).

## Reply style
The reply model streams a simple line format, not JSON, so the first bubble can go out while the rest is still generating: first line `react: <message_id> <emoji>` or `react: none`, then bubbles separated by a line containing only `---`, optional `quote: <message_id>` as the first line of a bubble. 0 to 3 bubbles. Parse the stream and send each bubble the moment its `---` (or the end) arrives.
- Text like a person: short bubbles, under ~300 characters each unless asked for something long.
- No markdown headings, lists, tables or markdown links. WhatsApp formatting (*bold*, _italic_) only rarely.
- Match the person's language and register (if they write in lowercase without punctuation, so does it).
- Emojis follow the person. None until they use some, then at most as many as they do, and never as decoration at the end of every bubble. A message that's only an emoji is a real message and gets a real (short) reply or a reaction.
- At most one question per turn.
- Use memory silently. Never say "I remember", "according to my notes" or "you told me before". Never ask for something it already knows. If a remembered fact is old and might have changed, check lightly.
- First contact: a short, human hello. Learn name and timezone naturally over the conversation, never as a form. Default the timezone from the phone number's country code until the person confirms it.

## Short-term memory
- The prompt always holds the last 40 messages of the conversation verbatim (or ~6k tokens, whichever is smaller), both sides, with timestamps.
- Must handle references ("the second one", "that place"), corrections ("actually make it 7"), quoted replies (`context.id` on inbound messages) and "like I said earlier".

## Long-term memory, with judgement
Facts
- One table in the contact's Durable Object SQLite: `id, text, kind, signal, created_at, event_date?, source_message_ids, status (active | superseded | deleted), superseded_by?, embedding`.
- `text` is one self-contained statement with absolute dates ("Sister Aru lives in Almaty", "Job interview at Monzo on 2026-11-12 14:00"). Resolve relative dates at the time they were said.
- `kind`: identity, person, preference, plan (has a date), routine, work, place, other.

Extraction, after the reply is sent
- The extraction model reads the latest turn plus the 10 most similar existing facts. For each candidate memory it assigns `signal` 1 to 5 and an operation: `ADD`, `UPDATE` (the new fact supersedes an old one, which is kept so "where did I live before?" works), `DELETE`, `NONE`.
- Persist only signal ≥3. High signal: names and relationships, plans with dates, stable preferences, work and projects, places, recurring routines. Noise: small talk, passing states ("I'm tired"), one-off trivia, the assistant's own suggestions.
Retrieval, on the reply path
- Core profile: ≤300 tokens of the most important stable facts (name, timezone, key people, standing preferences). Always in the prompt; regenerated when facts change.
- Per turn: embed the thread, cosine similarity over this contact's active facts and derived insights (brute force; one contact has at most thousands), small recency boost, top 12. Each shown with its date, e.g. "(said 2026-10-12)".
- Prompt order: system prompt → core profile → retrieved memories → recent messages → current thread, with the current date and time in the person's timezone.

Control
- "What do you know about me?" → a short plain summary.
- "Forget X" → hard-delete the matching facts and insights, confirm in one line.

## Derived memory (bonus)
- When a conversation has been quiet for 30 minutes (Durable Object alarm), the derived-insights model reads the new facts plus related older ones and writes up to 3 derived insights: connections or implications the person never stated together.
  - "Flying to Almaty on 12 Nov" + "sister's birthday is 14 Nov" → "Will probably be in Almaty for his sister's birthday."
  - "Vegetarian" + "trip to Lisbon next week" → "Restaurant suggestions for Lisbon should be vegetarian."
- Each insight stores `evidence_fact_ids` and a confidence, and is retrieved like a fact but labelled as derived.
- The agent uses insights tentatively ("isn't that the week of your sister's birthday?") and never presents them as something the person said.
- Delete an insight when any of its evidence facts is superseded or forgotten.

## Web pages and demos (bonus)
- When a message contains a URL, call Browser Rendering `/screenshot` (mobile viewport) and `/markdown` in parallel. Give Claude the screenshot and the trimmed markdown, so it can talk about what the page looks like and what it says.
- Expose `view_page(url)` as a tool so the agent can open links itself.
- When the agent sends a URL, send it with `preview_url: true` so WhatsApp shows a link preview.
- Store a one-line fact about what was shared ("Shared his bamboo forest demo on 2026-11-06").

## Proactive follow-ups
- When a plan with a date is stored ("interview Thursday 2pm"), set an alarm for a couple of hours after it and send a short check-in ("how did it go?").
- WhatsApp only allows free-form messages within 24h of the person's last message. Send the follow-up only if it falls inside that window; otherwise skip it. Document this limit in the README.
- At most one proactive message per day. Skip it if the person has messaged since. No messages between 22:00 and 09:00 in their timezone.

## Evals
- Automated, no eval framework. `npm run eval` is a small custom harness run under Vitest (one test per scenario) that feeds timestamped scripts through the same message pipeline in Node, bypassing WhatsApp, with a fake clock to jump days. Then it asks probe questions and scores the answers.
- ~20 scenarios in YAML, each with gold answers:
  - short-term (6): references, corrections, a three-message burst
  - long-term (6): recall days later, updates (uses the newest value and still knows the old one), dates, "I don't know" for things never mentioned
  - derived (4): answers that need two or more stored facts the person never connected
  - judgement (2): after 50 messages of small talk with 3 real facts mixed in, the store holds the 3 facts and no junk
  - forget and isolation (2): a forgotten fact never comes back; a canary told to contact A never appears in contact B's replies
- Cadence checks (deterministic): a burst of 3 messages produces exactly one reply turn; an unfinished message ("so basically...") gets the longer wait; a message arriving mid-generation produces one reply covering all messages.
- Judge: `claude-opus-5-5` with the gold answer, labels correct / partial / wrong / hallucinated. Deterministic string checks where possible.
- Baseline: the same agent with long-term and derived memory turned off.
- Model comparison: `npm run eval -- --reply=claude-opus-5-5` (same flags for `--extract` and `--derive`). Vary one job at a time with the others at their defaults, so one run per candidate rather than every combination. For each candidate report accuracy on the categories that job affects (reply: short-term; extraction: long-term and judgement; derive: derived), p50/p95 latency to first bubble, and cost per 1,000 replies computed from logged usage. Pick per job, set it in `src/models.ts`, and put the comparison table in `EVALS.md`.
- Latency, per model candidate and per effort level (`--effort=low|medium|high`): p50 and p95 for time to first token, time to first bubble and total turn time, from the per-turn logs. Run every reply candidate with thinking off or lowest effort, then the best one at medium to see whether more thinking buys accuracy worth its delay. Speed counts as much as accuracy in the pick: a candidate that misses the 5s p95 loses the reply job no matter how it scores.
- Output: `EVALS.md` with a results table (category, baseline, this agent) and the transcript of each scenario.

## Order
Deploy from the first step so it can be texted throughout: webhook and basic reply → cadence and style → evals → long-term memory → derived memory → web pages → proactive follow-ups.

README: what it does and how to text it, an architecture diagram (Mermaid), a map of the repo, the eval table, known limits (24h window), and what I'd build next (follow-ups outside the 24h window, voice replies).

Don't add anything that isn't in this brief. If something is ambiguous, ask me instead of guessing.