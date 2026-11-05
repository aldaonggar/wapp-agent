import { parseUpdate } from "./telegram";
import { parseWebhook, verifySignature } from "./whatsapp";

let warnedRegular = false; // once per isolate

// Empty ALLOWED_TELEGRAM admits anyone who finds the bot (the owner's choice); entries are @usernames or numeric user ids.
function telegramAllowed(list: string | undefined, user: { id: number; username?: string }): boolean {
  const allowed = new Set((list ?? "").split(",").map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
  return allowed.size === 0 || allowed.has(String(user.id)) || (user.username !== undefined && allowed.has(user.username.toLowerCase()));
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/webhook") {
      if (request.method === "GET") {
        const q = url.searchParams;
        if (env.WHATSAPP_VERIFY_TOKEN && q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN) {
          return new Response(q.get("hub.challenge") ?? "", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("forbidden", { status: 403 });
      }
      if (request.method === "POST") {
        const raw = await request.text();
        const ok = await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET);
        if (!ok) return new Response("invalid signature", { status: 401 });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
        const { inbound, statuses } = parseWebhook(body);
        for (const s of statuses) {
          console.log(JSON.stringify({ event: "status", id: s.id, status: s.status, pricingType: s.pricingType, errorCode: s.errorCode }));
          if (s.pricingType === "regular" && !warnedRegular) {
            warnedRegular = true;
            console.warn("WhatsApp pricing type is now regular: the free service-message tier is used up and Meta may stop delivering");
          }
        }
        const allowed = new Set((env.ALLOWED_PHONES ?? "").split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean)); // digits only: "+31 6 ..." and "31..." both match Meta's wa_id
        for (const m of inbound) {
          if (!allowed.has(m.from)) {
            console.log(JSON.stringify({ event: "dropped_sender", from: "…" + m.from.slice(-4) }));
            continue;
          }
          await env.CONTACT.getByName(m.from).ingest(m); // returns in ms: SQL + setAlarm; a throw makes Meta redeliver
        }
        return new Response("ok");
      }
    }

    // Dark (404) until TELEGRAM_WEBHOOK_SECRET is set; Telegram sends the secret given to setWebhook in this header on every update.
    if (url.pathname === "/telegram" && request.method === "POST" && env.TELEGRAM_WEBHOOK_SECRET) {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      let body: unknown;
      try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      const u = parseUpdate(body); // null: groups, bots, edits, other update kinds
      if (u && telegramAllowed(env.ALLOWED_TELEGRAM, u.user)) await env.CONTACT.getByName(u.m.from).ingest(u.m);
      else if (u) console.log(JSON.stringify({ event: "dropped_sender", from: u.user.username ?? "…" + String(u.user.id).slice(-4) }));
      return new Response("ok"); // Telegram retries anything but 2xx
    }

    return new Response("not found", { status: 404 });
  },
};
