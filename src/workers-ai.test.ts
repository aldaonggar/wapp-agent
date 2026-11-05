import { expect, test } from "vitest";
import { embedViaBinding, embedViaRest, rerankViaBinding, rerankViaRest, toBase64, transcribeViaBinding } from "./workers-ai";

const rest = (result: unknown, calls: { url: string; init: RequestInit }[] = []) =>
  (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ result, success: true, errors: [] })); }) as unknown as typeof fetch;

test("toBase64 encodes and round-trips a large buffer", () => {
  expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  const big = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
  expect(Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0))).toEqual(big);
});

test("embedViaBinding L2-normalises, keeps positions for empty texts and skips an all-empty batch", async () => {
  const inputs: unknown[] = [];
  const ai = { run: async (_m: string, i: { text: string[] }) => { inputs.push(i); return { data: i.text.map(() => [3, 4]) }; } } as unknown as Ai;
  const out = await embedViaBinding(ai)(["hi", " "]);
  expect(out).toHaveLength(2);
  expect(Array.from(out[0])).toEqual(Array.from(new Float32Array([0.6, 0.8])));
  expect(out[1]).toEqual(new Float32Array(1024));
  expect(inputs).toEqual([{ text: ["hi"], truncate_inputs: true }]);
  expect(await embedViaBinding(ai)([""])).toEqual([new Float32Array(1024)]);
  expect(inputs).toHaveLength(1);
});

test("embedViaRest posts the documented body, aligns empties and returns normalised vectors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const out = await embedViaRest("ACC", "tok", rest({ data: [[3, 4], [0, 2]] }, calls))(["a", "", "b"]);
  expect(out.map((v) => Array.from(v).slice(0, 2))).toEqual([Array.from(new Float32Array([0.6, 0.8])), [0, 0], [0, 1]]);
  expect(out[1].every((x) => x === 0)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/ACC/ai/run/@cf/baai/bge-m3");
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ text: ["a", "b"], truncate_inputs: true });
  expect(await embedViaRest("A", "t", rest(null, calls))([])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("embedViaRest batches at 100 and surfaces API errors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (u: string, init: RequestInit) => { calls.push({ url: u, init }); return new Response(JSON.stringify({ result: { data: JSON.parse(init.body as string).text.map(() => [1, 0]) }, success: true })); }) as unknown as typeof fetch;
  expect(await embedViaRest("A", "t", f)(Array.from({ length: 101 }, (_, i) => "t" + i))).toHaveLength(101);
  expect(calls.map((c) => JSON.parse(c.init.body as string).text.length)).toEqual([100, 1]);
  const bad = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7003 }] }), { status: 400 })) as unknown as typeof fetch;
  await expect(embedViaRest("A", "t", bad)(["x"])).rejects.toThrow(/7003/);
});

test("rerankViaRest maps response ids to input order and zeroes empties", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = rest({ response: [{ id: 1, score: 0.9 }, { id: 0, score: 0.2 }] }, calls);
  expect(await rerankViaRest("A", "t", f)("q", ["a", "b"])).toEqual([0.2, 0.9]);
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: "q", contexts: [{ text: "a" }, { text: "b" }] });
  expect(await rerankViaRest("A", "t", rest({ response: [{ id: 0, score: 0.5 }] }))("q", ["", "b"])).toEqual([0, 0.5]);
  expect(await rerankViaRest("A", "t", f)("", ["a"])).toEqual([0]);
  expect(await rerankViaRest("A", "t", f)("q", [])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("rerankViaBinding sends query and contexts", async () => {
  const seen: unknown[] = [];
  const ai = { run: async (_m: string, i: unknown) => { seen.push(i); return { response: [{ id: 0, score: 0.7 }] }; } } as unknown as Ai;
  expect(await rerankViaBinding(ai)("q", ["a"])).toEqual([0.7]);
  expect(seen).toEqual([{ query: "q", contexts: [{ text: "a" }] }]);
});

test("transcribeViaBinding sends base64 audio, language only when given, throws on empty text", async () => {
  const seen: Record<string, unknown>[] = [];
  let text = " hello ";
  const ai = { run: async (_m: string, i: Record<string, unknown>) => { seen.push(i); return { text }; } } as unknown as Ai;
  expect(await transcribeViaBinding(ai)(new Uint8Array([104, 105]), "audio/ogg; codecs=opus")).toBe("hello");
  expect(seen[0]).toEqual({ audio: "aGk=", task: "transcribe", vad_filter: true });
  await transcribeViaBinding(ai, "ru")(new Uint8Array([1]), "audio/ogg");
  expect(seen[1].language).toBe("ru");
  text = "  ";
  await expect(transcribeViaBinding(ai)(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(/empty/);
});
