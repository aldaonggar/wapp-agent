import { expect, test } from "vitest";
import { parseReply, splitLong, type ReplyEvent } from "./stream";

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
  ["react with no target (newest inbound)", "react: 👍\nhello", [{ type: "react", target: "", emoji: "👍" }, b("hello")]],
  ["react with no space before the emoji", "react: #2❤️\nhello", [{ type: "react", target: "#2", emoji: "❤️" }, b("hello")]],
  ["react: none with punctuation", "react: none.\nhello", [b("hello")]],
  ["upper-case header", "REACT: #1 👍\nhi", [{ type: "react", target: "#1", emoji: "👍" }, b("hi")]],
  ["a header with no usable emoji is dropped", "react: #2\nhello", [b("hello")]],
  ["a header with a word is dropped", "react: maybe\nhello", [b("hello")]],
  ["an emoji with text glued on is dropped", "react: 👍hello\nhi", [b("hi")]],
  ["a digit glued to the emoji is dropped", "react: 2❤️\nhi", [b("hi")]],
  ["a copied history stamp is stripped from each bubble", "react: none\n[2026-11-05 21:12] cool, all set then.\n---\n[Nur 2026-11-05 21:12] night 🌙", [b("cool, all set then."), b("night 🌙")]],
  ["em dashes become commas, hyphens and number ranges stay", "react: none\nhey! glad you did. i am here — how is it going?\n---\nwait—no, 2024–2026 was a well-known era", [b("hey! glad you did. i am here, how is it going?"), b("wait, no, 2024–2026 was a well-known era")]],
  ["an em dash before punctuation or at the start leaves no stray comma", "— fine.\n---\nok —.", [b("fine."), b("ok.")]],
  ["a bracketed word that is not a stamp stays", "[important] read this", [b("[important] read this")]],
  ["voice header after the react line", "react: #1 👍\nvoice: yes\nhere you go", [{ type: "react", target: "#1", emoji: "👍" }, { type: "voice" }, b("here you go")]],
  ["voice header first, react after it", "voice: yes\nreact: none\nhere you go", [{ type: "voice" }, b("here you go")]],
  ["voice header is case-insensitive and takes y, true and trailing punctuation", "react: none\nVOICE: Y\nvoice: True.\nok", [{ type: "voice" }, { type: "voice" }, b("ok")]],
  ["voice header with another value is no request and no text", "react: none\nvoice: no\nvoice: maybe\nvoice:\nok", [b("ok")]],
  ["voice header after bubble text is ignored and never shown", "react: none\nhello\nvoice: yes\n---\nvoice: yes\nbye", [b("hello"), b("bye")]],
  ["a line that only starts with voice: is text", "react: none\nvoice: deep and calm, loved it", [b("voice: deep and calm, loved it")]],
  ["a one-word voice line after text stays text", "react: none\nparts:\nvoice: soprano", [b("parts:\nvoice: soprano")]],
  ["skin tones and ZWJ sequences are one emoji", "react: #1 👍🏽\nreact: #1 👨‍👩‍👧\nhi", [{ type: "react", target: "#1", emoji: "👍🏽" }, { type: "react", target: "#1", emoji: "👨‍👩‍👧" }, b("hi")]],
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

test("splits at sentence ends when there is no paragraph break: a few short pieces, then the hard limit", async () => {
  const para = "Hello there friend. ".repeat(250).trim(); // ~5,000 chars
  const t = texts(await collect(whole(para)));
  expect(t.length).toBeGreaterThan(2);
  for (const p of t) { expect(p.length).toBeLessThanOrEqual(4096); expect(p.endsWith(".")).toBe(true); }
  expect(t[0].length).toBeLessThanOrEqual(360); // the opening pieces read like chat bubbles
  expect(t.join(" ")).toBe(para);
});

test("quote only on the first piece of a split bubble", async () => {
  const para = "q".repeat(3000);
  const ev = await collect(whole(`react: none\nquote: #2\n${para}\n\n${para}`));
  expect(ev.length).toBe(2);
  expect(ev[0]).toMatchObject({ quote: "#2" });
  expect(ev[1]).not.toHaveProperty("quote");
});

test("a standalone react line after text is dropped, never shown (a model re-emits it after tool steps)", async () => {
  expect(await collect(whole("hi\nreact: none"))).toEqual([b("hi")]);
  expect(await collect(whole("hi\nreact: #2 \u2764\ufe0f\nmore"))).toEqual([b("hi\nmore")]); // too late to react, still never text
});

test("a header line repeated after a tool step never leaks into a bubble", async () => {
  const input = "react: none\nsec, let me check that\nreact: none\nyou're right, i stand corrected.";
  expect(await collect(whole(input))).toEqual([b("sec, let me check that\nyou're right, i stand corrected.")]);
  expect(await collect(whole("react: not sure about that\nok"))).toEqual([b("react: not sure about that\nok")]); // two words: content, not a header
});

test("a long bubble is split into messages at paragraph, then sentence, breaks", () => {
  const para = "First paragraph that is long enough to matter. ".repeat(4).trim();
  const three = [para, para, para].join("\n\n");
  const pieces = splitLong(three);
  expect(pieces).toEqual([para, para, para]);
  const sentences = "This is a sentence of modest length that goes on a bit. ".repeat(12).trim();
  const bySentence = splitLong(sentences);
  expect(bySentence.length).toBeGreaterThan(1);
  for (const p of bySentence) expect(p.length).toBeLessThanOrEqual(360);
  expect(bySentence.join(" ")).toBe(sentences);
  expect(splitLong("x".repeat(500))).toEqual(["x".repeat(500)]); // one unbreakable sentence stays whole under the hard limit
  expect(splitLong("short reply")).toEqual(["short reply"]);
});
