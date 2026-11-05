import { z } from "zod";
import type { Llm } from "../src/core/types";
import { pickModels } from "../src/models";
import type { ProbeResult } from "./harness";

const Verdict = z.object({ label: z.enum(["correct", "partial", "wrong", "hallucinated"]), reason: z.string() });
const FactsVerdict = z.object({ matched: z.number().int().min(0), junk: z.number().int().min(0) });

const JUDGE = `You grade one reply from a WhatsApp chat companion against a gold answer.
You get the conversation leading up to the question (it may be empty), the question, the gold answer and the reply.
The gold is either the fact the reply must convey or the behaviour it must show (for example "says it doesn't know").
Labels:
- correct: the reply conveys the gold fact or shows the gold behaviour. Wording, tone, emojis and extra small talk do not matter.
- partial: the reply conveys only part of the gold, or hedges between the gold and something else.
- wrong: the reply contradicts the gold, misses it, is empty, or says it does not know (or asks for the information) while the gold gives it.
- hallucinated: the reply asserts a specific fact that is neither in the gold nor in the conversation, in place of or on top of the gold.
Give a one-line reason.`;

const FACTS = `You compare the facts a memory system stored about a person against the gold facts it should have stored.
matched: how many gold facts are expressed by at least one stored fact (paraphrases count).
junk: how many stored facts express none of the gold facts.`;

const opts = { modelId: pickModels({}).judge, reasoning: { effort: "low" as const }, sessionId: "eval-judge" };

export async function judge(llm: Llm, p: { question: string; gold: string; answer: string }): Promise<{ label: ProbeResult["label"]; reason: string }> {
  const content = `${p.question}\n\nGold: ${p.gold}\n\nReply: ${p.answer || "(no reply)"}`;
  return (await llm.object({ ...opts, job: "judge", system: JUDGE, messages: [{ role: "user", content }], schema: Verdict })).value;
}

export async function judgeFacts(llm: Llm, p: { gold: string[]; stored: string[] }): Promise<{ matched: number; junk: number }> {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const content = `Gold facts:\n${list(p.gold)}\n\nStored facts:\n${list(p.stored)}`;
  const { value } = await llm.object({ ...opts, job: "judge", system: FACTS, messages: [{ role: "user", content }], schema: FactsVerdict });
  return { matched: Math.min(value.matched, p.gold.length), junk: Math.min(value.junk, p.stored.length) }; // a count can't exceed its list
}
