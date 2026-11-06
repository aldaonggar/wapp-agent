import { expect, test } from "vitest";
import { FakeClock, FakeWa, makeEvalDeps, stubLlm } from "../../evals/harness";
import { MAX_EDITS_PER_HOUR, editPage, pageChanges, type Op } from "./page-edit";
import { checkValue, fieldSource, fillFields, scanFields } from "./page-fields";
import { buildPage, getPage, recentPages, render, setPageState } from "./pages";

const SRC = "## Trip\n\nBudget: [field: Budget] and [count: Nights]\n\n[text: Notes]\n\nHotel: [choice: Hotel | Ibis | Marriott | Hostel]\n\n[multi: Extras | Pool, Spa | Gym]\n\n## Packing\n\n- [ ] socks\n- [x] charger\n\n## Ideas\n\n- [ ] museum\n- [ ] beach";
const mk = (first = SRC) => {
  let text = first;
  const llm = Object.assign(stubLlm({ text: (c) => (typeof text === "function" ? (text as (c: unknown) => string)(c) : text) }), { next: (t: string) => { text = t; } });
  const clock = new FakeClock();
  return { llm, clock, deps: makeEvalDeps({ clock: clock.forContact("a"), wa: new FakeWa(clock), llm, contactKey: "abc" }) };
};
const idOf = (r: unknown) => (r as { url: string }).url.split("/").pop()!;
let seq = 0;
const edit = (t: ReturnType<typeof mk>, id: string, op: Op, rev?: number) => editPage(t.deps.db, t.clock.t, id, op, ++seq, rev);
const row = (t: ReturnType<typeof mk>) => t.deps.db.all<{ source: string; html: string; state: string; fields: string; rev: number }>("SELECT source, html, state, fields, rev FROM pages")[0];
const made = async (src = SRC) => { const t = mk(src); return { t, id: idOf(await buildPage(t.deps, "Trip", "b")) }; };

test("field syntax round trips any text: escapes for \\ ] | = , and newlines, empty value omitted, same labels get distinct keys, code stays text", () => {
  const f = scanFields("a [field: Name = Ana] [field: Name] [multi: Pick = A\\, B, C | A, B | C] [count: N = 3]\n`[field: in code]`\n```\n[field: fenced]\n```\n[choice: Hotel = Ibis | Ibis | Marriott]");
  expect(f.map((x) => [x.kind, x.key, x.value])).toEqual([["field", "name:0", "Ana"], ["field", "name:1", null], ["multi", "pick:0", ["A, B", "C"]], ["count", "n:0", "3"], ["choice", "hotel:0", "Ibis"]]);
  expect(f[2].options).toEqual(["A, B", "C"]);
  const nasty = { kind: "text" as const, label: "a = b | c ] d", options: [], value: "x\\y ] | = , \n z" };
  const [back] = scanFields(fieldSource(nasty));
  expect(back).toMatchObject({ kind: "text", label: nasty.label, value: nasty.value });
  expect(fieldSource({ kind: "choice", label: "H", options: ["A", "B"], value: "B" })).toBe("[choice: H = B | A | B]");
  expect(fieldSource({ kind: "multi", label: "E", options: ["A", "B"], value: ["A", "B"] })).toBe("[multi: E = A, B | A | B]");
  expect(fieldSource({ kind: "count", label: "N", options: [], value: null })).toBe("[count: N]");
  expect(scanFields("[field: no close\n[field: x]")).toHaveLength(1);
});

test("checkValue: choices must be options, counts whole numbers 0..9999, text at most 2000 characters, multi a subset", () => {
  const choice = { kind: "choice" as const, options: ["A", "B"] }, count = { kind: "count" as const, options: [] }, text = { kind: "text" as const, options: [] }, multi = { kind: "multi" as const, options: ["A", "B"] };
  expect([checkValue(choice, "B"), checkValue(choice, "C"), checkValue(choice, 1)]).toEqual(["B", undefined, undefined]);
  expect([checkValue(count, "0"), checkValue(count, 9999), checkValue(count, "10000"), checkValue(count, "-1"), checkValue(count, "1.5"), checkValue(count, "abc"), checkValue(count, "007")]).toEqual(["0", "9999", undefined, undefined, undefined, undefined, "7"]);
  expect([checkValue(text, "x".repeat(2000))!.length, checkValue(text, "x".repeat(2001)), checkValue({ ...text, kind: "field" }, " a \n b ")]).toEqual([2000, undefined, "a b"]);
  expect([checkValue(multi, ["A"]), checkValue(multi, ["A", "A", "B"]), checkValue(multi, ["C"]), checkValue(multi, "A"), checkValue(multi, [])]).toEqual([["A"], ["A", "B"], undefined, undefined, []]);
});

test("render: every field kind becomes inputs from our own markup; the model's text cannot forge one; fields are not tick boxes", () => {
  const html = render(SRC);
  expect(html).toContain('<input data-f="budget:0" type="text" maxlength="2000" value="">');
  expect(html).toContain('<textarea data-f="notes:0" rows="3" maxlength="2000"></textarea>');
  expect(html).toContain('<input data-f="hotel:0" type="radio" name="hotel:0" value="Marriott">');
  expect(html).toContain('<input data-f="extras:0" type="checkbox" value="Pool, Spa">');
  expect(html).toMatch(/<output>0<\/output>/);
  expect(html.match(/<input type="checkbox"(?: checked)?>/g)).toHaveLength(4); // the task boxes only
  expect(render("[field: A = x\"><script>1</script>]")).toContain('value="x&quot;&gt;&lt;script&gt;1&lt;/script&gt;"');
  expect(render("[choice: H = Marriott | Ibis | Marriott]\n\nforged 0 9")).toContain('value="Marriott" checked');
  expect(render("[choice: H = Marriott | Ibis | Marriott]\n\nforged 0 9")).not.toMatch(/[\uE002-\uE007]/);
});

test("editPage field: the value is written into the source in the documented form and rendered; ticks stay; an older seq is ignored; bad values are 400", async () => {
  const { t, id } = await made();
  setPageState(t.deps.db, id, 0, true, 5);
  const set = (key: string, value: unknown, s = ++seq) => editPage(t.deps.db, t.clock.t, id, { field: { key, value } }, s);
  expect(set("budget:0", "400")).toEqual({ ok: true, rev: 0 });
  expect(set("nights:0", 3)).toMatchObject({ ok: true });
  expect(set("notes:0", "line one\nline two")).toMatchObject({ ok: true });
  expect(set("hotel:0", "Marriott")).toMatchObject({ ok: true });
  expect(set("extras:0", ["Pool, Spa", "Gym"])).toMatchObject({ ok: true });
  const r = row(t);
  expect(r.source).toContain("[field: Budget = 400] and [count: Nights = 3]");
  expect(r.source).toContain("[text: Notes = line one\\nline two]");
  expect(r.source).toContain("[choice: Hotel = Marriott | Ibis | Marriott | Hostel]");
  expect(r.source).toContain("[multi: Extras = Pool\\, Spa, Gym | Pool, Spa | Gym]");
  expect(JSON.parse(r.fields)).toEqual({ "budget:0": "400", "nights:0": "3", "notes:0": "line one\nline two", "hotel:0": "Marriott", "extras:0": ["Pool, Spa", "Gym"] });
  const html = getPage(t.deps.db, id)!.html;
  expect(html).toContain('value="400"');
  expect(html).toContain('<input data-f="hotel:0" type="radio" name="hotel:0" value="Marriott" checked>');
  expect(html).toContain("<output>3</output>");
  expect(html).toContain("line one\nline two</textarea>");
  expect(html).toContain('data-i="0" checked'); // the tick set before is still there
  expect(r.rev).toBe(0); // a field save does not change the page's shape
  expect(set("budget:0", "999", 1)).toEqual({ ok: true, rev: 0 }); // older than the last save of that field: acknowledged, not applied
  expect(row(t).source).toContain("Budget = 400");
  for (const [k, v] of [["nope:0", "x"], ["hotel:0", "Tent"], ["nights:0", 10000], ["nights:0", "-1"], ["budget:0", "x".repeat(2001)], ["extras:0", ["Sauna"]], ["budget:0", ["a"]]] as const) expect([k, set(k, v)]).toEqual([k, { ok: false, status: 400, error: expect.any(String) }]);
  expect(set("budget:0", "")).toMatchObject({ ok: true }); // clearing a text field writes no value
  expect(row(t).source).toContain("[field: Budget] and");
  const same = await made("[field: X = 1] [field: X = 2]");
  expect(editPage(same.t.deps.db, 0, same.id, { field: { key: "x:1", value: "9" } }, 1)).toMatchObject({ ok: true });
  expect(row(same.t).source).toBe("[field: X = 1] [field: X = 9]"); // two fields with one label stay distinct
});

test("editPage add, remove, note: edits to the source, rendered through the same pipeline; ticks follow their items", async () => {
  const { t, id } = await made();
  setPageState(t.deps.db, id, 2, true, 5); // museum
  let r = edit(t, id, { add: { list: 0, text: "  insurance\ncard " } });
  expect(r).toMatchObject({ ok: true, rev: 1, body: expect.stringContaining("insurance card") });
  expect(row(t).source).toContain("- [ ] socks\n- [x] charger\n- [ ] insurance card\n\n## Ideas");
  r = edit(t, id, { note: { list: 0, index: 0, text: "borrow Ana's" } });
  expect(row(t).source).toContain("- [ ] socks\n  - note: borrow Ana's\n- [x] charger");
  expect((r as { body: string }).body).toContain('<li class="note">borrow Ana&#39;s</li>');
  edit(t, id, { note: { list: 0, index: 0, text: "wool ones" } }); // replaces
  edit(t, id, { note: { list: 1, index: 1, text: "closed Mondays" } });
  expect(row(t).source).toMatch(/- \[ \] socks\n {2}- note: wool ones\n- \[x\] charger/);
  expect(row(t).source).toContain("- [ ] beach\n  - note: closed Mondays");
  edit(t, id, { note: { list: 0, index: 0, text: "" } }); // clears
  expect(row(t).source).not.toContain("wool");
  edit(t, id, { remove: { list: 0, index: 0 } }); // socks
  expect(row(t).source).toContain("## Packing\n\n- [x] charger\n- [ ] insurance card\n");
  const ticked = () => (JSON.parse(row(t).state) as number[]).map((i) => ["charger", "insurance", "museum", "beach"][i]);
  expect(ticked()).toEqual(["charger", "museum"]); // museum moved from box 2 to 3 with the add, then back to 2 with the remove
});

test("editPage errors: unknown page 404, no source, bad shapes, unknown list or item, over-long item and note, a page that would pass 64 KB", async () => {
  const { t, id } = await made();
  expect(edit(t, "nope", { add: { list: 0, text: "x" } })).toMatchObject({ ok: false, status: 404 });
  for (const op of [{ add: { list: 5, text: "x" } }, { add: { list: 0, text: "  " } }, { add: { list: 0, text: "x".repeat(201) } }, { add: { list: -1, text: "x" } }, { add: { list: 0, text: 5 } }, { remove: { list: 0, index: 9 } }, { remove: { list: 0 } }, { note: { list: 0, index: 0, text: "x".repeat(301) } }, { note: { list: 0, index: 7, text: "x" } }, {}, null, { zzz: 1 }] as unknown as Op[]) expect([JSON.stringify(op), edit(t, id, op)]).toEqual([JSON.stringify(op), { ok: false, status: 400, error: expect.any(String) }]);
  expect(edit(t, id, { add: { list: 0, text: "x".repeat(200) } })).toMatchObject({ ok: true });
  expect(editPage(t.deps.db, 0, id, { add: { list: 0, text: "x" } }, -1 as number)).toMatchObject({ ok: false, status: 400 });
  t.deps.db.run("UPDATE pages SET source=NULL");
  expect(edit(t, id, { add: { list: 0, text: "x" } })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("before edits") });
  const big = await made("## L\n\n- [ ] a\n\n" + "para\n\n".repeat(3500)); // about 50 KB rendered: items fit until 64 KB, then the edit is refused
  for (let i = 0; i < 100 && edit(big.t, big.id, { add: { list: 0, text: "y".repeat(200) } }).ok; i++);
  expect(edit(big.t, big.id, { add: { list: 0, text: "z".repeat(200) } })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("64 KB") });
});

test("editPage keeps the list numbering honest: a second list, an ordered list, a list inside a quote and a list with no boxes", async () => {
  const { t, id } = await made("- plain\n- bullets\n\n1. [ ] one\n2. [ ] two\n\n> - [ ] quoted\n\n- [ ] last");
  expect(edit(t, id, { add: { list: 0, text: "two and a half" } })).toMatchObject({ ok: true }); // list 0 is the ordered one: plain bullets are not a checklist
  expect(row(t).source).toBe("- plain\n- bullets\n\n1. [ ] one\n2. [ ] two\n1. [ ] two and a half\n\n> - [ ] quoted\n\n- [ ] last");
  expect(render(row(t).source).match(/class="add" data-list="(\d)"/g)).toEqual(['class="add" data-list="0"', 'class="add" data-list="1"']); // the quote's list gets none
  expect(edit(t, id, { remove: { list: 1, index: 0 } })).toMatchObject({ ok: true });
  expect(row(t).source).toBe("- plain\n- bullets\n\n1. [ ] one\n2. [ ] two\n1. [ ] two and a half\n\n> - [ ] quoted\n\n");
  expect(edit(t, id, { add: { list: 1, text: "x" } })).toMatchObject({ ok: false, status: 400 }); // only one checklist is left
});

test("editPage ticks follow their items through add, remove and note, and a page whose ticks cannot be synced (a marker in a code fence) refuses structural edits but still takes field values", async () => {
  const { t, id } = await made("- [ ] a\n- [ ] b\n- [x] c\n  - [ ] c1\n- [ ] d");
  setPageState(t.deps.db, id, 4, true, 3); // d
  const names = () => [...getPage(t.deps.db, id)!.html.matchAll(/data-i="\d+"( checked)?> ([a-z0-9]+)/g)].filter((m) => m[1]).map((m) => m[2]);
  expect(names()).toEqual(["c", "d"]);
  edit(t, id, { remove: { list: 0, index: 1 } }); // b
  expect(names()).toEqual(["c", "d"]);
  edit(t, id, { remove: { list: 0, index: 1 } }); // c with its nested c1
  expect(names()).toEqual(["d"]);
  edit(t, id, { add: { list: 0, text: "e" } });
  edit(t, id, { note: { list: 0, index: 0, text: "n" } });
  expect(names()).toEqual(["d"]);
  expect(row(t).source).toBe("- [ ] a\n  - note: n\n- [x] d\n- [ ] e");
  const fenced = await made("```\n- [ ] sample\n```\n\n- [ ] a\n\n[field: F]");
  expect(edit(fenced.t, fenced.id, { add: { list: 0, text: "b" } })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("ticks") });
  expect(editPage(fenced.t.deps.db, 0, fenced.id, { field: { key: "f:0", value: "v" } }, 1)).toMatchObject({ ok: true });
});

test("rev: an edit or tick from a stale view is refused with the current body; a model edit and every structural edit bump it, a field save does not", async () => {
  const { t, id } = await made();
  expect(row(t).rev).toBe(0);
  expect(edit(t, id, { add: { list: 0, text: "x" } }, 0)).toMatchObject({ ok: true, rev: 1 });
  const stale = edit(t, id, { remove: { list: 0, index: 0 } }, 0);
  expect(stale).toMatchObject({ ok: false, status: 409, rev: 1, body: expect.stringContaining("<h2") });
  expect(row(t).source).toContain("- [ ] socks"); // not removed
  expect(setPageState(t.deps.db, id, 0, true, 50, 0)).toBe("stale");
  expect(setPageState(t.deps.db, id, 0, true, 50, 1)).toBe(true);
  expect(setPageState(t.deps.db, id, 0, true, 51)).toBe(true); // no rev: no check
  expect(getPage(t.deps.db, id)!.html).toContain('<main data-rev="1">');
  expect(getPage(t.deps.db, id)!.rev).toBe(1);
  await buildPage(t.deps, "Trip", "tweak", id);
  expect(row(t).rev).toBe(2);
});

test("the edit cap: 300 an hour per page, counted over the last hour, other pages unaffected", async () => {
  const { t, id } = await made();
  const other = idOf(await buildPage(t.deps, "Other", "b"));
  for (let i = 0; i < MAX_EDITS_PER_HOUR; i++) expect(editPage(t.deps.db, t.clock.t, id, { field: { key: "budget:0", value: "1" } }, i + 1)).toMatchObject({ ok: true });
  expect(editPage(t.deps.db, t.clock.t, id, { field: { key: "budget:0", value: "2" } }, 999)).toMatchObject({ ok: false, status: 429 });
  expect(editPage(t.deps.db, t.clock.t, other, { field: { key: "budget:0", value: "2" } }, 1)).toMatchObject({ ok: true });
  expect(editPage(t.deps.db, t.clock.t + 3_600_001, id, { field: { key: "budget:0", value: "2" } }, 999)).toMatchObject({ ok: true });
  expect(t.deps.db.all("SELECT 1 FROM page_edits WHERE page_id=?", id).length).toBeLessThan(5); // old rows are dropped
});

test("page_events: one line per change, a field typed twice is one line, oldest first, capped, nothing logged for ticks", async () => {
  const { t, id } = await made();
  edit(t, id, { field: { key: "budget:0", value: "300" } });
  edit(t, id, { add: { list: 0, text: "insurance card" } });
  edit(t, id, { field: { key: "budget:0", value: "400" } });
  edit(t, id, { note: { list: 0, index: 0, text: "borrow Ana's" } });
  edit(t, id, { remove: { list: 0, index: 1 } });
  edit(t, id, { field: { key: "hotel:0", value: "Ibis" } });
  setPageState(t.deps.db, id, 0, true, 80);
  expect(pageChanges(t.deps.db).lines).toEqual([
    'added "insurance card" to Trip', 'set Budget to "400" on Trip', 'noted "borrow Ana\'s" on "socks" in Trip', 'removed "charger" from Trip', 'set Hotel to "Ibis" on Trip',
  ]);
  for (let i = 0; i < 60; i++) edit(t, id, { note: { list: 0, index: 0, text: `n${i}` } });
  expect(t.deps.db.all("SELECT 1 FROM page_events")).toHaveLength(50);
  expect(pageChanges(t.deps.db).lines).toHaveLength(20);
});

test("a model edit keeps what people entered: values, added items and notes survive an edit that echoes the source it was sent, and a dropped value is put back", async () => {
  const echo = mk();
  const id = idOf(await buildPage(echo.deps, "Trip", "b"));
  (echo.llm as unknown as { next: (t: unknown) => void }).next((c: { messages: { content: string }[] }) => /Here is the current page[^\n]*\n([\s\S]*)\n\nApply these changes/.exec(c.messages[0].content)![1]);
  edit(echo, id, { field: { key: "budget:0", value: "400" } });
  edit(echo, id, { field: { key: "hotel:0", value: "Hostel" } });
  edit(echo, id, { add: { list: 0, text: "insurance card" } });
  edit(echo, id, { note: { list: 0, index: 0, text: "borrow Ana's" } });
  const before = row(echo).source;
  await buildPage(echo.deps, "Trip", "make the title longer", id);
  expect(row(echo).source).toBe(before);
  const sent = JSON.stringify(echo.llm.textCalls.at(-1)!.messages[0].content);
  expect(sent).toContain("[field: Budget = 400]");
  expect(sent).toContain("[choice: Hotel = Hostel | Ibis | Marriott | Hostel]");
  expect(sent).toContain("insurance card");
  expect(sent).toContain("note: borrow Ana's");
  expect(sent).toContain("keep all of that exactly");
  // a model that rewrites the page and forgets the values: the saved ones come back where the field still exists and still fits
  (echo.llm as unknown as { next: (t: unknown) => void }).next("## Trip\n\nBudget: [field: Budget]\n\n[choice: Hotel | Ibis | Marriott]\n\n[count: Guests]");
  await buildPage(echo.deps, "Trip", "rewrite", id);
  expect(row(echo).source).toBe("## Trip\n\nBudget: [field: Budget = 400]\n\n[choice: Hotel | Ibis | Marriott]\n\n[count: Guests]"); // Hostel is no longer an option
  expect(JSON.parse(row(echo).fields)).toEqual({ "budget:0": "400" });
  expect(fillFields("[field: A] [field: A = keep]", { "a:0": "x", "a:1": "y" })).toBe("[field: A = x] [field: A = keep]");
});

test("recentPages and the prompt carry field values and notes, compactly", async () => {
  const { t, id } = await made("## P\n\n- [ ] socks\n- [ ] tent\n\n[field: Budget] [count: Nights = 3] [multi: X = A | A | B]");
  edit(t, id, { note: { list: 0, index: 1, text: "borrow Ana's" } });
  edit(t, id, { field: { key: "budget:0", value: "400" } });
  const [p] = recentPages(t.deps.db, t.clock.t);
  expect(p).toMatchObject({ notes: ["tent → borrow Ana's"], fields: ["Budget = 400", "Nights = 3", "X = A"] });
  const { buildPrompt } = await import("./prompt");
  const sys = buildPrompt({ profile: "", memories: [], history: [], pending: [], nowLocal: "n", tz: "UTC", tzConfirmed: true, snapshots: [], pages: [p], pageChanges: ['added "insurance card" to P'] }).system[1].content as string;
  expect(sys).toContain(`- Trip (id ${id}, 0 of 2 ticked; left: socks, tent; notes: tent → borrow Ana's; fields: Budget = 400; Nights = 3; X = A)`.replace("Trip", "Trip"));
  expect(sys).toContain('since your last message they changed pages (on the page itself, not in chat):\n- added "insurance card" to P');
  expect(buildPrompt({ profile: "", memories: [], history: [], pending: [], nowLocal: "n", tz: "UTC", tzConfirmed: true, snapshots: [], pageChanges: [] }).system[1].content).not.toContain("since your last message");
});
