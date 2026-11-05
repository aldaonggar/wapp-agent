import { expect, test } from "vitest";
import { embedViaBinding } from "./workers-ai";

test("embedViaBinding L2-normalises, drops empty strings and skips an empty batch", async () => {
  const inputs: unknown[] = [];
  const ai = { run: async (_model: string, i: { text: string[] }) => { inputs.push(i); return { data: i.text.map(() => [3, 4]) }; } } as unknown as Ai;
  const out = await embedViaBinding(ai)(["hi", " "]);
  expect(out.map((v) => Array.from(v))).toEqual([Array.from(new Float32Array([0.6, 0.8]))]);
  expect(inputs).toEqual([{ text: ["hi"], truncate_inputs: true }]);
  expect(await embedViaBinding(ai)([""])).toEqual([]);
  expect(inputs).toHaveLength(1);
});
