export type ReplyEvent =
  | { type: "react"; target: string; emoji: string }
  | { type: "bubble"; text: string; quote?: string };

const LIMIT = 4096;

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
    const parts = splitLong(lines.join("\n").trim());
    for (const [i, text] of parts.entries()) {
      emitted++;
      yield quote && i === 0 ? { type: "bubble", text, quote } : { type: "bubble", text };
    }
  }

  function* line(l: string): Generator<ReplyEvent> {
    if (!started) {
      if (!l.trim()) return;
      started = true;
      const m = l.match(/^react:\s*(none|(\S+)\s+(\S+))\s*$/i);
      if (m) {
        if (m[2]) yield { type: "react", target: m[2], emoji: m[3] };
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
