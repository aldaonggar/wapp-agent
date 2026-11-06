import { expect, test } from "vitest";
import { SYSTEM_PROMPT, buildPrompt, windowHistory, type HistoryRow } from "./prompt";
import type { MemoryHit } from "./types";

const T = Date.UTC(2026, 10, 4, 9, 3); // 14:03 in Asia/Almaty (UTC+5)
const row = (i: number, text = `m${i}`): HistoryRow => ({ id: `w${i}`, direction: i % 2 ? "out" : "in", text, ts: T + i, kind: "text" });

test("windowHistory keeps the newest 40 of 60 rows, chronological", () => {
  const out = windowHistory(Array.from({ length: 60 }, (_, i) => row(i)));
  expect(out).toHaveLength(40);
  expect(out[0].id).toBe("w20");
  expect(out[39].id).toBe("w59");
});

test("windowHistory with 50 rows of 1,000 chars keeps the newest 24 (6,000 tokens)", () => {
  const out = windowHistory(Array.from({ length: 50 }, (_, i) => row(i, "x".repeat(1000))));
  expect(out.map((r) => r.id)).toEqual(Array.from({ length: 24 }, (_, i) => `w${26 + i}`));
});

test("buildPrompt orders system blocks, stamps history and attaches pending media", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  const { system, messages } = buildPrompt({
    profile: "Name: Aru. Lives in Almaty.",
    memories: [{ id: 1, kind: "fact", text: "Sister lives in Astana", date: "2026-10-12", score: 0.9, status: "active" }],
    history: [
      { id: "a", direction: "in", text: "hello", ts: T, kind: "text", alias: "#12" },
      { id: "b", direction: "in", text: "[photo]", ts: T, kind: "image", alias: "#13", mediaNote: "a red bike" },
      { id: "c", direction: "out", text: "nice bike", ts: T, kind: "text", reactions: "❤️" },
    ],
    pending: [{ id: "d", direction: "in", text: "what colour is it?", ts: T + 120_000, kind: "image", alias: "#1", media: { bytes: jpeg, mime: "image/jpeg" } }],
    nowLocal: "2026-11-04 14:05",
    tz: "Asia/Almaty",
    tzConfirmed: false,
    snapshots: [],
  });
  expect(system[0].content).toBe(SYSTEM_PROMPT);
  const dyn = system[1].content;
  expect(dyn).toContain("now: 2026-11-04 14:05 (Asia/Almaty, unconfirmed guess from the phone number)");
  expect(dyn.split("\n").some((l) => l.endsWith("(said 2026-10-12)"))).toBe(true);
  expect(messages[0]).toEqual({ role: "user", content: expect.stringContaining("[#12 2026-11-04 14:03] hello") });
  expect(messages[0].content).toContain("(photo: a red bike)");
  expect(messages[1]).toEqual({ role: "assistant", content: "[2026-11-04 14:03] nice bike (reacted ❤️)" });
  const last = messages.at(-1)!;
  expect(last.role).toBe("user");
  const parts = last.content as { type: string; text?: string; mediaType?: string; data?: unknown }[];
  expect(parts[0]).toEqual({ type: "text", text: "[#1 2026-11-04 14:05] what colour is it?" });
  expect(parts.filter((p) => p.type === "file")).toEqual([{ type: "file", mediaType: "image/jpeg", data: jpeg }]);
});

test("buildPrompt adds the first-contact introduction line only while the history window is empty", () => {
  const base = { profile: "", memories: [], nowLocal: "2026-11-04 14:05", tz: "UTC", tzConfirmed: false, snapshots: [], pending: [{ id: "a", direction: "in" as const, text: "Hi, I just pressed Start.", ts: T, kind: "text", alias: "#1" }] };
  const first = buildPrompt({ ...base, history: [] }).system[1].content;
  expect(first).toContain("first contact: nothing has been said before. Before anything else, introduce yourself in one short bubble");
  expect(first).toContain("set reminders at a time they name, read photos, listen to voice notes, read links they send, look things up on the web when you need current information, build a small web page for them when something reads better that way and send the link, and forget anything on request");
  expect(first).toContain("Two short bubbles at most.");
  expect(buildPrompt({ ...base, history: [row(0)] }).system[1].content).not.toContain("first contact:");
});

test("buildPrompt renders the agent's own reaction as (you reacted …)", () => {
  const { messages } = buildPrompt({
    profile: "", memories: [], nowLocal: "2026-11-04 14:05", tz: "Asia/Almaty", tzConfirmed: true, snapshots: [],
    history: [{ id: "a", direction: "in", text: "got the job!", ts: T, kind: "text", alias: "#1", myReaction: "🎉" }],
    pending: [{ id: "b", direction: "in", text: "thanks", ts: T, kind: "text", alias: "#2" }],
  });
  expect(messages[0]).toEqual({ role: "user", content: "[#1 2026-11-04 14:03] got the job! (you reacted 🎉)" });
});

test("buildPrompt drops the guess label once the timezone is confirmed and renders a page snapshot", () => {
  const jpeg = new Uint8Array([1]);
  const { system, messages } = buildPrompt({
    profile: "", memories: [], history: [], nowLocal: "2026-11-04 14:05", tz: "Asia/Almaty", tzConfirmed: true,
    pending: [{ id: "d", direction: "in", text: "look https://x.io", ts: T, kind: "text", alias: "#1" }],
    snapshots: [{ url: "https://x.io", finalUrl: "https://x.io/home", title: "X", status: 200, markdown: "# Hi", jpeg }],
  });
  expect(system[1].content).toMatch(/^now: 2026-11-04 14:05 \(Asia\/Almaty\)$/m);
  const parts = messages[0].content as { type: string; text?: string }[];
  expect(parts).toContainEqual({ type: "text", text: "page X (https://x.io/home, status 200):\n# Hi" });
  expect(parts).toContainEqual({ type: "file", mediaType: "image/jpeg", data: jpeg });
});

test("buildPrompt renders every memory status and adds the control sentences only with memory on", () => {
  const base = { profile: "", history: [], pending: [], nowLocal: "2026-11-08 14:05", tz: "Asia/Almaty", tzConfirmed: true, snapshots: [] };
  const memories: MemoryHit[] = [
    { id: 2, kind: "fact", text: "Sister Aru lives in Astana", date: "2026-11-08", score: 1, status: "active" },
    { id: 1, kind: "fact", text: "Sister Aru lives in Almaty", date: "2026-11-08", score: 0.9, status: "superseded" },
    { id: 1, kind: "insight", text: "Will visit Astana for the birthday", date: "2026-11-08", score: 0.8, confidence: 0.8, status: "active" },
  ];
  const on = buildPrompt({ ...base, memories, memory: true }).system[1].content;
  expect(on).toContain("- Sister Aru lives in Astana (said 2026-11-08)\n- Sister Aru lives in Almaty (superseded on 2026-11-08)\n- Will visit Astana for the birthday (derived, confidence 0.8)");
  expect(on).toContain("If they ask what you know about them, answer with a short plain summary of the profile and the most relevant memories.");
  expect(on).toContain("call the forget tool");
  expect(on).toMatch(/confirm in one line/);
  expect(on).toContain("Something they asked you to forget may still appear in the conversation above; never use or mention it again.");
  expect(buildPrompt({ ...base, memories: [] }).system[1].content).not.toMatch(/forget tool|know about them/); // the first-contact line may say "forget"
});

test("buildPrompt lists recent pages with ids, tick counts only when there are checkboxes; the rules say to update in place", () => {
  const base = { profile: "", memories: [], history: [], pending: [], nowLocal: "x", tz: "UTC", tzConfirmed: true, snapshots: [] };
  const dyn = buildPrompt({ ...base, pages: [{ id: "A".repeat(22), title: "Packing", ticked: 2, total: 5, left: ["socks", "charger", "adapter"], editable: true }, { id: "B".repeat(22), title: "Trip", ticked: 0, total: 0, left: [], editable: true }, { id: "C".repeat(22), title: "Old", ticked: 0, total: 0, left: [], editable: false }] }).system[1].content;
  expect(dyn).toContain(`pages (last 7 days):\n- Packing (id ${"A".repeat(22)}, 2 of 5 ticked; left: socks, charger, adapter)\n- Trip (id ${"B".repeat(22)})\n- Old (not editable)`);
  expect(buildPrompt({ ...base, pages: [] }).system[1].content).not.toContain("pages (last");
  expect(SYSTEM_PROMPT).toContain("call make_page with that page's id");
});

test("buildPrompt lists pending reminders in local time with their ids; the system prompt names the tools", () => {
  const base = { profile: "", memories: [], history: [], pending: [], nowLocal: "2026-11-04 14:05", tz: "Asia/Almaty", tzConfirmed: true, snapshots: [] };
  const dyn = buildPrompt({ ...base, reminders: [{ id: 3, text: "call the dentist", due_ts: Date.UTC(2026, 10, 5, 4, 0) }] }).system[1].content;
  expect(dyn).toContain("reminders (pending, local time):\n- 2026-11-05 09:00 call the dentist (id 3)");
  expect(buildPrompt({ ...base, reminders: [] }).system[1].content).not.toContain("reminders (pending");
  const many = buildPrompt({ ...base, reminders: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, text: `r${i + 1}`, due_ts: Date.UTC(2026, 10, 5, 4, i) })) }).system[1].content;
  expect(many).toContain("r10 (id 10)\n- and 2 more");
  expect(many).not.toContain("(id 11)");
  expect(SYSTEM_PROMPT).toContain("call set_reminder");
  expect(SYSTEM_PROMPT).toContain("cancel_reminder");
  expect(SYSTEM_PROMPT).toContain("fix it and call again without mentioning it");
  expect(SYSTEM_PROMPT).toContain("such as WhatsApp or Telegram"); // one prompt for both transports; markdown emphasis shows literally on Telegram
  expect(SYSTEM_PROMPT).not.toMatch(/on WhatsApp|only rarely/);
  expect(SYSTEM_PROMPT).toContain("never write a timestamp, a bracketed time or a date prefix");
  expect(SYSTEM_PROMPT).toContain("Never an em dash or en dash");
});

test("the system prompt offers search and a voice note on request, and says how to ask for each", () => {
  expect(SYSTEM_PROMPT).toContain("- Look things up on the web when you need current information.");
  expect(SYSTEM_PROMPT).toContain("browsing beyond a quick web search and links they send");
  expect(SYSTEM_PROMPT).toContain("search_web is only for current or outside information");
  expect(SYSTEM_PROMPT).toContain("- Voice notes: when they send you one, or whenever they ask for one, your reply goes out as a voice note (you can say so when asked). A plain text message still gets a text reply.");
  expect(SYSTEM_PROMPT).toContain('- If they ask you to say it out loud, speak, or send a voice note, put "voice: yes" as a header line right after the react line and write the reply the way you would say it; it goes out as one voice note.');
});

test("history marks voice notes in both directions so the model knows who spoke", () => {
  const base = { profile: "", memories: [], pending: [], nowLocal: "2026-11-05 23:35", tz: "Europe/Amsterdam", tzConfirmed: true, snapshots: [] };
  const history = [
    { id: "a", direction: "in" as const, text: "what time is it", ts: Date.UTC(2026, 10, 5, 22, 7), kind: "audio" },
    { id: "b", direction: "out" as const, text: "about seven past eleven", ts: Date.UTC(2026, 10, 5, 22, 7, 10), kind: "audio" },
    { id: "c", direction: "out" as const, text: "anything else?", ts: Date.UTC(2026, 10, 5, 22, 7, 20), kind: "text" },
  ];
  const text = buildPrompt({ ...base, history }).messages.map((m) => (typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((p) => p.text ?? "").join("\n"))).join("\n");
  expect(text).toContain("what time is it (voice note)");
  expect(text).toContain("about seven past eleven (sent as a voice note)");
  expect(text).toMatch(/anything else\?(\n|$)/);
  expect(text).not.toContain("anything else? (sent");
});
