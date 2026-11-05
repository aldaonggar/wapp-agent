import { z } from "zod";
import { blobToVec, formatLocal, vecToBlob } from "./db";
import { cosineTopN } from "./memory";
import type { Deps } from "./types";

export const InsightSchema = z.object({ insights: z.array(z.object({ text: z.string(), confidence: z.number().min(0).max(1), evidence_fact_ids: z.array(z.number().int()) })).max(3) });

const MIN_CONFIDENCE = 0.5, RELATED_PER_FACT = 5;

export const INSIGHT_PROMPT = `You look for connections in what a WhatsApp companion knows about one person. You get NEW facts and RELATED older facts, each as [id] text (kind, date said), and the current local time.

Find up to 3 connections or implications that the person never stated together: two or more facts that, taken together, mean something neither says alone (a trip on the same days as a family birthday; a diet that matters for a restaurant booking; an early flight that clashes with a morning routine).
- Every insight is one short self-contained sentence in the language of the facts, about the person.
- evidence_fact_ids lists the ids of the facts it rests on, taken only from the listed [id]s, at least two; at least one should be a new fact.
- confidence is 0 to 1: how sure you are the connection is real and will matter.
- Never restate a single fact, never invent facts, and skip anything that is just a guess about feelings.
- If nothing connects, return {"insights": []}.`;

type Fact = { id: number; text: string; kind: string; created_at: number; embedding: Uint8Array };

export async function deriveInsights(deps: Deps, sessionId = "insights"): Promise<number> {
  const { db, clock, models, llm } = deps;
  const since = db.all<{ t: number | null }>("SELECT last_insights_run AS t FROM state")[0]?.t ?? 0;
  const now = clock.now();
  const fresh = db.all<Fact>("SELECT id, text, kind, created_at, embedding FROM facts WHERE status='active' AND created_at > ? ORDER BY id", since);
  if (!fresh.length) { db.run("UPDATE state SET last_insights_run=?", now); return 0; }

  const newIds = new Set(fresh.map((f) => f.id));
  const relatedIds = new Set<number>();
  for (const f of fresh) if (f.embedding) for (const s of cosineTopN(db, blobToVec(f.embedding), RELATED_PER_FACT + newIds.size, "facts", true).filter((s) => !newIds.has(s.id)).slice(0, RELATED_PER_FACT)) relatedIds.add(s.id);
  const related = relatedIds.size ? db.all<Fact>("SELECT id, text, kind, created_at, embedding FROM facts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify([...relatedIds])) : [];

  const tz = db.all<{ timezone: string | null }>("SELECT timezone FROM contact")[0]?.timezone || "UTC";
  const line = (f: Fact) => `[${f.id}] ${f.text} (${f.kind}, ${formatLocal(f.created_at, tz).slice(0, 10)})`;
  const input = `Now: ${formatLocal(now, tz)} (${tz})\n\nNew facts:\n${fresh.map(line).join("\n")}\n\nRelated older facts:\n${related.map(line).join("\n") || "(none)"}`;
  const { value } = await llm.object({ job: "derive", modelId: models.derive, system: INSIGHT_PROMPT, messages: [{ role: "user", content: input }], schema: InsightSchema, sessionId });

  const active = new Set(db.all<{ id: number }>("SELECT id FROM facts WHERE status='active'").map((r) => r.id));
  const keep = value.insights.filter((i) => i.text.trim() && i.confidence >= MIN_CONFIDENCE && i.evidence_fact_ids.length >= 2 && i.evidence_fact_ids.every((id) => active.has(id)));
  if (keep.length) {
    const vecs = await deps.embed(keep.map((i) => i.text.trim()));
    keep.forEach((i, n) => db.run("INSERT INTO insights(text, confidence, evidence_fact_ids, created_at, embedding) VALUES (?, ?, ?, ?, ?)", i.text.trim(), i.confidence, JSON.stringify(i.evidence_fact_ids), now, vecToBlob(vecs[n])));
  }
  db.run("UPDATE state SET last_insights_run=?", now);
  return keep.length;
}
