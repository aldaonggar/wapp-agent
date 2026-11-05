import { expect, test, vi } from "vitest";
import { extractUrls, makeSnapshot } from "./browser";

test("extractUrls finds the first two http(s) urls and ignores ftp://", () => {
  const text = "see https://a.com/x?y=1 and http://b.org, also ftp://c.net and https://d.io";
  expect(extractUrls(text)).toEqual(["https://a.com/x?y=1", "http://b.org"]);
  expect(extractUrls("ftp://c.net only")).toEqual([]);
});

const ok = (meta: unknown) => new Response(JSON.stringify({ success: true, result: { screenshot: btoa("\x01\x02\x03"), markdown: "---\ntitle: X\n---\n# Hi" }, meta }));

test("makeSnapshot posts the documented body and decodes the result", async () => {
  const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => ok({ status: 200, title: "X", finalUrl: "https://x/" }));
  const snap = await makeSnapshot({ accountId: "acc", token: "tok", fetch: f as typeof fetch, log: () => {} })("https://x");
  const [u, init] = f.mock.calls[0];
  expect(u).toBe("https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot?cacheTTL=0");
  expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  expect(JSON.parse(init!.body as string)).toEqual({
    url: "https://x", formats: ["screenshot", "markdown"],
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    screenshotOptions: { type: "jpeg", quality: 80 }, gotoOptions: { waitUntil: "networkidle2", timeout: 20000 }, bestAttempt: true,
  });
  expect(snap).toEqual({ url: "https://x", finalUrl: "https://x/", title: "X", status: 200, markdown: "# Hi", jpeg: new Uint8Array([1, 2, 3]) });
});

test("makeSnapshot falls back to the request url when meta has no finalUrl", async () => {
  const snap = await makeSnapshot({ accountId: "a", token: "t", fetch: (async () => ok(undefined)) as typeof fetch })("https://x");
  expect(snap).toMatchObject({ finalUrl: "https://x", title: "", status: 0 });
});

test("makeSnapshot returns null on 429 and logs Retry-After", async () => {
  const log = vi.fn();
  const f = (async () => new Response("{}", { status: 429, headers: { "Retry-After": "7" } })) as typeof fetch;
  expect(await makeSnapshot({ accountId: "a", token: "t", fetch: f, log })("https://x")).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: 429, retryAfter: "7" }));
});

const mk = (f: typeof fetch, extra: { timeoutMs?: number } = {}) => { const log = vi.fn(); return { log, snap: makeSnapshot({ accountId: "a", token: "t", fetch: f, log, ...extra }) }; };
const json = (b: unknown) => (async () => new Response(JSON.stringify(b))) as typeof fetch;

test("makeSnapshot returns null and logs bad_body on success:false", async () => {
  const { log, snap } = mk(json({ success: false, result: { screenshot: "AA==", markdown: "x" } }));
  expect(await snap("https://x")).toBeNull();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ reason: "bad_body" }));
});

test("makeSnapshot returns null when screenshot or markdown is missing", async () => {
  expect(await mk(json({ success: true, result: { markdown: "x" } })).snap("https://x")).toBeNull();
  expect(await mk(json({ success: true, result: { screenshot: "AA==" } })).snap("https://x")).toBeNull();
});

test("makeSnapshot returns null and logs on a network error or a non-JSON body", async () => {
  const net = mk((async () => { throw new Error("boom"); }) as typeof fetch);
  expect(await net.snap("https://x")).toBeNull();
  expect(net.log).toHaveBeenCalledWith(expect.objectContaining({ error: "boom" }));
  const bad = mk((async () => new Response("<html>")) as typeof fetch);
  expect(await bad.snap("https://x")).toBeNull();
  expect(bad.log).toHaveBeenCalledWith(expect.objectContaining({ event: "snapshot_failed" }));
});

test("makeSnapshot returns null when the request never resolves before the timeout", async () => {
  const hang = ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)))) as typeof fetch;
  expect(await mk(hang, { timeoutMs: 20 }).snap("https://x")).toBeNull();
});

test("makeSnapshot strips empty and CRLF front matter", async () => {
  for (const md of ["---\n---\n# A", "---\r\ntitle: X\r\n---\r\n# A"]) {
    const r = await mk(json({ success: true, result: { screenshot: "AA==", markdown: md } })).snap("https://x");
    expect(r?.markdown).toBe("# A");
  }
});
