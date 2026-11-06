# Privacy and terms

This is a personal WhatsApp assistant run by its owner for a small invited group, as a demonstration. It is not a commercial service and has no advertising, analytics or resale of data.

## What it stores

For each person who texts it, kept in a separate store that no other person's conversation can reach:

- The messages you send and the replies it sends, with timestamps, identified by your WhatsApp phone number.
- For photos and voice notes: a short text description or transcript. The file itself is held in memory only while the reply is being written and is not kept.
- For links you send: the text of the page, used for that reply.
- Web pages it builds for you when something reads better that way (the content you asked for, laid out as a page). A page is stored in your own store, together with which of its checkboxes you ticked and the Markdown it was made from, and is readable (and its ticks changeable) by anyone who holds its link, with no login; the link is long and random, and the page carries no tracking and only one fixed script that saves ticks and anything typed on the page (fields, list items, notes: stored with the page, readable by anyone who holds the link and by the assistant, which may remember what you chose or filled in), though your browser loads its font from Google Fonts, which sees your IP address. Ask the owner to delete it.
- Facts it has decided are worth remembering about you (for example a plan, a preference, where you live), insights it derives from several such facts, and a short profile built from them.
- Timing and cost of each reply, with no message content.

## Where it goes

- Storage runs in the owner's Cloudflare account (Cloudflare Workers and Durable Objects).
- Messages are carried by Meta's WhatsApp Business Platform, under WhatsApp's own terms.
- To write a reply, the conversation is sent to third-party language models through OpenRouter (the models in use are listed in the README), to Cloudflare Workers AI for voice transcription and search embeddings, and to Cloudflare Browser Rendering for links you send and for result pages it opens itself. When it looks something up, a short search query it writes from the conversation goes through OpenRouter to a small search model (named in the README's model table) and to OpenRouter's web search provider (Exa); the results come back through that model, and the Worker fetches the result pages directly. Those providers process the data to produce the reply; the owner has no control over their retention policies beyond what their terms state.
- The owner can read the stored conversations and the service logs.

## Deleting your data

- Tell the assistant to forget something, in your own words, and it deletes the matching facts and tells you what it removed.
- To delete everything about you, ask the person who invited you; the store for your number is removed in full.
- Data is kept until you ask for deletion or the demonstration is shut down.

## Terms of use

- The service is provided as is, for the invited group, with no guarantee of availability, accuracy or continuity. It may be stopped at any time.
- Do not send it credentials, payment details, health or other sensitive information about yourself or anyone else.
- By texting it you agree to this processing. You can stop at any time by asking for deletion and no longer messaging it.

Questions go to the owner through the person who invited you or through this repository.
