import type { Tokens } from "marked";
import { checkValue, fieldSource, fieldValues, scanFields } from "./page-fields";
import { MAX_PAGE_BYTES, blankDefs, countBoxes, firstTicks, getPage, md, render, ticksOf, withTicks, wrap } from "./pages";
import type { Db } from "./types";

// What a person changes on a page is an edit to its Markdown source, so the page model sees it on any later edit. editPage applies one op to the source with a small deterministic editor, renders it through the same pipeline as the model's own pages and stores it.
export type Op =
  | { add: { list: number; text: string } }
  | { remove: { list: number; index: number } }
  | { note: { list: number; index: number; text: string } }
  | { field: { key: string; value: unknown } };
export type EditResult = { ok: true; body?: string; rev: number } | { ok: false; status: 400 | 404 | 409 | 429; error: string; body?: string; rev?: number };
export const MAX_EDITS_PER_HOUR = 300, MAX_ITEM = 200, MAX_NOTE = 300;

/** The top-level lists with tick boxes, in order, with their place in the source; null if the lexer's pieces do not add up to the source. */
function checklists(src: string) {
  const out: { list: Tokens.List; at: number }[] = [];
  let at = 0;
  for (const t of md.lexer(blankDefs(src))) {
    if (t.type === "list" && (t as Tokens.List).items.some((i) => i.task)) out.push({ list: t as Tokens.List, at });
    at += t.raw.length;
  }
  return at === src.length ? out : null;
}

const oneLine = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\s-]+/g, " ").trim() : "").slice(0, max + 1);
const num = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** Applies a list op to the source (ticks already written into it); the new source and a line for the bot's log, or an error. */
function editList(src: string, op: { list: number; index?: number; text?: string }, kind: "add" | "remove" | "note"): { src: string; log: (title: string) => string } | string {
  const L = checklists(src)?.[op.list];
  if (!L) return "no such list";
  const { list, at } = L, items = list.items;
  let p = at;
  const offs = items.map((i) => { const o = p; p += i.raw.length; return o; });
  if (p > at + list.raw.length || list.raw.slice(p - at).trim()) return "that list cannot be edited";
  if (kind === "add") {
    const text = oneLine(op.text, MAX_ITEM);
    if (!text || text.length > MAX_ITEM) return `an item is 1 to ${MAX_ITEM} characters`;
    const m = /^([ \t]*)([-*+]|\d{1,9}([.)]))/.exec(items[0].raw)!, end = at + list.raw.trimEnd().length;
    return { src: `${src.slice(0, end)}\n${m[1]}${m[3] ? "1" + m[3] : m[2]} [ ] ${text}${src.slice(end)}`, log: (t) => `added "${text}" to ${t}` };
  }
  const i = op.index!, item = items[i];
  if (!item) return "no such item";
  const label = item.text.split("\n")[0].slice(0, 60);
  if (kind === "remove") return { src: src.slice(0, offs[i]) + src.slice(offs[i] + item.raw.length), log: (t) => `removed "${label}" from ${t}` };
  const text = oneLine(op.text, MAX_NOTE);
  if (text.length > MAX_NOTE) return `a note is at most ${MAX_NOTE} characters`;
  const body = item.raw.trimEnd(), lines = body.split("\n"), head = /^([ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+)/.exec(lines[0])!;
  const k = lines.findIndex((l, j) => j > 0 && /^[ \t]+[-*+][ \t]+note:/.test(l));
  if (k >= 0) { if (text) lines[k] = `${/^[ \t]+[-*+][ \t]+/.exec(lines[k])![0]}note: ${text}`; else lines.splice(k, 1); } else if (text) lines.push(`${" ".repeat(head[1].length + head[2].length)}- note: ${text}`);
  return { src: src.slice(0, offs[i]) + lines.join("\n") + item.raw.slice(body.length) + src.slice(offs[i] + item.raw.length), log: (t) => (text ? `noted "${text}" on "${label}" in ${t}` : `cleared the note on "${label}" in ${t}`) };
}

function logEvent(db: Db, now: number, page: string, key: string | null, text: string): void {
  if (key) db.run("DELETE FROM page_events WHERE page_id=? AND key=?", page, key); // typing in one field twice is one change
  db.run("INSERT INTO page_events(page_id, key, text, at) VALUES (?,?,?,?)", page, key, text.slice(0, 200), now);
  db.run("DELETE FROM page_events WHERE id NOT IN (SELECT id FROM page_events ORDER BY id DESC LIMIT 50)");
}

/** What people changed on their pages since the bot last answered (oldest first, at most 20), and the row to delete up to once the turn that used them succeeds. */
export function pageChanges(db: Db): { lines: string[]; upTo: number } {
  const r = db.all<{ id: number; text: string }>("SELECT id, text FROM page_events ORDER BY id LIMIT 20");
  return { lines: r.map((x) => x.text), upTo: r.at(-1)?.id ?? 0 };
}

/**
 * One edit from the page's own script. ok: the page's new <main> body (for structural ops; a field save needs none) and its rev.
 * Errors: 400 invalid, 404 unknown page, 409 the viewer's rev is stale (body and rev are the page as it is now), 429 over 300 edits an hour.
 * A field save older than the field's last one (seq) is acknowledged and ignored; add, remove and note apply in arrival order.
 */
export function editPage(db: Db, now: number, id: string, op: Op, seq: number, rev?: number): EditResult {
  const r = db.all<{ title: string; html: string; source: string | null; state: string | null; seqs: string | null; rev: number | null }>("SELECT title, html, source, state, seqs, rev FROM pages WHERE id=?", id)[0];
  if (!r) return { ok: false, status: 404, error: "no such page" };
  const bad = (error: string): EditResult => ({ ok: false, status: 400, error });
  if (db.all<{ n: number }>("SELECT COUNT(*) AS n FROM page_edits WHERE page_id=? AND at > ?", id, now - 3_600_000)[0].n >= MAX_EDITS_PER_HOUR) return { ok: false, status: 429, error: "too many edits: try again in a while" };
  db.run("DELETE FROM page_edits WHERE at <= ?", now - 3_600_000);
  db.run("INSERT INTO page_edits(page_id, at) VALUES (?,?)", id, now);
  if (!num(seq)) return bad("bad seq");
  if (!r.source) return bad("that page was made before edits were possible");
  const cur = r.rev ?? 0, o = (op ?? {}) as Record<string, Record<string, unknown> | undefined>;
  let source = r.source, log: string, state = r.state, seqs = r.seqs, key: string | null = null;
  if (o.field) {
    const f = scanFields(source).find((x) => x.key === o.field!.key);
    if (!f) return bad("no such field");
    const v = checkValue(f, o.field.value);
    if (v === undefined) return bad("that value does not fit the field");
    const s = JSON.parse(seqs ?? "{}") as Record<string, number>, sk = `f:${f.key}`;
    if (seq <= (s[sk] ?? -1)) return { ok: true, rev: cur }; // an older save of this field arriving late
    s[sk] = seq;
    seqs = JSON.stringify(s);
    const value = v === "" || (Array.isArray(v) && !v.length) ? null : v;
    source = source.slice(0, f.start) + fieldSource({ ...f, value }) + source.slice(f.end);
    key = `${id}:${f.key}`;
    const shownV = value == null ? "" : (Array.isArray(value) ? value.join(", ") : value).replace(/\s+/g, " ").slice(0, 80);
    log = value == null ? `cleared ${f.label} on ${r.title}` : `set ${f.label} to "${shownV}" on ${r.title}`;
  } else {
    const kind = o.add ? "add" : o.remove ? "remove" : o.note ? "note" : null, a = kind && o[kind]!;
    if (!a || !num(a.list) || (kind !== "add" && !num(a.index)) || (kind !== "remove" && typeof a.text !== "string")) return bad("bad edit");
    if (rev !== undefined && rev !== cur) { const p = getPage(db, id)!; return { ok: false, status: 409, error: "the page changed: reloaded", body: p.body, rev: p.rev }; }
    const synced = withTicks(source, new Set(ticksOf(r.html, r.state)), countBoxes(r.html)); // the ticks go into the source, then come back out of the new render: they follow their items
    if (synced === null) return bad("that page's ticks cannot be kept through an edit");
    const e = editList(synced, a as { list: number; index?: number; text?: string }, kind);
    if (typeof e === "string") return bad(e);
    source = e.src; log = e.log(r.title);
  }
  const content = render(source).trim(), html = wrap(r.title, content), bytes = new TextEncoder().encode(html).length;
  if (!content || bytes > MAX_PAGE_BYTES) return bad("the page is full (64 KB)");
  if (!o.field) state = JSON.stringify(firstTicks(html));
  const next = o.field ? cur : cur + 1;
  db.run("UPDATE pages SET html=?, bytes=?, source=?, state=?, seqs=?, fields=?, rev=?, updated_at=? WHERE id=?", html, bytes, source, state, seqs, JSON.stringify(fieldValues(source)), next, now, id);
  logEvent(db, now, id, key, log);
  return { ok: true, rev: next, ...(o.field ? {} : { body: getPage(db, id)!.body }) };
}
