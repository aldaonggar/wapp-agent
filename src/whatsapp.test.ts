import { expect, test } from "vitest";
import worker from "./index";
import { verifySignature } from "./whatsapp";

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ctx = {} as ExecutionContext;
const env = { WHATSAPP_VERIFY_TOKEN: "t", WHATSAPP_APP_SECRET: "secret" } as Env;
const body = '{"object":"whatsapp_business_account"}';

test("verifySignature accepts the HMAC of the raw body", async () => {
  const sig = "sha256=" + (await hmacHex("secret", body));
  expect(await verifySignature(body, sig, "secret")).toBe(true);
});

test("verifySignature rejects a wrong secret, a missing header and a re-serialised body", async () => {
  const sig = "sha256=" + (await hmacHex("secret", body));
  expect(await verifySignature(body, sig, "other")).toBe(false);
  expect(await verifySignature(body, null, "secret")).toBe(false);
  expect(await verifySignature(JSON.stringify(JSON.parse(body), null, 2), sig, "secret")).toBe(false);
});

test("GET /webhook echoes hub.challenge only with the right token", async () => {
  const url = "https://x/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=";
  const ok = await worker.fetch(new Request(url + "t"), env, ctx);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("123");
  const bad = await worker.fetch(new Request(url + "nope"), env, ctx);
  expect(bad.status).toBe(403);
});

test("POST /webhook with a bad signature is 401; with a good one 200", async () => {
  const bad = await worker.fetch(
    new Request("https://x/webhook", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=00" } }),
    env,
    ctx,
  );
  expect(bad.status).toBe(401);
  const sig = "sha256=" + (await hmacHex("secret", body));
  const good = await worker.fetch(
    new Request("https://x/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sig } }),
    env,
    ctx,
  );
  expect(good.status).toBe(200);
  expect(await good.text()).toBe("ok");
});
