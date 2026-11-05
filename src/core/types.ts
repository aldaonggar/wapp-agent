export type InboundKind = "text" | "image" | "video" | "audio" | "sticker" | "document" | "location" | "contacts" | "reaction" | "unsupported";
export interface Inbound { id: string; from: string; name?: string; ts: number; kind: InboundKind; text?: string; mediaId?: string; mime?: string; voice?: boolean; quotedId?: string; reaction?: { messageId: string; emoji?: string } }
export interface WaStatus { id: string; status: string; recipientId: string; ts: number; pricingType?: string; errorCode?: number }
export interface WaClient {
  sendText(to: string, body: string, opts?: { quote?: string; previewUrl?: boolean }): Promise<{ id: string }>;
  sendReaction(to: string, messageId: string, emoji: string): Promise<void>;
  markReadTyping(messageId: string): Promise<void>;
  fetchMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }>;
  sendAudio?(to: string, bytes: Uint8Array, mime: string, opts?: { quote?: string }): Promise<{ id: string }>; // optional: a transport without it gets text replies
  window24h?(to: string): boolean; // optional: Meta's 24-hour reply window applies unless the transport answers false (Telegram has none)
}
export type { Usage, Llm, StreamCall, ObjectCall } from "../llm";
export type { ReasoningSetting, ModelChoice } from "../models";
export type Param = string | number | null | Uint8Array;
export type Row = Record<string, string | number | null | Uint8Array>;
export interface Db { all<T = Row>(sql: string, ...p: Param[]): T[]; run(sql: string, ...p: Param[]): void; batch(sql: string): void }

import type { Llm } from "../llm";
import type { ModelChoice } from "../models";
export interface Clock { now(): number; sleep(ms: number): Promise<void>; setAlarm(at: number | null): Promise<void> | void } // null deletes the alarm
export interface Snapshot { url: string; finalUrl: string; title: string; status: number; markdown: string; jpeg: Uint8Array }
export interface Features { memory: boolean; retrieval: "cosine" | "hybrid"; replyEffort?: "low" | "medium" | "high" }
export interface MemoryHit { id: number; kind: "fact" | "insight"; text: string; date: string; score: number; confidence?: number; status: "active" | "superseded" }
export interface Deps {
  db: Db; clock: Clock; wa: WaClient; llm: Llm;
  embed(texts: string[]): Promise<Float32Array[]>;
  rerank(query: string, docs: string[]): Promise<number[]>;
  transcribe(bytes: Uint8Array, mime: string): Promise<string>;
  tts?(text: string): Promise<{ bytes: Uint8Array; mime: string }>; // optional: without it every reply is text
  snapshot(url: string): Promise<Snapshot | null>;
  models: ModelChoice; features: Features;
  contactKey: string; // opaque per-contact id for logs and OpenRouter session_id/user; never the phone number
  log(event: Record<string, unknown>): void;
}
