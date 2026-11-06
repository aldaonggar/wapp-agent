import { expect, test } from "vitest";
import { FakeClock, FakeWa, makeEvalDeps, stubLlm } from "../../evals/harness";
import { JOBS } from "../models";
import { MAX_PAGE_BYTES, PAGE_SYSTEM, TEMPLATE_CSS, buildPage, PAGE_SCRIPT, SCRIPT_HASH, getPage, recentPages, render, setPageState, sanitize, wrap } from "./pages";

const MD = "# Phones\n\n| Model | Price |\n|---|---|\n| A | 10 |\n\nSee [the review](https://example.com/r?a=1&b=2) and **buy** *soon*.";

test("render turns Markdown with a table and a link into content tags only", () => {
  const html = render(MD);
  expect(html).toContain("<h1>Phones</h1>");
  expect(html).toMatch(/<table>[\s\S]*<th>Model<\/th>[\s\S]*<td>10<\/td>/);
  expect(html).toContain('<a href="https://example.com/r?a=1&amp;b=2">the review</a>');
  expect(html).toContain("<strong>buy</strong>");
  expect(html).not.toMatch(/\s(align|style|class)=/);
});

test("a Markdown task list renders as tickable checkboxes (not disabled), nested lists and a numbered list keep their structure", () => {
  const html = render("## Pack\n\n- [ ] passport\n- [x] charger\n  - [ ] cable\n\n1. first\n2. second");
  expect(html).toMatch(/<li><input type="checkbox"> passport<\/li>/);
  expect(html).toMatch(/<li><input type="checkbox" checked> charger/);
  expect(html).toMatch(/<ul>\s*<li><input type="checkbox"> cable<\/li>\s*<\/ul>/); // nested inside charger's item
  expect(html).not.toContain("disabled");
  expect(html).toMatch(/<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
  expect(render('<input type="text" value="x"><input type=checkbox checked onclick="x()"><dl><dt>Label</dt><dd>Value</dd></dl>')).toBe('<input type="checkbox" checked><dl><dt>Label</dt><dd>Value</dd></dl>');
});

test("tables with header rows and a nested list in a cell-free fragment survive an HTML fragment too", () => {
  const html = render("<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><ul><li>x<ul><li>y</li></ul></li></ul><hr><blockquote>q</blockquote><pre><code>c</code></pre>");
  expect(html).toBe("<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><ul><li>x<ul><li>y</li></ul></li></ul><hr><blockquote>q</blockquote><pre><code>c</code></pre>");
});

test("raw HTML inside Markdown is shown as text, and image and javascript: links do not survive", () => {
  const html = render('hi <script>alert(1)</script> <b onclick="x()">b</b>\n\n![pic](https://e.example/p.png) [x](javascript:alert(1))');
  expect(html).not.toMatch(/<(script|b|img)\b/i); // an escaped "onclick" is inert text
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toMatch(/javascript\s*:/i);
});

test("an HTML fragment is cleaned to the allowed tags: script, handlers, styles, unknown tags and bad hrefs go; text stays", () => {
  const html = render('<h2 style="color:red" onclick="x()">T</h2><script>alert(1)</script><style>p{color:red}</style><p class="a">x <font color=red>y</font> <a href="javascript:1" onclick="z()">bad</a> <a href=\'https://ok.example/\' target=_blank>ok</a></p><iframe src="https://e.example"></iframe>');
  expect(html).toBe('<h2>T</h2><p>x y <a>bad</a> <a href="https://ok.example/">ok</a></p>');
});

test("a tag the regexes misread (odd quote in an unquoted value) is escaped, never passed through", () => {
  const html = render("<p>hi</p><meta content='0;url=https://evil.example/' x='>' http-equiv=refresh y=a\"b>");
  expect(html).not.toMatch(/<meta/i);
  expect(render('<a href=\'https://x/ onx=1"\'>l</a>')).not.toMatch(/\son\w+=|<a href="https:\/\/x\/>/);
});

test("sanitize removes script tags (closed, unclosed, nested), on* attributes, javascript: URLs and refresh tags", () => {
  expect(sanitize('<p>a</p><script>alert(1)</script><SCRIPT src="x.js"></SCRIPT >b')).toBe("<p>a</p>b");
  expect(sanitize("<scr<script></script>ipt>alert(1)</scr<script></script>ipt>")).not.toMatch(/<script/i);
  expect(sanitize('<img src="a.png" onerror="x()" ONLOAD=y() alt="ok">')).toBe('<img src="a.png" alt="ok">');
  expect(sanitize('<a href="JaVaScRiPt :1">y</a>')).toBe('<a href="1">y</a>');
  expect(sanitize('<meta http-equiv="refresh" content="0;url=https://evil.example"><p>ok</p>')).toBe("<p>ok</p>");
});

test("wrap: the fixed template has the Iceland link, a title, the title as first heading only when the content has none", () => {
  const withH = wrap("T <1>", "<h2>x</h2><p>y</p>");
  expect(withH).toContain("<title>T &lt;1&gt;</title>");
  expect(withH).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Iceland&display=swap">');
  expect(withH).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
  expect(withH).toContain(TEMPLATE_CSS);
  expect(withH).not.toContain("<h1>");
  expect(wrap("Trip", "<p>y</p>")).toContain("<h1>Trip</h1>");
});

test("the template CSS is black and white only: no colour value besides #000 and #fff, no shadows, gradients or radii", () => {
  expect(TEMPLATE_CSS.match(/#[0-9a-f]{3,8}\b/gi)!.map((c) => c.toLowerCase()).sort()).toEqual(["#000", "#000", "#fff", "#fff"]);
  expect(TEMPLATE_CSS).not.toMatch(/rgb|hsl|gradient|shadow|radius|\burl\(/i);
  expect(TEMPLATE_CSS.replace(/#(000|fff)\b/gi, "")).not.toMatch(/\b(red|blue|green|gray|grey|orange|purple|pink|yellow|teal|navy)\b/i);
});

const mk = (first: string) => {
  let text = first;
  const llm = Object.assign(stubLlm({ text: () => text }), { next: (t: string) => { text = t; } });
  const clock = new FakeClock();
  return { llm, deps: makeEvalDeps({ clock: clock.forContact("a"), wa: new FakeWa(clock), llm, contactKey: "abc" }) };
};

test("buildPage calls the page model with the content-only system prompt, low effort, 8000 tokens and 45 s; stores the wrapped, cleaned page under a 22-character id", async () => {
  const { llm, deps } = mk("```markdown\n" + MD + "\n\n<script>x()</script>\n```");
  const r = await buildPage(deps, "Trip", "three days in Lisbon");
  expect(llm.textCalls).toEqual([{
    job: "page", modelId: JOBS.page.default, system: PAGE_SYSTEM, messages: [{ role: "user", content: "Title: Trip\n\nBrief:\nthree days in Lisbon" }],
    maxOutputTokens: 8000, reasoning: { effort: "low" }, sessionId: "abc", timeoutMs: 45_000,
  }]);
  expect(PAGE_SYSTEM).toMatch(/CONTENT[\s\S]*No CSS/);
  expect(r).toEqual({ url: expect.stringMatching(/^https:\/\/wapp-agent\.test\/p\/abc\/[A-Za-z0-9_-]{22}$/), title: "Trip" });
  const id = (r as { url: string }).url.split("/").pop()!;
  const stored = deps.db.all<{ id: string; title: string; html: string; bytes: number }>("SELECT * FROM pages")[0];
  expect(stored).toMatchObject({ id, title: "Trip", bytes: new TextEncoder().encode(stored.html).length });
  expect(stored.html).toContain(TEMPLATE_CSS);
  expect(stored.html).toContain("<h1>Phones</h1>");
  expect(stored.html).not.toMatch(/<script/i);
  expect(getPage(deps.db, id)).toEqual({ html: stored.html, title: "Trip" });
  expect(getPage(deps.db, "nope")).toBeNull();
});

test("buildPage ids are random per page", async () => {
  const { deps } = mk(MD);
  const ids = new Set<string>();
  for (let i = 0; i < 5; i++) ids.add(((await buildPage(deps, "T", "b")) as { url: string }).url.split("/").pop()!);
  expect(ids.size).toBe(5);
});

test("buildPage refuses over 64 KB and an empty reply, and stores nothing", async () => {
  const big = mk("# x\n\n" + "a".repeat(MAX_PAGE_BYTES));
  expect(await buildPage(big.deps, "T", "b")).toEqual({ error: expect.stringContaining("too big") });
  const none = mk("  ");
  expect(await buildPage(none.deps, "T", "b")).toEqual({ error: expect.stringContaining("no page") });
  expect(big.deps.db.all("SELECT 1 FROM pages")).toHaveLength(0);
  expect(none.deps.db.all("SELECT 1 FROM pages")).toHaveLength(0);
});

const BOXES = "## Pack\n\n- [ ] a\n- [x] b\n- [ ] c";
const idOf = (r: unknown) => (r as { url: string }).url.split("/").pop()!;

test("getPage numbers every checkbox with data-i, applies stored ticks over the model's own, and adds the one script only when there are boxes", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  expect(getPage(deps.db, id)!.html).toContain('<input type="checkbox" data-i="1" checked>'); // b is ticked in the source: only the stored state counts once there is one
  expect(setPageState(deps.db, id, [0, 2])).toBe(true);
  const html = getPage(deps.db, id)!.html;
  expect(html).toContain('<input type="checkbox" data-i="0" checked>');
  expect(html).toContain('<input type="checkbox" data-i="1">');
  expect(html).toContain('<input type="checkbox" data-i="2" checked>');
  expect(html.match(/<script>/g)).toHaveLength(1);
  expect(html).toContain(`<script>${PAGE_SCRIPT}</script>`);
  expect(PAGE_SCRIPT.split("\n").length).toBeLessThan(25);
  expect(getPage(mk("x").deps.db, "nope")).toBeNull();
});

test("a page without checkboxes is served without the script; content cannot bring its own data-i", async () => {
  const { deps } = mk("# Hi\n\ntext");
  expect(getPage(deps.db, idOf(await buildPage(deps, "T", "b")))!.html).not.toContain("<script");
  expect(render('<input type="checkbox" data-i="9" onclick="x()">')).toBe('<input type="checkbox">');
});

test("the CSP hash covers the exact script text", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PAGE_SCRIPT));
  expect(SCRIPT_HASH).toBe(Buffer.from(digest).toString("base64"));
});

test("setPageState rejects an unknown id, out-of-range, fractional or negative indexes and more than the cap; dedupes and sorts", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  expect(setPageState(deps.db, "nope", [])).toBe(false);
  for (const bad of [[3], [-1], [0.5], [NaN], Array(501).fill(0)]) expect(setPageState(deps.db, id, bad)).toBe(false);
  expect(setPageState(deps.db, id, [2, 0, 2])).toBe(true);
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[0,2]" }]);
});

test("recentPages lists pages of the last 7 days with ids and tick counts, newest first, at most 5", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  setPageState(deps.db, id, [0, 1]);
  expect(recentPages(deps.db, deps.clock.now())).toEqual([{ id, title: "Pack", ticked: 2, total: 3 }]);
  expect(recentPages(deps.db, deps.clock.now() + 8 * 86_400_000)).toEqual([]);
  for (let i = 0; i < 6; i++) deps.db.run("INSERT INTO pages(id, title, html, created_at) VALUES (?, 't', '', ?)", `x${i}`, deps.clock.now() + i);
  expect(recentPages(deps.db, deps.clock.now())).toHaveLength(5);
});

test("buildPage with a page_id updates in place: same id, new content and source, ticks kept only for boxes that remain, updated_at bumped, cap counts it; unknown or source-less id is an error", async () => {
  const { llm, deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  setPageState(deps.db, id, [0, 2]);
  llm.next("## Pack\n\n- [ ] only");
  expect(await buildPage(deps, "Pack2", "drop two", id)).toBeDefined();
  expect(deps.db.all("SELECT 1 FROM pages")).toHaveLength(1);
  const row = deps.db.all<{ title: string; state: string; source: string; updated_at: number }>("SELECT title, state, source, updated_at FROM pages WHERE id=?", id)[0];
  expect(row).toMatchObject({ title: "Pack2", state: "[0]", source: "## Pack\n\n- [ ] only", updated_at: deps.clock.now() });
  expect(getPage(deps.db, id)!.html).toContain('data-i="0" checked');
  expect(JSON.stringify(llm.textCalls.at(-1))).toContain("current page");
  deps.db.run("UPDATE pages SET created_at=0 WHERE id=?", id);
  expect(deps.db.all("SELECT 1 FROM pages WHERE created_at > ?1 OR updated_at > ?1", deps.clock.now() - 86_400_000)).toHaveLength(1);
  expect(await buildPage(deps, "T", "b", "nope")).toEqual({ error: expect.stringContaining("no page") });
  deps.db.run("UPDATE pages SET source=NULL WHERE id=?", id);
  expect(await buildPage(deps, "T", "b", id)).toEqual({ error: expect.stringContaining("before edits") });
});
