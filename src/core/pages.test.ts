import { expect, test } from "vitest";
import { FakeClock, FakeWa, makeEvalDeps, stubLlm } from "../../evals/harness";
import { JOBS } from "../models";
import { MAX_PAGE_BYTES, PAGE_SYSTEM, TEMPLATE_CSS, buildPage, PAGE_SCRIPT, SCRIPT_HASH, getPage, pagesLeftToday, recentPages, render, setPageState, sanitize, wrap } from "./pages";

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
  expect(getPage(deps.db, id)).toMatchObject({ title: "Trip", body: expect.stringContaining("<h1>Phones</h1>") });
  expect(getPage(deps.db, id)!.html.replace(/<script>[\s\S]*<\/script>\n/, "").replace(' data-rev="0"', "")).toBe(stored.html);
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

let seqN = 0; const ps = (db: Parameters<typeof setPageState>[0], id: string, i: number, c: boolean) => setPageState(db, id, i, c, ++seqN);
const BOXES = "## Pack\n\n- [ ] a\n- [x] b\n- [ ] c";
const idOf = (r: unknown) => (r as { url: string }).url.split("/").pop()!;

test("getPage numbers every checkbox with data-i, applies stored ticks over the model's own, and adds the one script", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  expect(getPage(deps.db, id)!.html).toContain('<input type="checkbox" data-i="1" checked>'); // b is ticked in the source: only the stored state counts once there is one
  ps(deps.db, id, 0, true); ps(deps.db, id, 1, false); ps(deps.db, id, 2, true);
  const html = getPage(deps.db, id)!.html;
  expect(html).toContain('<input type="checkbox" data-i="0" checked>');
  expect(html).toContain('<input type="checkbox" data-i="1">');
  expect(html).toContain('<input type="checkbox" data-i="2" checked>');
  expect(html.match(/<script>/g)).toHaveLength(1);
  expect(html).toContain(`<script>${PAGE_SCRIPT}</script>`);
  expect(PAGE_SCRIPT.split("\n").length).toBeLessThan(200);
  expect(getPage(mk("x").deps.db, "nope")).toBeNull();
});

test("every page is served with the one script; content cannot bring its own data-i", async () => {
  const { deps } = mk("# Hi\n\ntext");
  expect(getPage(deps.db, idOf(await buildPage(deps, "T", "b")))!.html.match(/<script>/g)).toHaveLength(1);
  expect(render('<input type="checkbox" data-i="9" onclick="x()">')).toBe('<input type="checkbox">');
});

test("the CSP hash covers the exact script text", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PAGE_SCRIPT));
  expect(SCRIPT_HASH).toBe(Buffer.from(digest).toString("base64"));
});

test("setPageState merges one box at a time and rejects an unknown id, bad index or non-boolean", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b")); // b starts ticked
  expect(ps(deps.db, "nope", 0, true)).toBe(false);
  for (const [i, c] of [[3, true], [-1, true], [0.5, true], [NaN, true], [0, "yes"]] as const) expect(ps(deps.db, id, i, c as boolean)).toBe(false);
  expect(ps(deps.db, id, 2, true) && ps(deps.db, id, 0, true) && ps(deps.db, id, 0, true)).toBe(true);
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[0,1,2]" }]);
  ps(deps.db, id, 1, false); // two viewers: the other's ticks stay
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[0,2]" }]);
});

test("recentPages lists pages of the last 7 days with ids, tick counts and unticked labels, newest first, at most 5", async () => {
  const { llm, deps } = mk("- [ ] socks\n- [ ] **charger** & cable\n- [ ] " + "x".repeat(80));
  const id = idOf(await buildPage(deps, "Pack", "b"));
  ps(deps.db, id, 0, true);
  expect(recentPages(deps.db, deps.clock.now())).toEqual([{ id, title: "Pack", ticked: 1, total: 3, left: ["charger & cable", "x".repeat(60)], editable: true, notes: [], fields: [] }]);
  expect(recentPages(deps.db, deps.clock.now() + 8 * 86_400_000)).toEqual([]);
  llm.next(Array.from({ length: 12 }, (_, i) => `- [ ] i${i}`).join("\n"));
  await buildPage(deps, "Many", "b");
  expect(recentPages(deps.db, deps.clock.now()).find((p) => p.title === "Many")!.left).toEqual(Array.from({ length: 8 }, (_, i) => `i${i}`));
  for (let i = 0; i < 6; i++) deps.db.run("INSERT INTO pages(id, title, html, created_at) VALUES (?, 't', '', ?)", `x${i}`, deps.clock.now() + 1 + i);
  const l = recentPages(deps.db, deps.clock.now() + 10);
  expect(l.map((p) => p.id)).toEqual(["x5", "x4", "x3", "x2", "x1"]); // newest first, capped at 5
  expect(l[0].editable).toBe(false);
  deps.db.run("UPDATE pages SET updated_at=? WHERE id=?", deps.clock.now() + 50, id);
  expect(recentPages(deps.db, deps.clock.now() + 60)[0].id).toBe(id); // an edit counts as new
});

test("a page with NULL state (made before state existed) serves and counts its own checked marks", async () => {
  const { deps } = mk("x");
  deps.db.run("INSERT INTO pages(id, title, html, created_at) VALUES ('old', 'Old', '<input type=\"checkbox\" checked> done <input type=\"checkbox\"> todo', ?)", deps.clock.now());
  expect(getPage(deps.db, "old")!.html).toContain('data-i="0" checked> done <input type="checkbox" data-i="1"> todo');
  expect(recentPages(deps.db, deps.clock.now())[0]).toMatchObject({ ticked: 1, total: 2, left: ["todo"], editable: false });
  expect(ps(deps.db, "old", 1, true)).toBe(true);
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[0,1]" }]); // the first tick keeps the old mark
});

const tickedLabels = (deps: ReturnType<typeof mk>["deps"], id: string) => [...getPage(deps.db, id)!.html.matchAll(/data-i="\d+"( checked)?> ([a-z]+)/g)].filter((m) => m[1]).map((m) => m[2]);

test("buildPage with a page_id updates in place: same id and link, new content and source, updated_at bumped; unknown or source-less id is an error", async () => {
  const { llm, deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  llm.next("## Pack\n\n- [ ] only");
  expect(await buildPage(deps, "Pack2", "drop two", id)).toEqual({ url: `https://wapp-agent.test/p/abc/${id}`, title: "Pack2" });
  expect(deps.db.all("SELECT 1 FROM pages")).toHaveLength(1);
  expect(deps.db.all("SELECT title, state, source, updated_at FROM pages WHERE id=?", id)[0]).toMatchObject({ title: "Pack2", state: "[]", source: "## Pack\n\n- [ ] only", updated_at: deps.clock.now() });
  expect(JSON.stringify(llm.textCalls.at(-1))).toContain("current page");
  expect(await buildPage(deps, "T", "b", "nope")).toEqual({ error: expect.stringContaining("no page") });
  deps.db.run("UPDATE pages SET source=NULL WHERE id=?", id);
  expect(await buildPage(deps, "T", "b", id)).toEqual({ error: expect.stringContaining("before edits") });
});

test("ticks follow items across an edit: the model sees the real ticks, insert at top and removal keep the right boxes ticked", async () => {
  const { llm, deps } = mk("- [ ] a\n- [ ] b\n- [ ] c");
  const id = idOf(await buildPage(deps, "L", "b"));
  ps(deps.db, id, 1, true);
  llm.next("- [ ] passport\n- [ ] a\n- [x] b\n- [ ] c"); // a model that keeps b's mark
  await buildPage(deps, "L", "add passport at the top", id);
  expect(JSON.stringify(llm.textCalls.at(-1))).toContain("- [ ] a\\n- [x] b\\n- [ ] c"); // it was shown the stored tick
  expect(tickedLabels(deps, id)).toEqual(["b"]);
  llm.next("- [ ] passport\n- [x] b\n- [ ] c"); // a removed: b stays ticked
  await buildPage(deps, "L", "drop a", id);
  expect(tickedLabels(deps, id)).toEqual(["b"]);
  llm.next("- [ ] passport\n- [ ] c"); // the ticked item itself removed
  await buildPage(deps, "L", "drop b", id);
  expect(tickedLabels(deps, id)).toEqual([]);
});

test("the daily cap counts page-model calls: ten edits of one page exhaust it, the oldest ages out after 24 h", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "P", "b"));
  for (let i = 0; i < 8; i++) await buildPage(deps, "P", "b", id);
  expect(pagesLeftToday(deps.db, deps.clock.now())).toBe(true); // 9 calls
  await buildPage(deps, "P", "b", id);
  expect(pagesLeftToday(deps.db, deps.clock.now())).toBe(false); // the 10th used it up
  expect(pagesLeftToday(deps.db, deps.clock.now() + 86_400_001)).toBe(true);
});

test("setPageState ignores a save whose seq is not above the box's last one, per box; a bad seq is rejected", async () => {
  const { deps } = mk(BOXES);
  const id = idOf(await buildPage(deps, "Pack", "b"));
  const st = () => (deps.db.all("SELECT state FROM pages")[0] as { state: string }).state;
  expect(setPageState(deps.db, id, 0, true, 5)).toBe(true);
  expect(setPageState(deps.db, id, 0, false, 4)).toBe(true); // a late, older save: accepted as a request, not applied
  expect(setPageState(deps.db, id, 0, false, 5)).toBe(true); // equal is not greater
  expect(st()).toBe("[0,1]");
  expect(setPageState(deps.db, id, 2, true, 1)).toBe(true); // another box has its own counter
  expect(st()).toBe("[0,1,2]");
  expect(setPageState(deps.db, id, 0, false, 6)).toBe(true);
  expect(st()).toBe("[1,2]");
  for (const q of [-1, 1.5, NaN, Infinity, "3", undefined]) expect(setPageState(deps.db, id, 1, false, q as number)).toBe(false);
  expect(st()).toBe("[1,2]");
});

test("recentPages 'left' labels decode numeric and named entities, once", async () => {
  const { deps } = mk("- [ ] it's &amp; \"q\" <b>\n- [ ] a&nbsp;b &#x27;x&#39; &amp;lt;");
  await buildPage(deps, "E", "b");
  expect(recentPages(deps.db, deps.clock.now())[0].left).toEqual(["it's & \"q\" <b>", "a b 'x' &lt;"]);
});

test("HTML-fragment source keeps a tick across an edit (no markers to rewrite: ticks carry by position)", async () => {
  const frag = (n: number) => Array.from({ length: n }, (_, i) => `<ul><li><input type="checkbox"> item${i}</li></ul>`).join("");
  const { llm, deps } = mk(frag(3));
  const id = idOf(await buildPage(deps, "H", "b"));
  ps(deps.db, id, 1, true);
  llm.next(frag(3));
  await buildPage(deps, "H", "tweak", id);
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[1]" }]);
  llm.next(frag(2)); // fewer boxes: ticks beyond the end drop
  await buildPage(deps, "H", "shorter", id);
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[1]" }]);
});

test("a blockquoted task item counts as a marker and an empty '- [ ]' item does not, so neither shifts ticks", async () => {
  const src = "- [ ] a\n> - [ ] quoted\n- [ ]\n- [ ] c";
  const { llm, deps } = mk(src);
  const id = idOf(await buildPage(deps, "Q", "b"));
  expect(getPage(deps.db, id)!.html.match(/ data-i="/g)).toHaveLength(3); // a, quoted, c
  ps(deps.db, id, 2, true); // c
  llm.next(src.replace("[ ] c", "[x] c")); // a model that keeps the mark it was shown
  await buildPage(deps, "Q", "same", id);
  expect(JSON.stringify(llm.textCalls.at(-1))).toContain("- [ ] a\\n> - [ ] quoted\\n- [ ]\\n- [x] c");
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[2]" }]);
});

test("when markers and boxes disagree (a marker inside a code fence) the source is shown as stored and ticks carry by position", async () => {
  const src = "```\n- [ ] not a box\n```\n\n- [ ] a\n- [ ] b";
  const { llm, deps } = mk(src);
  const id = idOf(await buildPage(deps, "F", "b"));
  ps(deps.db, id, 1, true);
  llm.next("- [ ] a\n- [ ] b\n- [ ] c");
  await buildPage(deps, "F", "add c", id);
  expect(JSON.stringify(llm.textCalls.at(-1))).toContain("```\\n- [ ] not a box\\n```\\n\\n- [ ] a\\n- [ ] b"); // untouched
  expect(deps.db.all("SELECT state FROM pages")).toEqual([{ state: "[1]" }]);
});

test("the fence strip removes a fence around the whole output only, never a leading code block of a real page", async () => {
  const wrapped = mk("```markdown\n# T\n\n- [ ] a\n```");
  await buildPage(wrapped.deps, "T", "b");
  expect((wrapped.deps.db.all("SELECT source FROM pages")[0] as { source: string }).source).toBe("# T\n\n- [ ] a");
  const code = "```js\nlet x = 1;\n```\n\nthen text";
  const real = mk(code);
  await buildPage(real.deps, "T", "b");
  expect((real.deps.db.all("SELECT source FROM pages")[0] as { source: string }).source).toBe(code);
});

// ---- phase 1: read-only powers ----

test("details and summary: bare, with open kept on details, from raw Markdown or a fragment; attributes, other raw tags and stray text stay refused", () => {
  const html = render("## Day 1\n\n<details>\n<summary>Morning</summary>\n\n- museum\n\n**bold** text\n\n</details>\n\n<details open><summary>Open</summary>\n\nx\n\n</details>");
  expect(html).toMatch(/<details>\s*<summary>Morning<\/summary>\s*<ul>\s*<li>museum<\/li>\s*<\/ul>\s*<p><strong>bold<\/strong> text<\/p>\s*<\/details>/);
  expect(html).toContain("<details open><summary>Open</summary>");
  const bad = render('<details onclick="x()" class="a"><summary style="color:red">T</summary><p>x</p></details><details><script>x()</script><b>no</b></details>');
  expect(bad).toBe("<details><summary>T</summary><p>x</p></details><details><b>no</b></details>");
  const md = render('# x\n\n<details class="a">\n<summary onclick="x()">T</summary>\n\n</details>\n\n<div>raw</div>');
  expect(md).not.toMatch(/<(details|summary|div)[^>]*(class|onclick)/);
  expect(md).toContain("&lt;details class=");
  expect(md).toContain("&lt;div&gt;raw");
});

test("h2 and h3 get stable slug ids, repeats are de-duplicated, h1 and h4 stay bare; a generated id never collides with a heading that already has that text", () => {
  const html = render("# Top\n\n## Food & Drink\n\n### Food & Drink\n\n## Food & Drink\n\n## Food Drink 2\n\n## Food & drink 2\n\n#### Deep\n\n## ünï ✓");
  expect(html.match(/<h[1-6][^>]*>/g)).toEqual(['<h1>', '<h2 id="food-drink">', '<h3 id="food-drink-2">', '<h2 id="food-drink-3">', '<h2 id="food-drink-2-2">', '<h2 id="food-drink-2-3">', '<h4>', '<h2 id="ünï">']);
  expect(render("## **Bold** `code`")).toBe('<h2 id="bold-code"><strong>Bold</strong> <code>code</code></h2>\n');
});

test("contents: 4 or more h2/h3 add a plain Contents list of anchors before the first of them; 3 do not", () => {
  const sec = (n: number) => Array.from({ length: n }, (_, i) => `## Part ${i + 1}\n\ntext`).join("\n\n");
  const four = wrap("T", render(sec(4)));
  expect(four).toMatch(/<main>\n<nav><strong>Contents<\/strong><ul><li><a href="#part-1">Part 1<\/a><\/li>[\s\S]*<a href="#part-4">Part 4<\/a><\/li><\/ul><\/nav>\n?<h2 id="part-1">/);
  expect(wrap("T", render(sec(3)))).not.toContain("<nav>");
  const withH1 = wrap("T", render("# Mine\n\n" + sec(4)));
  expect(withH1.indexOf("</h1>")).toBeLessThan(withH1.indexOf("<nav>")); // after the title
  expect(withH1.indexOf("<nav>")).toBeLessThan(withH1.indexOf('<h2 id="part-1">'));
  expect(wrap("T", render("## A & $& <b>\n\n## b\n\n### c\n\n## d"))).toContain('<a href="#a-b">A &amp; $&amp; &lt;b&gt;</a>'); // text escaped, no replacement patterns
});

test("progress: a page with checkboxes says 'n of m done' above the first checklist only", async () => {
  const { deps } = mk("## Pack\n\n- [ ] a\n- [x] b\n\n## More\n\n- [ ] c");
  const id = idOf(await buildPage(deps, "Pack", "b"));
  let html = getPage(deps.db, id)!.html;
  expect(html).toContain('<p class="progress">1 of 3 done</p><ul>');
  expect(html.match(/class="progress"/g)).toHaveLength(1);
  ps(deps.db, id, 0, true);
  expect(getPage(deps.db, id)!.html).toContain("2 of 3 done");
  expect(getPage(mk("# x").deps.db, "nope")).toBeNull();
  const none = mk("# no boxes");
  expect(getPage(none.deps.db, idOf(await buildPage(none.deps, "T", "b")))!.html).not.toContain('class="progress"');
  html = getPage(deps.db, id)!.html;
  expect(TEMPLATE_CSS).toContain("li:has(> input[type=checkbox]:checked) { text-decoration: line-through; }");
});

test("footnotes: [^1] becomes a numbered link, definitions a numbered list with back-links, numbered by first use; unknown refs, unused notes and code stay as text", () => {
  const html = render("Fact[^b] and more[^a], again[^b], gone[^zz], `code [^a]`.\n\n[^a]: Note **A** <script>x()</script>\n[^b]: Note B\n[^unused]: never");
  expect(html).toContain('Fact<sup><a href="#fn-1" id="fnref-1">1</a></sup> and more<sup><a href="#fn-2" id="fnref-2">2</a></sup>, again<sup><a href="#fn-1">1</a></sup>, gone[^zz], <code>code [^a]</code>.');
  expect(html).toMatch(/<section class="footnotes"><ol><li id="fn-1">Note B <a href="#fnref-1">back<\/a><\/li><li id="fn-2">Note <strong>A<\/strong> [^<]*<a href="#fnref-2">back<\/a><\/li><\/ol><\/section>/);
  expect(html).not.toMatch(/<script|never|\[\^[ab]\]:/);
  expect(render("no notes[^1]")).toBe("<p>no notes[^1]</p>\n");
  expect(render("a[^1]\n\n[^1]: [^1] self")).not.toMatch(/|/);
});

test("the print block hides controls, avoids breaks inside tables and items, and needs no network font", () => {
  const print = /@media print \{([\s\S]*?)\n\}/.exec(TEMPLATE_CSS)![1];
  expect(print).toMatch(/\.copy, \.filter[^{]*\{ display: none; \}/);
  expect(print).toMatch(/table, tr, li[^{]*\{ break-inside: avoid; \}/);
  expect(print).toMatch(/color: black/);
  expect(print).not.toMatch(/googleapis|Iceland/);
});

test("the served script is the exact text the CSP hash covers and has no template placeholder or closing tag in it", async () => {
  const { deps } = mk("## x");
  const html = getPage(deps.db, idOf(await buildPage(deps, "T", "b")))!.html;
  expect(html).toContain(`<script>${PAGE_SCRIPT}</script>`);
  expect(PAGE_SCRIPT).not.toMatch(/<\/script|\$\{/i);
  expect(() => new Function(PAGE_SCRIPT)).not.toThrow(); // compiles
});
