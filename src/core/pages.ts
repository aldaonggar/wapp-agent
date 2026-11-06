import { Marked, Renderer, type Tokens } from "marked";
import { fieldHtml, fieldValues, fillFields, scanFields, type Field, esc } from "./page-fields";
import { EFFORT, reasoningFor } from "../models";
import type { Db, Deps } from "./types";

export const MAX_PAGE_BYTES = 64 * 1024, MAX_PAGES_PER_DAY = 10, PAGE_TIMEOUT_MS = 45_000, PAGE_MAX_OUTPUT = 8000;

export const PAGE_SYSTEM = `You write the CONTENT of one web page from a brief. The Worker owns the design; you never style anything.
- Output Markdown and nothing else: no explanation, no code fences around the whole thing. Use the full structure it offers: headings and sub-headings, bullet and nested lists, numbered lists, task lists ("- [ ] item", "- [x] done"), tables with a header row, blockquotes, code blocks, "---" rules between sections, links, bold and italic.
- No CSS, no <style>, no <html> or <body>, no scripts, no images, no emoji, and no raw HTML except the folding block below.
- Fold a long section the reader may skip (a day of an itinerary, an FAQ answer) with <details><summary>Title</summary>, a blank line, the section in Markdown, a blank line, </details>. Nothing else is allowed inside those tags: no attributes except open on details.
- Footnotes: put [^1] after the claim and, on a line of its own anywhere, [^1]: the note.
- Things the reader fills in, for a page to plan together, collect answers or keep using (not for plain reading), written in the text where the input belongs: [field: Label] one line of text, [text: Label] several lines, [choice: Label | A | B | C] pick one, [multi: Label | A | B | C] pick any, [count: Label] a number with + and -. Plain labels and options: no = , | [ ] \\ inside them. Example: "Budget (EUR): [field: Budget]" or "Hotel: [choice: Hotel | Ibis | Marriott | Hostel]". The reader's answers are written back into the source as [field: Budget = 400] and [choice: Hotel = Ibis | Ibis | Marriott | Hostel].
- Every top-level task list can be added to, pruned and annotated by the reader on the page (notes are stored as a nested "- note: ..." line under the item). When you are given a page to change, keep every filled-in value, every item they added and every note exactly as written unless the changes say otherwise; a new field is written without " = value".
- Headings get a table of contents automatically, tables sort and long lists filter on their own: just use real headings and tables.
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
summary { font-weight: 700; cursor: pointer; list-style: none; margin: 1rem 0 0.5rem; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "+ "; }
details[open] > summary::before { content: "− "; }
nav { border-bottom: 1px solid currentColor; margin: 1rem 0; padding-bottom: 0.5rem; }
nav ul { list-style: none; padding-left: 0; margin: 0.25rem 0; }
.progress { margin: 0 0 0.5rem; }
li:has(> input[type=checkbox]:checked) { text-decoration: line-through; }
th { cursor: pointer; }
th[aria-sort=ascending]::after { content: " ↑"; }
th[aria-sort=descending]::after { content: " ↓"; }
.filter, .add input, li > input.note { display: block; width: 100%; box-sizing: border-box; margin: 0.5rem 0; padding: 0.25rem 0; font: inherit; color: inherit; background: none; border: 0; border-bottom: 1px solid currentColor; appearance: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0 0.4rem; text-decoration: underline; cursor: pointer; }
.add { margin: 0 0 1rem; }
.ctl { margin-left: 0.5rem; font-size: 0.85em; }
li.note { list-style: none; font-size: 0.9em; margin: 0; }
li.note::before { content: "note: "; }
.f { display: inline-block; margin: 0.25rem 1rem 0.25rem 0; }
.f[data-kind=text] { display: block; margin-right: 0; }
.lab { font-weight: 700; margin-right: 0.4rem; }
.f input[type=text], .f textarea { font: inherit; color: inherit; background: none; border: 0; border-bottom: 1px solid currentColor; appearance: none; max-width: 100%; }
.f textarea { display: block; width: 100%; box-sizing: border-box; border: 1px solid currentColor; padding: 0.4rem 0.6rem; resize: vertical; }
.f input[type=radio], .f input[type=checkbox] { appearance: none; width: 1.1rem; height: 1.1rem; margin: 0 0.3rem 0 0; vertical-align: -0.15rem; border: 1px solid currentColor; background: none; }
.f input:checked { background: currentColor; }
output { display: inline-block; min-width: 2ch; text-align: center; font-weight: 700; }
sup a { text-decoration: none; }
.footnotes { border-top: 1px solid currentColor; margin-top: 2rem; font-size: 0.9em; }
@media print {
  body { max-width: none; background: white; color: black; font: 12pt/1.4 system-ui, sans-serif; }
  .copy, .filter, .add, .ctl, button { display: none; }
  table, tr, li, pre, details { break-inside: avoid; }
}
`;

import { PAGE_SCRIPT } from "./page-script";
export { PAGE_SCRIPT, SCRIPT_HASH } from "./page-script";

const BOX = /<input type="checkbox"(?: checked)?>/g;
export const countBoxes = (html: string) => html.match(BOX)?.length ?? 0;
export const firstTicks = (html: string) => [...html.matchAll(BOX)].flatMap((m, i) => (m[0].endsWith(" checked>") ? [i] : []));
/** Ticked indexes: the stored state, or for a page made before state existed (NULL) the page's own marks. */
export const ticksOf = (html: string, state: string | null) => (state == null ? firstTicks(html) : (JSON.parse(state) as number[]));
/** Rewrites the task marks of a Markdown source from the ticks; null unless its markers (marked's task-list rule) number exactly `n`, i.e. match the page's boxes. */
export const withTicks = (source: string, on: Set<number>, n: number) => {
  const MARK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\](?=[ \t]+\S)/gm;
  if ((source.match(MARK)?.length ?? 0) !== n) return null;
  let k = 0;
  return source.replace(MARK, (_, pre: string) => `${pre}[${on.has(k++) ? "x" : " "}]`);
};

const HEAD = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g;
/** 4 or more h2/h3: a plain Contents list of anchors, right before the first of them (after the title and any intro). */
const withContents = (body: string) => {
  const hs = [...body.matchAll(HEAD)];
  const toc = hs.length < 4 ? "" : `<nav><strong>Contents</strong><ul>${hs.map((m) => `<li><a href="#${m[2]}">${m[3].replace(/<[^>]*>/g, "")}</a></li>`).join("")}</ul></nav>`;
  return body.replace(/<h[23] id=/, (m) => toc + m); // a function: the list may hold "$"
};

export const wrap = (title: string, content: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Iceland&display=swap">
<style>${TEMPLATE_CSS}</style></head><body>
<main>
${withContents(/<h[1-6]\b/i.test(content) ? content : `<h1>${esc(title)}</h1>\n${content}`)}
</main>
</body></html>
`;

const TAGS = new Set("h1 h2 h3 h4 h5 h6 p br hr ul ol li table thead tbody tr th td blockquote pre code a strong em b i del dl dt dd input details summary".split(" "));
/** Only the content tags survive, bare: no attributes except an http(s) or mailto href on a link and a checkbox input. Everything else is dropped, text kept. */
export function allowTags(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(\/?)([a-z][a-z0-9]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi, (_, close: string, name: string, attrs: string) => {
      const tag = name.toLowerCase();
      if (tag === "input") return /\btype\s*=\s*["']?checkbox\b/i.test(attrs) ? `<input type="checkbox"${/\bchecked\b/i.test(attrs) ? " checked" : ""}>` : ""; // task-list boxes, tickable, nothing else
      if (!TAGS.has(tag)) return "";
      if (tag === "details" && !close && /\bopen\b/i.test(attrs)) return "<details open>";
      if (close || tag !== "a") return `<${close}${tag}>`;
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
      return /^(https?:|mailto:)/i.test(url) ? `<a href="${url.replace(/"/g, "&quot;")}">` : "<a>";
    });
}

// Raw HTML in Markdown is shown as text, never passed through, except the bare folding tags. [^id] is a footnote reference (a placeholder here, numbered in render).
export const md = new Marked({
  renderer: {
    html: ({ text }) => text.split(/(<\/?(?:details(?: open)?|summary)>)/gi).map((p, i) => (i % 2 ? p : esc(p))).join(""),
    // A top-level list with tick boxes is a checklist: its number marks the place for the add-item input (editPage addresses lists by it).
    list(this: Renderer, t: Tokens.List & { checklist?: number }) { const out = Renderer.prototype.list.call(this, t); return t.checklist === undefined ? out : `${out}\uE006${t.checklist}\uE007`; },
  },
  extensions: [{ name: "fn", level: "inline", start: (s: string) => s.indexOf("[^"), tokenizer(s: string) { const m = /^\[\^([\w-]+)\]/.exec(s); return m ? { type: "fn", raw: m[0], id: m[1] } : undefined; }, renderer: (t) => `\uE004${t.id}\uE005` }],
});

// Last word: any `<` that is not one of allowTags' own output forms is text, so a tag the regexes misread (an odd quote) can never reach the browser.
const clean = (html: string) => sanitize(allowTags(html))
  .replace(/<(?!\/?(?:h[1-6]|p|br|hr|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|pre|code|a|strong|em|b|i|del|dl|dt|dd|details|summary)>|details open>|a href="[^"<>]*">|input type="checkbox"(?: checked)?>)/g, "&lt;");

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
/** h2 and h3 get a stable id (marked has none): the text as a slug, "-2", "-3" for repeats. */
const withIds = (html: string) => {
  const used = new Set<string>();
  return html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, l: string, inner: string) => {
    let id = slug(text(inner)), n = 1;
    for (const base = id; used.has(id); ) id = `${base}-${++n}`;
    used.add(id);
    return `<h${l} id="${id}">${inner}</h${l}>`;
  });
};

/** Footnote definition lines become blank lines of the same length (so offsets hold and the editor lexes what the renderer lexes); the notes are collected. */
export const blankDefs = (src: string, notes = new Map<string, string>()) => src.replace(/^\[\^([\w-]+)\]:[ \t]*(.+)$/gm, (m, id: string, t: string) => (notes.set(id, t), " ".repeat(m.length)));

/** Markdown (what the model is asked for) or, if it wrote an HTML fragment anyway, that fragment: either way cleaned to the content tags. */
export function render(text: string): string {
  const src = text.replace(/[\uE000-\uE007]/g, ""); // that range is ours: placeholders below, never from the model
  if (/^\s*<(?!\/?(?:details|summary)\b)[a-z]/i.test(src)) return clean(src); // a page may start with a fold
  // Fields and footnote definitions are taken out of the text first (placeholders in the private-use range), then put back as our own markup after the cleaner.
  const fields = scanFields(src);
  // shortcut: a "[^id]: text" line inside a code fence is also taken as a definition; upgrade if a page ever shows one.
  const notes = new Map<string, string>();
  const body = blankDefs(fields.reduceRight((t, f, i) => t.slice(0, f.start) + `\uE002${i}\uE003` + t.slice(f.end), src), notes);
  const tokens = md.lexer(body);
  let k = 0;
  for (const t of tokens) if (t.type === "list" && (t as Tokens.List).items.some((i) => i.task)) (t as Tokens.List & { checklist?: number }).checklist = k++;
  let html = clean(md.parser(tokens));
  const order: string[] = [];
  html = html.replace(/\uE004([\w-]+)\uE005/g, (m, id: string) => {
    if (!notes.has(id)) return `[^${id}]`;
    const first = !order.includes(id);
    if (first) order.push(id);
    const n = order.indexOf(id) + 1;
    return `<sup><a href="#fn-${n}"${first ? ` id="fnref-${n}"` : ""}>${n}</a></sup>`;
  });
  if (order.length) html += `<section class="footnotes"><ol>${order.map((id, i) => `<li id="fn-${i + 1}">${clean((md.parseInline(notes.get(id)!, { async: false }) as string).replace(/\uE004[\w-]*\uE005/g, ""))} <a href="#fnref-${i + 1}">back</a></li>`).join("")}</ol></section>`;
  html = html
    .replace(/\uE006(\d+)\uE007/g, (_, n: string) => `<div class="add" data-list="${n}"><input type="text" maxlength="200" placeholder="add item" aria-label="add item"> <button type="button">add</button></div>`)
    .replace(/\uE002(\d+)\uE003/g, (_, i: string) => (fields[+i] ? fieldHtml(fields[+i]) : ""))
    .replace(/<li>note: /g, '<li class="note">');
  return withIds(html);
}

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
  const prev = pageId === undefined ? undefined : db.all<{ source: string; html: string; state: string | null; fields: string | null; rev: number | null }>("SELECT source, html, state, fields, rev FROM pages WHERE id=?", pageId)[0];
  const oldOn = new Set(prev ? ticksOf(prev.html, prev.state) : []), tickedSource = prev ? withTicks(prev.source, oldOn, countBoxes(prev.html)) : null; // null: markers and boxes disagree, ticks then carry by position
  db.run("INSERT INTO page_builds(at) VALUES (?)", clock.now());
  const r = await llm.text({
    job: "page", modelId: models.page, system: PAGE_SYSTEM, messages: [{ role: "user", content: prev ? `Title: ${title}\n\nHere is the current page (Markdown; [x] items are ticked, keep each item's mark as it is on every item you keep. People have also filled in fields such as [field: Label = value], added list items and written notes as nested "- note: ..." lines: keep all of that exactly as it is, unless the changes say otherwise):\n${tickedSource ?? prev.source}\n\nApply these changes and return the full updated page:\n${brief}` : `Title: ${title}\n\nBrief:\n${brief}` }],
    maxOutputTokens: PAGE_MAX_OUTPUT, reasoning: reasoningFor(models.page, EFFORT.page), sessionId: deps.contactKey, timeoutMs: PAGE_TIMEOUT_MS,
  });
  let text = r.text.trim().replace(/^```(?:markdown|md|html)?[ \t]*\n([\s\S]*)\n```$/i, "$1").replace(/\r\n?/g, "\n").replace(/[\uE000-\uE007]/g, ""); // some models fence the whole document anyway; a leading code block of a real page stays. The private-use range is ours (placeholders)
  if (prev?.fields) text = fillFields(text, JSON.parse(prev.fields)); // a value the model dropped comes back
  if (new TextEncoder().encode(text).length > MAX_PAGE_BYTES) return { error: "the page came out too big (over 64 KB): ask for something shorter" };
  const now = prev && db.all<{ source: string; state: string | null }>("SELECT source, state FROM pages WHERE id=?", pageId!)[0];
  if (prev && (now?.source !== prev.source || now?.state !== prev.state)) return { error: "the page was changed on the page itself while it was being rebuilt: ask again" }; // nothing stored: their changes stay
  const content = render(text).trim();
  if (!content) return { error: "the page model returned no page" };
  const html = wrap(title, content);
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_PAGE_BYTES) return { error: "the page came out too big (over 64 KB): ask for something shorter" };
  const id = pageId ?? newId(), state = JSON.stringify(!prev || tickedSource != null ? firstTicks(html) : [...oldOn].filter((i) => i < countBoxes(html)).sort((a, b) => a - b)); // ticks follow the items the model kept, as it wrote them
  const fields = JSON.stringify(fieldValues(text));
  if (prev) db.run("UPDATE pages SET title=?, html=?, bytes=?, source=?, updated_at=?, state=?, fields=?, rev=? WHERE id=?", title, html, bytes, text, clock.now(), state, fields, (prev.rev ?? 0) + 1, id);
  else db.run("INSERT INTO pages(id, title, html, bytes, created_at, source, state, fields) VALUES (?,?,?,?,?,?,?,?)", id, title, html, bytes, clock.now(), text, state, fields);
  return { url: `${deps.publicUrl}/p/${deps.contactKey}/${id}`, title };
}

/** The page as served: every checkbox gets its data-i and the stored ticks, a "n of m done" line sits above the first checklist, and the one script rides along. Content can hold none of these (the cleaner strips them). `body` is what is inside <main>, for the script to swap in. */
export function getPage(db: Db, id: string): { html: string; title: string; body: string; rev: number } | null {
  const r = db.all<{ html: string; title: string; state: string | null; rev: number | null }>("SELECT html, title, state, rev FROM pages WHERE id=?", id)[0];
  if (!r) return null;
  const on = new Set(ticksOf(r.html, r.state));
  let i = 0, done = 0;
  let html = r.html.replace(BOX, () => { const k = i++, t = on.has(k); done += +t; return `<input type="checkbox" data-i="${k}"${t ? " checked" : ""}>`; });
  const first = html.indexOf('<input type="checkbox" data-i="0"');
  if (first >= 0) { const at = Math.max(html.lastIndexOf("<ul>", first), html.lastIndexOf("<ol>", first)); html = at < 0 ? html : `${html.slice(0, at)}<p class="progress">${done} of ${i} done</p>${html.slice(at)}`; }
  const rev = r.rev ?? 0;
  html = html.replace("<main>", `<main data-rev="${rev}">`);
  const body = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
  const end = html.lastIndexOf("</body>");
  return { html: end >= 0 ? `${html.slice(0, end)}<script>${PAGE_SCRIPT}</script>\n${html.slice(end)}` : html, title: r.title, body, rev };
}

/** Tick or untick one checkbox (by order of appearance; "stale" when the viewer's rev is not the page's; a save whose seq is not above the box's last one is ignored); a delta merged here, so two viewers never overwrite each other. False for an unknown page, a bad index or a non-boolean. */
export function setPageState(db: Db, id: string, i: number, checked: boolean, seq: number, rev?: number): boolean | "stale" {
  const r = db.all<{ html: string; state: string | null; seqs: string | null; rev: number | null }>("SELECT html, state, seqs, rev FROM pages WHERE id=?", id)[0];
  if (!r || typeof checked !== "boolean" || !Number.isInteger(i) || i < 0 || i >= countBoxes(r.html) || !Number.isSafeInteger(seq) || seq < 0) return false;
  if (rev !== undefined && rev !== (r.rev ?? 0)) return "stale"; // the page changed shape since the viewer loaded it: its box numbers no longer mean the same items
  const seqs = JSON.parse(r.seqs ?? "{}") as Record<string, number>; // newest save seen per box: saves race, the older one must not win
  if (seq <= (seqs[i] ?? -1)) return true;
  seqs[i] = seq;
  const on = new Set(ticksOf(r.html, r.state));
  if (checked) on.add(i); else on.delete(i);
  db.run("UPDATE pages SET state=?, seqs=? WHERE id=?", JSON.stringify([...on].sort((a, b) => a - b)), JSON.stringify(seqs), id);
  return true;
}

export interface PageLine { id: string; title: string; ticked: number; total: number; left: string[]; editable: boolean; notes?: string[]; fields?: string[] }
const ENT: Record<string, string> = { quot: '"', lt: "<", gt: ">", amp: "&", nbsp: " ", apos: "'" };
const text = (h: string) => h.replace(/<[^>]*>/g, "").replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, x, n) => (n ? ENT[n.toLowerCase()] : String.fromCodePoint(d ? +d : parseInt(x, 16))) ?? m).trim(); // one pass, so "&amp;lt;" stays "&lt;"
/** Labels of the unticked boxes (the text after each, up to the end of its item), at most 8, 60 characters each. */
const leftOver = (html: string, on: Set<number>) =>
  html.split(BOX).slice(1).flatMap((seg, i) => (on.has(i) ? [] : [text(seg.split(/<\/li>|<[uo]l>|<input/)[0]).slice(0, 60)])).filter(Boolean).slice(0, 8);
/** "item → note" for each item that has a nested "- note: ..." line, at most 5. */
const notesOf = (src: string) => {
  let item = "";
  const out: string[] = [];
  for (const l of src.split("\n")) {
    const m = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(l), note = m && /^note:[ \t]*(.+)$/.exec(m[2]);
    if (note && item) out.push(`${item.slice(0, 40)} → ${note[1].slice(0, 80)}`);
    else if (m && !note) item = m[2].replace(/^\[[ xX]\][ \t]+/, "");
  }
  return out.slice(0, 5);
};
const shown = (v: Field["value"]) => (v == null || !v.length ? "?" : (Array.isArray(v) ? v.join(", ") : v).replace(/\s+/g, " ").slice(0, 80));
/** Pages from the last 7 days, newest first (made or updated), for the prompt. One query. */
export function recentPages(db: Db, now: number): PageLine[] {
  return db.all<{ id: string; title: string; html: string; state: string | null; source: string | null }>("SELECT id, title, html, state, source FROM pages WHERE MAX(created_at, COALESCE(updated_at, 0)) > ? ORDER BY MAX(created_at, COALESCE(updated_at, 0)) DESC LIMIT 5", now - 7 * 86_400_000)
    .map((r) => { const on = new Set(ticksOf(r.html, r.state)); return { id: r.id, title: r.title, ticked: on.size, total: countBoxes(r.html), left: leftOver(r.html, on), editable: !!r.source, notes: notesOf(r.source ?? ""), fields: scanFields(r.source ?? "").slice(0, 8).map((f) => `${f.label.slice(0, 40)} = ${shown(f.value)}`) }; });
}
