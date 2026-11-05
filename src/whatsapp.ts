import type { Inbound, WaClient, WaStatus } from "./core/types";
const enc = new TextEncoder();

/** Verify Meta's X-Hub-Signature-256 over the raw request body (constant-time). */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export const GRAPH = "https://graph.facebook.com/v27.0";

export class WaError extends Error {
  constructor(
    public code: number,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "WaError";
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const MEDIA = ["image", "video", "audio", "sticker", "document"] as const;

function describe(m: Obj, type: string): string | undefined {
  switch (type) {
    case "text":
      return str(obj(m.text).body);
    case "image":
      return str(obj(m.image).caption) ?? "[photo]";
    case "video":
      return ((str(obj(m.video).caption) ?? "") + " [a video]").trim();
    case "sticker":
      return "a sticker";
    case "document": {
      const d = obj(m.document);
      return `document: ${[str(d.filename), str(d.mime_type) && `(${str(d.mime_type)})`].filter(Boolean).join(" ")}`;
    }
    case "location": {
      const l = obj(m.location);
      const place = [str(l.name), str(l.address)].filter(Boolean).join(", ");
      const coords = typeof l.latitude === "number" && typeof l.longitude === "number" ? `${l.latitude}, ${l.longitude}` : "";
      return `location: ${place || coords}`.trimEnd();
    }
    case "contacts":
      return arr(m.contacts)
        .map((c) => `contact card: ${str(obj(c.name).formatted_name) ?? ""} ${str(arr(c.phones)[0]?.phone) ?? ""}`.trimEnd())
        .join("\n");
  }
}

export function parseWebhook(body: unknown): { inbound: Inbound[]; statuses: WaStatus[] } {
  const inbound: Inbound[] = [];
  const statuses: WaStatus[] = [];
  for (const entry of arr(obj(body).entry)) {
    for (const change of arr(entry.changes)) {
      const value = obj(change.value);
      const name = str(obj(arr(value.contacts)[0]?.profile).name);
      for (const m of arr(value.messages)) {
        const rawType = str(m.type) ?? "";
        const known = rawType === "text" || rawType === "location" || rawType === "contacts" || rawType === "reaction" || (MEDIA as readonly string[]).includes(rawType);
        const kind = (known ? rawType : "unsupported") as Inbound["kind"];
        const ctx = obj(m.context);
        const msg: Inbound = {
          id: str(m.id) ?? "",
          from: str(m.from) ?? "",
          ts: Number(m.timestamp) * 1000,
          kind,
        };
        if (name) msg.name = name;
        const text = known ? describe(m, rawType) : undefined;
        if (text !== undefined) msg.text = text;
        const qid = str(ctx.id);
        if (qid && ctx.referred_product === undefined) msg.quotedId = qid;
        if ((MEDIA as readonly string[]).includes(rawType)) {
          const media = obj(m[rawType]);
          msg.mediaId = str(media.id);
          msg.mime = str(media.mime_type);
          if (rawType === "audio" && media.voice === true) msg.voice = true;
        }
        if (kind === "reaction") {
          const r = obj(m.reaction);
          msg.reaction = { messageId: str(r.message_id) ?? "", emoji: str(r.emoji) };
        }
        inbound.push(msg);
      }
      for (const s of arr(value.statuses)) {
        const st: WaStatus = {
          id: str(s.id) ?? "",
          status: str(s.status) ?? "",
          recipientId: str(s.recipient_id) ?? "",
          ts: Number(s.timestamp) * 1000,
        };
        const pt = str(obj(s.pricing).type);
        if (pt) st.pricingType = pt;
        const code = arr(s.errors)[0]?.code;
        if (typeof code === "number") st.errorCode = code;
        statuses.push(st);
      }
    }
  }
  return { inbound, statuses };
}

export function makeWaClient(cfg: {
  token: string;
  phoneNumberId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): WaClient {
  const rawFetch = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  // Every Graph API request is bounded; a timeout or network failure surfaces as WaError(0, 0).
  const fail = (e: unknown): never => { throw e instanceof WaError ? e : new WaError(0, 0, e instanceof Error ? e.message : String(e)); };
  const doFetch = (url: string, init: RequestInit) => rawFetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000) }).catch(fail);
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const auth = { Authorization: `Bearer ${cfg.token}` };

  async function check(res: Response): Promise<Obj> {
    const json = obj(await res.json().catch(() => ({})));
    if (!res.ok || json.error !== undefined) {
      const e = obj(json.error);
      throw new WaError(typeof e.code === "number" ? e.code : 0, res.status, str(e.message) ?? `HTTP ${res.status}`);
    }
    return json;
  }

  const post = async (body: Obj): Promise<Obj> =>
    check(
      await doFetch(`${GRAPH}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      }),
    );

  return {
    async sendText(to, body, opts) {
      const payload: Obj = {
        recipient_type: "individual",
        to: "+" + to,
        type: "text",
        text: { preview_url: opts?.previewUrl ?? false, body },
      };
      if (opts?.quote) payload.context = { message_id: opts.quote };
      for (const delay of [1000, 4000, 16000, undefined]) {
        try {
          const json = await post(payload);
          return { id: str(arr(json.messages)[0]?.id) ?? "" };
        } catch (e) {
          if (!(e instanceof WaError && e.code === 131056) || delay === undefined) throw e;
          await sleep(delay);
        }
      }
      throw new Error("unreachable");
    },
    async sendReaction(to, messageId, emoji) {
      await post({
        recipient_type: "individual",
        to: "+" + to,
        type: "reaction",
        reaction: { message_id: messageId, emoji },
      });
    },
    async markReadTyping(messageId) {
      await post({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
    },
    async fetchMedia(mediaId) {
      for (let attempt = 0; ; attempt++) {
        try {
          const meta = await check(await doFetch(`${GRAPH}/${mediaId}?phone_number_id=${cfg.phoneNumberId}`, { headers: auth }));
          if (typeof meta.url !== "string") throw new WaError(0, 502, `media ${mediaId}: no url`);
          const res = await doFetch(meta.url, { headers: auth });
          if (!res.ok) throw new WaError(0, res.status, `media ${mediaId}: ${res.status}`);
          return {
            bytes: new Uint8Array(await res.arrayBuffer().catch(fail)),
            mime: res.headers.get("content-type") ?? str(meta.mime_type) ?? "",
          };
        } catch (e) {
          if (!(e instanceof WaError && e.status === 404) || attempt > 0) throw e;
        }
      }
    },
  };
}
