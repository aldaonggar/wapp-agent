import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { makeLlm } from "../src/llm";
import { evalConfig, loadScenarios, runScenario, type ScenarioResult } from "./harness";

const env = process.env;

describe.skipIf(!env.OPENROUTER_API_KEY || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)("scenarios", () => {
  const cfg = evalConfig();
  const results: ScenarioResult[] = [];

  // One file per configuration; a filtered run replaces only the scenarios it ran.
  afterAll(() => {
    if (!results.length) return;
    mkdirSync("evals/results", { recursive: true });
    const file = `evals/results/${cfg.tag}.json`;
    const prev: ScenarioResult[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).scenarios : [];
    const scenarios = [...prev.filter((p) => !results.some((r) => r.name === p.name)), ...results].sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(file, JSON.stringify({ tag: cfg.tag, config: cfg, at: new Date().toISOString(), scenarios }, null, 2) + "\n");
  });

  for (const sc of loadScenarios("evals/scenarios", env.EVAL_FILTER)) {
    test(sc.name, { timeout: 20 * 60_000 }, async () => {
      const r = await runScenario(sc, cfg, makeLlm(env.OPENROUTER_API_KEY!));
      results.push(r);
      const failed = [...r.probes.filter((p) => p.label !== "correct").map((p) => `${p.ask} → ${p.label}: ${p.reason}`), ...r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`)];
      expect(failed).toEqual([]);
    });
  }
});
