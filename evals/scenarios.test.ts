import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { makeLlm } from "../src/llm";
import { evalConfig, loadScenarios, runScenario, type Scenario, type ScenarioResult } from "./harness";

const env = process.env;
const crashed = (sc: Scenario, detail: string): ScenarioResult =>
  ({ name: sc.name, category: sc.category, probes: [], checks: [{ name: "crashed", passed: false, detail }], transcript: [], turns: [], costUsd: 0, costByJob: {}, judgeCostUsd: 0, passed: false });

describe.skipIf(!env.OPENROUTER_API_KEY || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)("scenarios", () => {
  const cfg = evalConfig();
  const scenarios = loadScenarios("evals/scenarios", env.EVAL_FILTER);
  const results: ScenarioResult[] = [];

  // One file per configuration; a filtered run replaces only the scenarios it ran.
  afterAll(() => {
    // A test that timed out never pushed: record it, so the merge below cannot keep a stale result under its name.
    for (const sc of scenarios) if (!results.some((r) => r.name === sc.name)) results.push({ ...crashed(sc, "no result: timed out or aborted"), at: new Date().toISOString() });
    if (!results.length) return;
    mkdirSync("evals/results", { recursive: true });
    const file = `evals/results/${cfg.tag}.json`;
    const prev: ScenarioResult[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).scenarios : [];
    const merged = [...prev.filter((p) => !results.some((r) => r.name === p.name)), ...results].sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(file, JSON.stringify({ tag: cfg.tag, config: cfg, at: new Date().toISOString(), scenarios: merged }, null, 2) + "\n");
  });

  for (const sc of scenarios) {
    test(sc.name, { timeout: 20 * 60_000 }, async () => {
      let r: ScenarioResult;
      try {
        r = await runScenario(sc, cfg, makeLlm(env.OPENROUTER_API_KEY!));
      } catch (e) {
        r = crashed(sc, e instanceof Error ? e.message : String(e));
      }
      results.push({ ...r, at: new Date().toISOString() });
      const failed = [...r.probes.filter((p) => p.label !== "correct").map((p) => `${p.ask} → ${p.label}: ${p.reason}`), ...r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`)];
      expect(failed).toEqual([]);
    });
  }
});
