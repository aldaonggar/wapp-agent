import { parseWebhook, verifySignature } from "./whatsapp";

let warnedRegular = false; // once per isolate

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

    return new Response("not found", { status: 404 });
  },
};
