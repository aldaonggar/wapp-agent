export type ReasoningSetting = { effort: "none" | "low" | "medium" | "high" } | { enabled: false } | null;
export interface ModelSpec { id: string; in: number; out: number; cachedIn: number; vision: boolean; lowest: ReasoningSetting; mandatoryThinking: boolean }

const m = (id: string, i: number, out: number, cachedIn: number, vision: boolean, lowest: ReasoningSetting, mandatoryThinking = false): [string, ModelSpec] =>
  [id, { id, in: i, out, cachedIn, vision, lowest, mandatoryThinking }];

// USD per 1M tokens, OpenRouter list prices 2026-11-04 (design §4.1).
export const MODELS: Record<string, ModelSpec> = Object.fromEntries([
  m("deepseek/deepseek-v4.1-flash", 0.045, 0.5, 0.018, true, { effort: "none" }),
  m("openai/gpt-6.1-terra", 1, 5, 0.05, true, { effort: "none" }),
  m("openai/gpt-6.1-sol", 2, 10, 0.1, true, { effort: "low" }, true),
  m("anthropic/claude-sonnet-5.5", 2, 10, 0.1, true, { effort: "low" }, true),
  m("moonshotai/kimi-k2.6", 0.65, 3.41, 0.15, true, { enabled: false }),
  m("z-ai/glm-5.2", 0.006, 6.8, 0.005, false, { effort: "none" }),
  m("openai/gpt-6-luna", 0.1, 0.5, 0.01, true, { effort: "none" }),
  m("anthropic/claude-haiku-5.5", 0.1, 0.5, 0.01, true, { effort: "none" }),
  m("deepseek/deepseek-v4-pro", 1.6, 3.2, 0.135, false, null),
  m("anthropic/claude-opus-5.5", 4, 20, 0.2, true, null, true),
]);

export const JOBS = {
  reply: {
    default: "deepseek/deepseek-v4.1-flash",
    candidates: ["deepseek/deepseek-v4.1-flash", "openai/gpt-6.1-terra", "openai/gpt-6.1-sol", "anthropic/claude-sonnet-5.5", "moonshotai/kimi-k2.6", "z-ai/glm-5.2"],
    compareByDefault: ["deepseek/deepseek-v4.1-flash", "moonshotai/kimi-k2.6", "z-ai/glm-5.2"],
  },
  vision: { default: "openai/gpt-6.1-terra", candidates: ["openai/gpt-6.1-terra", "anthropic/claude-sonnet-5.5"] },
  // extract and derive defaults measured 2026-11-05 (EVALS.md); deepseek-v4-pro has no host in the account's OpenRouter allowed-providers list.
  extract: { default: "anthropic/claude-haiku-5.5", candidates: ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna", "anthropic/claude-haiku-5.5"] },
  derive: { default: "openai/gpt-6.1-sol", candidates: ["deepseek/deepseek-v4-pro", "openai/gpt-6.1-sol", "anthropic/claude-sonnet-5.5"] },
  judge: { default: "anthropic/claude-opus-5.5" as const },
};

export const CHINA_HOSTS = ["deepseek", "moonshotai", "z-ai", "alibaba", "baidu", "siliconflow", "streamlake"];

export interface ModelChoice { reply: string; vision: string; extract: string; derive: string; judge: string }

export function pickModels(env: Partial<Record<"MODEL_REPLY" | "MODEL_VISION" | "MODEL_EXTRACT" | "MODEL_DERIVE", string>>): ModelChoice {
  return {
    reply: env.MODEL_REPLY || JOBS.reply.default,
    vision: env.MODEL_VISION || JOBS.vision.default,
    extract: env.MODEL_EXTRACT || JOBS.extract.default,
    derive: env.MODEL_DERIVE || JOBS.derive.default,
    judge: JOBS.judge.default,
  };
}

export function replyModelFor(choice: ModelChoice, needsVision: boolean): string {
  return needsVision && !MODELS[choice.reply]?.vision ? choice.vision : choice.reply;
}

function spec(id: string): ModelSpec {
  const s = MODELS[id];
  if (!s) throw new Error(`unknown model ${id}`);
  return s;
}

export function costUsd(id: string, u: { input: number; output: number; cached: number }): number {
  const s = spec(id);
  return ((u.input - u.cached) * s.in + u.cached * s.cachedIn + u.output * s.out) / 1e6;
}

export function maxOutputTokensFor(id: string, effort?: "low" | "medium" | "high"): number {
  return spec(id).mandatoryThinking || effort === "medium" || effort === "high" ? 2048 : 400;
}

export function reasoningFor(id: string, effort?: "low" | "medium" | "high"): ReasoningSetting {
  return effort ? { effort } : spec(id).lowest;
}

export function needsHostFilter(id: string): boolean {
  return /^(deepseek|moonshotai|z-ai)\//.test(id);
}
