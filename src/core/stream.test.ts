import { expect, test } from "vitest";
import { parseReply, type ReplyEvent } from "./stream";

async function* whole(s: string) { yield s; }
async function* chars(s: string) { for (const c of s) yield c; }
async function collect(it: AsyncIterable<string>, max?: number) {
  const out: ReplyEvent[] = [];
  for await (const e of parseReply(it, max)) out.push(e);
  return out;
}
const b = (text: string, quote?: string): ReplyEvent => (quote ? { type: "bubble", text, quote } : { type: "bubble", text });

const cases: [string, string, ReplyEvent[]][] = [
  ["two bubbles", "react: none\nhello\n---\nsecond", [b("hello"), b("second")]],
  ["react", "react: #3 ❤️", [{ type: "react", target: "#3", emoji: "❤️" }]],
  ["quote", "react: none\nquote: #2\nanswer", [b("answer", "#2")]],
  ["no header", "hello there", [b("hello there")]],
  ["cap", "react: none\na\n---\nb\n---\nc\n---\nd", [b("a"), b("b"), b("c\n\nd")]],
  ["inline dashes", "react: none\nwait --- no\n", [b("wait --- no")]],
];

for (const [name, input, expected] of cases) {
  test(name, async () => {
    expect(await collect(whole(input))).toEqual(expected);
    expect(await collect(chars(input))).toEqual(expected);
  });
}

test("splits long bubbles at a boundary", async () => {
  const para = "x".repeat(3000);
  const ev = await collect(whole(`${para}\n\n${para}`));
  expect(ev.map((e) => e.type === "bubble" && e.text.length)).toEqual([3000, 3000]);
});

test("emits first bubble before the stream ends", async () => {
  async function* slow() {
    yield "react: none\nfirst\n---\n";
    await new Promise(() => {});
  }
  const it = parseReply(slow());
  const r = await Promise.race([it.next(), new Promise((res) => setTimeout(() => res("timeout"), 200))]);
  expect(r).toEqual({ done: false, value: b("first") });
});
