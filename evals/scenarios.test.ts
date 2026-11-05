import { afterAll, describe, expect, test } from "vitest";
import { makeLlm } from "../src/llm";
import { evalConfig, loadScenarios, runScenario, type ScenarioResult } from "./harness";
import { crashed, saveResults } from "./results";

const env = process.env;

describe.skipIf(!env.OPENROUTER_API_KEY || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)("scenarios", () => {
  const cfg = evalConfig();
  const scenarios = loadScenarios("evals/scenarios", env.EVAL_FILTER);
  const results: ScenarioResult[] = [];

  afterAll(() => {
    // A test that timed out never pushed: record it, so the merge cannot keep a stale result under its name.
    for (const sc of scenarios) if (!results.some((r) => r.name === sc.name)) results.push({ ...crashed(sc, "no result: timed out or aborted"), at: new Date().toISOString() });
    saveResults(cfg, results);
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
