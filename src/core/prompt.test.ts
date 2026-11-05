import { expect, test } from "vitest";
import { SYSTEM_PROMPT, buildPrompt, windowHistory, type HistoryRow } from "./prompt";

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
