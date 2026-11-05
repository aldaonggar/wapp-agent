export type ReplyEvent =
  | { type: "react"; target: string; emoji: string } // target "" = their newest message
  | { type: "bubble"; text: string; quote?: string };

const LIMIT = 4096;

// Exactly one emoji: a flag, or a pictograph with variation selectors / skin tones, ZWJ-joined to more.
const EMOJI = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\u{FE0E}\u{FE0F}\p{Emoji_Modifier}]*)*)$/u;

// Lenient: "react: #n <emoji>", "react: #n<emoji>", "react: <emoji>"; "none" or a token that is not one emoji is no reaction.
function header(l: string): ReplyEvent | null {
  const m = /^\s*react:\s*(#\d+|\d+(?=\s))?\s*(\S*)/i.exec(l)!;
  const emoji = m[2].replace(/[.,!;:]+$/, "");
  return EMOJI.test(emoji) ? { type: "react", target: m[1] ?? "", emoji } : null;
}

// Split at the last paragraph, else sentence, boundary before the limit.
function splitLong(text: string): string[] {
  const out: string[] = [];
  while (text.length > LIMIT) {
    const win = text.slice(0, LIMIT);
    let cut = win.lastIndexOf("\n\n");
    if (cut <= 0) {
      const m = [...win.matchAll(/[.!?](?=\s)/g)].pop();
      cut = m ? m.index! + 1 : LIMIT;
    }
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
    const isHeader = /^\s*react:/i.test(l);
    // A tool step makes the model write its header again: a react line before any bubble text is still the header.
    if (!started || (isHeader && emitted === 0 && !cur.some((x) => x.trim()))) {
      if (!l.trim()) return;
      started = true;
      if (isHeader) {
        const r = header(l);
        if (r) yield r;
        return;
      }
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
