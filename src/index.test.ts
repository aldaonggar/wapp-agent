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
  const burned: number[] = [];
  const env = {
    WHATSAPP_APP_SECRET: "secret", WHATSAPP_VERIFY_TOKEN: verifyToken, ALLOWED_PHONES: allowed,
    CONTACT: {
      getByName: (name: string) => {
        names.push(name);
        return {
          ingest: async (m: Inbound) => { ingested.push({ name, m }); },
          burn: async (n: number) => { burned.push(n); return { iterations: n, checksum: 7 }; },
        };
      },
    },
  } as unknown as Env;
  return { env, names, ingested, burned };
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

test("/__cpu clamps n at 200,000,000 and rejects non-numeric n", async () => {
  const f = fakeEnv(A);
  expect((await worker.fetch(new Request("https://x/__cpu?n=abc"), f.env, ctx)).status).toBe(400);
  const res = await worker.fetch(new Request("https://x/__cpu?n=999999999999"), f.env, ctx);
  expect(await res.json()).toEqual({ iterations: 200_000_000, checksum: 7 });
  expect(f.names).toEqual(["probe"]);
  expect(f.burned).toEqual([200_000_000]);
});
