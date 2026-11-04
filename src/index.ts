import { verifySignature } from "./whatsapp";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/webhook") {
      if (request.method === "GET") {
        const q = url.searchParams;
        if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN) {
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
        return new Response("ok"); // body handling comes in Task 6
      }
    }

    // Temporary CPU probe, removed after the CPU-limit check.
    if (url.pathname === "/__cpu") {
      const ms = Number(url.searchParams.get("ms") ?? 50);
      const t0 = performance.now();
      const start = Date.now();
      while (Date.now() - start < ms);
      return new Response(String(Math.round(performance.now() - t0)));
    }

    return new Response("not found", { status: 404 });
  },
};
