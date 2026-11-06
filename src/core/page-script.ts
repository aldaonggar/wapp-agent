// The one script any page runs (hash-allowed in the CSP, added at serve time): saves ticks, and adds sorting, filter boxes and copy buttons to what the page holds. Pure DOM, no libraries; String.raw keeps the regexes as written.
export const PAGE_SCRIPT = String.raw`const $ = (s, r = document) => [...r.querySelectorAll(s)];
const root = () => document.querySelector("main") || document.body;

// Saving: ticks, one request at a time and in order, keepalive so a tick just before closing still lands. The seq rises per target and across reloads, so the server drops a save older than one it has.
const last = {};
const seqFor = (k) => last[k] = Math.max((last[k] || 0) + 1, Date.now());
let queue = Promise.resolve();
const save = (key, body) => queue = queue.then(() => fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, seq: seqFor(key) }), keepalive: true }).catch(() => {}));

// "n of m done" above the first checklist, kept live as boxes are ticked.
const progress = () => {
  const p = $(".progress")[0], b = $("input[data-i]");
  if (p) p.textContent = b.filter((c) => c.checked).length + " of " + b.length + " done";
};
addEventListener("change", (e) => {
  const c = e.target;
  if (!c.matches("input[data-i]")) return;
  progress();
  save("t" + c.dataset.i, { i: +c.dataset.i, checked: c.checked });
});

// Sorting: a click on a header sorts that column, again to reverse; numbers when every cell reads as one, else natural text order.
const NUM = /^[^\d-]*-?\d[\d,]*(\.\d+)?[^\d]*$/;
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
  const b = e.target.closest && e.target.closest("button.copy");
  if (b) navigator.clipboard.writeText(b.previousElementSibling.textContent).then(() => {
    b.textContent = "copied";
    setTimeout(() => b.textContent = "copy", 1000);
  }).catch(() => {});
});
addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches && e.target.matches("th")) sortBy(e.target); });

// Run on load: a filter box above any table or list of more than 15 rows, a "copy" button after every code block and after inline code of 8+ characters.
const enhance = () => {
  $("th").forEach((th) => th.tabIndex = 0);
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
