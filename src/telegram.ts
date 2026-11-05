import type { Inbound, WaClient } from "./core/types";
import { WaError } from "./whatsapp";

// Telegram Bot API transport behind the WaClient interface. Ids carry the chat so no extra state is needed:
// contact `tg:<chat_id>`, message `tg:<chat_id>:<message_id>`, reaction event `...:r<date>`, media `tg:<file_id>`.
export const TG = "https://api.telegram.org";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function parseUpdate(body: unknown): { m: Inbound; user: { id: number; username?: string } } | null {
  const u = obj(body);
  const reaction = u.message_reaction !== undefined;
  const src = reaction ? obj(u.message_reaction) : obj(u.message); // edited_message, channel_post etc. fall through as empty
  const chat = obj(src.chat), from = obj(reaction ? src.user : src.from);
  const chatId = num(chat.id), userId = num(from.id), mid = num(src.message_id), date = num(src.date);
  if (chat.type !== "private" || chatId === undefined || userId === undefined || mid === undefined || date === undefined || from.is_bot === true) return null;
  const user = { id: userId, ...(str(from.username) ? { username: str(from.username) } : {}) };
  const id = `tg:${chatId}:${mid}`;
  const m: Inbound = { id, from: `tg:${chatId}`, ts: date * 1000, kind: "unsupported" };
  const name = str(from.first_name);
  if (name) m.name = name;
  if (reaction) {
    m.id = `${id}:r${date}`;
    m.kind = "reaction";
    m.reaction = { messageId: id, emoji: arr(src.new_reaction).map((r) => str(r.emoji)).find(Boolean) };
    return { m, user };
  }
  const quoted = num(obj(src.reply_to_message).message_id);
  if (quoted !== undefined) m.quotedId = `tg:${chatId}:${quoted}`;
  const caption = str(src.caption);
  const media = (file: Obj, mime: string | undefined) => { const fid = str(file.file_id); if (fid) m.mediaId = `tg:${fid}`; if (mime) m.mime = mime; };
  if (src.text !== undefined) {
    const text = str(src.text) ?? "";
    m.kind = "text";
    m.text = /^\/start(\s|$)/.test(text) ? "Hi" : text; // t.me/<bot>?start=x arrives as "/start x"
  } else if (src.photo !== undefined) {
    const sizes = arr(src.photo), best = sizes.reduce((a, b) => ((num(b.width) ?? 0) * (num(b.height) ?? 0) > (num(a.width) ?? 0) * (num(a.height) ?? 0) ? b : a), sizes[0] ?? {});
    m.kind = "image";
    m.text = caption ?? "[photo]";
    media(best, "image/jpeg");
  } else if (src.voice !== undefined) {
    m.kind = "audio";
    m.voice = true;
    media(obj(src.voice), str(obj(src.voice).mime_type) ?? "audio/ogg");
  } else if (src.audio !== undefined) {
    m.kind = "audio";
    media(obj(src.audio), str(obj(src.audio).mime_type));
  } else if (src.video !== undefined || src.video_note !== undefined) {
    const v = obj(src.video ?? src.video_note);
    m.kind = "video";
    m.text = ((caption ?? "") + " [a video]").trim();
    media(v, str(v.mime_type) ?? "video/mp4");
  } else if (src.sticker !== undefined) {
    const s = obj(src.sticker);
    m.kind = "sticker";
    m.text = `a sticker ${str(s.emoji) ?? ""}`.trim();
    if (s.is_animated !== true && s.is_video !== true) media(s, "image/webp");
  } else if (src.document !== undefined) {
    const d = obj(src.document);
    m.kind = "document";
    m.text = `document: ${[str(d.file_name), str(d.mime_type) && `(${str(d.mime_type)})`].filter(Boolean).join(" ")}`;
    media(d, str(d.mime_type));
  } else if (src.location !== undefined) {
    const v = obj(src.venue), l = obj(src.location);
    const place = [str(v.title), str(v.address)].filter(Boolean).join(", ");
    const coords = typeof l.latitude === "number" && typeof l.longitude === "number" ? `${l.latitude}, ${l.longitude}` : "";
    m.kind = "location";
    m.text = `location: ${place || coords}`.trimEnd();
  } else if (src.contact !== undefined) {
    const c = obj(src.contact);
    m.kind = "contacts";
    m.text = `contact card: ${[str(c.first_name), str(c.last_name)].filter(Boolean).join(" ")} ${str(c.phone_number) ?? ""}`.trimEnd();
  }
  return { m, user };
}

const EXT_MIME: Record<string, string> = { oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", pdf: "application/pdf" };
const chatOf = (id: string) => Number(id.split(":")[1]); // "tg:<chat>" or "tg:<chat>:<message_id>"
const messageOf = (id: string) => Number(id.split(":")[2]);

export function makeTgClient(cfg: { token: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }): WaClient {
  const rawFetch = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const fail = (e: unknown): never => { throw e instanceof WaError ? e : new WaError(0, 0, e instanceof Error ? e.message : String(e)); };
  const doFetch = (url: string, init: RequestInit) => rawFetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000) }).catch(fail);
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call(method: string, body: Obj, retried = false): Promise<unknown> {
    const res = await doFetch(`${TG}/bot${cfg.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = obj(await res.json().catch(() => ({})));
    if (res.ok && json.ok === true) return json.result;
    const retryAfter = num(obj(json.parameters).retry_after);
    if (res.status === 429 && !retried && retryAfter !== undefined && retryAfter <= 30) {
      await sleep(retryAfter * 1000);
      return call(method, body, true);
    }
    throw new WaError(num(json.error_code) ?? 0, res.status, str(json.description) ?? `HTTP ${res.status}`);
  }

  return {
    async sendText(to, body, opts) {
      const chat_id = chatOf(to);
      const r = obj(await call("sendMessage", {
        chat_id, text: body, link_preview_options: { is_disabled: !opts?.previewUrl },
        ...(opts?.quote ? { reply_parameters: { message_id: messageOf(opts.quote), allow_sending_without_reply: true } } : {}),
      }));
      const mid = num(r.message_id);
      return { id: mid === undefined ? "" : `tg:${chat_id}:${mid}` }; // "" makes the core store a failed row, as with WhatsApp
    },
    async sendReaction(to, messageId, emoji) {
      // Telegram's reaction set lists ❤ without the variation selector that models usually emit.
      await call("setMessageReaction", { chat_id: chatOf(to), message_id: messageOf(messageId), reaction: [{ type: "emoji", emoji: emoji.replace(/\uFE0F/g, "") }] });
    },
    async markReadTyping(messageId) {
      await call("sendChatAction", { chat_id: chatOf(messageId), action: "typing" });
    },
    async fetchMedia(mediaId) {
      const path = str(obj(await call("getFile", { file_id: mediaId.slice(3) })).file_path);
      if (!path) throw new WaError(0, 502, "getFile: no file_path");
      const res = await doFetch(`${TG}/file/bot${cfg.token}/${path}`, {});
      if (!res.ok) throw new WaError(0, res.status, `media download: ${res.status}`);
      const ct = res.headers.get("content-type")?.split(";")[0].trim();
      const mime = ct && ct !== "application/octet-stream" ? ct : EXT_MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "";
      return { bytes: new Uint8Array(await res.arrayBuffer().catch(fail)), mime };
    },
  };
}

/** One client for both transports: every id and recipient that starts with `tg:` goes to Telegram. */
export function routeTransports(wa: WaClient, tg: WaClient): WaClient {
  const pick = (id: string) => (id.startsWith("tg:") ? tg : wa);
  return {
    sendText: (to, body, opts) => pick(to).sendText(to, body, opts),
    sendReaction: (to, messageId, emoji) => pick(to).sendReaction(to, messageId, emoji),
    markReadTyping: (messageId) => pick(messageId).markReadTyping(messageId),
    fetchMedia: (mediaId) => pick(mediaId).fetchMedia(mediaId),
  };
}
