// The shared console parts (docs/plans/phase-2.md "Line 0" §5-§6).
//   pnpm test:console-kit
// No browser, no network. Each part in components/kit/ is compiled with
// Next's SWC (real radix-ui, react and next/link) and rendered with
// renderToStaticMarkup:
//   1. PageHeader: title, description, breadcrumb (links marked as reads,
//      the current page unlinked), actions
//   2. StatusBadge: every kind's words and tones; an unknown state reads
//      "Unknown", never the raw code; offerState from enabled and the window
//   3. EmptyState: the sentence, the description, the action
//   4. MoneyCell: formatMoney, mono, tabular, right-aligned; a dash for none
//   5. RoleGate for every role (support, the least-trusted, first): allowed →
//      the control untouched; not allowed → hidden (mode "hide") or
//      aria-disabled with the reason in a tooltip, its clicks and Enter/Space
//      swallowed before the control's own handler
//   6. DataTable: columns, rows in the server's order, the row link, the row
//      actions slot, skeleton rows, the empty state, the sticky header, 40px
//      rows (48px on touch), truncation with a tooltip, sortable headers from
//      props (aria-sort), and the footer ("1–50 of N", Previous/Next or
//      "Load more")
//   7. components/kit imports only components/ui, lib/ and its own folder
//      (no old components/console or components/admin part)
//   8. data-read-control: never on a submit button or inside a form that is
//      not method="get"; outside components/kit/ only in a file with a reasoned
//      row in scripts/support/read-controls.js
//      (a submit or image type, a dynamic type, a spread, form=/formAction
//      are unsafe too)
//   9. every <RoleGate> in app/ and components/ wraps a child that forwards
//      onClick and aria-disabled (<button>, <a>, Button, Link); the string
//      data-role-gate appears nowhere but components/kit/role-gate.js (a fake
//      gate would pass support's stray-control rule)
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

const KIT = "components/kit";
const PARTS = ["page-header", "status-badge", "empty-state", "money-cell", "role-gate", "data-table"];

// Next's SWC compiles components/kit, components/ui and lib/ (CommonJS out);
// packages come from node_modules
const swc = require("next/dist/build/swc/index.js");
let swcReady = null;
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const cache = new Map();
const resolveLocal = (id) => {
  const rel = id.slice(2);
  for (const c of [`${rel}.js`, rel]) {
    try {
      readFileSync(join(ROOT, c));
      return c;
    } catch {}
  }
  throw new Error(`cannot resolve ${id}`);
};
const load = async (rel) => {
  await (swcReady ??= swc.loadBindings());
  const file = join(ROOT, rel);
  if (cache.has(file)) return cache.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (/^@\/(components\/(ui|kit)|lib)\//.test(id)) deps.set(id, await load(resolveLocal(id)));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
};

const h = React.createElement;
const [PH, SB, ES, MC, RG, DT] = await Promise.all(PARTS.map((p) => load(`${KIT}/${p}.js`)));
const { TooltipProvider } = await load("components/ui/tooltip.js");
const { ROLES, ACTIONS, roleAllows, isWriteAction } = await import("../lib/platform/authz.js");
const { formatMoney } = await import("../lib/format.js");
const html = (el) => renderToStaticMarkup(h(TooltipProvider, null, el));
// the opening tag of the element with this attribute
const tag = (s, attr) => (s.match(new RegExp(`<[a-z]+\\b[^>]*${attr}[^>]*>`)) || [""])[0];

// ---------- 1. PageHeader ----------
await t("PageHeader: title, description, breadcrumb (reads, the current page unlinked), actions", () => {
  const s = html(h(PH.PageHeader, { title: "Orders", description: "Every order from your storefront.", breadcrumb: [{ label: "Home", href: "/admin/dashboard" }, { label: "Orders", href: "/admin/orders" }], actions: h("button", { id: "act" }, "Export") }));
  ok(/<h1 [^>]*font-semibold[^>]*>Orders<\/h1>/.test(s), "the title is the h1, weight 600:");
  ok(s.includes("Every order from your storefront."), "the description:");
  ok(/<nav aria-label="Breadcrumb">/.test(s), "the breadcrumb nav:");
  ok(/<a href="\/admin\/dashboard" data-read-control="true"/.test(s), "a parent crumb is a link marked as a read:");
  ok(!s.includes('href="/admin/orders"') && /<span aria-current="page">Orders<\/span>/.test(s), "the current crumb is plain text with aria-current:");
  ok(/data-kit="page-actions"[^>]*>\s*<button id="act">Export<\/button>/.test(s), "the actions slot:");
  const bare = html(h(PH.PageHeader, { title: "Media" }));
  ok(!bare.includes("Breadcrumb") && !bare.includes("page-actions") && !bare.includes("<p"), "no breadcrumb, description or actions when none are given:");
});

// ---------- 2. StatusBadge ----------
await t("StatusBadge: every kind's plain words and tones; unknown reads \"Unknown\"; offerState", () => {
  const TONES = ["success", "warning", "danger", "info", "muted"];
  eq(Object.keys(SB.STATUS_WORDS), ["order", "offer", "bundle", "media", "sync"], "the kinds:");
  for (const [kind, table] of Object.entries(SB.STATUS_WORDS)) {
    for (const [status, [label, tone]] of Object.entries(table)) {
      ok(TONES.includes(tone), `${kind}.${status} has a known tone:`);
      ok(/^[A-Z][a-z]/.test(label) && !label.includes("_"), `${kind}.${status} is a plain sentence-case word ("${label}"):`);
      const s = html(h(SB.StatusBadge, { kind, status }));
      ok(s.includes(`data-variant="${tone}"`) && s.includes(`data-status="${status}"`) && s.includes(`>${label}</span>`), `${kind}.${status} renders "${label}" in ${tone}:`);
    }
  }
  const unknown = html(h(SB.StatusBadge, { kind: "order", status: "weird_code" }));
  ok(unknown.includes(">Unknown</span>") && unknown.includes('data-variant="muted"') && !unknown.includes(">weird_code<"), "an unknown state reads Unknown, muted:");
  eq(html(h(SB.StatusBadge, { kind: "nope", status: "x" })).includes(">Unknown<"), true, "an unknown kind reads Unknown:");
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  eq([
    SB.offerState({ enabled: 0 }, now),
    SB.offerState({ enabled: 1 }, now),
    SB.offerState({ enabled: 1, starts_at: "2026-11-26T00:00:00.000Z" }, now),
    SB.offerState({ enabled: 1, ends_at: "2026-11-25T11:59:59.000Z" }, now),
    SB.offerState({ enabled: 1, starts_at: "2026-11-20T00:00:00.000Z", ends_at: "2026-11-30T00:00:00.000Z" }, now),
    SB.offerState({ enabled: 0, starts_at: "2026-11-26T00:00:00.000Z" }, now),
  ], ["off", "live", "scheduled", "ended", "live", "off"], "offerState:");
});

await t("StatusBadge covers every order status in lib/orders.js and every sync runState", () => {
  const orders = read("lib/orders.js");
  const statuses = [...orders.slice(orders.indexOf("export const ORDER_STATUS"), orders.indexOf("};", orders.indexOf("export const ORDER_STATUS"))).matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  ok(statuses.length >= 7, `found ${statuses.length} order statuses:`);
  eq(statuses.filter((s) => !SB.STATUS_WORDS.order[s]), [], "order statuses without words:");
  const sync = read("lib/admin/sync-view.js").match(/\/\/ (none \| running[^\n]*)/)[1].split(" | ").map((s) => s.trim());
  eq(sync.filter((s) => !SB.STATUS_WORDS.sync[s]), [], "sync states without words:");
});

// ---------- 3. EmptyState ----------
await t("EmptyState: the sentence, the description and the action", () => {
  const s = html(h(ES.EmptyState, { title: "No orders yet", description: "Orders show here once a shopper checks out.", action: h("a", { href: "/admin/onboarding", id: "next" }, "Finish setup") }));
  ok(s.includes('data-kit="empty-state"') && s.includes(">No orders yet</p>") && s.includes("Orders show here once a shopper checks out."), "the words:");
  ok(/<a href="\/admin\/onboarding" id="next">Finish setup<\/a>/.test(s), "the action:");
  ok(!html(h(ES.EmptyState, { title: "Nothing here" })).includes("<a "), "no action when none is given:");
});

// ---------- 4. MoneyCell ----------
await t("MoneyCell: formatMoney, mono, tabular, right-aligned; a dash for no amount", () => {
  for (const [amount, currency] of [[1499, "INR"], [1499.5, "INR"], [20, "USD"], [0, "INR"]]) {
    const s = html(h(MC.MoneyCell, { amount, currency }));
    ok(s.includes(`>${formatMoney(amount, currency)}</span>`), `${amount} ${currency} → ${formatMoney(amount, currency)}:`);
    ok(/class="[^"]*\btext-right\b[^"]*\bfont-mono\b[^"]*\btabular-nums\b/.test(s), `${amount}: mono, tabular, right-aligned:`);
  }
  for (const none of [null, "", undefined]) ok(html(h(MC.MoneyCell, { amount: none, currency: "INR" })).includes('aria-label="No amount">—'), `${JSON.stringify(none)} shows a dash:`);
  // no currency: a dash and a warning, never a guessed ₹
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  let s;
  try {
    s = html(h(MC.MoneyCell, { amount: 1499 }));
  } finally {
    console.warn = warn;
  }
  ok(s.includes('aria-label="No amount">—') && !s.includes("₹") && !s.includes("1,499"), "no currency: a dash, no amount:");
  eq(warned.length, 1, "no currency: one dev warning:");
  ok(!/currency\s*=\s*"/.test(read(`${KIT}/money-cell.js`)), "no default currency in the source:");
});

// ---------- 5. RoleGate ----------
const WRITE = "orders.push";
const READ = "orders.read";
await t("RoleGate, support (least-trusted): a write control is aria-disabled with the reason in a tooltip, or hidden; a read control is untouched", () => {
  ok(ACTIONS.includes(WRITE) && ACTIONS.includes(READ) && isWriteAction(WRITE), "the actions are real:");
  ok(!roleAllows("support", WRITE) && roleAllows("support", READ), "support may read orders, not write them:");
  const button = h("button", { type: "button", className: "px-3" }, "Push to Shopify");
  const s = html(h(RG.RoleGate, { role: "support", action: WRITE, reason: "Support access is read-only." }, button));
  const b = tag(s, 'data-role-gate="disabled"');
  ok(b.startsWith("<button") && b.includes('aria-disabled="true"') && !/\sdisabled=""/.test(b), "aria-disabled, not disabled (it stays focusable):");
  ok(b.includes('data-slot="tooltip-trigger"'), "the control is the tooltip's trigger:");
  ok(/class="px-3 cursor-not-allowed opacity-50"/.test(b), "its own classes kept, plus the disabled look:");
  ok(s.includes(">Push to Shopify</button>"), "the label stays:");
  ok(read(`${KIT}/role-gate.js`).includes("<TooltipContent>{reason}</TooltipContent>"), "the reason is the tooltip's content (portal content mounts only in a browser):");
  eq(html(h(RG.RoleGate, { role: "support", action: WRITE, reason: "Support access is read-only.", mode: "hide" }, button)), "", "mode hide: nothing renders:");
  eq(html(h(RG.RoleGate, { role: "support", action: READ, reason: "x" }, button)), '<button type="button" class="px-3">Push to Shopify</button>', "a read support may do: untouched:");
  const link = html(h(RG.RoleGate, { role: "support", action: "offers.write", reason: "Support access is read-only." }, h("a", { href: "/admin/offers/new", className: "x" }, "New offer")));
  const a = tag(link, 'data-role-gate="disabled"');
  ok(a.startsWith("<a") && !a.includes("href=") && a.includes('role="link"') && a.includes('tabindex="0"') && a.includes('aria-disabled="true"') && link.includes(">New offer</a>"), "a gated link loses its href, keeps role=link and a tab stop:");
  const kept = html(h(RG.RoleGate, { role: "support", action: "offers.write", reason: "x" }, h("a", { href: "/admin/offers/new", id: "new-offer", "aria-label": "Create an offer", "data-track": "new", onClick: () => {} }, "New")));
  const ka = tag(kept, 'data-role-gate="disabled"');
  ok(ka.includes('id="new-offer"') && ka.includes('aria-label="Create an offer"') && ka.includes('data-track="new"') && !ka.includes("href="), "a gated link keeps id, aria-label and data-*, drops href:");
  const { default: Link } = require("next/link");
  const nl = html(h(RG.RoleGate, { role: "support", action: "offers.write", reason: "Support access is read-only." }, h(Link, { href: "/admin/offers/new" }, "New offer")));
  ok(!nl.includes("href=") && nl.includes('role="link"'), "a gated next/link too:");
  const nlp = html(h(RG.RoleGate, { role: "support", action: "offers.write", reason: "x" }, h(Link, { href: "/admin/offers/new", prefetch: false, replace: true, id: "l1" }, "New")));
  ok(nlp.includes('id="l1"') && !/prefetch|replace=/.test(nlp), "next/link's own options are dropped, other props kept:");
  const own = RG.RoleGate({ role: "support", action: "offers.write", reason: "x", children: h("a", { href: "/x", onClick: () => { throw new Error("ran"); } }, "x") }).props.children[0].props.children;
  own.props.onClick({ preventDefault() {}, stopPropagation() {} });
});

await t("RoleGate swallows a gated control's click and Enter/Space before its own handler", () => {
  let fired = 0;
  const el = RG.RoleGate({ role: "support", action: WRITE, reason: "Support access is read-only.", children: h("button", { onClick: () => fired++ }, "Cancel order") });
  const gated = el.props.children[0].props.children;
  eq([gated.props["aria-disabled"], gated.props["data-role-gate"]], [true, "disabled"], "the gated props:");
  const ev = () => ({ prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });
  const click = ev();
  gated.props.onClick(click);
  eq([fired, click.prevented, click.stopped], [0, 1, 1], "a click: the handler never runs, the default and bubbling stop:");
  for (const key of ["Enter", " "]) {
    const k = { ...ev(), key };
    gated.props.onKeyDown(k);
    eq(k.prevented, 1, `${JSON.stringify(key)} is swallowed:`);
  }
  const tab = { ...ev(), key: "Tab" };
  gated.props.onKeyDown(tab);
  eq(tab.prevented, 0, "Tab still moves focus:");
});

await t("RoleGate for every role and every action: gated exactly when roleAllows says no; allowed controls are the same element", () => {
  ok(ROLES.includes("support"), "support is a role:");
  const roles = ["support", ...ROLES.filter((r) => r !== "support")];
  const child = h("button", { type: "button" }, "Do it");
  for (const role of roles) {
    for (const action of ACTIONS) {
      const el = RG.RoleGate({ role, action, reason: "Not for this role.", children: child });
      if (roleAllows(role, action)) eq(el === child, true, `${role} ${action}: untouched:`);
      else ok(el && el.props.children[0].props.children.props["aria-disabled"] === true, `${role} ${action}: gated:`);
      eq(RG.RoleGate({ role, action, reason: "x", mode: "hide", children: child }) === null, !roleAllows(role, action), `${role} ${action}: hide mode:`);
    }
  }
  eq(RG.RoleGate({ role: undefined, action: READ, reason: "x", mode: "hide", children: child }), null, "no role: hidden:");
});

// ---------- 6. DataTable ----------
const COLUMNS = [
  { key: "number", header: "Order", sortable: true },
  { key: "customer", header: "Customer", truncate: true },
  { key: "status", header: "Status", cell: (r) => h(SB.StatusBadge, { kind: "order", status: r.status }) },
  { key: "total", header: "Total", align: "right", sortable: true, cell: (r) => h(MC.MoneyCell, { amount: r.total, currency: "INR" }) },
];
const ROWS = [
  { id: "ord_b", number: "PAV-1002", customer: "A very long customer name that needs truncating", status: "synced", total: 2499 },
  { id: "ord_a", number: "PAV-1001", customer: "Asha", status: "sync_failed", total: 999 },
];
await t("DataTable: columns, rows in the server's order, the row link, the row actions slot, sticky header, 40px/48px rows", () => {
  const s = html(h(DT.DataTable, { columns: COLUMNS, rows: ROWS, rowHref: (r) => `/admin/orders/${r.id}`, rowActions: (r) => h("button", { "data-act": r.id }, "More"), label: "Orders" }));
  ok(/<table [^>]*aria-label="Orders"/.test(s), "the accessible name:");
  eq([...s.matchAll(/<th [^>]*>(?:<button[^>]*>)?([^<]+)/g)].map((m) => m[1]), ["Order", "Customer", "Status", "Total"], "the headers (and none for actions but sr-only):");
  ok(s.includes('<span class="sr-only">Actions</span>'), "the actions column is named for screen readers:");
  ok(s.indexOf("PAV-1002") < s.indexOf("PAV-1001"), "rows keep the server's order (no client sort):");
  ok(/<a [^>]*href="\/admin\/orders\/ord_b"[^>]*data-read-control="true"[^>]*>PAV-1002<\/a>|<a [^>]*data-read-control="true"[^>]*href="\/admin\/orders\/ord_b"[^>]*>PAV-1002<\/a>/.test(s), "the first column links to the row's page, marked as a read:");
  eq((s.match(/<a /g) || []).length, 2, "one link per row:");
  ok(s.includes('data-act="ord_b"') && s.includes('data-act="ord_a"'), "the row actions slot per row:");
  ok(s.includes(">In Shopify</span>") && s.includes(">Shopify push failed</span>") && s.includes(`>${formatMoney(2499, "INR")}</span>`), "custom cells render:");
  ok(/<thead [^>]*class="[^"]*\bsticky\b[^"]*\btop-0\b/.test(s), "the header is sticky:");
  ok(/data-slot="table-container" class="[^"]*\bmax-h-\[calc\(100dvh-14rem\)\][^"]*\boverflow-auto\b/.test(s), "inside a height-capped scroll box:");
  const rows = [...s.matchAll(/<tr [^>]*data-slot="table-row"[^>]*>/g)].slice(1);
  ok(rows.length === 2 && rows.every((r) => /\bh-10\b/.test(r) && /\bpointer-coarse:h-12\b/.test(r)), "body rows are 40px, 48px on touch:");
  ok(/<th [^>]*class="[^"]*\btext-right\b/.test(s) && /<td [^>]*class="[^"]*\btext-right\b/.test(s), "a right-aligned column:");
  const cell = tag(s, 'data-slot="tooltip-trigger"');
  ok(cell.startsWith("<span") && /\btruncate\b/.test(cell) && cell.includes('tabindex="0"') && cell.includes('data-read-control="true"') && s.includes(">A very long customer name that needs truncating</span>"), "a truncated cell is a focusable tooltip trigger (keyboard reaches the full text), marked as a read:");
  const linked = html(h(DT.DataTable, { columns: [{ key: "customer", header: "Customer", truncate: true }], rows: ROWS, rowHref: (r) => `/admin/orders/${r.id}` }));
  ok(/<a [^>]*data-slot="tooltip-trigger"[^>]*>A very long customer name|<a [^>]*href="\/admin\/orders\/ord_b"[^>]*data-slot="tooltip-trigger"/.test(linked) && !/<span[^>]*tabindex/.test(linked), "in the link column the row link is the trigger (no second tab stop):");
  ok(read(`${KIT}/data-table.js`).includes("<TooltipContent>{value}</TooltipContent>"), "the tooltip holds the whole value:");
});

await t("DataTable: sortable headers come from props (aria-sort, onSort), none without onSort", () => {
  const calls = [];
  const s = html(h(DT.DataTable, { columns: COLUMNS, rows: ROWS, sort: { key: "total", dir: "desc" }, onSort: (k) => calls.push(k) }));
  ok(/<th [^>]*aria-sort="descending"[^>]*>\s*<button[^>]*data-read-control="true"[^>]*>Total/.test(s), "Total is sorted descending, its header a read button:");
  eq((s.match(/aria-sort=/g) || []).length, 1, "only the sorted column has aria-sort:");
  eq((s.match(/<th [^>]*>\s*<button/g) || []).length, 2, "two sortable headers are buttons:");
  ok(s.indexOf("PAV-1002") < s.indexOf("PAV-1001"), "the rows are not re-sorted on the client:");
  const asc = html(h(DT.DataTable, { columns: COLUMNS, rows: ROWS, sort: { key: "number", dir: "asc" }, onSort: () => {} }));
  ok(/aria-sort="ascending"/.test(asc), "ascending:");
  ok(!/<th [^>]*>\s*<button/.test(html(h(DT.DataTable, { columns: COLUMNS, rows: ROWS }))), "no onSort, no sort buttons:");
});

await t("DataTable: skeleton rows while loading, the empty state once loaded and empty", () => {
  const s = html(h(DT.DataTable, { columns: COLUMNS, rows: [], loading: true, empty: h("p", { id: "empty" }, "No orders yet"), footer: { offset: 0, total: 0 } }));
  eq((s.match(/data-kit="skeleton-row"/g) || []).length, 5, "five skeleton rows by default:");
  ok(/<td [^>]*colSpan="4"|<td [^>]*colspan="4"/.test(s) && s.includes('data-slot="skeleton"'), "each spans the columns with a skeleton:");
  ok(/aria-busy="true"/.test(s) && !s.includes('id="empty"') && !s.includes("data-table-footer"), "busy; no empty state or footer while loading:");
  eq((html(h(DT.DataTable, { columns: COLUMNS, rows: [], loading: true, skeletonRows: 3 })).match(/skeleton-row/g) || []).length, 3, "skeletonRows:");
  eq(html(h(DT.DataTable, { columns: COLUMNS, rows: [], empty: h("p", { id: "empty" }, "No orders yet") })), '<p id="empty">No orders yet</p>', "loaded and empty: the empty state alone:");
  ok(html(h(DT.DataTable, { columns: COLUMNS, rows: [] })).includes("<tbody"), "no empty state given: an empty table:");
});

await t("DataTable footer: \"1–50 of N\" with Previous/Next, or Load more", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `ord_${i}`, number: `PAV-${i}`, customer: "C", status: "paid", total: 1 }));
  const first = html(h(DT.DataTable, { columns: COLUMNS, rows: many, footer: { offset: 0, total: 120, onPrevious: () => {}, onNext: () => {} } }));
  ok(first.includes(">1–50 of 120</span>"), "the range:");
  ok(/<button[^>]*data-read-control="true"[^>]*disabled=""[^>]*>Previous<\/button>|<button[^>]*disabled=""[^>]*data-read-control="true"[^>]*>Previous<\/button>/.test(first), "Previous is disabled on the first page:");
  ok(/<button(?![^>]*disabled="")[^>]*>Next<\/button>/.test(first), "Next is enabled:");
  const last = html(h(DT.DataTable, { columns: COLUMNS, rows: many.slice(0, 20), footer: { offset: 100, total: 120, onPrevious: () => {}, onNext: () => {} } }));
  ok(last.includes(">101–120 of 120</span>") && /<button[^>]*disabled=""[^>]*>Next<\/button>/.test(last) && /<button(?![^>]*disabled="")[^>]*>Previous<\/button>/.test(last), "the last page: Next disabled, Previous enabled:");
  const more = html(h(DT.DataTable, { columns: COLUMNS, rows: many, footer: { total: 120, onLoadMore: () => {} } }));
  ok(more.includes(">1–50 of 120</span>") && />Load more<\/button>/.test(more) && !more.includes(">Next<"), "Load more mode:");
  ok(/>Loading…<\/button>/.test(html(h(DT.DataTable, { columns: COLUMNS, rows: many, footer: { total: 120, onLoadMore: () => {}, loadingMore: true } }))), "loading more:");
  ok(!html(h(DT.DataTable, { columns: COLUMNS, rows: many, footer: { total: 50, onLoadMore: () => {} } })).includes("Load more"), "everything loaded: no Load more:");
  ok(!html(h(DT.DataTable, { columns: COLUMNS, rows: many })).includes("data-table-footer"), "no footer prop, no footer:");
});

// ---------- 7. imports ----------
await t("components/kit holds the six parts and imports only components/ui, lib/, its own folder and packages", () => {
  const files = readdirSync(join(ROOT, KIT)).sort();
  eq(files, PARTS.map((p) => `${p}.js`).sort(), "the files:");
  for (const f of files) {
    const ids = [...read(`${KIT}/${f}`).matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    eq(ids.filter((id) => (id.startsWith("@/") && !/^@\/(components\/(ui|kit)|lib)\//.test(id)) || id.startsWith(".")), [], `${f} imports:`);
  }
});

// ---------- 8. data-read-control ----------
const { READ_CONTROLS } = await import("./support/read-controls.js");
const walk = (rel) => readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : /\.(js|jsx|tsx?)$/.test(e.name) ? [`${rel}/${e.name}`] : []));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
// each mark: its opening tag, whether it submits, whether it sits in a form that isn't method="get"
function readMarks(src) {
  const out = [];
  for (const m of src.matchAll(/data-read-control/g)) {
    const start = src.lastIndexOf("<", m.index);
    const rest = src.slice(m.index);
    const end = m.index + (rest.search(/(?<![=\-])>/) + 1 || rest.length);
    const open = src.slice(start, end);
    const name = (open.match(/^<([\w.]+)/) || [])[1] || "";
    const formOpen = src.lastIndexOf("<form", start);
    const inForm = formOpen >= 0 && src.lastIndexOf("</form>", start) < formOpen;
    const formTag = inForm ? src.slice(formOpen, src.indexOf(">", formOpen) + 1) : "";
    const literalType = (open.match(/\btype=(?:"([^"]*)"|'([^']*)'|\{"([^"]*)"\})/) || []).slice(1).find((x) => x != null);
    out.push({
      open,
      submits:
        ["submit", "image"].includes(literalType) ||
        (/\btype=/.test(open) && literalType == null) || // a dynamic type={x}
        /\{\s*\.\.\./.test(open) || // a spread may carry type, form or formAction
        /\b(?:form|formAction|formaction)=/.test(open) ||
        (inForm && /^(button|Button)$/.test(name) && literalType == null),
      postForm: inForm && !/\bmethod=(?:"get"|\{"get"\}|'get')/i.test(formTag),
    });
  }
  return out;
}
await t("data-read-control: never on a submit button or in a non-GET form; outside components/kit/ only with a reasoned row", () => {
  const bad = (src) => readMarks(src).filter((r) => r.submits || r.postForm).length;
  eq([
    bad('<button type="button" data-read-control onClick={() => go()}>Next</button>'),
    bad('<button type="submit" data-read-control>Save</button>'),
    bad('<form method="get"><input name="q" data-read-control /><Button type="button" data-read-control>Search</Button></form>'),
    bad('<form action={save}><Button data-read-control>Go</Button></form>'),
    bad('<form onSubmit={save}><input data-read-control /></form>'),
    bad('<form method="get"><Button data-read-control>Search</Button></form>'),
    bad('<button type="button" form="save-form" data-read-control>Go</button>'),
    bad('<Button type="button" formAction={save} data-read-control>Go</Button>'),
    bad('<input type="image" alt="Go" data-read-control />'),
    bad('<Button type={kind} data-read-control>Go</Button>'),
    bad('<Button {...props} data-read-control>Go</Button>'),
    bad('<form method="post"><input name="q" data-read-control /></form>'),
    bad('<form method={m}><input name="q" data-read-control /></form>'),
    bad('<Link href="/admin/orders" data-read-control>Orders</Link>'),
  ], [0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0], "the rule bites (submit, default submit, non-GET form, form=, formAction, type=image, dynamic type, spread, method post, dynamic method):");
  for (const r of READ_CONTROLS) ok(r && typeof r.path === "string" && typeof r.reason === "string" && r.reason.trim().length >= 10, `read-controls row ${JSON.stringify(r)} needs a path and a reason:`);
  const problems = [];
  const files = [...walk("app"), ...walk("components")];
  let marks = 0;
  for (const f of files) {
    const src = stripComments(read(f));
    if (!src.includes("data-read-control")) continue;
    const found = readMarks(src);
    marks += found.length;
    for (const r of found) {
      if (r.submits) problems.push(`${f}: a submit control is marked a read: ${r.open}`);
      if (r.postForm) problems.push(`${f}: a marked control sits in a form that is not method="get": ${r.open}`);
    }
    if (!f.startsWith(`${KIT}/`) && !READ_CONTROLS.some((r) => r.path === f)) problems.push(`${f}: data-read-control outside components/kit/ needs a row in scripts/support/read-controls.js`);
  }
  ok(marks >= 5, `found ${marks} marks (the kit's own):`);
  for (const r of READ_CONTROLS) ok(files.includes(r.path) && stripComments(read(r.path)).includes("data-read-control"), `${r.path} is listed but marks nothing: remove the row:`);
  eq(problems, [], "found:");
});

// ---------- 9. RoleGate's child forwards the props; no fake gates ----------
const GATE_FILE = `${KIT}/role-gate.js`;
const fakeGates = (files) => files.filter((f) => f !== GATE_FILE && read(f).includes("data-role-gate"));
await t("data-role-gate appears only in components/kit/role-gate.js (no hand-made gate)", () => {
  const files = [...walk("app"), ...walk("components"), ...walk("lib")];
  ok(files.includes(GATE_FILE) && read(GATE_FILE).includes("data-role-gate"), "RoleGate sets it:");
  eq(fakeGates([...files, "scripts/test-console-kit.js"]), ["scripts/test-console-kit.js"], "the ban bites (a file that names it is caught):");
  eq(fakeGates(files), [], "files outside role-gate.js that name data-role-gate:");
});

const FORWARDS = new Set(["button", "a", "Button", "Link"]);
const gateChildren = (src) => [...src.matchAll(/<RoleGate\b[^>]*?(?<!=)>\s*<([\w.]+)/g)].map((m) => m[1]);
await t("every <RoleGate> wraps a child that forwards onClick and aria-disabled (<button>, <a>, Button, Link)", () => {
  eq(gateChildren('<RoleGate role={r} action="orders.push" reason="x">\n  <Button onClick={push}>Push</Button>\n</RoleGate>'), ["Button"], "reads the child:");
  eq(gateChildren('<RoleGate role={r} action="a" reason="x"><Badge>Hi</Badge></RoleGate>').filter((n) => !FORWARDS.has(n)), ["Badge"], "a child that doesn't forward is flagged:");
  const problems = [];
  for (const f of [...walk("app"), ...walk("components")]) {
    const src = stripComments(read(f));
    if (!src.includes("<RoleGate")) continue;
    const kids = gateChildren(src);
    if (kids.length !== (src.match(/<RoleGate\b/g) || []).length) problems.push(`${f}: a <RoleGate> whose child is not a plain element tag (write the child inline)`);
    for (const name of kids) if (!FORWARDS.has(name)) problems.push(`${f}: <RoleGate> wraps <${name}>, which may not forward onClick/aria-disabled: use a <button>, <a>, Button or Link`);
  }
  eq(problems, [], "found:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
