import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { EvalConfig, Scenario } from "./harness";
import { crashed, saveResults } from "./results";

const dir = mkdtempSync(join(tmpdir(), "wapp-results-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cfg = { memory: true, retrieval: "hybrid", tag: "t" } as EvalConfig;
const sc = (name: string): Scenario => ({ name, category: "short-term", steps: [] });
const read = () => JSON.parse(readFileSync(join(dir, "t.json"), "utf8")).scenarios.map((s: { name: string; passed: boolean }) => [s.name, s.passed]);

test("a filtered run replaces only the scenarios it ran, sorted by name", () => {
  saveResults(cfg, [{ ...crashed(sc("b"), "x"), passed: true }, crashed(sc("a"), "x")], dir);
  expect(read()).toEqual([["a", false], ["b", true]]);
  saveResults(cfg, [crashed(sc("b"), "again")], dir);
  expect(read()).toEqual([["a", false], ["b", false]]);
  saveResults(cfg, [], dir); // nothing ran: file untouched
  expect(read()).toEqual([["a", false], ["b", false]]);
});
