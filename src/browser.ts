import type { Deps } from "./core/types";
// http(s) URLs in chat text, first two; trailing punctuation is not part of the URL.
export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/gi) ?? []).slice(0, 2);
}

const SNAPSHOT_PATH = "browser-rendering/snapshot";
const MAX_MARKDOWN = 12_000;

// null on any failure (non-2xx, success:false, missing fields, timeout): the model is simply told the page could not be opened.
export function makeSnapshot(cfg: { accountId: string; token: string; fetch?: typeof fetch; timeoutMs?: number; log?: (e: Record<string, unknown>) => void }): Deps["snapshot"] {
  const f = cfg.fetch ?? fetch, log = cfg.log ?? console.log;
  return async (url) => {
    try {
      const res = await f(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/${SNAPSHOT_PATH}?cacheTTL=0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url, formats: ["screenshot", "markdown"],
          viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
          screenshotOptions: { type: "jpeg", quality: 80 }, gotoOptions: { waitUntil: "networkidle2", timeout: 20000 }, bestAttempt: true,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 25_000),
      });
      if (!res.ok) {
        log({ event: "snapshot_failed", status: res.status, retryAfter: res.headers.get("Retry-After") });
        return null;
      }
      const body = (await res.json()) as { success?: boolean; result?: { screenshot?: string; markdown?: string }; meta?: { title?: string; status?: number; finalUrl?: string } };
      const { screenshot, markdown } = body.result ?? {};
      if (body.success === false || !screenshot || markdown === undefined) {
        log({ event: "snapshot_failed", reason: "bad_body" });
        return null;
      }
      return {
        url, finalUrl: body.meta?.finalUrl ?? url, title: body.meta?.title ?? "", status: body.meta?.status ?? 0,
        markdown: markdown.replace(/^---\r?\n[\s\S]*?\r?\n?---\r?\n/, "").slice(0, MAX_MARKDOWN),
        jpeg: Uint8Array.from(atob(screenshot), (c) => c.charCodeAt(0)),
      };
    } catch (e) {
      log({ event: "snapshot_failed", error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const RESULTS = 3, PAGE_CHARS = 3000, PAGE_BYTES = 200_000;

// At most PAGE_BYTES of a body: a huge page must not fill the Durable Object's memory.
async function readCapped(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader(), dec = new TextDecoder(), parts: string[] = [];
  for (let n = 0; n < PAGE_BYTES;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    parts.push(dec.decode(value, { stream: true }));
  }
  void reader.cancel().catch(() => {});
  return parts.join("");
}
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? m;
  const n = Number("0" + e.slice(1)); // "0x27" and "039" both parse
  return n <= 0x10ffff ? String.fromCodePoint(n) : m;
});

const key = (u: string) => { const p = URL.parse(u); return p ? p.host.replace(/^www\./, "") + p.pathname.replace(/\/$/, "") + p.search : u; }; // scheme, www and a trailing slash do not make a new page

// DuckDuckGo's HTML results: organic anchors have class result__a and wrap the target in uddg= (ads link to y.js without it).
export function parseResults(html: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  for (const [a, inner] of html.matchAll(/<a\s[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = /\shref="([^"]*)"/i.exec(a)?.[1];
    const url = href ? URL.parse(decode(href), "https://duckduckgo.com")?.searchParams.get("uddg") : null;
    if (url && /^https?:\/\//i.test(url) && !out.some((r) => key(r.url) === key(url))) out.push({ title: decode(inner.replace(/<[^>]*>/g, "")).trim(), url });
  }
  return out;
}

// Readable text of a page: scripts, styles and comments dropped, tags to spaces, whitespace collapsed, the first 3,000 characters.
export const pageText = (html: string): string =>
  decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, PAGE_CHARS);

// The top 3 results and their main pages, no Browser Rendering. Never throws: a refusal is [], a page that fails has text "".
export function makeSearch(cfg: { fetch?: typeof fetch; log?: (e: Record<string, unknown>) => void } = {}): NonNullable<Deps["search"]> {
  const f = cfg.fetch ?? fetch, log = cfg.log ?? console.log;
  const get = (url: string, ms: number) => f(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(ms) });
  return async (query) => {
    try {
      const res = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 6000);
      const hits = res.status === 200 ? parseResults(await res.text()).slice(0, RESULTS) : [];
      if (!hits.length) {
        log({ event: "search_failed", status: res.status }); // 202 is DuckDuckGo's bot challenge; 200 with nothing parsed is a challenge page or no results
        return [];
      }
      return await Promise.all(hits.map(async (h) => {
        try {
          const r = await get(h.url, 5000);
          return { ...h, text: r.ok && /^(text|application\/xhtml)/i.test(r.headers.get("content-type") ?? "") ? pageText(await readCapped(r)) : "" };
        } catch {
          return { ...h, text: "" };
        }
      }));
    } catch (e) {
      log({ event: "search_failed", error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  };
}
