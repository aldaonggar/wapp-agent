export type InboundKind = "text" | "image" | "video" | "audio" | "sticker" | "document" | "location" | "contacts" | "reaction" | "unsupported";
export interface Inbound { id: string; from: string; name?: string; ts: number; kind: InboundKind; text?: string; mediaId?: string; mime?: string; voice?: boolean; quotedId?: string; reaction?: { messageId: string; emoji?: string } }
export interface WaStatus { id: string; status: string; recipientId: string; ts: number; pricingType?: string; errorCode?: number }
export interface WaClient {
  sendText(to: string, body: string, opts?: { quote?: string; previewUrl?: boolean }): Promise<{ id: string }>;
  sendReaction(to: string, messageId: string, emoji: string): Promise<void>;
  markReadTyping(messageId: string): Promise<void>;
  fetchMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }>;
}
export type { Usage, Llm, StreamCall, ObjectCall } from "../llm";
export type { ReasoningSetting, ModelChoice } from "../models";
