import { expect, test } from "vitest";
import { bubblePauseMs, looksUnfinished, turnDue } from "./cadence";

test("looksUnfinished", () => {
  for (const t of ["so basically...", "hey", "quick q", "so", "And.", "hey!"]) expect(looksUnfinished(t)).toBe(true);
  for (const t of ["see you at 7", "I think it's fine", "ok thanks", "okay"]) expect(looksUnfinished(t)).toBe(false);
});

test("turnDue", () => {
  expect(turnDue(10_000, 10_000, "ok")).toBe(13_000);
  expect(turnDue(10_000, 10_000, "and")).toBe(18_000);
  expect(turnDue(24_000, 10_000, "and")).toBe(25_000);
});

test("bubblePauseMs", () => {
  expect(bubblePauseMs(300)).toBe(2000);
  expect(bubblePauseMs(40)).toBe(1000);
});
