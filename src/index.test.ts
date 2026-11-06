import { SCRIPT_HASH } from "./core/pages";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Inbound } from "./core/types";
import worker from "./index";

const A = "15550000001", B = "15550000002";
const ctx = {} as ExecutionContext;

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeEnv(allowed: string, verifyToken = "t") {
  const names: string[] = [];
  const ingested: { name: string; m: Inbound }[] = [];
  const env = {
    WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: "secret", WHATSAPP_VERIFY_TOKEN: verifyToken, ALLOWED_PHONES: allowed,
    CONTACT: {
      getByName: (name: string) => {
        names.push(name);
        return {
          ingest: async (m: Inbound) => { ingested.push({ name, m }); },
        };
      },
    },
  } as unknown as Env;
  return { env, names, ingested };
}

const value = (v: object) => ({ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550009999", phone_number_id: "1" }, ...v } });
const text = (from: string, id: string) => value({ contacts: [{ profile: { name: from }, wa_id: from }], messages: [{ from, id, timestamp: "1762250000", type: "text", text: { body: "hi" } }] });
const status = (pricing: string) => value({ statuses: [{ id: "wamid.out.1", status: "delivered", timestamp: "1762250001", recipient_id: A, pricing: { type: pricing } }] });
const hook = (...changes: object[]) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes }] });

async function post(env: Env, payload: object): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + (await hmacHex("secret", body));
  return worker.fetch(new Request("https://x/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sig } }), env, ctx);
}

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

test("routes one POST with two senders to two objects", async () => {
  const f = fakeEnv(`${A}, ${B}`);
  const res = await post(f.env, hook(text(A, "wamid.A1"), text(B, "wamid.B1"), status("free_customer_service")));
  expect(res.status).toBe(200);
  expect(f.names).toEqual([A, B]);
  expect(f.ingested.map((x) => [x.name, x.m.id])).toEqual([[A, "wamid.A1"], [B, "wamid.B1"]]);
});

test("matches ALLOWED_PHONES entries written with plus, spaces or dashes", async () => {
  const f = fakeEnv(`+1 555-000-0001, ${B}`);
  const res = await post(f.env, hook(text(A, "wamid.A1")));
  expect(res.status).toBe(200);
  expect(f.ingested.map((x) => x.name)).toEqual([A]);
});

test("drops a sender not in ALLOWED_PHONES", async () => {
  const f = fakeEnv("15550000009");
  const res = await post(f.env, hook(text(A, "wamid.A1")));
  expect(res.status).toBe(200);
  expect(f.ingested).toEqual([]);
});

test("logs a status with pricingType regular once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = fakeEnv(A);
  expect((await post(f.env, hook(status("regular")))).status).toBe(200);
  expect((await post(f.env, hook(status("regular")))).status).toBe(200);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain("regular");
  expect(f.ingested).toEqual([]);
});

test("GET /webhook with an empty WHATSAPP_VERIFY_TOKEN is 403 even for an empty token", async () => {
  const f = fakeEnv(A, "");
  const res = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.challenge=1&hub.verify_token="), f.env, ctx);
  expect(res.status).toBe(403);
});

test("/health names the configured transports and fails with none", async () => {
  const get = (env: object) => worker.fetch(new Request("https://x/health"), env as unknown as Env, ctx);
  const wa = { WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "v" };
  const tg = { TELEGRAM_BOT_TOKEN: "b", TELEGRAM_WEBHOOK_SECRET: "w" };
  expect(await (await get({ ...wa, ...tg })).text()).toBe("ok whatsapp,telegram");
  expect(await (await get(wa)).text()).toBe("ok whatsapp");
  expect(await (await get(tg)).text()).toBe("ok telegram");
  const none = await get({ WHATSAPP_TOKEN: "t", TELEGRAM_BOT_TOKEN: "b" }); // partial sets count as off
  expect(none.status).toBe(503);
});

test("POST /webhook is 404 while WhatsApp is not fully configured", async () => {
  const f = fakeEnv(A);
  (f.env as unknown as Record<string, unknown>).WHATSAPP_PHONE_NUMBER_ID = "";
  const res = await post(f.env, hook(text(A, "wamid.A1")));
  expect(res.status).toBe(404);
  expect(f.ingested).toEqual([]);
});

test("GET /p/<key>/<id> serves the page with the locked-down headers; 404 for an unknown id, another contact's id, a malformed key or id, and non-GET", async () => {
  const KA = "a".repeat(64), KB = "b".repeat(64), ID = "A".repeat(22);
  const stores: Record<string, Record<string, { html: string; title: string }>> = { [KA]: { [ID]: { html: "<h1>hi</h1>", title: "T" } }, [KB]: {} };
  const env = { CONTACT: {
    idFromString: (k: string) => { if (!stores[k]) throw new Error("invalid id"); return k; },
    get: (k: string) => ({ page: async (id: string) => stores[k][id] ?? null }),
  } } as unknown as Env;
  const get = (path: string, method = "GET") => worker.fetch(new Request("https://x" + path, { method }), env, ctx);
  const ok = await get(`/p/${KA}/${ID}`);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("<h1>hi</h1>");
  expect(Object.fromEntries(ok.headers)).toMatchObject({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; form-action 'none'; base-uri 'none'`,
    "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store",
  });
  for (const path of [`/p/${KA}/${"B".repeat(22)}`, `/p/${KB}/${ID}`, `/p/${"c".repeat(64)}/${ID}`, `/p/short/${ID}`, `/p/${KA}/short`, `/p/${KA}/${ID}/x`]) expect([path, (await get(path)).status]).toEqual([path, 404]);
  expect((await get(`/p/${KA}/${ID}`, "PUT")).status).toBe(404);
});

test("POST /p/<key>/<id> stores ticks (204); bad JSON, wrong type, oversize and rejected state are 400; wrong key or id is 404", async () => {
  const K = "a".repeat(64), ID = "A".repeat(22);
  const saved: [number, boolean, number][] = [];
  const env = { CONTACT: {
    idFromString: (k: string) => { if (k !== K) throw new Error("invalid id"); return k; },
    get: () => ({ page: async (id: string) => (id === ID ? { html: "", title: "" } : null), setPageState: async (_: string, i: number, c: boolean, q: number) => { if (i > 2) return false; saved.push([i, c, q]); return true; } }),
  } } as unknown as Env;
  const post = (path: string, body: string, type = "application/json") => worker.fetch(new Request("https://x" + path, { method: "POST", body, headers: { "content-type": type } }), env, ctx);
  const p = `/p/${K}/${ID}`;
  expect((await post(p, '{"i":2,"checked":true,"seq":7}')).status).toBe(204);
  expect(saved).toEqual([[2, true, 7]]);
  for (const [b, t] of [["{nope", "application/json"], ["null", "application/json"], ['{"i":0,"checked":"x","seq":1}', "application/json"], ['{"i":"0","checked":true,"seq":1}', "application/json"], ['{"i":9,"checked":true,"seq":1}', "application/json"], ['{"i":0,"checked":true,"seq":1}', "text/plain"], ['{"i":0,"checked":true}', "application/json"], ['{"i":0,"checked":true,"seq":1.5}', "application/json"], ['{"i":0,"checked":true,"seq":-1}', "application/json"], ['{"i":0,"checked":true,"seq":"1"}', "application/json"], [JSON.stringify({ i: 0, checked: true, seq: 1, pad: "x".repeat(500) }), "application/json"]]) expect([b.slice(0, 12), (await post(p, b, t)).status]).toEqual([b.slice(0, 12), 400]);
  expect((await post(`/p/${"b".repeat(64)}/${ID}`, '{"i":0,"checked":true,"seq":1}')).status).toBe(404);
  expect((await post(`/p/${K}/${"B".repeat(22)}`, '{"i":0,"checked":true,"seq":1}')).status).toBe(404);
});

test("POST /p/<key>/<id> with an op goes to editPage (200 with the new body, 4 KB cap), a stale tick is 409 with the current body, and editPage's refusals keep their status", async () => {
  const K = "a".repeat(64), ID = "A".repeat(22);
  const calls: unknown[][] = [];
  const results: Record<string, unknown> = { add: { ok: true, body: "<p>new</p>", rev: 4 }, field: { ok: true, rev: 4 }, stale: { ok: false, status: 409, error: "stale", body: "<p>now</p>", rev: 5 }, rate: { ok: false, status: 429, error: "slow down" } };
  const env = { CONTACT: {
    idFromString: (k: string) => { if (k !== K) throw new Error("invalid id"); return k; },
    get: () => ({
      page: async (id: string) => (id === ID ? { html: "", title: "", body: "<p>current</p>", rev: 5 } : null),
      setPageState: async (_: string, i: number, __: boolean, ___: number, rev?: number) => (rev === 3 ? "stale" : i < 3),
      editPage: async (...a: unknown[]) => { calls.push(a); return results[Object.keys((a[1] as object))[0] === "add" ? "add" : (a[1] as { x?: string }).x ?? "field"]; },
    }),
  } } as unknown as Env;
  const post = (body: string) => worker.fetch(new Request(`https://x/p/${K}/${ID}`, { method: "POST", body, headers: { "content-type": "application/json" } }), env, ctx);
  const add = await post('{"op":{"add":{"list":0,"text":"x"}},"seq":9,"rev":4}');
  expect([add.status, await add.json(), add.headers.get("content-type")]).toEqual([200, { html: "<p>new</p>", rev: 4 }, "application/json"]);
  expect(calls).toEqual([[ID, { add: { list: 0, text: "x" } }, 9, 4]]);
  const field = await post('{"op":{"field":{"key":"a:0","value":"v"}},"seq":10}');
  expect([field.status, await field.json()]).toEqual([200, { html: null, rev: 4 }]);
  expect(calls[1]).toEqual([ID, { field: { key: "a:0", value: "v" } }, 10, undefined]);
  results.field = results.stale;
  expect(await (await post('{"op":{"field":{"key":"a:0","value":"v"}},"seq":11}')).json()).toEqual({ error: "stale", html: "<p>now</p>", rev: 5 });
  results.field = results.rate;
  expect((await post('{"op":{"field":{"key":"a:0","value":"v"}},"seq":12}')).status).toBe(429);
  const tick = await post('{"i":0,"checked":true,"seq":1,"rev":3}');
  expect([tick.status, await tick.json()]).toEqual([409, { html: "<p>current</p>", rev: 5 }]);
  expect((await post('{"i":0,"checked":true,"seq":1,"rev":5}')).status).toBe(204);
  expect((await post(JSON.stringify({ op: { add: { list: 0, text: "x".repeat(5000) } }, seq: 1 }))).status).toBe(400); // over 4 KB
  expect((await post(JSON.stringify({ op: { add: { list: 0, text: "x".repeat(3000) } }, seq: 1 }))).status).toBe(200);
  for (const b of ['{"op":{"add":{}}}', '{"op":"x","seq":1}', '{"op":null,"seq":1}']) expect([b, (await post(b)).status]).toEqual([b, 400]);
});
