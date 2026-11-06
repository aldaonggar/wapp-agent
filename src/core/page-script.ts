// The one script any page runs (hash-allowed in the CSP, added at serve time): saves ticks, and adds sorting, filter boxes and copy buttons to what the page holds. Pure DOM, no libraries; String.raw keeps the regexes as written.
export const PAGE_SCRIPT = String.raw`const $ = (s, r = document) => [...r.querySelectorAll(s)];
const root = () => document.querySelector("main") || document.body;

// Saving: ticks, field values and list edits go to the page's own address, one request at a time and in order (keepalive, so a save just before closing still lands). The seq rises per target and across reloads, so the server drops a save older than one it has.
// rev is the page's version as loaded; a save for a page that has since changed shape comes back 409 with the current body, and an edit comes back with the new body. Either way the page body is swapped in without a reload.
const last = {};
const seqFor = (k) => last[k] = Math.max((last[k] || 0) + 1, Date.now());
let queue = Promise.resolve(), rev = (root().dataset || {}).rev;
// Unsaved typing in a field survives a body swap: it is put back and saved.
const show = (d) => {
  if (!d.html) return location.reload();
  const dirty = $(".f textarea, .f input[type=text]", root()).filter((x) => x.value !== x.defaultValue).map((x) => [x.closest(".f").dataset.f, x.value]);
  root().innerHTML = d.html;
  root().dataset.rev = rev = d.rev;
  enhance();
  dirty.forEach(([key, v]) => { const f = $(".f", root()).find((x) => x.dataset.f === key); if (f) { f.querySelector("textarea, input").value = v; field(f, v); } });
};
// The rev is the one the person's view had when they acted, not when the request goes out. Resolves true when the server took it.
const save = (key, body) => {
  const r = rev === undefined ? undefined : +rev, s = seqFor(key);
  return queue = queue.then(() => fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, seq: s, rev: r }), keepalive: true })
    .then((res) => res.status === 409 ? res.json().then((d) => (show(d), false)) : res.status === 200 ? res.json().then((d) => (d.html && show(d), true)) : res.ok)
    .catch(() => false));
};

// "n of m done" above the first checklist, kept live as boxes are ticked.
const progress = () => {
  const p = $(".progress")[0], b = $("input[data-i]");
  if (p) p.textContent = b.filter((c) => c.checked).length + " of " + b.length + " done";
};
// A field changed: send its whole value (the checked options for "multi"). A tick: send the box.
const field = (f, value) => save("f" + f.dataset.f, { op: { field: { key: f.dataset.f, value } } });
addEventListener("change", (e) => {
  const c = e.target, f = c.closest(".f");
  if (f) field(f, f.dataset.kind === "multi" ? $("input:checked", f).map((x) => x.value) : c.value);
  else if (c.matches("input[data-i]")) {
    progress();
    save("t" + c.dataset.i, { i: +c.dataset.i, checked: c.checked });
  }
});

// Checklists: where an item sits is its list's number (on the add box after the list) and its place among the list's items.
const where = (li) => ({ list: +li.parentNode.nextElementSibling.dataset.list, index: [...li.parentNode.children].indexOf(li) });
const addItem = (add) => {
  const i = add.querySelector("input"), text = i.value.trim();
  if (!text) return;
  i.value = "";
  save("l", { op: { add: { list: +add.dataset.list, text } } }).then((ok) => { // refused or stale: the typed text comes back
    if (!ok) { const box = $(".add input", root()).find((x) => x.closest(".add").dataset.list === add.dataset.list); if (box && !box.value) box.value = text; }
  });
};
const noteBox = (li) => {
  if (li.querySelector(":scope > input.note")) return;
  const old = li.querySelector(":scope > ul > li.note"), i = document.createElement("input");
  i.type = "text"; i.className = "note"; i.maxLength = 300; i.placeholder = "note"; i.setAttribute("aria-label", "note");
  i.value = old ? old.textContent : "";
  i.addEventListener("change", () => save("l", { op: { note: { ...where(li), text: i.value } } })); // Enter or leaving the box, only if it changed
  i.addEventListener("blur", () => i.remove());
  li.querySelector(":scope > .ctl").after(i);
  i.focus();
};

// Sorting: a click on a header sorts that column, again to reverse; numbers when every cell reads as one, else natural text order.
const NUM = /^[^\d\p{L}-]*-?\d[\d,]*(\.\d+)?[^\d]*$/u; // a letter before the digits ("A-1") makes it text
const sortBy = (th) => {
  const table = th.closest("table"), i = [...th.parentNode.children].indexOf(th);
  const down = th.getAttribute("aria-sort") === "ascending";
  $("th", table).forEach((h) => h.removeAttribute("aria-sort"));
  th.setAttribute("aria-sort", down ? "descending" : "ascending");
  const rows = [...table.rows].filter((r) => !r.querySelector("th")), cell = (r) => (r.cells[i] ? r.cells[i].textContent : "").trim();
  const numeric = rows.every((r) => !cell(r) || NUM.test(cell(r)));
  const key = (r) => numeric ? parseFloat(cell(r).replace(/[^\d.-]/g, "")) || 0 : cell(r);
  rows.sort((a, b) => (numeric ? key(a) - key(b) : key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: "base" })) * (down ? -1 : 1));
  rows.forEach((r) => r.parentNode.appendChild(r));
};
addEventListener("click", (e) => {
  const th = e.target.closest && e.target.closest("th");
  if (th && th.closest("table")) sortBy(th);
  const x = e.target.closest && e.target.closest("button");
  if (!x) return;
  const f = x.closest(".f"), li = x.closest("li");
  if (x.closest(".add")) addItem(x.closest(".add"));
  else if (f && x.dataset.d) { // the +/- stepper of a count, kept between 0 and 9999
    const o = f.querySelector("output"), n = Math.min(9999, Math.max(0, (+o.textContent || 0) + +x.dataset.d));
    o.textContent = n;
    field(f, String(n));
  } else if (x.dataset.act === "note") noteBox(li);
  else if (x.dataset.act === "remove") { // two taps: the first asks
    if (x.textContent !== "sure?") { x.textContent = "sure?"; setTimeout(() => x.textContent = "remove", 3000); return; }
    save("l", { op: { remove: where(li) } });
  }
  const b = x.matches("button.copy") && x;
  if (b) navigator.clipboard.writeText(b.previousElementSibling.textContent).then(() => {
    b.textContent = "copied";
    setTimeout(() => b.textContent = "copy", 1000);
  }).catch(() => {});
});
addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.matches("th")) sortBy(e.target);
  else if (e.target.matches(".add input")) addItem(e.target.closest(".add"));
});

// Run on load, and again after a body swap: item controls, a filter box above any table or list of more than 15 rows, a "copy" button after every code block and after inline code of 8+ characters.
const enhance = () => {
  $("th").forEach((th) => th.tabIndex = 0);
  $(".add", root()).forEach((add) => { // "note" and "remove" on each item of the list before an add box
    if (!add.previousElementSibling || !add.previousElementSibling.matches("ul, ol")) return;
    [...add.previousElementSibling.children].forEach((li) => {
      const c = document.createElement("span");
      c.className = "ctl";
      c.innerHTML = '<button type="button" data-act="note">note</button><button type="button" data-act="remove">remove</button>';
      li.insertBefore(c, li.querySelector(":scope > ul, :scope > ol"));
    });
  });
  $("table, ul, ol", root()).forEach((el) => {
    const rows = el.matches("table") ? [...el.rows].filter((r) => !r.querySelector("th")) : [...el.children].filter((c) => c.matches("li"));
    if (rows.length <= 15) return;
    const f = document.createElement("input");
    f.type = "text"; f.className = "filter"; f.placeholder = "filter"; f.setAttribute("enterkeyhint", "search");
    f.addEventListener("input", () => rows.forEach((r) => r.hidden = !r.textContent.toLowerCase().includes(f.value.trim().toLowerCase())));
    el.before(f);
  });
  $("pre, :not(pre, a) > code", root()).forEach((el) => {
    if (el.matches("code") && el.textContent.length < 8) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "copy"; b.textContent = "copy";
    el.after(b);
  });
};
enhance();`;
export const SCRIPT_HASH = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PAGE_SCRIPT)))));
