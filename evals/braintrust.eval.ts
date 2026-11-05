// npm run eval -- --braintrust [flags]: the same scenarios, harness and judge as scenarios.test.ts, run through Braintrust's Eval
// so configurations can be compared in its UI. Results also land in evals/results/, so EVALS.md is the same whichever runner produced them.
import { Eval } from "braintrust";
import { makeLlm } from "../src/llm";
import { evalConfig, loadScenarios, runScenario, type Scenario, type ScenarioResult } from "./harness";
import { crashed, saveResults } from "./results";

const env = process.env;
for (const k of ["OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!env[k]) throw new Error(`${k} is not set (see SETUP.md)`);
const cfg = evalConfig();
const scenarios = loadScenarios("evals/scenarios", env.EVAL_FILTER);
const results: ScenarioResult[] = [];
const frac = (n: number, d: number) => (d ? n / d : null); // null: nothing of that kind in the scenario, Braintrust leaves the score out
const CAP_MS = 20 * 60_000; // same per-scenario cap as scenarios.test.ts
const capped = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no result after ${CAP_MS / 60_000} min`)), CAP_MS).unref())]);

Eval("wapp-agent", {
  experimentName: cfg.tag,
  metadata: { ...cfg },
  data: scenarios.map((sc) => ({ input: sc, tags: [sc.category], metadata: { category: sc.category } })),
  maxConcurrency: 1, // the latency columns in EVALS.md are wall-clock per turn; concurrent scenarios would share rate limits and skew them
  task: async (sc: Scenario, hooks) => {
    let r: ScenarioResult;
    try {
      r = await capped(runScenario(sc, cfg, makeLlm(env.OPENROUTER_API_KEY!)));
    } catch (e) {
      r = crashed(sc, e instanceof Error ? e.message : String(e));
    }
    r = { ...r, at: new Date().toISOString() };
    results.push(r);
    if (!r.passed) process.exitCode = 1; // like the vitest runner: a failed scenario fails the command (the CLI exits early only on its own errors)
    saveResults(cfg, results); // after every scenario, so an aborted run keeps what finished
    hooks.span.log({ metrics: { estimated_cost: r.costUsd, judge_cost_usd: r.judgeCostUsd } });
    return r;
  },
  scores: [
    ({ output }) => ({ name: "passed", score: output.passed ? 1 : 0 }),
    ({ output }) => ({ name: "probes_correct", score: frac(output.probes.filter((p) => p.label === "correct").length, output.probes.length) }),
    ({ output }) => ({ name: "checks_passed", score: frac(output.checks.filter((c) => c.passed).length, output.checks.length) }),
  ],
});
