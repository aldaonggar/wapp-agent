import type { DatabaseSync } from "node:sqlite";
import type { Db, Param, Row } from "./types";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, direction TEXT, kind TEXT, text TEXT, ts INTEGER, quoted_id TEXT, media_id TEXT, mime TEXT, media_note TEXT, voice INTEGER DEFAULT 0, reactions TEXT, turn_id INTEGER, status TEXT DEFAULT 'pending');
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, kind TEXT, signal INTEGER, created_at INTEGER, event_date TEXT, source_message_ids TEXT, status TEXT DEFAULT 'active', superseded_by INTEGER, followup_done INTEGER DEFAULT 0, embedding BLOB);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, fact_id UNINDEXED);
CREATE TABLE IF NOT EXISTS insights(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, confidence REAL, evidence_fact_ids TEXT, created_at INTEGER, status TEXT DEFAULT 'active', embedding BLOB);
CREATE TABLE IF NOT EXISTS profile(id INTEGER PRIMARY KEY CHECK(id=1), text TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS contact(id INTEGER PRIMARY KEY CHECK(id=1), wa_id TEXT, name TEXT, timezone TEXT, timezone_confirmed INTEGER DEFAULT 0, last_inbound_ts INTEGER, last_proactive_date TEXT);
CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), turn_due INTEGER, insights_due INTEGER, followup_due INTEGER, followup_fact_id INTEGER, burst_started_at INTEGER, generation INTEGER DEFAULT 0, turn_attempts INTEGER DEFAULT 0, last_insights_run INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS turns(id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, wait_ms INTEGER, retrieval_ms INTEGER, ttft_ms INTEGER, ttfb_ms INTEGER, total_ms INTEGER, model TEXT, provider TEXT, bubbles INTEGER, regenerated INTEGER DEFAULT 0, error TEXT, usage TEXT, recalled TEXT);
CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, job TEXT, model TEXT, usage TEXT);
INSERT OR IGNORE INTO state(id) VALUES (1);
`;

export function migrate(db: Db): void {
  db.batch(SCHEMA);
  // Columns added after the first deploy.
  if (!db.all("SELECT 1 FROM pragma_table_info('turns') WHERE name='recalled'").length) db.run("ALTER TABLE turns ADD COLUMN recalled TEXT");
}

const plain = (r: Record<string, unknown>): Row => {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[k] = v instanceof ArrayBuffer ? new Uint8Array(v) : (v as Row[string]);
  return o;
};

export function fromDO(sql: SqlStorage): Db {
  const bind = (p: Param[]) => p.map((x) => (x instanceof Uint8Array ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : x));
  return {
    all: <T = Row>(q: string, ...p: Param[]) => sql.exec(q, ...bind(p)).toArray().map((r) => plain(r)) as T[],
    run: (q, ...p) => { sql.exec(q, ...bind(p)).toArray(); }, // consume the cursor so a lazy statement always runs
    batch: (q) => { sql.exec(q).toArray(); },
  };
}

export function fromNode(db: DatabaseSync): Db {
  return {
    all: <T = Row>(q: string, ...p: Param[]) => db.prepare(q).all(...p).map((r) => ({ ...r })) as T[],
    run: (q, ...p) => { db.prepare(q).run(...p); },
    batch: (q) => { db.exec(q); },
  };
}

export const vecToBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
export const blobToVec = (b: Uint8Array): Float32Array => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export function formatLocal(ts: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(ts).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
