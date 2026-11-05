// Result bookkeeping shared by the vitest and Braintrust runners: one file per configuration in evals/results/, read by report.ts.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { EvalConfig, Scenario, ScenarioResult } from "./harness";

export const crashed = (sc: Scenario, detail: string): ScenarioResult =>
  ({ name: sc.name, category: sc.category, probes: [], checks: [{ name: "crashed", passed: false, detail }], transcript: [], turns: [], costUsd: 0, costByJob: {}, judgeCostUsd: 0, passed: false });

// A filtered run replaces only the scenarios it ran; the rest of the file is kept.
export function saveResults(cfg: EvalConfig, results: ScenarioResult[], dir = "evals/results"): void {
  if (!results.length) return;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${cfg.tag}.json`;
  const prev: ScenarioResult[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).scenarios : [];
  const merged = [...prev.filter((p) => !results.some((r) => r.name === p.name)), ...results].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(`${file}.tmp`, JSON.stringify({ tag: cfg.tag, config: cfg, at: new Date().toISOString(), scenarios: merged }, null, 2) + "\n");
  renameSync(`${file}.tmp`, file); // atomic: the Braintrust runner rewrites the file after every scenario
}
