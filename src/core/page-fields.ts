// The page model's field syntax and its round trip. [field: Label], [text: Label], [choice: Label | A | B], [multi: Label | A | B], [count: Label]
// become inputs; a value is written back into the source as [field: Label = value], [choice: Label = B | A | B], [multi: Label = A, C | A | B | C], [count: Label = 3].
// Inside a token \ ] | = , and a newline are escaped with a backslash (\n for a newline), so any text round-trips.
export type FieldKind = "field" | "text" | "choice" | "multi" | "count";
export type FieldValue = string | string[] | null;
export interface Field { kind: FieldKind; label: string; options: string[]; value: FieldValue; key: string; start: number; end: number }

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wr = (s: string, comma = false) => s.replace(comma ? /[\\\]|=,]/g : /[\\\]|=]/g, "\\$&").replace(/\n/g, "\\n"); // a comma only needs escaping inside the values of a multi
const unwr = (s: string) => s.replace(/\\(.)/gs, (_, c: string) => (c === "n" ? "\n" : c));
/** Splits on a separator that is not backslash-escaped; the pieces stay escaped. */
const splitU = (s: string, sep: string) => {
  const out = [""];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") out[out.length - 1] += s[i] + (s[++i] ?? "");
    else if (s[i] === sep) out.push("");
    else out[out.length - 1] += s[i];
  }
  return out;
};

export const MAX_TEXT = 2000, MAX_COUNT = 9999;

// A fenced block, a code span, or a field token: code is matched first so a field shown as an example stays text.
const TOKEN = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))|(`+)[^\n]*?\2|\[(field|text|choice|multi|count):((?:[^\\\]\n]|\\.)*)\]/gm;

/** Every field in the source, in order, with its place; the key is the label's slug plus how many fields before it had the same label. */
export function scanFields(src: string): Field[] {
  const seen = new Map<string, number>(), out: Field[] = [];
  for (const m of src.matchAll(TOKEN)) {
    if (!m[3]) continue;
    const kind = m[3] as FieldKind, parts = splitU(m[4], "|"), [lab, ...rest] = splitU(parts[0], "=");
    const label = unwr(lab.trim()), raw = rest.length ? rest.join("=").trim() : "";
    const slug = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "f", n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    const options = kind === "choice" || kind === "multi" ? parts.slice(1).map((o) => unwr(o.trim())).filter(Boolean) : [];
    const value: FieldValue = !raw ? null : kind === "multi" ? splitU(raw, ",").map((v) => unwr(v.trim())).filter(Boolean) : unwr(raw);
    out.push({ kind, label, options, value, key: `${slug}:${n}`, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** The token as it is written into the source. */
export const fieldSource = (f: Pick<Field, "kind" | "label" | "options" | "value">) => {
  const empty = f.value == null || f.value.length === 0;
  const v = empty ? "" : ` = ${Array.isArray(f.value) ? f.value.map((x) => wr(x, true)).join(", ") : wr(f.value as string)}`;
  return `[${f.kind}: ${wr(f.label)}${v}${f.options.map((o) => ` | ${wr(o)}`).join("")}]`;
};

/** The value to store for a save, or null when it does not fit the field: the choice must be one of the options, a count a whole number 0..9999, text at most 2000 characters. */
export function checkValue(f: Pick<Field, "kind" | "options">, v: unknown): FieldValue | undefined {
  if (f.kind === "multi") { const u = Array.isArray(v) ? [...new Set(v)] : null; return u && u.every((x) => f.options.includes(x as string)) ? (u as string[]) : undefined; }
  if (typeof v !== "string" && !(f.kind === "count" && typeof v === "number")) return undefined;
  const s = String(v);
  if (f.kind === "count") return /^\d{1,4}$/.test(s) ? String(+s) : undefined;
  if (f.kind === "choice") return f.options.includes(s) ? s : undefined;
  return s.length <= MAX_TEXT ? (f.kind === "field" ? s.replace(/\s+/g, " ").trim() : s.trim()) : undefined;
}

/** Keeps what a person filled in when the page model returns the source without it: a field the new text leaves empty gets its saved value back (if it still fits). */
export function fillFields(src: string, saved: Record<string, FieldValue>): string {
  let out = src;
  for (const f of scanFields(src).reverse()) {
    const v = f.value == null || f.value.length === 0 ? checkValue(f, saved[f.key]) : undefined;
    if (v != null && v.length) out = out.slice(0, f.start) + fieldSource({ ...f, value: v }) + out.slice(f.end);
  }
  return out;
}

/** The values to remember: key to value, filled fields only. */
export const fieldValues = (src: string): Record<string, FieldValue> =>
  Object.fromEntries(scanFields(src).filter((f) => f.value != null && f.value.length > 0).map((f) => [f.key, f.value]));

/** The input markup for one field (our own, added after the cleaner: the model never writes attributes). */
export function fieldHtml(f: Field): string {
  const k = esc(f.key), v = f.value, label = `<span class="lab">${esc(f.label)}</span>`;
  const group = (type: string, on: (o: string) => boolean) => f.options.map((o) => `<label><input data-f="${k}" type="${type}"${type === "radio" ? ` name="${k}"` : ""} value="${esc(o)}"${on(o) ? " checked" : ""}> ${esc(o)}</label>`).join(" ");
  const body =
    f.kind === "field" ? `<label>${label} <input data-f="${k}" type="text" maxlength="${MAX_TEXT}" value="${esc((v as string) ?? "")}"></label>`
    : f.kind === "text" ? `<label>${label} <textarea data-f="${k}" rows="3" maxlength="${MAX_TEXT}">${esc((v as string) ?? "")}</textarea></label>`
    : f.kind === "choice" ? `${label} ${group("radio", (o) => o === v)}`
    : f.kind === "multi" ? `${label} ${group("checkbox", (o) => Array.isArray(v) && v.includes(o))}`
    : `${label} <button type="button" data-d="-1">−</button> <output>${esc((v as string) ?? "0")}</output> <button type="button" data-d="1">+</button>`;
  return `<span class="f" data-f="${k}" data-kind="${f.kind}">${body}</span>`;
}
