import { expect, test, vi } from "vitest";
import { extractUrls, makeSearch, makeSnapshot, pageText } from "./browser";

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

test("pageText drops scripts, styles, comments and tags, decodes entities, collapses whitespace and keeps 3,000 characters", () => {
  const html = `<html><head><title>T</title><style>body{color:red}</style><script>var x = "<b>no</b>";</script></head>
    <body><!-- nav --><h1>Opening   hours</h1>\n<p>Mon&ndash;Fri&nbsp;9&#8211;18 &amp; Sat <SCRIPT type="x">y()</SCRIPT >10&#x2013;14</p></body></html>`;
  expect(pageText(html)).toBe("T Opening hours Mon&ndash;Fri 9\u201318 & Sat 10\u201314");
  expect(pageText(`<p>${"a ".repeat(4000)}</p>`)).toHaveLength(3000);
});

const html = (body: string, init: ResponseInit = {}) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" }, ...init });

const OR = "https://openrouter.ai/api/v1/chat/completions";
const cite = (url: string, title = "T", content = "snippet") => ({ type: "url_citation", url_citation: { url, title, content } });
const orBody = (...annotations: unknown[]) => Response.json({ choices: [{ message: { role: "assistant", content: "x", annotations } }] });
const search = (f: (u: string, init?: RequestInit) => Promise<Response>, log = vi.fn(), o = {}) => makeSearch({ apiKey: "k", fetch: f as typeof fetch, log, ...o });

test("makeSearch asks OpenRouter's web plugin, fetches each cited page in parallel (capped, text only), dedupes, and keeps 3", async () => {
  let open = 0, maxOpen = 0, sent: { url: string; init?: RequestInit }[] = [];
  const f = async (u: string, init?: RequestInit) => {
    sent.push({ url: u, init });
    if (u === OR) return orBody(cite("https://www.louvre.fr/en/visit/", "Louvre"), cite("https://louvre.fr/en/visit"), cite("https://a.example/"), cite("https://b.example/"), cite("https://c.example/"));
    open++; maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return u.startsWith("https://a.") ? new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }) : html("<p>Open 9 to 18</p>");
  };
  const out = await search(f)("louvre hours");
  const body = JSON.parse(sent[0].init!.body as string);
  expect(sent[0].init!.headers).toMatchObject({ Authorization: "Bearer k" });
  expect(body).toMatchObject({ model: "openai/gpt-6-luna", max_tokens: 120, reasoning: { effort: "none" }, plugins: [{ id: "web", engine: "exa", max_results: 3 }], provider: { ignore: expect.arrayContaining(["deepseek"]) } });
  expect(body.messages[0].content).toContain("louvre hours");
  expect(maxOpen).toBe(3);
  expect(out).toEqual([
    { title: "Louvre", url: "https://www.louvre.fr/en/visit/", text: "Open 9 to 18" },
    { title: "T", url: "https://a.example/", text: "snippet" }, // not a text page: the snippet
    { title: "T", url: "https://b.example/", text: "Open 9 to 18" },
  ]);
});

test("makeSearch falls back to the citation snippet when a page fails or is empty", async () => {
  const f = async (u: string) => {
    if (u === OR) return orBody(cite("https://x.example/", "X", "  from\n the snippet "), cite("https://y.example/", "Y", "y snippet"));
    if (u.includes("x.")) throw new Error("reset");
    return html("<script>1</script>");
  };
  expect((await search(f)("q")).map((r) => r.text)).toEqual(["from the snippet", "y snippet"]);
});

test("makeSearch returns [] and logs search_failed for no citations, a non-200, a network error and a timeout; never the query", async () => {
  const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
  const cases: [(u: string, init?: RequestInit) => Promise<Response>, object, object][] = [
    [async () => orBody(), {}, { reason: "no_citations" }],
    [async () => orBody({ type: "other" }, cite("ftp://x")), {}, { reason: "no_citations" }],
    [async () => new Response("", { status: 402 }), {}, { status: 402 }],
    [async () => { throw new Error("dns"); }, {}, { error: "dns" }],
    [hang, { timeoutMs: 20 }, { error: expect.stringMatching(/timeout|abort/i) }],
  ];
  for (const [f, o, logged] of cases) {
    const log = vi.fn();
    await expect(search(f, log, o)("secretquery")).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith({ event: "search_failed", ...logged });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secretquery");
  }
});

test("makeSearch reads at most ~200 KB of a result page and rejects a page without a text content type", async () => {
  let pulled = 0;
  const big = new ReadableStream<Uint8Array>({ pull(c) { pulled += 65536; c.enqueue(new Uint8Array(65536).fill(97)); } });
  const f = async (u: string) => {
    if (u === OR) return orBody(cite("https://big.example/", "Big", ""), cite("https://none.example/", "None", ""));
    return u.includes("big") ? new Response(big, { headers: { "Content-Type": "text/plain" } }) : new Response("<p>x</p>", { headers: { "Content-Type": "application/octet-stream" } });
  };
  const out = await search(f)("q");
  expect(out[0].text).toHaveLength(3000);
  expect(pulled).toBeLessThanOrEqual(65536 * 6);
  expect(out[1].text).toBe("");
});
