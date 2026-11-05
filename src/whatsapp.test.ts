import { expect, test } from "vitest";
import worker from "./index";
import { GRAPH, WaError, makeWaClient, parseWebhook, verifySignature } from "./whatsapp";

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

test("verifySignature fails closed on an empty app secret", async () => {
  expect(await verifySignature(body, "sha256=" + "0".repeat(64), "")).toBe(false);
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

const META = { display_phone_number: "15550783881", phone_number_id: "106540352242922" };
const CONTACT = { profile: { name: "Sheena Nelson" }, wa_id: "16505551234" };
const QUOTED = "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA";
const hook = (...values: object[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: values.map((value) => ({ field: "messages", value: { messaging_product: "whatsapp", metadata: META, ...value } })) }],
});
const msg = (extra: object) => ({ contacts: [CONTACT], messages: [{ from: "16505551234", id: "wamid.X", timestamp: "1744344496", ...extra }] });
const one = (extra: object) => parseWebhook(hook(msg(extra))).inbound[0];

test("parseWebhook: text with quoted reply", () => {
  const { inbound } = parseWebhook(
    hook(msg({ id: "wamid.T", timestamp: "1749416383", type: "text", context: { from: "15550783881", id: QUOTED }, text: { body: "Does it come in another color?" } })),
  );
  expect(inbound[0]).toMatchObject({ kind: "text", from: "16505551234", name: "Sheena Nelson", text: "Does it come in another color?", quotedId: QUOTED, ts: 1749416383000 });
});

test("parseWebhook: catalog context (referred_product) is not a quote", () => {
  const m = one({ type: "text", text: { body: "hi" }, context: { id: "wamid.C", referred_product: { catalog_id: "1" } } });
  expect(m.quotedId).toBeUndefined();
});

test("parseWebhook: media, location, contacts, reaction, unsupported", () => {
  expect(one({ type: "image", image: { caption: "Taj Mahal", mime_type: "image/jpeg", id: "1003383421387256" } })).toMatchObject({ kind: "image", text: "Taj Mahal", mediaId: "1003383421387256", mime: "image/jpeg" });
  expect(one({ type: "image", image: { mime_type: "image/jpeg", id: "1" } }).text).toBe("[photo]");
  expect(one({ type: "video", video: { caption: "look", mime_type: "video/mp4", id: "2" } })).toMatchObject({ kind: "video", text: "look [a video]", mediaId: "2" });
  expect(one({ type: "video", video: { mime_type: "video/mp4", id: "2" } }).text).toBe("[a video]");
  expect(one({ type: "audio", audio: { mime_type: "audio/ogg; codecs=opus", id: "3", voice: true } })).toMatchObject({ kind: "audio", voice: true, mediaId: "3", mime: "audio/ogg; codecs=opus" });
  expect(one({ type: "sticker", sticker: { mime_type: "image/webp", id: "4" } })).toMatchObject({ kind: "sticker", text: "a sticker", mediaId: "4" });
  expect(one({ type: "document", document: { filename: "a.pdf", mime_type: "application/pdf", id: "5" } })).toMatchObject({ kind: "document", text: "document: a.pdf (application/pdf)", mediaId: "5" });
  expect(one({ type: "location", location: { name: "Cafe", address: "1 Main St", latitude: 1, longitude: 2 } }).text).toBe("location: Cafe, 1 Main St");
  expect(one({ type: "location", location: { latitude: 37.4847, longitude: -122.1477 } }).text).toBe("location: 37.4847, -122.1477");
  expect(one({ type: "contacts", contacts: [{ name: { formatted_name: "Ann A" }, phones: [{ phone: "+1 650" }] }, { name: { formatted_name: "Bob B" }, phones: [{ phone: "+2 111" }] }] }).text).toBe("contact card: Ann A +1 650\ncontact card: Bob B +2 111");
  expect(one({ type: "reaction", reaction: { message_id: "wamid.O", emoji: "👍" } })).toMatchObject({ kind: "reaction", reaction: { messageId: "wamid.O", emoji: "👍" } });
  expect(one({ type: "reaction", reaction: { message_id: "wamid.O" } }).reaction).toEqual({ messageId: "wamid.O", emoji: undefined });
  expect(one({ type: "unsupported", unsupported: { type: "edit" } }).kind).toBe("unsupported");
  expect(one({ type: "something_new" }).kind).toBe("unsupported");
});

test("parseWebhook: statuses", () => {
  const { statuses, inbound } = parseWebhook(
    hook({ statuses: [
      { id: "w1", status: "delivered", timestamp: "1750263773", recipient_id: "16505551234", pricing: { type: "free_customer_service" } },
      { id: "w2", status: "failed", timestamp: "1751142888", recipient_id: "16505551234", errors: [{ code: 131049 }] },
    ] }),
  );
  expect(inbound).toEqual([]);
  expect(statuses[0]).toEqual({ id: "w1", status: "delivered", recipientId: "16505551234", ts: 1750263773000, pricingType: "free_customer_service" });
  expect(statuses[1]).toMatchObject({ status: "failed", errorCode: 131049 });
});

test("parseWebhook mixed payload: two senders + one status in one POST", () => {
  const other = { contacts: [{ profile: { name: "B" }, wa_id: "16505559999" }], messages: [{ from: "16505559999", id: "wamid.B", timestamp: "1", type: "text", text: { body: "yo" } }] };
  const { inbound, statuses } = parseWebhook(hook(msg({ type: "text", text: { body: "hi" } }), other, { statuses: [{ id: "w", status: "sent", timestamp: "1", recipient_id: "16505551234" }] }));
  expect(inbound.map((m) => m.from)).toEqual(["16505551234", "16505559999"]);
  expect(inbound[1].name).toBe("B");
  expect(statuses).toHaveLength(1);
  expect(parseWebhook("garbage")).toEqual({ inbound: [], statuses: [] });
});

const OK = { messaging_product: "whatsapp", messages: [{ id: "wamid.OUT" }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const errBody = (code: number) => ({ error: { message: "x", code } });
function stub(...responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r;
  }) as unknown as typeof fetch;
  return { calls, f };
}

test("sendText posts the documented body and returns the wamid", async () => {
  const { calls, f } = stub(json(OK));
  const wa = makeWaClient({ token: "tok", phoneNumberId: "PN", fetch: f });
  expect(await wa.sendText("16505551234", "hello", { quote: "wamid.Q", previewUrl: true })).toEqual({ id: "wamid.OUT" });
  expect(calls[0].url).toBe(`${GRAPH}/PN/messages`);
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({
    messaging_product: "whatsapp", recipient_type: "individual", to: "+16505551234", type: "text",
    text: { preview_url: true, body: "hello" }, context: { message_id: "wamid.Q" },
  });
});

test("sendReaction and markReadTyping send the documented bodies", async () => {
  const { calls, f } = stub(json(OK), json({ success: true }));
  const wa = makeWaClient({ token: "t", phoneNumberId: "PN", fetch: f });
  await wa.sendReaction("16505551234", "wamid.R", "😀");
  await wa.markReadTyping("wamid.IN");
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "+16505551234", type: "reaction", reaction: { message_id: "wamid.R", emoji: "😀" } });
  expect(JSON.parse(calls[1].init?.body as string)).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.IN", typing_indicator: { type: "text" } });
});

test("sendText retries 131056 with 1s/4s/16s then succeeds", async () => {
  const { calls, f } = stub(json(errBody(131056), 400), json(errBody(131056), 400), json(errBody(131056), 400), json(OK));
  const delays: number[] = [];
  const wa = makeWaClient({ token: "t", phoneNumberId: "PN", fetch: f, sleep: async (ms) => void delays.push(ms) });
  expect(await wa.sendText("1", "x")).toEqual({ id: "wamid.OUT" });
  expect(delays).toEqual([1000, 4000, 16000]);
  expect(calls).toHaveLength(4);
});

test("sendText throws WaError(131056) after the last retry", async () => {
  const { calls, f } = stub(...[1, 2, 3, 4].map(() => json(errBody(131056), 400)));
  const wa = makeWaClient({ token: "t", phoneNumberId: "PN", fetch: f, sleep: async () => {} });
  await expect(wa.sendText("1", "x")).rejects.toMatchObject({ code: 131056, status: 400 });
  expect(calls).toHaveLength(4);
});

test("sendText throws WaError(131047) without retry; a 2xx body with error also throws", async () => {
  const a = stub(json(errBody(131047), 400));
  const err = await makeWaClient({ token: "t", phoneNumberId: "PN", fetch: a.f }).sendText("1", "x").catch((e) => e);
  expect(err).toBeInstanceOf(WaError);
  expect(err).toMatchObject({ code: 131047, status: 400 });
  expect(a.calls).toHaveLength(1);
  const b = stub(json(errBody(190), 200));
  await expect(makeWaClient({ token: "t", phoneNumberId: "PN", fetch: b.f }).sendText("1", "x")).rejects.toMatchObject({ code: 190, status: 200 });
});

test("fetchMedia resolves the url then downloads with the token; retries once on 404", async () => {
  const meta = { url: "https://lookaside.fbsbx.com/m", mime_type: "image/jpeg" };
  const bin = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  const { calls, f } = stub(json(meta), new Response("", { status: 404 }), json(meta), bin());
  const out = await makeWaClient({ token: "tok", phoneNumberId: "PN", fetch: f }).fetchMedia("MID");
  expect(out.bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(out.mime).toBe("image/png");
  expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/MID?phone_number_id=PN`, meta.url, `${GRAPH}/MID?phone_number_id=PN`, meta.url]);
  expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
});

test("fetchMedia gives up after a second 404", async () => {
  const meta = { url: "https://l/m", mime_type: "image/jpeg" };
  const { f } = stub(json(meta), new Response("", { status: 404 }), json(meta), new Response("", { status: 404 }));
  await expect(makeWaClient({ token: "t", phoneNumberId: "PN", fetch: f }).fetchMedia("MID")).rejects.toMatchObject({ status: 404 });
});
