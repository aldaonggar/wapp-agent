import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeClock, FakeWa, drain, makeEvalDeps, stubLlm } from "../evals/harness";
import { ContactCore } from "./core/contact";
import type { Inbound, WaClient } from "./core/types";
import worker from "./index";
import { TG, makeTgClient, parseUpdate, routeTransports } from "./telegram";
import { WaError, makeWaClient } from "./whatsapp";

const USER = { id: 123456789, is_bot: false, first_name: "Ann", username: "AnnK" };
const CHAT = { id: 123456789, type: "private" };
const update = (message: object) => ({ update_id: 1, message: { message_id: 42, from: USER, chat: CHAT, date: 1762250000, ...message } });
const one = (message: object) => parseUpdate(update(message))!.m;

test("parseUpdate: text with reply carries the chat in every id", () => {
  const u = parseUpdate(update({ text: "yes that one", reply_to_message: { message_id: 40, text: "this?" } }))!;
  expect(u.m).toEqual({ id: "tg:123456789:42", from: "tg:123456789", name: "Ann", ts: 1762250000000, kind: "text", text: "yes that one", quotedId: "tg:123456789:40" });
  expect(u.user).toEqual({ id: 123456789, username: "AnnK" });
  expect(one({ text: "/start" }).text).toBe("Hi, I just pressed Start.");
  expect(one({ text: "/start ref_42" }).text).toBe("Hi, I just pressed Start.");
  expect(one({ text: "/starting over" }).text).toBe("/starting over");
});

test("parseUpdate: photo picks the largest size; caption or [photo]", () => {
  const photo = [{ file_id: "s", width: 90, height: 60 }, { file_id: "L", width: 1280, height: 853 }, { file_id: "m", width: 320, height: 213 }];
  expect(one({ photo, caption: "Taj Mahal" })).toMatchObject({ kind: "image", text: "Taj Mahal", mediaId: "tg:L", mime: "image/jpeg" });
  expect(one({ photo }).text).toBe("[photo]");
  expect(one({ photo: [{ width: 1, height: 1 }] }).mediaId).toBeUndefined();
});

test("parseUpdate: voice, audio, video, sticker, document, location, venue, contact, unknown", () => {
  expect(one({ voice: { file_id: "V", duration: 3, mime_type: "audio/ogg" } })).toMatchObject({ kind: "audio", voice: true, mediaId: "tg:V", mime: "audio/ogg" });
  expect(one({ voice: { file_id: "V", duration: 3 } }).mime).toBe("audio/ogg");
  const audio = one({ audio: { file_id: "A", mime_type: "audio/mpeg" } });
  expect(audio).toMatchObject({ kind: "audio", mediaId: "tg:A", mime: "audio/mpeg" });
  expect(audio.voice).toBeUndefined();
  expect(one({ video: { file_id: "X", mime_type: "video/mp4" }, caption: "look" })).toMatchObject({ kind: "video", text: "look [a video]", mediaId: "tg:X" });
  expect(one({ video_note: { file_id: "N" } })).toMatchObject({ kind: "video", text: "[a video]", mime: "video/mp4" });
  expect(one({ animation: { file_id: "G", mime_type: "video/mp4" }, document: { file_id: "G", mime_type: "video/mp4" } })).toMatchObject({ kind: "video", text: "[a GIF]", mediaId: "tg:G", mime: "video/mp4" });
  expect(one({ sticker: { file_id: "S", emoji: "😀", is_animated: false, is_video: false } })).toMatchObject({ kind: "sticker", text: "a sticker 😀", mediaId: "tg:S", mime: "image/webp" });
  expect(one({ sticker: { file_id: "S", is_animated: true, is_video: false } })).toMatchObject({ kind: "sticker", text: "a sticker" });
  expect(one({ sticker: { file_id: "S", is_animated: true, is_video: false } }).mediaId).toBeUndefined();
  expect(one({ document: { file_id: "D", file_name: "a.pdf", mime_type: "application/pdf" } })).toMatchObject({ kind: "document", text: "document: a.pdf (application/pdf)", mediaId: "tg:D", mime: "application/pdf" });
  expect(one({ location: { latitude: 37.4847, longitude: -122.1477 } })).toMatchObject({ kind: "location", text: "location: 37.4847, -122.1477" });
  expect(one({ location: { latitude: 1, longitude: 2 }, venue: { location: { latitude: 1, longitude: 2 }, title: "Cafe", address: "1 Main St" } }).text).toBe("location: Cafe, 1 Main St");
  expect(one({ contact: { phone_number: "+1 650", first_name: "Ann", last_name: "A" } })).toMatchObject({ kind: "contacts", text: "contact card: Ann A +1 650" });
  const poll = one({ poll: { id: "p" } });
  expect(poll.kind).toBe("unsupported");
  expect(poll.text).toBeUndefined();
});

test("parseUpdate: reaction added and removed", () => {
  const r = (new_reaction: object[]) => parseUpdate({ update_id: 2, message_reaction: { chat: CHAT, message_id: 7, user: USER, date: 1762250100, old_reaction: [], new_reaction } })!.m;
  expect(r([{ type: "emoji", emoji: "👍" }])).toEqual({ id: "tg:123456789:7:r1762250100", from: "tg:123456789", name: "Ann", ts: 1762250100000, kind: "reaction", reaction: { messageId: "tg:123456789:7", emoji: "👍" } });
  expect(r([]).reaction).toEqual({ messageId: "tg:123456789:7", emoji: undefined });
});

test("parseUpdate: groups, bots, edits and other update kinds are null", () => {
  expect(parseUpdate(update({ text: "hi", chat: { id: -1001, type: "supergroup" } }))).toBeNull();
  expect(parseUpdate(update({ text: "hi", from: { ...USER, is_bot: true } }))).toBeNull();
  expect(parseUpdate({ update_id: 3, edited_message: { message_id: 42, from: USER, chat: CHAT, date: 1, text: "hi (edited)" } })).toBeNull();
  expect(parseUpdate({ update_id: 4, channel_post: { message_id: 1, chat: { id: -100, type: "channel" }, date: 1, text: "x" } })).toBeNull();
  expect(parseUpdate("garbage")).toBeNull();
});

// ---- client ----

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
const err = (error_code: number, description: string, parameters?: object) => new Response(JSON.stringify({ ok: false, error_code, description, ...(parameters ? { parameters } : {}) }), { status: error_code });
function stub(...responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r;
  }) as unknown as typeof fetch;
  return { calls, f, body: (i: number) => JSON.parse(calls[i].init?.body as string) as unknown };
}

test("sendText posts chat id, reply params and preview flag; returns tg:<chat>:<message_id>", async () => {
  const s = stub(ok({ message_id: 43 }), ok({ message_id: 44 }), ok({}));
  const tg = makeTgClient({ token: "TOK", fetch: s.f });
  expect(await tg.sendText("tg:123456789", "hello", { quote: "tg:123456789:40", previewUrl: true })).toEqual({ id: "tg:123456789:43" });
  expect(s.calls[0].url).toBe(`${TG}/botTOK/sendMessage`);
  expect(s.body(0)).toEqual({ chat_id: 123456789, text: "hello", link_preview_options: { is_disabled: false }, reply_parameters: { message_id: 40, allow_sending_without_reply: true } });
  expect(await tg.sendText("tg:123456789", "plain")).toEqual({ id: "tg:123456789:44" });
  expect(s.body(1)).toEqual({ chat_id: 123456789, text: "plain", link_preview_options: { is_disabled: true } });
  await expect(tg.sendText("tg:123456789", "x")).rejects.toMatchObject({ code: 0, status: 502 }); // no message_id in the result: the core stores a failed row
});

test("sendAudio posts multipart sendVoice: chat id, the bytes as voice.ogg with the mime, reply params; returns tg:<chat>:<message_id>", async () => {
  const s = stub(ok({ message_id: 45 }), ok({ message_id: 46 }), ok({}));
  const tg = makeTgClient({ token: "TOK", fetch: s.f });
  const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
  expect(await tg.sendAudio!("tg:123456789", bytes, "audio/ogg", { quote: "tg:123456789:40" })).toEqual({ id: "tg:123456789:45" });
  expect(s.calls[0].url).toBe(`${TG}/botTOK/sendVoice`);
  expect(s.calls[0].init?.headers).toBeUndefined(); // fetch writes the multipart boundary
  const form = s.calls[0].init?.body as FormData;
  expect(form.get("chat_id")).toBe("123456789");
  expect(JSON.parse(form.get("reply_parameters") as string)).toEqual({ message_id: 40, allow_sending_without_reply: true });
  const voice = form.get("voice") as File;
  expect([voice.name, voice.type, new Uint8Array(await voice.arrayBuffer())]).toEqual(["voice.ogg", "audio/ogg", bytes]);
  expect(await tg.sendAudio!("tg:123456789", bytes, "audio/ogg")).toEqual({ id: "tg:123456789:46" });
  expect((s.calls[1].init?.body as FormData).has("reply_parameters")).toBe(false);
  await expect(tg.sendAudio!("tg:123456789", bytes, "audio/ogg")).rejects.toMatchObject({ code: 0, status: 502 });
});

test("sendImage posts multipart sendPhoto: chat id, the JPEG as screenshot.jpg, caption cut at 1024, reply params; returns tg:<chat>:<message_id>", async () => {
  const s = stub(ok({ message_id: 47 }), ok({ message_id: 48 }), ok({}));
  const tg = makeTgClient({ token: "TOK", fetch: s.f });
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  expect(await tg.sendImage!("tg:123456789", bytes, "image/jpeg", { caption: "x".repeat(2000), quote: "tg:123456789:40" })).toEqual({ id: "tg:123456789:47" });
  expect(s.calls[0].url).toBe(`${TG}/botTOK/sendPhoto`);
  const form = s.calls[0].init?.body as FormData;
  expect(form.get("chat_id")).toBe("123456789");
  expect((form.get("caption") as string).length).toBe(1024);
  expect(JSON.parse(form.get("reply_parameters") as string)).toEqual({ message_id: 40, allow_sending_without_reply: true });
  const photo = form.get("photo") as File;
  expect([photo.name, photo.type, new Uint8Array(await photo.arrayBuffer())]).toEqual(["screenshot.jpg", "image/jpeg", bytes]);
  expect(await tg.sendImage!("tg:123456789", bytes, "image/jpeg")).toEqual({ id: "tg:123456789:48" });
  const bare = s.calls[1].init?.body as FormData;
  expect([bare.has("caption"), bare.has("reply_parameters")]).toEqual([false, false]);
  await expect(tg.sendImage!("tg:123456789", bytes, "image/jpeg")).rejects.toMatchObject({ code: 0, status: 502 });
});

test("routeTransports dispatches sendImage by prefix and fails it for a transport without one", async () => {
  const sent: string[] = [];
  const base = { sendText: async () => ({ id: "" }), sendReaction: async () => {}, markReadTyping: async () => {}, fetchMedia: async () => ({ bytes: new Uint8Array(), mime: "" }) };
  const r = routeTransports(base, { ...base, sendImage: async (to) => { sent.push(to); return { id: "" }; } });
  await r.sendImage!("tg:1", new Uint8Array(), "image/jpeg");
  await expect(r.sendImage!("15550000001", new Uint8Array(), "image/jpeg")).rejects.toMatchObject({ code: 0, status: 0 });
  expect(sent).toEqual(["tg:1"]);
  expect(routeTransports(base, base).sendImage).toBeUndefined();
});

test("sendReaction (variation selector stripped) and markReadTyping send the documented bodies", async () => {
  const s = stub(ok(true), ok(true));
  const tg = makeTgClient({ token: "TOK", fetch: s.f });
  await tg.sendReaction("tg:1", "tg:1:42", "❤️");
  await tg.markReadTyping("tg:1:42");
  expect(s.calls[0].url).toBe(`${TG}/botTOK/setMessageReaction`);
  expect(s.body(0)).toEqual({ chat_id: 1, message_id: 42, reaction: [{ type: "emoji", emoji: "❤" }] });
  expect(s.calls[1].url).toBe(`${TG}/botTOK/sendChatAction`);
  expect(s.body(1)).toEqual({ chat_id: 1, action: "typing" });
});

test("fetchMedia: getFile then download; mime from the response unless octet-stream, then from the extension", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const a = stub(ok({ file_id: "V", file_path: "voice/file_1.oga" }), new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
  const out = await makeTgClient({ token: "TOK", fetch: a.f }).fetchMedia("tg:V");
  expect(out).toEqual({ bytes, mime: "audio/ogg" });
  expect(a.body(0)).toEqual({ file_id: "V" });
  expect(a.calls[1].url).toBe(`${TG}/file/botTOK/voice/file_1.oga`);
  const b = stub(ok({ file_path: "photos/file_2.jpg" }), new Response(bytes, { headers: { "content-type": "image/jpeg" } }));
  expect((await makeTgClient({ token: "TOK", fetch: b.f }).fetchMedia("tg:P")).mime).toBe("image/jpeg");
  const c = stub(ok({ file_id: "V" }));
  await expect(makeTgClient({ token: "TOK", fetch: c.f }).fetchMedia("tg:V")).rejects.toMatchObject({ code: 0, status: 502 });
  const d = stub(ok({ file_path: "x.bin" }), new Response("", { status: 404 }));
  await expect(makeTgClient({ token: "TOK", fetch: d.f }).fetchMedia("tg:V")).rejects.toMatchObject({ code: 0, status: 404 });
  const e = stub(ok({ file_path: "documents/file_3.bin" }), new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
  expect((await makeTgClient({ token: "TOK", fetch: e.f }).fetchMedia("tg:D")).mime).toBe("");
});

test("429 is retried once after retry_after seconds; a second 429 or a long retry_after throws", async () => {
  const delays: number[] = [];
  const sleep = async (ms: number) => void delays.push(ms);
  const a = stub(err(429, "Too Many Requests: retry after 2", { retry_after: 2 }), ok({ message_id: 9 }));
  expect(await makeTgClient({ token: "T", fetch: a.f, sleep }).sendText("tg:1", "x")).toEqual({ id: "tg:1:9" });
  expect(delays).toEqual([2000]);
  const b = stub(err(429, "slow", { retry_after: 1 }), err(429, "slow", { retry_after: 1 }));
  await expect(makeTgClient({ token: "T", fetch: b.f, sleep }).sendText("tg:1", "x")).rejects.toMatchObject({ code: 429, status: 429 });
  expect(b.calls).toHaveLength(2);
  const c = stub(err(429, "slow", { retry_after: 60 }));
  await expect(makeTgClient({ token: "T", fetch: c.f, sleep }).sendText("tg:1", "x")).rejects.toMatchObject({ code: 429 });
  expect(c.calls).toHaveLength(1);
  const d = stub(err(429, "slow"));
  await expect(makeTgClient({ token: "T", fetch: d.f, sleep }).sendText("tg:1", "x")).rejects.toMatchObject({ code: 429 });
  expect(d.calls).toHaveLength(1);
  expect(delays).toEqual([2000, 1000]); // a and b slept once each; c and d never slept
});

test("an API error becomes WaError(error_code, http status, description); a hung request WaError(0, 0)", async () => {
  const s = stub(err(400, "Bad Request: chat not found"));
  const e = await makeTgClient({ token: "T", fetch: s.f }).sendText("tg:1", "x").catch((x) => x);
  expect(e).toBeInstanceOf(WaError);
  expect(e).toMatchObject({ code: 400, status: 400, message: "Bad Request: chat not found" });
  const hanging = (async (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
  await expect(makeTgClient({ token: "T", fetch: hanging, timeoutMs: 5 }).markReadTyping("tg:1:2")).rejects.toMatchObject({ code: 0, status: 0 });
});

test("routeTransports sends tg: ids to Telegram and everything else to WhatsApp; sendAudio and window24h dispatch the same way", async () => {
  const log: string[] = [];
  const fake = (name: string, audio = false): WaClient => ({
    async sendText(to) { log.push(`${name}.sendText ${to}`); return { id: "" }; },
    async sendReaction(to) { log.push(`${name}.sendReaction ${to}`); },
    async markReadTyping(id) { log.push(`${name}.typing ${id}`); },
    async fetchMedia(id) { log.push(`${name}.media ${id}`); return { bytes: new Uint8Array(), mime: "" }; },
    ...(audio ? { sendAudio: async (to: string) => { log.push(`${name}.sendAudio ${to}`); return { id: "" }; }, window24h: () => false } : {}),
  });
  const r = routeTransports(fake("wa"), fake("tg", true));
  await r.sendText("tg:1", "x");
  await r.sendText("15550000001", "x");
  await r.sendReaction("tg:1", "tg:1:2", "👍");
  await r.markReadTyping("tg:1:2");
  await r.markReadTyping("wamid.X");
  await r.fetchMedia("tg:F");
  await r.fetchMedia("1003383421387256");
  await r.sendAudio!("tg:1", new Uint8Array(), "audio/ogg");
  await expect(r.sendAudio!("15550000001", new Uint8Array(), "audio/ogg")).rejects.toMatchObject({ code: 0, status: 0 }); // this fake cannot: the core falls back to text
  expect(log).toEqual(["tg.sendText tg:1", "wa.sendText 15550000001", "tg.sendReaction tg:1", "tg.typing tg:1:2", "wa.typing wamid.X", "tg.media tg:F", "wa.media 1003383421387256", "tg.sendAudio tg:1"]);
  expect([r.window24h!("tg:1"), r.window24h!("15550000001")]).toEqual([false, true]); // a client without window24h keeps Meta's rule
  expect(routeTransports(fake("wa"), fake("tg")).sendAudio).toBeUndefined();
  const real = routeTransports(makeWaClient({ token: "t", phoneNumberId: "p" }), makeTgClient({ token: "t" }));
  expect([real.sendAudio !== undefined, real.window24h!("15550000001"), real.window24h!("tg:1")]).toEqual([true, true, false]);
});

test("end to end: a voice note from a Telegram contact is answered with one sendAudio on the Telegram client", async () => {
  const clock = new FakeClock(), view = clock.forContact("tg"), wa = new FakeWa(clock), tg = new FakeWa(clock);
  const deps = makeEvalDeps({ clock: view, wa, llm: stubLlm({ reply: () => "react: none\nall good here" }) });
  deps.wa = routeTransports(wa, tg);
  tg.media.set("tg:V", { bytes: new Uint8Array([1]), mime: "audio/ogg" });
  const core = new ContactCore(deps);
  await core.ingest({ id: "tg:123456789:42", from: "tg:123456789", ts: clock.t, kind: "audio", mediaId: "tg:V", mime: "audio/ogg", voice: true });
  await drain(core, view, clock, clock.t + 60_000);
  expect(tg.sent.map((s) => s.kind)).toEqual(["typing", "audio"]);
  expect(tg.sent[1]).toMatchObject({ to: "tg:123456789", mime: "audio/ogg", bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]) });
  expect(wa.sent).toEqual([]);
  expect(deps.db.all("SELECT kind, text, status FROM messages WHERE direction = 'out'")).toEqual([{ kind: "audio", text: "all good here", status: "sent" }]);
});

test("end to end: the /start update gets the first-contact introduction line; the next message does not", async () => {
  const clock = new FakeClock(), view = clock.forContact("start"), wa = new FakeWa(clock), tg = new FakeWa(clock);
  const llm = stubLlm({ reply: () => "react: none\nhi, I'm the assistant that remembers" });
  const deps = makeEvalDeps({ clock: view, wa, llm });
  deps.wa = routeTransports(wa, tg);
  const core = new ContactCore(deps);
  await core.ingest(parseUpdate(update({ text: "/start", date: clock.t / 1000 }))!.m);
  await drain(core, view, clock, clock.t + 60_000);
  expect(llm.calls).toHaveLength(1);
  expect(llm.calls[0].system[1].content).toContain("first contact: nothing has been said before");
  expect(JSON.stringify(llm.calls[0].messages)).toContain("Hi, I just pressed Start.");
  expect(tg.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual(["hi, I'm the assistant that remembers"]);
  clock.t += 60_000;
  await core.ingest(parseUpdate(update({ text: "what can you do?", message_id: 43, date: clock.t / 1000 }))!.m);
  await drain(core, view, clock, clock.t + 60_000);
  expect(llm.calls).toHaveLength(2);
  expect(llm.calls[1].system[1].content).not.toContain("first contact:");
});

// ---- POST /telegram ----

const ctx = {} as ExecutionContext;
function fakeEnv(allowed: string | undefined, secret = "s3cret") {
  const names: string[] = [];
  const ingested: Inbound[] = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: secret, ALLOWED_TELEGRAM: allowed,
    CONTACT: { getByName: (name: string) => { names.push(name); return { ingest: async (m: Inbound) => { ingested.push(m); } }; } },
  } as unknown as Env;
  return { env, names, ingested };
}
const post = (env: Env, payload: unknown, secret?: string) =>
  worker.fetch(new Request("https://x/telegram", { method: "POST", body: JSON.stringify(payload), headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} }), env, ctx);

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

test("POST /telegram: missing or wrong secret is 403; unset secret keeps the route dark (404)", async () => {
  const f = fakeEnv("");
  expect((await post(f.env, update({ text: "hi" }))).status).toBe(403);
  expect((await post(f.env, update({ text: "hi" }), "nope")).status).toBe(403);
  expect((await post(fakeEnv("", "").env, update({ text: "hi" }), "s3cret")).status).toBe(404);
  expect(f.ingested).toEqual([]);
  const bad = await worker.fetch(new Request("https://x/telegram", { method: "POST", body: "{", headers: { "x-telegram-bot-api-secret-token": "s3cret" } }), f.env, ctx);
  expect(bad.status).toBe(400);
});

test("POST /telegram: empty or unset allowlist admits; the Durable Object is named tg:<chat_id>", async () => {
  for (const list of ["", undefined]) {
    const f = fakeEnv(list);
    const res = await post(f.env, update({ text: "hi" }), "s3cret");
    expect(res.status).toBe(200);
    expect(f.names).toEqual(["tg:123456789"]);
    expect(f.ingested.map((m) => m.id)).toEqual(["tg:123456789:42"]);
  }
});

test("POST /telegram: an ingest failure is logged and still answers 200 so Telegram moves on", async () => {
  const f = fakeEnv("");
  (f.env as unknown as { CONTACT: unknown }).CONTACT = { getByName: () => ({ ingest: async () => { throw new Error("boom"); } }) };
  expect((await post(f.env, update({ text: "hi" }), "s3cret")).status).toBe(200);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toEqual({ event: "ingest_failed", error: "boom" });
});

test("POST /telegram: a retryable Durable Object error answers 503 so Telegram redelivers", async () => {
  const f = fakeEnv("");
  (f.env as unknown as { CONTACT: unknown }).CONTACT = { getByName: () => ({ ingest: async () => { throw Object.assign(new Error("reset"), { retryable: true }); } }) };
  expect((await post(f.env, update({ text: "hi" }), "s3cret")).status).toBe(503);
  expect(vi.mocked(console.log).mock.calls.some((c) => String(c[0]).includes("ingest_failed"))).toBe(false);
});

test("POST /telegram: allowlist by @username (any case) or numeric id; others are dropped with a short log", async () => {
  for (const list of ["@annk", "ANNK, 42", " 123456789 ", "@other,123456789"]) {
    const f = fakeEnv(list);
    expect((await post(f.env, update({ text: "hi" }), "s3cret")).status).toBe(200);
    expect(f.ingested, list).toHaveLength(1);
  }
  const f = fakeEnv("@other, 42");
  expect((await post(f.env, update({ text: "hi" }), "s3cret")).status).toBe(200);
  expect(f.ingested).toEqual([]);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toEqual({ event: "dropped_sender", from: "AnnK" });
  expect((await post(f.env, update({ text: "hi", from: { id: 987654321, is_bot: false, first_name: "B" } }), "s3cret")).status).toBe(200);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toEqual({ event: "dropped_sender", from: "…4321" });
});

test("POST /telegram: a group update or an edit is ignored with 200", async () => {
  const f = fakeEnv("");
  expect((await post(f.env, update({ text: "hi", chat: { id: -1001, type: "supergroup" } }), "s3cret")).status).toBe(200);
  expect((await post(f.env, { update_id: 5, edited_message: { message_id: 1, from: USER, chat: CHAT, date: 1, text: "x" } }, "s3cret")).status).toBe(200);
  expect(f.ingested).toEqual([]);
  expect(f.names).toEqual([]);
});

test("POST /telegram is 404 without the bot token even when the secret is set", async () => {
  const f = fakeEnv("");
  (f.env as unknown as Record<string, unknown>).TELEGRAM_BOT_TOKEN = "";
  expect((await post(f.env, update({ text: "hi" }), "s3cret")).status).toBe(404);
  expect(f.ingested).toEqual([]);
});
