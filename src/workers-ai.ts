import type { Deps } from "./core/types";

const DIM = 1024;
const EMBED = "@cf/baai/bge-m3", WHISPER = "@cf/openai/whisper-large-v3-turbo", TTS = "@cf/deepgram/aura-1";
type Run = (model: string, input: Record<string, unknown>) => Promise<unknown>;

const viaBinding = (ai: Ai): Run => (model, input) => (ai.run as (m: string, i: unknown) => Promise<unknown>)(model, input);

function viaRest(accountId: string, token: string, fetchFn: typeof fetch): Run {
  return async (model, input) => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: unknown; success?: boolean; errors?: unknown };
    if (!res.ok || json.success === false) throw new Error(`workers-ai ${model}: ${res.status} ${JSON.stringify(json.errors ?? "").slice(0, 200)}`);
    return json.result;
  };
}

const blank = (s: string) => !s.trim();

// Empty texts are never sent (bge-m3 rejects them) but keep their position with a zero vector.
function embedWith(run: Run): Deps["embed"] {
  return async (texts) => {
    const out = texts.map(() => new Float32Array(DIM));
    const idx = texts.flatMap((t, i) => (blank(t) ? [] : [i]));
    for (let b = 0; b < idx.length; b += 100) {
      const part = idx.slice(b, b + 100);
      const r = (await run(EMBED, { text: part.map((i) => texts[i]), truncate_inputs: true })) as { data?: number[][] };
      if (!r?.data || r.data.length !== part.length) throw new Error("bge-m3: unexpected output " + JSON.stringify(r).slice(0, 200));
      r.data.forEach((v, k) => {
        const n = Math.hypot(...v) || 1;
        out[part[k]] = Float32Array.from(v, (x) => x / n);
      });
    }
    return out;
  };
}

function rerankWith(run: Run): Deps["rerank"] {
  return async (query, docs) => {
    const scores = docs.map(() => 0);
    const idx = docs.flatMap((d, i) => (blank(d) ? [] : [i]));
    if (blank(query) || !idx.length) return scores;
    const r = (await run(EMBED, { query, contexts: idx.map((i) => ({ text: docs[i] })) })) as { response?: { id: number; score: number }[] };
    if (!r?.response) throw new Error("bge-m3 rerank: unexpected output " + JSON.stringify(r).slice(0, 200));
    for (const { id, score } of r.response) if (idx[id] !== undefined) scores[idx[id]] = score;
    return scores;
  };
}

export const embedViaBinding = (ai: Ai): Deps["embed"] => embedWith(viaBinding(ai));
export const embedViaRest = (accountId: string, token: string, fetchFn: typeof fetch = fetch): Deps["embed"] => embedWith(viaRest(accountId, token, fetchFn));
export const rerankViaBinding = (ai: Ai): Deps["rerank"] => rerankWith(viaBinding(ai));
export const rerankViaRest = (accountId: string, token: string, fetchFn: typeof fetch = fetch): Deps["rerank"] => rerankWith(viaRest(accountId, token, fetchFn));

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// OGG/Opus is the one format WhatsApp shows as a voice note. Measured 2026-11-05: p50 0.58 s for a 126-character reply; billed per character, 1,364 neurons per 1,000.
// The service labels the body audio/mpeg whatever the container, so the mime is set here.
export function ttsViaBinding(ai: Ai): NonNullable<Deps["tts"]> {
  return async (text) => {
    const res = await (ai.run as (m: string, i: unknown, o: unknown) => Promise<Response>)(TTS, { text, encoding: "opus", container: "ogg" }, { returnRawResponse: true });
    if (!res.ok) throw new Error(`aura-1: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/ogg" };
  };
}

export function transcribeViaBinding(ai: Ai, language?: string): Deps["transcribe"] {
  const run = viaBinding(ai);
  return async (bytes) => {
    const r = (await run(WHISPER, { audio: toBase64(bytes), task: "transcribe", vad_filter: true, ...(language ? { language } : {}) })) as { text?: string };
    const text = r?.text?.trim();
    if (!text) throw new Error("whisper: empty transcript");
    return text;
  };
}
