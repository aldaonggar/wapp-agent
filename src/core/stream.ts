export type ReplyEvent =
  | { type: "react"; target: string; emoji: string } // target "" = their newest message
  | { type: "voice" } // the model asked for this reply to go out as a voice note
  | { type: "bubble"; text: string; quote?: string };

const LIMIT = 4096; // the transport's hard limit
const SOFT = 250; // a bubble longer than this reads like an email: split at paragraph, else sentence, breaks
const MAX_SOFT_PIECES = 6; // after that, only the hard limit splits (a wall of text stays a wall rather than a flood)
const MIN_TAIL = 40; // never leave a dangling fragment

// Exactly one emoji: a flag, or a pictograph with variation selectors / skin tones, ZWJ-joined to more.
const EMOJI = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}\p{Emoji_Modifier}]*)*)$/u;

// Lenient: "react: #n <emoji>", "react: #n<emoji>", "react: <emoji>"; "none" or a token that is not one emoji is no reaction.
function header(l: string): ReplyEvent | null {
  const m = /^\s*react:\s*(#\d+|\d+(?=\s))?\s*(\S*)/i.exec(l)!;
  const emoji = m[2].replace(/[.,!;:]+$/, "");
  return EMOJI.test(emoji) ? { type: "react", target: m[1] ?? "", emoji } : null;
}

// Soft split at the last paragraph, else sentence, boundary before SOFT; hard split before LIMIT when nothing else works.
function cutPoint(text: string, limit: number, hard: boolean): number {
  const win = text.slice(0, limit);
  const para = win.lastIndexOf("\n\n");
  if (para > 0) return para;
  const m = [...win.matchAll(/[.!?](?=\s)/g)].pop();
  if (m) return m.index! + 1;
  return hard ? (win.lastIndexOf(" ") > 0 ? win.lastIndexOf(" ") : limit) : -1;
}

export function splitLong(text: string): string[] {
  const out: string[] = [];
  for (;;) {
    let cut = -1;
    if (out.length < MAX_SOFT_PIECES - 1 && text.length > SOFT) { // chat-sized pieces first
      cut = cutPoint(text, SOFT, false);
      if (cut > 0 && text.length - cut < MIN_TAIL) cut = -1;
    }
    if (cut <= 0 && text.length > LIMIT) cut = cutPoint(text, LIMIT, true); // then only the transport limit
    if (cut <= 0) break;
    out.push(text.slice(0, cut).trim());
    text = text.slice(cut).trim();
  }
  if (text) out.push(text);
  return out;
}

// History lines are shown to the model as "[alias 2026-11-05 21:12] text"; some models copy the stamp into their own bubbles.
const STAMP = /^\s*\[(?:[^\]\n]{0,40}\s)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\]\s*/;
// An em dash (or a spaced en dash) is the most recognisable machine tell in a chat; people type a comma.
const DASH = /\s*\u2014\s*|\s+\u2013\s+/g;
const untell = (s: string) => s.replace(DASH, ", ").replace(/^, /, "").replace(/, ([,.!?])/g, "$1");

export async function* parseReply(chunks: AsyncIterable<string>, maxBubbles = 3): AsyncGenerator<ReplyEvent> {
  let tail = "";
  let started = false; // first non-empty line seen
  let cur: string[] = [];
  let emitted = 0;

  function* flush(): Generator<ReplyEvent> {
    const lines = cur;
    cur = [];
    while (lines.length && !lines[0].trim()) lines.shift();
    let quote: string | undefined;
    const q = lines[0]?.match(/^quote:\s*(\S+)\s*$/i);
    if (q) {
      quote = q[1];
      lines.shift();
    }
    const parts = splitLong(lines.map((l) => untell(l.replace(STAMP, ""))).join("\n").trim());
    if (parts.length) emitted++; // cap counts logical bubbles, not split pieces
    for (const [i, text] of parts.entries()) {
      yield quote && i === 0 ? { type: "bubble", text, quote } : { type: "bubble", text };
    }
  }

  function* line(l: string): Generator<ReplyEvent> {
    // "voice: yes" is a header only before any bubble text; anywhere it is never bubble text, and any other value is no request.
    const voice = /^\s*voice:\s*(\S*)\s*$/i.exec(l);
    const head = emitted === 0 && !cur.some((x) => x.trim()), yes = !!voice && /^(yes|y|true)$/i.test(voice[1].replace(/[.,!;:]+$/, ""));
    if (voice && (head || yes)) { // a one-word body line like "voice: soprano" stays text
      if (head && yes) yield { type: "voice" };
      return;
    }
    // A standalone header line is never bubble text, wherever a tool step made the model write it again;
    // it counts as a reaction only before any bubble text.
    if (/^\s*react:\s*(#\d+\s*|\d+\s+)?\S*\s*$/i.test(l)) {
      started = true;
      if (emitted === 0 && !cur.some((x) => x.trim())) {
        const r = header(l);
        if (r) yield r;
      }
      return;
    }
    if (!started) {
      if (!l.trim()) return;
      started = true;
    }
    if (l.trim() === "---") {
      if (emitted < maxBubbles - 1) yield* flush();
      else cur.push("");
    } else cur.push(l);
  }

  for await (const chunk of chunks) {
    tail += chunk;
    const parts = tail.split("\n");
    tail = parts.pop()!;
    for (const l of parts) yield* line(l);
  }
  if (tail) yield* line(tail);
  yield* flush();
}
