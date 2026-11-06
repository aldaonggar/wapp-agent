import { Marked } from "marked";
import { EFFORT, reasoningFor } from "../models";
import type { Db, Deps } from "./types";

export const MAX_PAGE_BYTES = 64 * 1024, MAX_PAGES_PER_DAY = 10, PAGE_TIMEOUT_MS = 45_000, PAGE_MAX_OUTPUT = 8000;

export const PAGE_SYSTEM = `You write the CONTENT of one web page from a brief. The Worker owns the design; you never style anything.
- Output Markdown and nothing else: no explanation, no code fences around the whole thing. Use the full structure it offers: headings and sub-headings, bullet and nested lists, numbered lists, task lists ("- [ ] item", "- [x] done"), tables with a header row, blockquotes, code blocks, "---" rules between sections, links, bold and italic.
- No CSS, no <style>, no <html> or <body>, no scripts, no raw HTML, no images, no emoji.
- Pick the structure that fits the content: a comparison becomes a table; a plan or itinerary dated sections with numbered lists; a to-do or packing list a task list; label and value rows (facts about one thing) a two-column table; a mockup sections with labelled blocks in plain text or tables; a recipe an ingredient list and numbered steps; a summary headed sections with short bullets.
- Concise, no filler, no introduction about the page itself. It is read on a phone: short paragraphs, tables of at most 4 columns.
- Use only what the brief says. Invent no facts, prices, dates or links; if something is missing, leave it out or mark it as unknown.
- Stay under 30 KB.`;

// The one template every page uses: black on white, white on black in dark mode, no other colour (the model never styles).
export const TEMPLATE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0 auto; padding: 1.5rem 1rem 4rem; max-width: 680px; background: #fff; color: #000; font: 1.125rem/1.6 Iceland, system-ui, sans-serif; text-align: left; }
@media (prefers-color-scheme: dark) { body { background: #000; color: #fff; } }
h1, h2, h3, h4 { font-weight: 700; line-height: 1.25; margin: 2rem 0 0.75rem; }
h1 { font-size: 2rem; margin-top: 0; }
a { color: inherit; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid currentColor; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
hr { border: 0; border-top: 1px solid currentColor; margin: 2rem 0; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 1px solid currentColor; }
ul, ol { padding-left: 1.5rem; }
li { margin: 0.25rem 0; }
li:has(> input[type=checkbox]) { list-style: none; margin-left: -1.5rem; }
input[type=checkbox] { width: 1.1rem; height: 1.1rem; margin: 0 0.6rem 0 0; vertical-align: -0.15rem; accent-color: currentColor; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1.5rem; }
dt { font-weight: 700; }
dd { margin: 0; }
pre, code { font-family: ui-monospace, monospace; font-size: 0.95em; }
pre { overflow-x: auto; padding: 0.75rem; border: 1px solid currentColor; }
`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const wrap = (title: string, content: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Iceland&display=swap">
<style>${TEMPLATE_CSS}</style></head><body>
${/<h[1-6]\b/i.test(content) ? "" : `<h1>${esc(title)}</h1>\n`}${content}
</body></html>
`;

const TAGS = new Set("h1 h2 h3 h4 h5 h6 p br hr ul ol li table thead tbody tr th td blockquote pre code a strong em b i del dl dt dd input".split(" "));
/** Only the content tags survive, bare: no attributes except an http(s) or mailto href on a link and a checkbox input. Everything else is dropped, text kept. */
export function allowTags(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(\/?)([a-z][a-z0-9]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi, (_, close: string, name: string, attrs: string) => {
      const tag = name.toLowerCase();
      if (tag === "input") return /\btype\s*=\s*["']?checkbox\b/i.test(attrs) ? `<input type="checkbox"${/\bchecked\b/i.test(attrs) ? " checked" : ""}>` : ""; // task-list boxes, tickable, nothing else
      if (!TAGS.has(tag)) return "";
      if (close || tag !== "a") return `<${close}${tag}>`;
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
      return /^(https?:|mailto:)/i.test(url) ? `<a href="${url.replace(/"/g, "&quot;")}">` : "<a>";
    });
}

const md = new Marked({ renderer: { html: ({ text }) => esc(text) } }); // raw HTML in Markdown is shown as text, never passed through

/** Markdown (what the model is asked for) or, if it wrote an HTML fragment anyway, that fragment: either way cleaned to the content tags. */
export const render = (text: string): string => sanitize(allowTags(/^\s*<[a-z]/i.test(text) ? text : (md.parse(text, { async: false }) as string)));

/** Defence in depth behind the response's CSP: no scripts, inline handlers, javascript: URLs or refresh tags in what is stored. Repeats until stable so a nested fragment cannot reassemble. */
export function sanitize(html: string): string {
  const once = (s: string) => s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>?/gi, "") // an unclosed or half-open tag
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    .replace(/(<[^>]*?)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "$1")
    .replace(/javascript\s*:/gi, "");
  for (let s = html; ; ) { const n = once(s); if (n === s) return n; s = n; }
}

const dayCount = (db: Db, now: number) => db.all<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE created_at > ?", now - 86_400_000)[0].n;
export const pagesLeftToday = (db: Db, now: number) => dayCount(db, now) < MAX_PAGES_PER_DAY;

// 16 random bytes in base64url: 22 characters, 128 bits.
const newId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** One call to the page model, then sanitise, size-check and store. Errors come back as text the reply model can relay. */
export async function buildPage(deps: Deps, title: string, brief: string): Promise<{ url: string; title: string } | { error: string }> {
  const { llm, models, db, clock } = deps;
  const r = await llm.text({
    job: "page", modelId: models.page, system: PAGE_SYSTEM, messages: [{ role: "user", content: `Title: ${title}\n\nBrief:\n${brief}` }],
    maxOutputTokens: PAGE_MAX_OUTPUT, reasoning: reasoningFor(models.page, EFFORT.page), sessionId: deps.contactKey, timeoutMs: PAGE_TIMEOUT_MS,
  });
  const text = r.text.trim().replace(/^```(?:markdown|md|html)?\s*\n?|\n?```\s*$/gi, ""); // some models fence the document anyway
  if (new TextEncoder().encode(text).length > MAX_PAGE_BYTES) return { error: "the page came out too big (over 64 KB): ask for something shorter" };
  const content = render(text).trim();
  if (!content) return { error: "the page model returned no page" };
  const html = wrap(title, content);
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_PAGE_BYTES) return { error: "the page came out too big (over 64 KB): ask for something shorter" };
  const id = newId();
  db.run("INSERT INTO pages(id, title, html, bytes, created_at) VALUES (?,?,?,?,?)", id, title, html, bytes, clock.now());
  return { url: `${deps.publicUrl}/p/${deps.contactKey}/${id}`, title };
}

export const getPage = (db: Db, id: string): { html: string; title: string } | null =>
  db.all<{ html: string; title: string }>("SELECT html, title FROM pages WHERE id=?", id)[0] ?? null;
