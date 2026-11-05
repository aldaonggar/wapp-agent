import type { Deps } from "./core/types";

// bge-m3 through the AI binding: ≤100 texts per call, no empty strings, L2-normalised. REST, rerank, transcribe: Task 8.
export function embedViaBinding(ai: Ai): Deps["embed"] {
  return async (texts) => {
    const text = texts.filter((t) => t.trim());
    const out: Float32Array[] = [];
    for (let i = 0; i < text.length; i += 100) {
      const r = await ai.run("@cf/baai/bge-m3", { text: text.slice(i, i + 100), truncate_inputs: true });
      if (!("data" in r) || !r.data) throw new Error("bge-m3: unexpected output " + JSON.stringify(r).slice(0, 200));
      for (const v of r.data) {
        const n = Math.hypot(...v) || 1;
        out.push(Float32Array.from(v, (x) => x / n));
      }
    }
    return out;
  };
}
