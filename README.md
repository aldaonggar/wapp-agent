# wapp-agent

A WhatsApp and Telegram assistant that remembers you. It runs on Cloudflare Workers. One Durable Object per contact keeps that person's chat, facts and insights in SQLite. Nothing is shared between contacts.

Repo: https://github.com/aldaonggar/wapp-agent (branch `feat/wapp-agent`). Worker: https://wapp-agent.alda-onggar.workers.dev (`/health` returns `ok`).

What was asked: [init.md](init.md). What was decided and why: [design](docs/superpowers/specs/2026-11-04-whatsapp-memory-agent-design.md). Manual setup done by the owner: [SETUP.md](SETUP.md). Verified API notes: [docs/superpowers/research/](docs/superpowers/research/).

## What it does and how to text it

Status (2026-11-05): on WhatsApp the whole chain ran in production (webhook, Durable Object, memory retrieval, model, send), but Meta then permanently restricted the owner's test account pending a business verification the owner cannot do, so WhatsApp delivery is blocked until that lifts. Telegram is the live channel for reviewers. The real-model eval results are being produced on a separate branch; until it merges, the numbers below come from offline tests with stub models.

- Replies like a person: it waits for a burst of messages to finish, then answers in short bubbles.
- Introduces itself on your first message: what it is and what it can do, in one or two bubbles.
- Reads photos, transcribes voice notes, and fetches pages for links you send.
- Remembers facts across days, works out things you did not say (insights), and forgets on request.
- Checks in later about plans that have a date.
- Sets reminders at an exact time: "remind me at 18:00 to call the dentist" gets a confirmation now and your own words back at 18:00. On WhatsApp delivery only works within 24 hours of your last message (Meta's rule, see Known limits), so a reminder for the day after tomorrow needs you to text again before it, and the bot says so when it sets one; on Telegram it arrives regardless.
- Answers a voice note with a voice note (one, carrying the whole reply); a text message gets text.

On WhatsApp (once Meta lifts the restriction): the owner must first add your WhatsApp number to Meta's recipient list ([SETUP.md section 7](SETUP.md)). Meta's test number only talks to numbers on that list. The number to text is Meta's test number, shown in the owner's Meta dashboard (API Setup page). You must text first; the bot cannot start a chat.

On Telegram: open the owner's bot (the owner gives you its `t.me` link), press **Start**, and talk; no number registration. The owner decides whether the bot is open to anyone who finds it or limited to a list of Telegram usernames or ids (`ALLOWED_TELEGRAM`, [SETUP.md section 9](SETUP.md)). The same agent and the same memory serve both apps; to it, a Telegram contact and a WhatsApp contact are two different people. A voice note gets a voice note back on Telegram too, and reminders and check-ins are delivered whenever they are due: Telegram has no 24-hour window.

Things to try:

1. Send three short messages in a row. You should get one reply that covers all three.
2. Send a photo and ask about it.
3. Send a voice note.
4. Send a link.
5. Ask "what do you know about me".
6. Say "forget ..." and a fact. Ask about it later.
7. Come back the next day and refer to something you said earlier.
8. Mention a plan with a date (for example a trip next week) and wait for the check-in.
9. Say "remind me in 20 minutes to ..." and wait; ask "what reminders do I have" or cancel one.
10. Send a voice note and get a voice note back.

## Architecture

```mermaid
flowchart LR
  P[Phone] --> M[Meta Cloud API]
  M -->|webhook| W[Worker]
  T[Telegram Bot API] -->|webhook| W
  W -->|verify, allowlist| D[ContactAgent DO]
  D --> C[ContactCore]
  C --> O[OpenRouter]
  C --> A[Workers AI]
  C --> B[Browser Rendering]
  C -->|send| M
  C -->|send| T
  D -.->|alarm| L[Alarm loop]
  L --> C
```

- `src/worker.ts` re-exports `src/index.ts` (verify signature, check allowlist, fan out to one Durable Object per contact) and the `ContactAgent` class.
- `ContactAgent` ([src/contact-agent.ts](src/contact-agent.ts)) holds SQLite and one alarm. `ContactCore` ([src/core/contact.ts](src/core/contact.ts)) holds the logic and has no Cloudflare imports, so tests and evals run it in plain Node.
- OpenRouter: reply, extraction, insights. Workers AI: bge-m3 embeddings and rerank, Whisper, Aura-1 text-to-speech for voice replies. Browser Rendering: `/snapshot` for links.
- Alarm loop: wait for the burst to end, run the turn, then remember (extract facts) off the reply path so the next reply never waits for it; derive insights after 30 minutes of quiet, then check follow-ups; send reminders at their time (no model call).

## Why the memory is in-house

There are memory libraries and hosted memory services (mem0, Zep and others) that do extraction, storage and retrieval for you. I did not use one. Memory is the core of this brief, so every step had to be inspectable and tunable: what counts as a fact, how strong a signal it needs before it is kept, when a new fact supersedes an old one, what is recalled for a turn and why. The platform also gives most of the plumbing away: each contact already has a SQLite database inside their Durable Object, so isolation and persistence were free, and what remained was one extraction prompt, one embedding per fact and retrieval over a few hundred vectors. Of the ones named above, each either needs an external database, puts a network hop in front of every reply, or does not run on Cloudflare Workers without patching. The extraction prompts are adapted from mem0's open-source prompts (Apache-2.0), so the prompt work builds on what is known to work.

## Repo map

`src/`

- [worker.ts](src/worker.ts): wrangler entry; re-exports the Worker and `ContactAgent`.
- [index.ts](src/index.ts): `/webhook` GET and POST, `/telegram` POST, allowlists, fan-out, `/health`.
- [contact-agent.ts](src/contact-agent.ts): Durable Object shell and dependency wiring.
- [env.d.ts](src/env.d.ts): `Env` augmentation (secret names, `CONTACT` binding).
- [models.ts](src/models.ts): model table, per-job defaults and candidates, prices, cost, host filter.
- [llm.ts](src/llm.ts): streaming and structured calls over the AI SDK and OpenRouter.
- [whatsapp.ts](src/whatsapp.ts): webhook parsing, Graph API client, signature check.
- [telegram.ts](src/telegram.ts): Bot API update parsing, client (text, reactions, typing, media, voice notes via `sendVoice`; no 24-hour window), and the transport router (`tg:` ids go to Telegram, everything else to WhatsApp).
- [browser.ts](src/browser.ts): URL extraction and Browser Rendering snapshots.
- [workers-ai.ts](src/workers-ai.ts): embeddings, rerank, transcription, text-to-speech.
- `*.test.ts` next to each file: unit tests.

`src/core/`

- [types.ts](src/core/types.ts): shared types.
- [db.ts](src/core/db.ts): schema, migrations, SQLite adapters, vector helpers.
- [cadence.ts](src/core/cadence.ts): when a burst is over; pauses between bubbles.
- [stream.ts](src/core/stream.ts): parses the model's reply into bubbles.
- [prompt.ts](src/core/prompt.ts): system prompt, history window, prompt assembly.
- [contact.ts](src/core/contact.ts): `ContactCore`: ingest, alarm, turn, scheduling.
- [memory.ts](src/core/memory.ts): remember, recall, forget, profile.
- [insights.ts](src/core/insights.ts): derived insights.
- [followups.ts](src/core/followups.ts): schedule and decide proactive check-ins.
- [reminders.ts](src/core/reminders.ts): explicit reminders at an exact time, behind the `set_reminder` and `cancel_reminder` tools.
- [timezone.ts](src/core/timezone.ts): timezone guess from the phone's country code.

`evals/`

- [run.ts](evals/run.ts): `npm run eval` CLI (flags become env, then vitest or, with `--braintrust`, the Braintrust CLI).
- [harness.ts](evals/harness.ts): fake clock and WhatsApp, scenario loader and runner.
- [judge.ts](evals/judge.ts): LLM judge for probes and facts.
- [braintrust.eval.ts](evals/braintrust.eval.ts): the same scenarios and judge as a Braintrust experiment.
- [results.ts](evals/results.ts): one results file per configuration, shared by both runners.
- [report.ts](evals/report.ts): `evals/results/*.json` to [EVALS.md](EVALS.md).
- [scenarios.test.ts](evals/scenarios.test.ts): one test per scenario (real models).
- [harness.test.ts](evals/harness.test.ts), [cadence.test.ts](evals/cadence.test.ts), [results.test.ts](evals/results.test.ts): offline tests (stub model, no keys).
- [scenarios/](evals/scenarios): 22 YAML scenarios. [fixtures/photo.jpg](evals/fixtures/photo.jpg): test image.

Docs and config

- [init.md](init.md): the original brief.
- [SETUP.md](SETUP.md): owner's manual setup.
- [EVALS.md](EVALS.md): generated eval report (currently "not run").
- [docs/superpowers/specs/](docs/superpowers/specs): design. [plans/](docs/superpowers/plans): task plan. [research/](docs/superpowers/research): API notes.
- [package.json](package.json), [tsconfig.json](tsconfig.json), [vitest.config.ts](vitest.config.ts), [wrangler.jsonc](wrangler.jsonc): config.

## Evals

Built: a harness that replays scripted conversations with a fake clock, an LLM judge, 22 scenarios and a reporter. Not done: **no real-model run has happened.** It needs `OPENROUTER_API_KEY`, which is not available yet. [EVALS.md](EVALS.md) is generated in its "not run" state, so it has no numbers to quote.

The 22 scenarios by category: short-term 8 (one is the reminder: "remind me in 2 hours to call mum", then the clock jumps and the harness's `expect_sent` step checks the reminder arrived), long-term 6, derived 4, judgement 2, forget 1, isolation 1.

```bash
npm run eval                                   # all scenarios, default models
npm run eval -- --reply=moonshotai/kimi-k2.6   # swap the reply model
npm run eval -- --extract=<id> --derive=<id>   # swap extraction or insight model
npm run eval -- --effort=high                  # reasoning effort: low | medium | high
npm run eval -- --no-memory                    # baseline without memory
npm run eval -- --retrieval=cosine             # cosine only instead of hybrid
npm run eval -- --filter=forget                # scenarios whose name matches a regex
npm run eval -- --braintrust                   # same run as a Braintrust experiment; the flags above still apply
npm run eval:report                            # results -> EVALS.md
```

Braintrust is optional and sits on top of the same harness: `--braintrust` runs the same scenarios and judge through its `Eval` and uploads one experiment per run, named after the configuration tag (a rerun of the same tag gets a new experiment with a derived name; `evals/results/<tag>.json` stays the merged record), so runs can be compared in its UI with per-scenario scores (`passed`, `probes_correct`, `checks_passed`) and cost metrics on each scenario. It needs `BRAINTRUST_API_KEY` in `.env.braintrust` (git-ignored; [SETUP.md section 8](SETUP.md)); without it the run still happens locally and uploads nothing. Either runner writes `evals/results/<tag>.json`, so [EVALS.md](EVALS.md) is the same whichever produced it.

Tests that run today (offline): `npm test` is 226 tests in 17 files; `npx vitest run evals/harness.test.ts evals/cadence.test.ts evals/results.test.ts` is 40 tests in 3 files; `npm run types && npx tsc --noEmit` is clean (`npm run types` generates `worker-configuration.d.ts`, which is git-ignored, so run it first on a fresh clone).

## Model picks

These are the cheapest in each row by OpenRouter list price (2026-11-04). The comparison that would confirm them has not run, so treat them as unproven defaults. Defaults and candidates are in [src/models.ts](src/models.ts); override with `MODEL_REPLY`, `MODEL_VISION`, `MODEL_EXTRACT`, `MODEL_DERIVE`.

| Job | Default | Input / output per 1M tokens |
|---|---|---|
| Reply | `deepseek/deepseek-v4.1-flash` | $0.045 / $0.50 |
| Vision (photos) | the reply model when it accepts images (the default does); `openai/gpt-6.1-terra` only when the reply model is text-only | $1 / $5 for `openai/gpt-6.1-terra` |
| Extract | `deepseek/deepseek-v4.1-flash` | $0.045 / $0.50 |
| Derive insights | `deepseek/deepseek-v4-pro` | $1.60 / $3.20 |
| Eval judge | `anthropic/claude-opus-5.5` | $4 / $20 |

Calls to DeepSeek, Moonshot and Z.ai models exclude China- and Singapore-hosted providers (`CHINA_HOSTS` in `src/models.ts`). The host that served each call is logged.

## Running it

```bash
npm install
npm run types      # generates worker-configuration.d.ts (git-ignored); needed before npx tsc --noEmit
npm run dev        # wrangler dev, reads .dev.vars
npm run deploy
npm test
npm run eval
```

`.dev.vars` (git-ignored) holds eleven names: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OPENROUTER_API_KEY`, `ALLOWED_PHONES`, plus three for Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_TELEGRAM`. Where each comes from is in [SETUP.md](SETUP.md).

## Known limits

- On WhatsApp, replies only within 24 hours of the person's last message (Meta rule): proactive check-ins and reminders outside that window are skipped (a skipped reminder is logged, never sent late), and the bot says so when it sets a reminder that far out. Telegram has no window.
- Meta's test number only talks to a small list of verified recipient numbers.
- Cloudflare Free plan: Browser Rendering is 10 minutes per day and one page request per 10 seconds; Workers AI is 10,000 neurons per day (about 200 minutes of voice notes).
- Meta's free tier is 1,000 delivered service messages per month per number. No payment method is on file. The status webhook's `pricing.type` flip is logged.
- Voice replies only answer voice notes, one voice note per reply, and the voice is English (Deepgram Aura-1 on Workers AI, OGG/Opus). Measured 2026-11-05 on a 25-word (126-character) reply: p50 0.58 s, max 0.93 s, 10 KB. Aura-1 bills 1,364 neurons per 1,000 characters (172 for that reply); a full reply of 300-900 characters is 400-1,200 neurons, so roughly 8 to 25 voice replies a day fit the Free plan's 10,000 neurons before anything else, after which each voice note costs one failed synthesis call before the text fallback. A reply in a non-Latin script, or any synthesis or upload failure, falls back to the text bubbles.
- Timezone is guessed from the phone's country code until the person says where they are; reminder times are resolved in that zone.
- The model comparison has not run (see Evals).
- Follow-ups and reminders never retry.
- The extractor sees only the current turn.
- Telegram: bots get no read receipts, so only the typing indicator shows. The timezone starts as UTC (a Telegram id carries no country code) until the person says where they are. The bot sets at most one reaction per message and only from Telegram's fixed emoji set; one outside it is logged as `send_failed` and the reply still goes out. `/telegram` answers 404 until `TELEGRAM_WEBHOOK_SECRET` is set. An update whose ingest fails for a reason other than a transient Durable Object error is logged as `ingest_failed` and dropped (Telegram redelivers only on a non-2xx answer). A reaction aimed at a photo inside an album lands on the album's first photo, while the transcript records it on the photo the bot picked.

## What I would build next

- On WhatsApp, follow-ups and reminders outside the 24-hour window, using approved message templates.
- Voice replies in the person's language (Aura-1 is English-only; MeloTTS is multilingual but returns WAV, which no platform shows as a voice note).
- Run the model comparison once the OpenRouter key exists, then set the defaults from the results.

## Credits

Extraction prompts are adapted from the open-source prompts of [mem0](https://github.com/mem0ai/mem0) (Apache-2.0).
