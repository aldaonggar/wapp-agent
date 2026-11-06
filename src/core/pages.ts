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

// The one script any page runs (hash-allowed in the CSP, injected at serve time for pages with checkboxes): sends each tick as it happens (keepalive, so a tick just before closing still lands).
export const PAGE_SCRIPT = `addEventListener("change", (e) => {
  const c = e.target;
  if (!c.matches("input[data-i]")) return;
  fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ i: +c.dataset.i, checked: c.checked }), keepalive: true }).catch(() => {});
});`;
export const SCRIPT_HASH = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PAGE_SCRIPT)))));

const BOX = /<input type="checkbox"(?: checked)?>/g;
const countBoxes = (html: string) => html.match(BOX)?.length ?? 0;
const firstTicks = (html: string) => [...html.matchAll(BOX)].flatMap((m, i) => (m[0].endsWith(" checked>") ? [i] : []));
/** Ticked indexes: the stored state, or for a page made before state existed (NULL) the page's own marks. */
const ticksOf = (html: string, state: string | null) => (state == null ? firstTicks(html) : (JSON.parse(state) as number[]));
// shortcut: counts task markers in code blocks too, so a "- [ ]" inside a fence shifts the ticks; fine for chat-made pages.
const withTicks = (source: string, on: Set<number>) => { let k = 0; return source.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/gm, (_, pre: string) => `${pre}[${on.has(k++) ? "x" : " "}]`); };

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
export const render = (text: string): string =>
  sanitize(allowTags(/^\s*<[a-z]/i.test(text) ? text : (md.parse(text, { async: false }) as string)))
    // Last word: any `<` that is not one of allowTags' own output forms is text, so a tag the regexes misread (an odd quote) can never reach the browser.
    .replace(/<(?!\/?(?:h[1-6]|p|br|hr|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|pre|code|a|strong|em|b|i|del|dl|dt|dd)>|a href="[^"<>]*">|input type="checkbox"(?: checked)?>)/g, "&lt;");

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

// The cap counts page-model calls (builds and edits, failed or not: the call is what costs), not stored pages.
export const pagesLeftToday = (db: Db, now: number) => db.all<{ n: number }>("SELECT COUNT(*) AS n FROM page_builds WHERE at > ?", now - 86_400_000)[0].n < MAX_PAGES_PER_DAY;

/** Why a page cannot be edited, or null. Pages made before edits existed have no source. */
export function pageEditError(db: Db, id: string): string | null {
  const r = db.all<{ source: string | null }>("SELECT source FROM pages WHERE id=?", id)[0];
  return !r ? "no page with that id: make a new one instead" : !r.source ? "that page was made before edits were possible: make a new one instead" : null;
}

// 16 random bytes in base64url: 22 characters, 128 bits.
const newId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** One call to the page model, then sanitise, size-check and store. Errors come back as text the reply model can relay. */
export async function buildPage(deps: Deps, title: string, brief: string, pageId?: string): Promise<{ url: string; title: string } | { error: string }> {
  const { llm, models, db, clock } = deps;
  const err = pageId === undefined ? null : pageEditError(db, pageId);
  if (err) return { error: err };
  const prev = pageId === undefined ? undefined : db.all<{ source: string; html: string; state: string | null }>("SELECT source, html, state FROM pages WHERE id=?", pageId)[0];
  db.run("INSERT INTO page_builds(at) VALUES (?)", clock.now());
  const r = await llm.text({
    job: "page", modelId: models.page, system: PAGE_SYSTEM, messages: [{ role: "user", content: prev ? `Title: ${title}\n\nHere is the current page (Markdown; [x] items are ticked, keep each item's mark as it is on every item you keep):\n${withTicks(prev.source, new Set(ticksOf(prev.html, prev.state)))}\n\nApply these changes and return the full updated page:\n${brief}` : `Title: ${title}\n\nBrief:\n${brief}` }],
    maxOutputTokens: PAGE_MAX_OUTPUT, reasoning: reasoningFor(models.page, EFFORT.page), sessionId: deps.contactKey, timeoutMs: PAGE_TIMEOUT_MS,
  });
  const text = r.text.trim().replace(/^```(?:markdown|md|html)?\s*\n?|\n?```\s*$/gi, ""); // some models fence the document anyway
  if (new TextEncoder().encode(text).length > MAX_PAGE_BYTES) return { error: "the page came out too big (over 64 KB): ask for something shorter" };
  const content = render(text).trim();
  if (!content) return { error: "the page model returned no page" };
  const html = wrap(title, content);
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_PAGE_BYTES) return { error: "the page came out too big (over 64 KB): ask for something shorter" };
  const id = pageId ?? newId(), state = JSON.stringify(firstTicks(html)); // ticks follow the items the model kept, as it wrote them
  if (prev) db.run("UPDATE pages SET title=?, html=?, bytes=?, source=?, updated_at=?, state=? WHERE id=?", title, html, bytes, text, clock.now(), state, id);
  else db.run("INSERT INTO pages(id, title, html, bytes, created_at, source, state) VALUES (?,?,?,?,?,?,?)", id, title, html, bytes, clock.now(), text, state);
  return { url: `${deps.publicUrl}/p/${deps.contactKey}/${id}`, title };
}

/** The page as served: every checkbox gets its data-i and the stored ticks; the saving script rides along when there are boxes. Content can hold neither (the cleaner strips both). */
export function getPage(db: Db, id: string): { html: string; title: string } | null {
  const r = db.all<{ html: string; title: string; state: string | null }>("SELECT html, title, state FROM pages WHERE id=?", id)[0];
  if (!r) return null;
  const on = new Set(ticksOf(r.html, r.state));
  let i = 0;
  const html = r.html.replace(BOX, () => `<input type="checkbox" data-i="${i}"${on.has(i++) ? " checked" : ""}>`);
  const at = html.lastIndexOf("</body>");
  return { html: i && at >= 0 ? `${html.slice(0, at)}<script>${PAGE_SCRIPT}</script>\n${html.slice(at)}` : html, title: r.title };
}

/** Tick or untick one checkbox (by order of appearance); a delta merged here, so two viewers never overwrite each other. False for an unknown page, a bad index or a non-boolean. */
export function setPageState(db: Db, id: string, i: number, checked: boolean): boolean {
  const r = db.all<{ html: string; state: string | null }>("SELECT html, state FROM pages WHERE id=?", id)[0];
  if (!r || typeof checked !== "boolean" || !Number.isInteger(i) || i < 0 || i >= countBoxes(r.html)) return false;
  const on = new Set(ticksOf(r.html, r.state));
  if (checked) on.add(i); else on.delete(i);
  db.run("UPDATE pages SET state=? WHERE id=?", JSON.stringify([...on].sort((a, b) => a - b)), id);
  return true;
}

export interface PageLine { id: string; title: string; ticked: number; total: number; left: string[]; editable: boolean }
const text = (h: string) => h.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
/** Labels of the unticked boxes (the text after each, up to the end of its item), at most 8, 60 characters each. */
const leftOver = (html: string, on: Set<number>) =>
  html.split(BOX).slice(1).flatMap((seg, i) => (on.has(i) ? [] : [text(seg.split(/<\/li>|<[uo]l>|<input/)[0]).slice(0, 60)])).filter(Boolean).slice(0, 8);
/** Pages from the last 7 days, newest first (made or updated), for the prompt. One query. */
export function recentPages(db: Db, now: number): PageLine[] {
  return db.all<{ id: string; title: string; html: string; state: string | null; source: string | null }>("SELECT id, title, html, state, source FROM pages WHERE MAX(created_at, COALESCE(updated_at, 0)) > ? ORDER BY MAX(created_at, COALESCE(updated_at, 0)) DESC LIMIT 5", now - 7 * 86_400_000)
    .map((r) => { const on = new Set(ticksOf(r.html, r.state)); return { id: r.id, title: r.title, ticked: on.size, total: countBoxes(r.html), left: leftOver(r.html, on), editable: !!r.source }; });
}
