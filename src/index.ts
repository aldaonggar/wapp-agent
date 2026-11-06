import { parseUpdate } from "./telegram";
import { SCRIPT_HASH } from "./core/pages";
import { parseWebhook, verifySignature } from "./whatsapp";

let warnedRegular = false; // once per isolate

// Nothing a page holds may run or load: the model wrote it. form-action and base-uri are not covered by default-src.
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; form-action 'none'; base-uri 'none'`,
  "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store",
};

// A transport is on when every secret it needs is set; the app runs with either one, and /health says which (503 with none).
export const transports = (env: Env) => ({
  whatsapp: !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN),
  telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
});

// Empty ALLOWED_TELEGRAM admits anyone who finds the bot (the owner's choice); entries are @usernames or numeric user ids.
function telegramAllowed(list: string | undefined, user: { id: number; username?: string }): boolean {
  const allowed = new Set((list ?? "").split(",").map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
  return allowed.size === 0 || allowed.has(String(user.id)) || (user.username !== undefined && allowed.has(user.username.toLowerCase()));
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const on = transports(env);
    if (url.pathname === "/health") {
      const active = Object.entries(on).filter(([, v]) => v).map(([k]) => k);
      return active.length ? new Response(`ok ${active.join(",")}`) : new Response("no transport configured: set the WhatsApp or the Telegram secrets (SETUP.md)", { status: 503 });
    }

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
        if (!on.whatsapp) return new Response("whatsapp not configured", { status: 404 });
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

    // Dark (404) until the bot token and the webhook secret are set; Telegram sends the secret given to setWebhook in this header on every update.
    if (url.pathname === "/telegram" && request.method === "POST" && on.telegram) {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      let body: unknown;
      try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      const u = parseUpdate(body); // null: groups, bots, edits, other update kinds
      if (u && telegramAllowed(env.ALLOWED_TELEGRAM, u.user)) {
        // A non-2xx makes Telegram redeliver; only transient Durable Object errors deserve that (ingest is idempotent), the rest is logged so one bad update cannot block a chat.
        try { await env.CONTACT.getByName(u.m.from).ingest(u.m); } catch (e) {
          if ((e as { retryable?: boolean }).retryable) return new Response("retry", { status: 503 });
          console.log(JSON.stringify({ event: "ingest_failed", error: e instanceof Error ? e.message : String(e) }));
        }
      } else if (u) console.log(JSON.stringify({ event: "dropped_sender", from: u.user.username ?? "…" + String(u.user.id).slice(-4) }));
      return new Response("ok");
    }

    // A page the agent built: the unguessable id in the link is the whole access control (PRIVACY.md says so).
    const pageLink = (request.method === "GET" || request.method === "POST") && url.pathname.match(/^\/p\/([0-9a-f]{64})\/([\w-]{22})$/);
    if (pageLink && request.method === "POST") { // tick state from the page's own script; JSON only, so a cross-origin form or fetch cannot send it
      const stub = (() => { try { return env.CONTACT.get(env.CONTACT.idFromString(pageLink[1])); } catch { return null; } })();
      if (!stub || !(await stub.page(pageLink[2]))) return new Response("not found", { status: 404 });
      if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response("bad request", { status: 400 });
      const body = await request.text();
      let d: { i?: unknown; checked?: unknown; seq?: unknown } = {};
      try { if (body.length <= 200) d = (JSON.parse(body) ?? {}) as typeof d; } catch { /* bad JSON */ }
      return typeof d.i === "number" && typeof d.checked === "boolean" && typeof d.seq === "number" && Number.isSafeInteger(d.seq) && d.seq >= 0 && await stub.setPageState(pageLink[2], d.i, d.checked, d.seq) ? new Response(null, { status: 204 }) : new Response("bad request", { status: 400 });
    }
    if (pageLink) {
      let page: { html: string; title: string } | null = null;
      try { page = await env.CONTACT.get(env.CONTACT.idFromString(pageLink[1])).page(pageLink[2]); } catch { /* a key that is not one of ours */ }
      if (page) return new Response(page.html, { headers: PAGE_HEADERS });
    }

    return new Response("not found", { status: 404 });
  },
};
