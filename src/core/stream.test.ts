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
  ["header repeated after a tool step", "react: none\n\nreact: none\nDone, forgotten.", [b("Done, forgotten.")]],
  ["reaction in the repeated header", "react: none\nreact: #2 👍\nok", [{ type: "react", target: "#2", emoji: "👍" }, b("ok")]],
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

const texts = (ev: ReplyEvent[]) => ev.map((e) => (e.type === "bubble" ? e.text : ""));

test("maxBubbles = 1 collects everything", async () => {
  expect(await collect(whole("react: none\na\n---\nb\n---\nc"), 1)).toEqual([b("a\n\nb\n\nc")]);
});

test("long final bubble splits without counting toward the cap", async () => {
  const para = "p".repeat(2500);
  const final = [para, para, para, para].join("\n\n"); // 10,006 chars
  const ev = await collect(whole(`react: none\none\n---\ntwo\n---\n${final}`), 3);
  const t = texts(ev);
  expect(t.slice(0, 2)).toEqual(["one", "two"]);
  const pieces = t.slice(2);
  expect(pieces.length).toBeGreaterThan(1);
  for (const p of pieces) expect(p.length).toBeLessThanOrEqual(4096);
  expect(pieces.join("\n\n")).toBe(final);
});

test("splits at a sentence end when there is no paragraph break", async () => {
  const para = "Hello there friend. ".repeat(250).trim(); // ~5,000 chars
  const t = texts(await collect(whole(para)));
  expect(t.length).toBe(2);
  for (const p of t) expect(p.length).toBeLessThanOrEqual(4096);
  expect(t[0].endsWith(".")).toBe(true);
  expect(t.join(" ")).toBe(para);
});

test("quote only on the first piece of a split bubble", async () => {
  const para = "q".repeat(3000);
  const ev = await collect(whole(`react: none\nquote: #2\n${para}\n\n${para}`));
  expect(ev.length).toBe(2);
  expect(ev[0]).toMatchObject({ quote: "#2" });
  expect(ev[1]).not.toHaveProperty("quote");
});

test("react line after the first non-empty line is content", async () => {
  expect(await collect(whole("hi\nreact: none"))).toEqual([b("hi\nreact: none")]);
});
