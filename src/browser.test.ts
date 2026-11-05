import { expect, test, vi } from "vitest";
import { extractUrls, makeSearch, makeSnapshot, pageText, parseResults } from "./browser";

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

// Shaped like html.duckduckgo.com/html/: an ad first (y.js, no uddg), then organic results.
const DDG = `<div class="result results_links result--ad"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;ad_provider=bingv7aa&amp;u3=https%3A%2F%2Fwww.bing.com%2Faclick">Cheap tickets</a></h2></div>
<div class="result results_links results_links_deep web-result "><h2 class="result__title">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.louvre.fr%2Fen%2Fvisit%3Flang%3Den&amp;rut=abc123">Hours &amp; <b>admission</b> | Mus&eacute;e du Louvre</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.louvre.fr%2Fen%2Fvisit%3Flang%3Den">The museum is open...</a></div>
<div class="result results_links web-result "><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FLouvre&amp;rut=d" class="result__a">Louvre &#8211; Wikipedia</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">bad</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.louvre.fr%2Fen%2Fvisit%3Flang%3Den">dup</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F">A</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2F">B</a></div>`;

test("parseResults keeps organic result__a anchors in order, decodes uddg and entities, and drops ads, non-http targets and repeats", () => {
  expect(parseResults(DDG)).toEqual([
    { title: "Hours & admission | Mus&eacute;e du Louvre", url: "https://www.louvre.fr/en/visit?lang=en" },
    { title: "Louvre \u2013 Wikipedia", url: "https://en.wikipedia.org/wiki/Louvre" },
    { title: "A", url: "https://a.example/" },
    { title: "B", url: "https://b.example/" },
  ]);
  expect(parseResults("<p>Unfortunately, bots use DuckDuckGo too.</p><div class=\"anomaly-modal__box\"></div>")).toEqual([]);
});

test("pageText drops scripts, styles, comments and tags, decodes entities, collapses whitespace and keeps 3,000 characters", () => {
  const html = `<html><head><title>T</title><style>body{color:red}</style><script>var x = "<b>no</b>";</script></head>
    <body><!-- nav --><h1>Opening   hours</h1>\n<p>Mon&ndash;Fri&nbsp;9&#8211;18 &amp; Sat <SCRIPT type="x">y()</SCRIPT >10&#x2013;14</p></body></html>`;
  expect(pageText(html)).toBe("T Opening hours Mon&ndash;Fri 9\u201318 & Sat 10\u201314");
  expect(pageText(`<p>${"a ".repeat(4000)}</p>`)).toHaveLength(3000);
});

const html = (body: string, init: ResponseInit = {}) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" }, ...init });

test("makeSearch fetches the DuckDuckGo HTML page, then the top 3 results' pages in parallel, with a browser User-Agent", async () => {
  const urls: string[] = [];
  let open = 0, maxOpen = 0;
  const f = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
    urls.push(String(u));
    expect((init!.headers as Record<string, string>)["User-Agent"]).toMatch(/^Mozilla\/5\.0 /);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    if (String(u).startsWith("https://html.duckduckgo.com/")) return html(DDG);
    open++; maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    if (String(u).includes("wikipedia")) throw new Error("connection reset");
    return String(u).startsWith("https://a.") ? new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }) : html("<p>Open 9 to 18</p>");
  });
  const out = await makeSearch({ fetch: f as typeof fetch, log: () => {} })("louvre opening hours & prices");
  expect(urls[0]).toBe("https://html.duckduckgo.com/html/?q=louvre%20opening%20hours%20%26%20prices");
  expect(urls.slice(1).sort()).toEqual(["https://a.example/", "https://en.wikipedia.org/wiki/Louvre", "https://www.louvre.fr/en/visit?lang=en"]);
  expect(maxOpen).toBe(3);
  expect(out).toEqual([
    { title: "Hours & admission | Mus&eacute;e du Louvre", url: "https://www.louvre.fr/en/visit?lang=en", text: "Open 9 to 18" },
    { title: "Louvre \u2013 Wikipedia", url: "https://en.wikipedia.org/wiki/Louvre", text: "" }, // the page failed: kept, with no text
    { title: "A", url: "https://a.example/", text: "" }, // not a text page
  ]);
});

test("makeSearch returns [] and logs the status when DuckDuckGo refuses, answers a challenge page or finds nothing; it never throws", async () => {
  const cases: [typeof fetch, Record<string, unknown>][] = [
    [(async () => html("<p>Unfortunately, bots use DuckDuckGo too.</p>", { status: 202 })) as typeof fetch, { status: 202 }],
    [(async () => html("<p>Select all squares containing a duck</p>")) as typeof fetch, { status: 200 }],
    [(async () => new Response("", { status: 503 })) as typeof fetch, { status: 503 }],
    [(async () => { throw new Error("dns"); }) as typeof fetch, { error: "dns" }],
  ];
  for (const [f, logged] of cases) {
    const log = vi.fn();
    await expect(makeSearch({ fetch: f, log })("q")).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith({ event: "search_failed", ...logged });
    expect(JSON.stringify(log.mock.calls)).not.toContain('"q"');
  }
});

test("parseResults treats scheme, www and a trailing slash as the same page", () => {
  const a = (u: string) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}">x</a>`;
  expect(parseResults(a("https://a.example/") + a("https://a.example") + a("http://www.a.example/") + a("https://b.example/")).map((r) => r.url)).toEqual(["https://a.example/", "https://b.example/"]);
});

test("makeSearch reads at most ~200 KB of a result page and rejects a page without a text content type", async () => {
  let pulled = 0;
  const big = new ReadableStream<Uint8Array>({ pull(c) { pulled += 65536; c.enqueue(new Uint8Array(65536).fill(97)); } });
  const f = (async (u: string | URL | Request) => {
    const s = String(u);
    if (s.startsWith("https://html.duckduckgo.com/")) return html(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbig.example%2F">Big</a><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnone.example%2F">None</a>`);
    return s.includes("big") ? new Response(big, { headers: { "Content-Type": "text/plain" } }) : new Response("<p>x</p>", { headers: { "Content-Type": "application/octet-stream" } });
  }) as typeof fetch;
  const out = await makeSearch({ fetch: f, log: () => {} })("q");
  expect(out[0].text).toHaveLength(3000);
  expect(pulled).toBeLessThanOrEqual(65536 * 6);
  expect(out[1].text).toBe("");
});
