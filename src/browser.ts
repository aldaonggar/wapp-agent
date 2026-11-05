import type { Deps } from "./core/types";
import { CHINA_HOSTS } from "./models";
const SEARCH_MODEL = "openai/gpt-6-luna";
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

// Readable text of a page: scripts, styles and comments dropped, tags to spaces, whitespace collapsed, the first 3,000 characters.
export const pageText = (html: string): string =>
  decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, PAGE_CHARS);

// OpenRouter's web plugin finds up to 3 sources (url_citation annotations); each main page is then fetched, falling back to the citation's snippet. Never throws: any failure is [].
export function makeSearch(cfg: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; log?: (e: Record<string, unknown>) => void }): NonNullable<Deps["search"]> {
  const f = cfg.fetch ?? fetch, log = cfg.log ?? console.log;
  return async (query) => {
    try {
      const res = await f("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SEARCH_MODEL, max_tokens: 120, reasoning: { effort: "none" }, plugins: [{ id: "web", engine: "exa", max_results: RESULTS }], provider: { ignore: CHINA_HOSTS },
          messages: [{ role: "user", content: `List the three most relevant current sources for: ${query}` }],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        log({ event: "search_failed", status: res.status });
        return [];
      }
      const body = (await res.json()) as { choices?: { message?: { annotations?: { type?: string; url_citation?: { url?: string; title?: string; content?: string } }[] } }[] };
      const hits: { title: string; url: string; snippet: string }[] = [];
      for (const a of body.choices?.[0]?.message?.annotations ?? []) {
        const c = a.type === "url_citation" ? a.url_citation : undefined;
        if (c?.url && /^https?:\/\//i.test(c.url) && !hits.some((h) => key(h.url) === key(c.url!))) hits.push({ title: c.title ?? "", url: c.url, snippet: c.content ?? "" });
      }
      if (!hits.length) {
        log({ event: "search_failed", reason: "no_citations" });
        return [];
      }
      return await Promise.all(hits.slice(0, RESULTS).map(async ({ snippet, ...h }) => {
        let text = "";
        try {
          const r = await f(h.url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(5000) });
          if (r.ok && /^(text|application\/xhtml)/i.test(r.headers.get("content-type") ?? "")) text = pageText(await readCapped(r));
        } catch { /* fall back to the snippet */ }
        return { ...h, text: text || snippet.replace(/\s+/g, " ").trim().slice(0, PAGE_CHARS) };
      }));
    } catch (e) {
      log({ event: "search_failed", error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  };
}
