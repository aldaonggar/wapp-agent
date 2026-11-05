import { describe, expect, it } from "vitest";
import { costUsd, maxOutputTokensFor, pickModels, reasoningFor, replyEffortFrom, replyModelFor } from "./models";

describe("models", () => {
  it("costUsd splits cached input", () => {
    const c = costUsd("deepseek/deepseek-v4.1-flash", { input: 10000, output: 1000, cached: 4000 });
    expect(Math.abs(c - (6000 * 0.045 + 4000 * 0.018 + 1000 * 0.5) / 1e6)).toBeLessThan(1e-9);
  });
  it("maxOutputTokensFor", () => {
    expect(maxOutputTokensFor("anthropic/claude-sonnet-5.5")).toBe(2048);
    expect(maxOutputTokensFor("deepseek/deepseek-v4.1-flash")).toBe(400);
    expect(maxOutputTokensFor("deepseek/deepseek-v4.1-flash", "medium")).toBe(2048);
  });
  it("reasoningFor", () => {
    expect(reasoningFor("moonshotai/kimi-k2.6")).toEqual({ enabled: false });
    expect(reasoningFor("moonshotai/kimi-k2.6", "high")).toEqual({ effort: "high" });
  });
  it("pickModels and replyModelFor", () => {
    expect(pickModels({ MODEL_REPLY: "z-ai/glm-5.2" }).reply).toBe("z-ai/glm-5.2");
    const c = { ...pickModels({}), reply: "z-ai/glm-5.2", vision: "openai/gpt-6.1-terra" };
    expect(replyModelFor(c, true)).toBe("openai/gpt-6.1-terra");
    expect(replyModelFor(c, false)).toBe("z-ai/glm-5.2");
  });
});

it("REPLY_EFFORT accepts low, medium, high and nothing else", () => {
  expect(replyEffortFrom("low")).toBe("low");
  expect(replyEffortFrom("medium")).toBe("medium");
  expect(replyEffortFrom("high")).toBe("high");
  expect(replyEffortFrom("none")).toBeUndefined();
  expect(replyEffortFrom("")).toBeUndefined();
  expect(replyEffortFrom(undefined)).toBeUndefined();
});
