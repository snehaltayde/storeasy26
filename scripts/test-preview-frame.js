// P3-FRAME suite (PV-01, ED-04, ED-02, PUB-11, PV-02): the storefront side of
// the editor, preview only.
//   1. bridge-core (components/preview/bridge-core.js) on a small stand-in
//      DOM, no jsdom: v1 for the legacy Designer unchanged; v2 after the
//      editor's hello: ready, capture-phase interception, pick, select,
//      refresh that keeps the scroll and the selection.
//   2. The real layout, rendered: a preview that ended (the bar and the
//      bridge with ok:false), a console cookie on the live store (the bridge
//      with reason "live", Edit this page), a valid session (the banner, the
//      live-store link, the offline line), no cookies (nothing new, the HTML
//      equal to the base commit's).
//   3. Preview-only attributes: data-doc on the header, the announcement, the
//      footer and <main>; data-field on the words, equal to the field
//      lib/registry/validate.js reports for the same value; never live.
//   4. After the batch 1 review: a broken release pointer gives the error
//      page, never "Opening soon"; section_render_failed names the store; a
//      closed store's quiz and bundle pages leak nothing.
// Everything is rendered with Next's own SWC and react-dom/server.
//   pnpm test:preview-frame
//
// FRAME_RECORD=1 prints the sha-256 of the shopper renders the byte-equality
// tests compare (run once on the base commit to record BEFORE below).
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { fontModule } from "./support/font-stub.js";
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();
const RECORD = process.env.FRAME_RECORD === "1";

const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__frameRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() { const r = req(); return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) }; }
export async function cookies() { const r = req(); return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) }; }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-pf-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pf-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const TENANTS = ["fv", "fl", "fc", "fb", "fj"];
const dbs = [".test-pf-default.db", ".test-pf-platform.db", ...TENANTS.map((t) => `.test-pf-${t}.db`)];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const R = await import("../lib/releases.js");
const Res = await import("../lib/content/resolve.js");
const Reg = await import("../lib/registry/index.js");
const Svc = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const PS = await import("../lib/preview-sessions.js");
const { runRequest } = await import("./support/request-cache.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  if (RECORD) return;
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ") || e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (got, want, m = "") => {
  if (got !== want) throw new Error(`${m} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const same = (got, want, m = "") => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${m}\n      expected ${b.slice(0, 600)}\n      got      ${a.slice(0, 600)}`);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

// =====================================================================================
// 1. bridge-core on a stand-in DOM (no jsdom)
// =====================================================================================

// Just enough DOM for the bridge: elements with attributes, children, closest
// (a tiny selector subset: tag, [attr], [attr="v"], .class, comma lists and
// tag[attr]), contains, classList, scrollIntoView; a document with listeners
// (capture flag kept), querySelector(All), head and body; a window with
// postMessage to its parent, sessionStorage, scrollTo/scrollY, reload.
class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.classes = new Set();
    this.scrolled = 0;
    for (const c of children) this.append(c);
    const self = this;
    this.classList = {
      add: (c) => self.classes.add(c),
      remove: (c) => self.classes.delete(c),
      contains: (c) => self.classes.has(c),
    };
  }
  append(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  appendChild(c) {
    return this.append(c);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  getAttribute(n) {
    return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
  }
  removeAttribute(n) {
    delete this.attrs[n];
  }
  get textContent() {
    return this.text ?? this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children = [];
    this.text = String(v);
  }
  insertAdjacentElement(where, el) {
    if (where !== "afterend" || !this.parentElement) throw new Error(`stand-in DOM: insertAdjacentElement ${where}`);
    const kids = this.parentElement.children;
    el.parentElement = this.parentElement;
    kids.splice(kids.indexOf(this) + 1, 0, el);
    return el;
  }
  matches(sel) {
    return sel.split(",").some((one) => matchOne(this, one.trim()));
  }
  closest(sel) {
    for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n;
    return null;
  }
  contains(other) {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  scrollIntoView() {
    this.scrolled++;
  }
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
}
function matchOne(el, sel) {
  const m = /^([a-z]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/i.exec(sel);
  if (!m) throw new Error(`stand-in DOM: selector not supported: ${sel}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const [, attr, , val, cls] of m[2].matchAll(/\[([\w-]+)(=(?:"([^"]*)"|[\w-]+))?\]|\.([\w-]+)/g)) {
    if (cls) {
      if (!el.classes.has(cls)) return false;
      continue;
    }
    if (!Object.hasOwn(el.attrs, attr)) return false;
    if (val !== undefined && el.attrs[attr] !== val) return false;
  }
  return true;
}
const h = (tag, attrs, ...children) => new El(tag, attrs || {}, children.flat());

function standIn(bodyChildren, { storage = "memory", embedded = true, path = "/", headChildren = [], kit = null } = {}) {
  const listeners = { doc: [], win: [] };
  const body = h("body", {}, ...bodyChildren);
  const head = h("head", {}, ...headChildren);
  const documentElement = h("html", kit ? { "data-kit": kit } : {}, head, body);
  const sent = [];
  const store = new Map();
  let reloads = 0;
  const scrolls = [];
  const sessionStorage =
    storage === "throws"
      ? {
          getItem() {
            throw new Error("SecurityError: storage blocked");
          },
          setItem() {
            throw new Error("SecurityError: storage blocked");
          },
          removeItem() {
            throw new Error("SecurityError: storage blocked");
          },
        }
      : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const document = {
    body,
    head,
    documentElement,
    getElementById: (id) => [...documentElement.walk()].find((e) => e.attrs.id === id) || null,
    createElement: (tag) => h(tag),
    addEventListener: (type, fn, capture) => listeners.doc.push({ type, fn, capture: capture === true }),
    removeEventListener: (type, fn) => (listeners.doc = listeners.doc.filter((l) => l.type !== type || l.fn !== fn)),
    querySelectorAll: (sel) => [...body.walk()].filter((e) => e.matches(sel)),
    querySelector: (sel) => [...body.walk()].find((e) => e.matches(sel)) || null,
  };
  const parent = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
  const win = {
    location: { origin: "https://fv.test", pathname: path, reload: () => reloads++ },
    scrollY: 0,
    scrollTo: (x, y) => scrolls.push(y),
    sessionStorage,
    CSS: { escape: (s) => String(s).replace(/["\\]/g, "\\$&") },
    addEventListener: (type, fn) => listeners.win.push({ type, fn }),
    removeEventListener: (type, fn) => (listeners.win = listeners.win.filter((l) => l.type !== type || l.fn !== fn)),
  };
  win.parent = embedded ? parent : win;
  const message = (data, origin = "https://fv.test", source = parent) => listeners.win.filter((l) => l.type === "message").forEach((l) => l.fn({ data, origin, source }));
  // P3-FIX2: the two phases, as a browser runs them at the document: every
  // capture listener first, then, unless one stopped propagation, the bubble
  // listeners (the page's own handlers). stopPropagation in the capture phase
  // keeps the bubble phase from running; listeners of the same phase all run.
  const fire = (type, target) => {
    const e = { type, target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const l of listeners.doc.filter((x) => x.type === type && x.capture)) l.fn(e);
    if (!e.stopped) for (const l of listeners.doc.filter((x) => x.type === type && !x.capture)) l.fn(e);
    return e;
  };
  return { window: win, document, sent, store, message, click: (el) => fire("click", el), submit: (el) => fire("submit", el), reloads: () => reloads, scrolls, listeners };
}

// A page the way the layout and the renderers mark it in a documents preview.
function samplePage() {
  const navLink = h("a", { href: "/collections" }, h("span", {}, ));
  const header = h("header", { "data-doc": "doc_header" }, h("div", { "data-sec": "announcement", "data-doc": "doc_announcement" }, h("a", { href: "/sale" })), navLink);
  const heroTitle = h("h1", { "data-field": "title" }, h("span", {}));
  const heroButton = h("a", { href: "/collections/serums", "data-field": "primary.label" });
  const hero = h("section", { "data-sec": "hero", "data-section-id": "sec_hero", "data-section-kind": "hero" }, heroTitle, h("div", {}, heroButton));
  const p0 = h("p", {});
  const p1 = h("p", {}, h("strong", {}));
  const rte = h("div", { "data-field": "html", "data-field-type": "rich_text" }, p0, p1);
  const rich = h("section", { "data-sec": "sec_rt", "data-section-id": "sec_rt", "data-section-kind": "rich_text" }, h("h2", { "data-field": "title" }), rte);
  const unfinished = h("section", { "data-sec": "sec_bn", "data-section-id": "sec_bn", "data-section-kind": "rich_text", "data-unfinished": "" });
  const submitBtn = h("button", {});
  const typeButton = h("button", { type: "button" });
  const form = h("form", { method: "post", action: "/api/contact" }, h("input", { type: "email" }), submitBtn, typeButton);
  const main = h("main", { "data-doc": "doc_home" }, hero, rich, unfinished, form);
  const liveLink = h("a", { href: "/api/preview?exit=1&to=%2F" });
  const toggle = h("form", { method: "post", action: "/api/preview" }, h("button", { type: "submit" }));
  const bar = h("div", { "data-preview-bar": "" }, liveLink, toggle);
  const footer = h("footer", { "data-doc": "doc_footer" }, h("a", { href: "/about" }));
  return { header, navLink, hero, heroTitle, heroButton, rich, rte, p0, p1, unfinished, form, submitBtn, typeButton, main, footer, bar, liveLink, toggle, nodes: [bar, header, main, footer] };
}

const Bridge = RECORD ? null : await import("../components/preview/bridge-core.js");
const docState = { kind: "documents", sid: "ps_00000000000000f1", docs: { doc_home: "h_home_1", doc_header: "h_head_1" }, offline: ["doc_x"], skipped: [], designShown: false };
const pickMsgs = (s) => s.sent.map((x) => x.msg).filter((m) => m?.type === "storeasy:pick");

console.log("— 1. bridge-core, on a stand-in DOM");

await t("not embedded: the bridge is inert (no listeners, nothing posted)", () => {
  const page = samplePage();
  const s = standIn(page.nodes, { embedded: false });
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true });
  eq(s.listeners.doc.length + s.listeners.win.length, 0, "listeners:");
  stop();
});

await t("v1 unchanged without the editor's hello: mount says ready, the Designer's hello turns on select mode, a [data-sec] click is swallowed and posted, highlight outlines and scrolls, refresh reloads", () => {
  const page = samplePage();
  const s = standIn(page.nodes);
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true, css: "x" });
  same(s.sent.map((x) => x.msg), [{ type: "storeasy:ready" }], "the mount's announce:");
  eq(s.sent[0].origin, "https://fv.test", "posted to its own origin only:");
  // before any hello, a click is the page's own
  const before = s.click(page.heroButton);
  eq(before.defaultPrevented, false, "no hello: a link click is not stopped:");
  eq(pickMsgs(s).length, 0, "no hello: no pick:");
  s.message("storeasy:designer:hello", "https://evil.test");
  eq(s.sent.length, 1, "another origin's hello is ignored:");
  s.message("storeasy:designer:hello");
  same(s.sent.at(-1).msg, { type: "storeasy:ready" }, "the hello's answer (v1 shape):");
  ok(s.document.body.classList.contains("storeasy-designing"), "select mode class:");
  eq(s.document.head.children.length, 1, "the outline styles are added:");
  const e = s.click(page.heroTitle);
  ok(e.defaultPrevented && e.stopped, "a click inside a [data-sec] is swallowed:");
  same(s.sent.at(-1).msg, { type: "storeasy:sec:click", id: "hero" }, "sec:click:");
  ok(page.hero.classList.contains("storeasy-selected"), "the clicked section is outlined:");
  // outside any [data-sec]: the page's own (v1 never touched those)
  const f = s.submit(page.form);
  eq(f.defaultPrevented, false, "v1 leaves form submits alone:");
  const g = s.click(page.footer.children[0]);
  eq(g.defaultPrevented, false, "v1 leaves a link outside a [data-sec] alone:");
  s.message({ type: "storeasy:sec:highlight", id: "sec_rt" });
  ok(page.rich.classList.contains("storeasy-selected") && !page.hero.classList.contains("storeasy-selected"), "highlight moves the outline:");
  eq(page.rich.scrolled, 1, "and scrolls to it:");
  eq(pickMsgs(s).length, 0, "v1 never posts a pick:");
  s.message({ type: "storeasy:refresh" });
  eq(s.reloads(), 1, "refresh reloads:");
  eq(s.store.size, 0, "v1 refresh stores nothing:");
  stop();
  eq(s.listeners.doc.length + s.listeners.win.length, 0, "taken down cleanly:");
  ok(!s.document.body.classList.contains("storeasy-designing"), "class removed:");
});

await t("v2 ready carries the layout's state (docs = the overlay's draft hashes, offline), ok, and the [data-unfinished] section ids; an ended preview carries ok:false with its reason", () => {
  const page = samplePage();
  const s = standIn(page.nodes);
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true });
  s.message({ type: "storeasy:editor:hello", v: 1 });
  eq(s.sent.length, 1, "a hello that isn't v2 is ignored:");
  s.message({ type: "storeasy:editor:hello", v: 2 });
  same(s.sent.at(-1).msg, { type: "storeasy:ready", v: 2, state: docState, ok: true, unfinished: ["sec_bn"] }, "ready:");
  ok(s.document.body.classList.contains("storeasy-editing"), "editing class:");
  stop();
  for (const reason of ["revoked", "expired", "not_found", "live"]) {
    const s2 = standIn(samplePage().nodes);
    const stop2 = Bridge.createBridge({ window: s2.window, document: s2.document, ok: false, reason });
    s2.message({ type: "storeasy:editor:hello", v: 2 });
    same(s2.sent.at(-1).msg, { type: "storeasy:ready", v: 2, state: null, ok: false, reason, unfinished: ["sec_bn"] }, `${reason}:`);
    stop2();
  }
});

await t("P3-FIX2: the bridge listens in the capture phase: with the page's own bubble-phase click and submit handlers added first, a v2 link click, a type=button click (P3-EDITOR) and a form submit never reach them; a click on plain text still does", () => {
  const page = samplePage();
  const s = standIn(page.nodes);
  const ran = [];
  // the page's own handlers (React's root listeners, a site script), added before the bridge mounts
  s.document.addEventListener("click", (e) => ran.push(["click", e.target]), false);
  s.document.addEventListener("submit", (e) => ran.push(["submit", e.target]), false);
  const mine = s.listeners.doc.length;
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true });
  same(s.listeners.doc.slice(mine).map((l) => [l.type, l.capture]), [["click", true], ["submit", true]], "the bridge's listeners:");
  s.message({ type: "storeasy:editor:hello", v: 2 });
  const link = s.click(page.heroButton);
  ok(link.defaultPrevented && link.stopped, "the link click is stopped:");
  const sub = s.submit(page.form);
  ok(sub.defaultPrevented && sub.stopped, "the submit is stopped:");
  const typeBtn = s.click(page.typeButton);
  ok(typeBtn.defaultPrevented && typeBtn.stopped, "a type=button click is stopped (P3-EDITOR):");
  eq(ran.length, 0, "the page's own handlers never ran:");
  const word = page.heroTitle.children[0];
  s.click(word);
  same(ran.map(([type, el]) => [type, el === word]), [["click", true]], "a click on plain text still reaches the page:");
  stop();
});

await t("v2: a click on a link inside a section and outside any section is prevented and posts pick {doc, sectionId, kind, field, offset}; a form submit, a submit button and (P3-EDITOR) a type=button are prevented", () => {
  const page = samplePage();
  const s = standIn(page.nodes);
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true });
  s.message({ type: "storeasy:editor:hello", v: 2 });
  const inSection = s.click(page.heroButton);
  ok(inSection.defaultPrevented && inSection.stopped, "the hero's button link is stopped:");
  same(pickMsgs(s).at(-1), { type: "storeasy:pick", doc: "doc_home", sectionId: "sec_hero", kind: "hero", field: "primary.label", offset: null }, "pick in the hero:");
  ok(page.hero.classList.contains("storeasy-selected"), "the picked section is outlined at once:");
  const inHeader = s.click(page.navLink.children[0]);
  ok(inHeader.defaultPrevented && inHeader.stopped, "a header link is stopped:");
  same(pickMsgs(s).at(-1), { type: "storeasy:pick", doc: "doc_header", sectionId: null, kind: null, field: null, offset: null }, "pick in the header:");
  s.click(page.header.children[0].children[0]);
  eq(pickMsgs(s).at(-1).doc, "doc_announcement", "the announcement bar's own document:");
  const footer = s.click(page.footer.children[0]);
  ok(footer.defaultPrevented, "a footer link is stopped:");
  eq(pickMsgs(s).at(-1).doc, "doc_footer", "the footer's document:");
  // a word, not a link: picked, not stopped
  const word = s.click(page.heroTitle.children[0]);
  eq(word.defaultPrevented, false, "a plain click is not prevented:");
  same(pickMsgs(s).at(-1), { type: "storeasy:pick", doc: "doc_home", sectionId: "sec_hero", kind: "hero", field: "title", offset: null }, "pick on the title:");
  // rich text: the block's index
  s.click(page.p1.children[0]);
  same(pickMsgs(s).at(-1), { type: "storeasy:pick", doc: "doc_home", sectionId: "sec_rt", kind: "rich_text", field: "html", offset: 1 }, "pick in a rich text field:");
  s.click(page.p0);
  eq(pickMsgs(s).at(-1).offset, 0, "first block:");
  // submits
  const sub = s.submit(page.form);
  ok(sub.defaultPrevented && sub.stopped, "a form submit is prevented:");
  const btn = s.click(page.submitBtn);
  ok(btn.defaultPrevented, "a submit button (no type) is prevented:");
  // P3-EDITOR (from the P3-FRAME review): a type=button is stopped too, so a
  // founder picking a section never adds to their cart or wishlist
  const plain = s.click(page.typeButton);
  ok(plain.defaultPrevented && plain.stopped, "a type=button is stopped as well:");
  // the preview's own bar keeps working: See the live store, Exit, the colours toggle
  const picks = pickMsgs(s).length;
  const live = s.click(page.liveLink);
  eq(live.defaultPrevented, false, "the bar's See the live store link is followed:");
  eq(s.submit(page.toggle).defaultPrevented, false, "the bar's colours toggle submits:");
  eq(s.click(page.toggle.children[0]).defaultPrevented, false, "and its button too:");
  eq(pickMsgs(s).length, picks, "the bar is never picked:");
  stop();
});

await t("P3-EDITOR: in the editor frame, a click on Add to cart, the wishlist heart, the cart drawer button, a quantity input, a summary and a role=button selects the section and runs none of the page's own handlers; v1 and no hello leave them alone", () => {
  const icon = h("svg", {});
  const addToCart = h("button", { type: "button", "aria-label": "Add to cart" }, h("span", {}, icon));
  const wish = h("button", { type: "button", "aria-label": "Add to wishlist" });
  const qty = h("input", { type: "number", name: "qty" });
  const sum = h("summary", {}, h("span", {}));
  const roleBtn = h("div", { role: "button" });
  const cartDrawer = h("button", { type: "button", "aria-label": "Open cart" });
  const product = h("section", { "data-section-id": "sec_pmain", "data-section-kind": "product_main" }, h("h1", {}), addToCart, wish, qty, h("details", {}, sum), roleBtn);
  const main = h("main", { "data-doc": "doc_product_layout" }, product);
  const header = h("header", { "data-doc": "doc_header" }, cartDrawer);
  const run = (hello) => {
    const s = standIn([header, main], { path: "/products/serum" });
    const ran = [];
    s.document.addEventListener("click", (e) => ran.push(e.target), false); // React's own handlers
    const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true });
    if (hello) s.message(hello);
    const out = [addToCart.children[0].children[0], wish, qty, sum.children[0], roleBtn, cartDrawer].map((el) => s.click(el));
    stop();
    return { s, ran, out };
  };
  const v2 = run({ type: "storeasy:editor:hello", v: 2 });
  ok(v2.out.every((e) => e.defaultPrevented && e.stopped), `every control click is stopped: ${JSON.stringify(v2.out.map((e) => [e.defaultPrevented, e.stopped]))}`);
  eq(v2.ran.length, 0, "the page's add-to-cart handler never ran:");
  const picks = pickMsgs(v2.s);
  same(picks[0], { type: "storeasy:pick", doc: "doc_product_layout", sectionId: "sec_pmain", kind: "product_main", field: null, offset: null }, "Add to cart picks the product section:");
  eq(picks.at(-1).doc, "doc_header", "the cart drawer button picks the header:");
  ok(product.classList.contains("storeasy-selected"), "the product section was outlined");
  for (const hello of [null, "storeasy:designer:hello"]) {
    const r = run(hello);
    ok(r.out.every((e) => !e.defaultPrevented), `${hello || "no hello"}: the page's own controls work`);
    eq(r.ran.length, 6, `${hello || "no hello"}: the page's handlers ran:`);
  }
});

await t("v2 select outlines the section and scrolls to it; refresh keeps the scroll and the selection in sessionStorage and the next mount restores them; a throwing storage still reloads and mounts", () => {
  const page = samplePage();
  const s = standIn(page.nodes, { path: "/about" });
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: true });
  s.message({ type: "storeasy:editor:hello", v: 2 });
  s.message({ type: "storeasy:select", sectionId: "sec_rt" });
  ok(page.rich.classList.contains("storeasy-selected"), "outlined:");
  eq(page.rich.scrolled, 1, "scrolled:");
  s.message({ type: "storeasy:select", sectionId: "sec_hero" });
  ok(page.hero.classList.contains("storeasy-selected") && !page.rich.classList.contains("storeasy-selected"), "the outline moves:");
  s.message({ type: "storeasy:select", sectionId: "sec_rt" }, "https://evil.test");
  ok(page.hero.classList.contains("storeasy-selected"), "another origin can't select:");
  s.window.scrollY = 640;
  s.message({ type: "storeasy:refresh" });
  eq(s.reloads(), 1, "reloaded:");
  same(JSON.parse(s.store.get(Bridge.RESTORE_KEY)), { path: "/about", y: 640, sectionId: "sec_hero" }, "kept:");
  stop();
  // the reload: a fresh page, the same storage
  const page2 = samplePage();
  const s2 = standIn(page2.nodes, { path: "/about" });
  for (const [k, v] of s.store) s2.store.set(k, v);
  const stop2 = Bridge.createBridge({ window: s2.window, document: s2.document, state: docState, ok: true });
  same(s2.scrolls, [640], "the scroll comes back:");
  ok(page2.hero.classList.contains("storeasy-selected"), "the selection comes back:");
  eq(s2.store.size, 0, "used once:");
  stop2();
  // another page: the kept place is not applied there
  const s3 = standIn(samplePage().nodes, { path: "/" });
  s3.store.set(Bridge.RESTORE_KEY, JSON.stringify({ path: "/about", y: 99, sectionId: null }));
  Bridge.createBridge({ window: s3.window, document: s3.document })();
  same(s3.scrolls, [], "not on another address:");
  // storage that throws: no crash, the reload still happens
  const s4 = standIn(samplePage().nodes, { storage: "throws" });
  const stop4 = Bridge.createBridge({ window: s4.window, document: s4.document, state: docState, ok: true });
  s4.message({ type: "storeasy:editor:hello", v: 2 });
  s4.message({ type: "storeasy:refresh" });
  eq(s4.reloads(), 1, "reloads anyway:");
  stop4();
});

// ---- Phase 1 line 6: look mode and the brand overlay (onboarding's brand step) ----
// A page as the layout renders it in a documents preview: #brand-vars in the
// head, the header's and the footer's logo slots, the footer's tagline slot.
function brandPage({ logo = null } = {}) {
  const img = () => h("img", logo ? { "data-store-logo-img": "", src: logo, alt: "Saved" } : { "data-store-logo-img": "", alt: "", hidden: "" });
  const words = () => h("span", logo ? { "data-store-logo-text": "", hidden: "" } : { "data-store-logo-text": "" });
  const headImg = img();
  const headText = words();
  const footImg = img();
  const footText = words();
  const tagline = h("p", { "data-store-tagline": "" });
  tagline.textContent = "Saved line";
  const link = h("a", { href: "/collections" });
  const header = h("header", { "data-doc": "doc_header" }, h("a", { href: "/" }, headImg, headText), link);
  const sec = h("section", { "data-section-id": "sec_hero", "data-section-kind": "hero" }, h("h1", { "data-field": "title" }));
  const main = h("main", { "data-doc": "doc_home" }, sec);
  const footer = h("footer", { "data-doc": "doc_footer" }, footImg, footText, tagline);
  const vars = h("style", { id: "brand-vars" });
  vars.textContent = ":root{--accent-500:#334155;}";
  return { headImg, headText, footImg, footText, tagline, link, sec, main, vars, nodes: [header, main, footer] };
}
const LOOK = { type: "storeasy:editor:hello", v: 2, look: true };
const brandFor = (id) => (id === "forest" ? { css: ":root{--accent-500:#166534;}", kit: "pulse-1" } : id === "glowy" ? { css: ":root{--accent-500:#ff00aa;}", kit: "glow-1" } : null);
const brandStand = (opts = {}) => {
  const page = brandPage(opts);
  const s = standIn(page.nodes, { headChildren: [page.vars], kit: "pulse-1" });
  const stop = Bridge.createBridge({ window: s.window, document: s.document, state: docState, ok: opts.ok ?? true, reason: opts.reason ?? null, css: "x", brandFor });
  return { page, s, stop };
};
const draftStyle = (s) => s.document.getElementById(Bridge.DRAFT_STYLE_ID);
const hidden = (el) => Object.hasOwn(el.attrs, "hidden");

await t("line 6, look mode: the look hello gets the same v2 ready; clicks and submits are still stopped; no pick is posted, select outlines nothing, no editing class; body.storeasy-look (the bar's hiding rule is in the styles)", () => {
  const { page, s, stop } = brandStand();
  s.message(LOOK);
  same(s.sent.at(-1).msg, { type: "storeasy:ready", v: 2, state: docState, ok: true, unfinished: [] }, "ready:");
  ok(s.document.body.classList.contains(Bridge.LOOK_CLASS), "look class:");
  ok(!s.document.body.classList.contains(Bridge.EDITING_CLASS), "no editing class:");
  const e = s.click(page.link);
  ok(e.defaultPrevented && e.stopped, "a link click is stopped:");
  s.click(page.sec.children[0]);
  eq(pickMsgs(s).length, 0, "no pick posted:");
  s.message({ type: "storeasy:select", sectionId: "sec_hero" });
  ok(!page.sec.classList.contains("storeasy-selected"), "select outlines nothing:");
  stop();
  ok(!s.document.body.classList.contains(Bridge.LOOK_CLASS), "taken down cleanly:");
});

await t("line 6, brand overlay: a palette puts its colours in <style id=brand-vars-draft> right after #brand-vars and its kit on <html>; a logo fills both logo slots (src, alt, shown; the words hidden); a description goes into the tagline as text; null for each puts the page's own back", () => {
  const { page, s, stop } = brandStand();
  s.message(LOOK);
  s.message({ type: "storeasy:brand", paletteId: "glowy", logo: { media: "/api/media/med_abc", alt: "Acme" }, description: "Soft serums" });
  const st = draftStyle(s);
  ok(st, "the draft style exists:");
  eq(st.textContent, ":root{--accent-500:#ff00aa;}", "its colours come from brandFor:");
  eq(s.document.head.children.indexOf(st), s.document.head.children.indexOf(page.vars) + 1, "right after #brand-vars:");
  eq(s.document.documentElement.getAttribute("data-kit"), "glow-1", "data-kit:");
  for (const img of [page.headImg, page.footImg]) {
    eq(img.getAttribute("src"), "/api/media/med_abc", "img src:");
    eq(img.getAttribute("alt"), "Acme", "img alt:");
    ok(!hidden(img), "img shown:");
  }
  ok(hidden(page.headText) && hidden(page.footText), "the words are hidden:");
  eq(page.tagline.textContent, "Soft serums", "tagline:");
  ok(!hidden(page.tagline), "tagline shown:");
  // a second change replaces, never stacks
  s.message({ type: "storeasy:brand", paletteId: "forest", logo: false, description: "" });
  eq(s.document.head.children.filter((c) => c.attrs.id === Bridge.DRAFT_STYLE_ID).length, 1, "one draft style:");
  eq(draftStyle(s).textContent, ":root{--accent-500:#166534;}", "Forest now:");
  eq(s.document.documentElement.getAttribute("data-kit"), "pulse-1", "kit follows:");
  ok(hidden(page.headImg) && hidden(page.footImg), "logo false: no picture:");
  ok(!hidden(page.headText) && !hidden(page.footText), "logo false: the store name shows:");
  ok(hidden(page.tagline), "an empty description hides the line:");
  // all null: the page as it rendered
  s.message({ type: "storeasy:brand", paletteId: null, logo: null, description: null });
  eq(draftStyle(s), null, "draft style removed:");
  eq(s.document.documentElement.getAttribute("data-kit"), "pulse-1", "kit back:");
  ok(hidden(page.headImg) && page.headImg.getAttribute("src") === null && page.headImg.getAttribute("alt") === "", "the header's empty picture slot is back:");
  ok(!hidden(page.headText), "the words are back:");
  eq(page.tagline.textContent, "Saved line", "the saved line is back:");
  ok(!hidden(page.tagline), "and shown:");
  eq(pickMsgs(s).length, 0, "nothing posted for an overlay:");
  eq(s.sent.filter((x) => x.msg?.type !== "storeasy:ready").length, 0, "the overlay sends nothing back:");
  stop();
  // a saved picture logo comes back after a change
  const b = brandStand({ logo: "/api/media/med_saved" });
  b.s.message(LOOK);
  b.s.message({ type: "storeasy:brand", paletteId: null, logo: { media: "/api/media/med_new", alt: "" }, description: null });
  eq(b.page.headImg.getAttribute("src"), "/api/media/med_new", "changed:");
  b.s.message({ type: "storeasy:brand", paletteId: null, logo: null, description: null });
  eq(b.page.headImg.getAttribute("src"), "/api/media/med_saved", "the saved picture is back:");
  eq(b.page.headImg.getAttribute("alt"), "Saved", "with its alt:");
  b.stop();
});

await t("line 6, brand overlay refusals: before any v2 hello, after only the Designer's hello, in the editor's (non-look) frame, from another origin, from a window that isn't the parent, and in a frame that isn't a working preview (revoked, expired, not_found, live, legacy) the message changes nothing", () => {
  const msg = { type: "storeasy:brand", paletteId: "forest", logo: { media: "/api/media/med_abc", alt: "A" }, description: "Hello" };
  const untouched = (b, label) => {
    eq(draftStyle(b.s), null, `${label}: no draft style:`);
    ok(hidden(b.page.headImg), `${label}: no picture:`);
    eq(b.page.tagline.textContent, "Saved line", `${label}: tagline:`);
    eq(b.s.document.documentElement.getAttribute("data-kit"), "pulse-1", `${label}: kit:`);
  };
  let b = brandStand();
  b.s.message(msg);
  untouched(b, "no hello");
  b.s.message("storeasy:designer:hello");
  b.s.message(msg);
  untouched(b, "v1 hello");
  b.stop();
  b = brandStand();
  b.s.message(LOOK);
  b.s.message(msg, "https://evil.test");
  untouched(b, "another origin");
  b.s.message(msg, "https://fv.test", { postMessage() {} });
  untouched(b, "not the parent");
  b.stop();
  // review fix: the editor's own frame (v2 without look) never draws an overlay
  b = brandStand();
  b.s.message({ type: "storeasy:editor:hello", v: 2 });
  b.s.message(msg);
  untouched(b, "editor frame (no look)");
  b.stop();
  for (const reason of ["revoked", "expired", "not_found", "live", "legacy"]) {
    const r = brandStand({ ok: false, reason });
    r.s.message(LOOK);
    r.s.message(msg);
    untouched(r, reason);
    r.stop();
  }
});

await t("line 6, brand overlay inputs: an unknown palette id, a javascript: or https://evil logo, a logo without a library address and a <script> description have no effect beyond plain text; the description is cut to 160", () => {
  const b = brandStand();
  b.s.message(LOOK);
  b.s.message({ type: "storeasy:brand", paletteId: "lime-hack", logo: null, description: null });
  eq(draftStyle(b.s), null, "unknown palette: nothing:");
  b.s.message({ type: "storeasy:brand", paletteId: { css: "body{display:none}" }, logo: null, description: null });
  eq(draftStyle(b.s), null, "a palette that isn't an id: nothing:");
  for (const media of ["javascript:alert(1)", "https://evil.test/x.png", "/api/media/../../etc", "//evil.test/api/media/med_a", "/api/media/med_a?x=1", 42]) {
    b.s.message({ type: "storeasy:brand", paletteId: null, logo: { media, alt: "x" }, description: null });
    ok(hidden(b.page.headImg) && b.page.headImg.getAttribute("src") === null, `logo ${media}: ignored`);
  }
  b.s.message({ type: "storeasy:brand", paletteId: null, logo: null, description: "<script>alert(1)</script>" });
  eq(b.page.tagline.textContent, "<script>alert(1)</script>", "set as text:");
  eq(b.page.tagline.children.length, 0, "no element made:");
  b.s.message({ type: "storeasy:brand", paletteId: null, logo: null, description: "y".repeat(400) });
  eq(b.page.tagline.textContent.length, 160, "cut to 160:");
  b.s.message({ type: "storeasy:brand", paletteId: null, logo: null, description: 7 });
  eq(b.page.tagline.textContent.length, 160, "a description that isn't text: ignored:");
  b.stop();
});

await t("routeDocFor: exact addresses from the layout, product and collection pages to their layout documents, others none", () => {
  const routes = { "/": "doc_home", "/about": "doc_ab", "/collections": "doc_collections_index" };
  eq(Bridge.routeDocFor("/", routes), "doc_home");
  eq(Bridge.routeDocFor("/about/", routes), "doc_ab", "trailing slash:");
  eq(Bridge.routeDocFor("/collections", routes), "doc_collections_index");
  eq(Bridge.routeDocFor("/collections/serums", routes), "doc_collection_layout");
  eq(Bridge.routeDocFor("/products/glow-serum", routes), "doc_product_layout");
  eq(Bridge.routeDocFor("/search", routes), null);
  eq(Bridge.routeDocFor(null, routes), "doc_home", "no address reads as /:");
});

// =====================================================================================
// stores, the JSX loader
// =====================================================================================

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");

const P = (n) => `gid://shopify/Product/${n}`;
const COL = (n) => `gid://shopify/Collection/${n}`;
const NOW = "2026-11-04T10:00:00.000Z";
async function tenant(id, { mode = "documents" } = {}) {
  await C.upsertTenant({ id, name: `PF ${id}`, domains: [`${id}.test`], dbUrl: `file:.test-pf-${id}.db`, config: { site: { name: `PF ${id} Store` }, site_url: `https://${id}.test` }, secrets: { order_link_secret: `${id}-secret` } });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, MIGRATIONS);
    const run = (sql, args = []) => libsql.execute({ sql, args });
    await run("INSERT INTO collections (id, handle, title, synced_at) VALUES (?, 'serums', 'Serums', ?)", [COL(1), NOW]);
    for (const [n, handle, title] of [
      [1, "glow-serum", "Glow Serum"],
      [2, "night-cream", "Night Cream"],
      [3, "dew-drops", "Dew Drops"],
    ]) {
      await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, created_at, synced_at) VALUES (?, ?, ?, 999, 999, 'INR', 1, ?, ?)", [P(n), handle, title, `2025-0${n}-01T00:00:00.000Z`, NOW]);
      await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default Title', 999, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${n}`, P(n)]);
      await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)", [COL(1), P(n), n]);
    }
    await run("UPDATE cms_state SET mode = ? WHERE id = 1", [mode]);
  });
  return T;
}
const FV = await tenant("fv"); // documents, published, with drafts
const FL = await tenant("fl", { mode: "legacy" }); // legacy, a v3 release live
const FC = await tenant("fc"); // documents, never published: closed
const FB = await tenant("fb"); // documents, a broken release pointer
const FJ = await tenant("fj"); // documents, published, for the failing-section log line
const inT = (T, fn) => withTenant(T, fn);

// One simulated request on T's host. The render runs OUTSIDE the tenant
// context, as in Next (the page's own tfetch calls find the store).
async function asRequest(T, fn, cookies = {}, path = "/") {
  globalThis.__frameRequest = { host: `${T.id}.test`, cookies };
  globalThis.__framePath = path;
  try {
    return await runRequest(fn);
  } finally {
    globalThis.__frameRequest = null;
    globalThis.__framePath = null;
  }
}

const sec = (kind, id, settings = {}) => {
  const s = Reg.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings } };
};
const HERO = { title: "Glow from within", highlight: "Glow", subtitle: "Clean skincare, made in small batches.", primary: { label: "Shop serums", link: { type: "url", href: "/collections/serums" } }, secondary: { label: "Read our story", link: { type: "url", href: "/about" } }, badge: "" };
const TEXT = { title: "How we make it", body: ["We start small.", "We test every batch.", "We ship from Pune."] };
const FAQ = { title: "Questions", items: [{ q: "Is it vegan?", a: "<p>Yes, all of it.</p>" }, { q: "How long does delivery take?", a: "<p>Two to four days.</p>" }] };
const BANNER = { title: "Free shipping this week", text: "On every order.", button: { label: "Shop now", link: { type: "url", href: "/collections" } } };
const homeSections = (heroTitle = HERO.title) => [sec("hero", "sec_hero", { ...HERO, title: heroTitle }), sec("text", "sec_text", TEXT), sec("faq", "sec_faq", FAQ), sec("banner", "sec_bn", BANNER)];
const withBody = (type, patch) => {
  const b = Reg.emptyBody(type);
  return { ...b, ...patch, meta: { ...b.meta, ...(patch.meta || {}) }, ...(patch.settings ? { settings: { ...(b.settings || {}), ...patch.settings } } : {}) };
};
async function upsert(type, body, id = null) {
  if (id) {
    try {
      const cur = await Svc.getDocument(id);
      return (await Svc.saveDraft({ id: cur.id, revision: cur.revision, body })).document;
    } catch (e) {
      if (e?.status !== 404 && !/no longer exists/.test(e?.message || "")) throw e;
    }
  }
  return (await Svc.createDocument({ type, body })).document;
}
async function publishAll(docs) {
  const r = await Pub.publish({ ids: docs.map((d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash })) });
  ok(r.release?.id, `publish: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
}

// FV: published home, header, footer, announcement and an about page; then
// drafts on the home page (a new hero title) and the about page.
const fvDocs = await inT(FV, async () => {
  const home = await upsert("home", withBody("home", { sections: homeSections() }), "doc_home");
  const header = await upsert("header", withBody("header", { settings: { mode: "custom", items: [{ label: "Serums", link: { type: "url", href: "/collections/serums" } }] } }), "doc_header");
  const footer = await upsert("footer", withBody("footer", { settings: { mode: "custom", items: [{ label: "About", link: { type: "url", href: "/about" } }] } }), "doc_footer");
  const ann = await upsert("announcement", withBody("announcement", { settings: { enabled: true, text: "Live bar words", link: null } }), "doc_announcement");
  const about = await upsert("page", withBody("page", { meta: { slug: "about", title: "Our story" }, sections: [sec("text", "sec_ab", { title: "Who we are", body: ["Two friends.", "One kitchen.", "Small batches."] })] }));
  const off = await upsert("page", withBody("page", { meta: { slug: "returns", title: "Returns" }, sections: [sec("text", "sec_rt1", { title: "Returns", body: ["Within 7 days."] })] }));
  await publishAll([home, header, footer, ann, about, off]);
  // drafts
  const homeD = await upsert("home", withBody("home", { sections: homeSections("Draft glow title") }), "doc_home");
  const aboutD = await upsert("page", withBody("page", { meta: { slug: "about", title: "Our story, drafted" }, sections: [sec("text", "sec_ab", { title: "Who we are", body: ["Two friends.", "One kitchen.", "Small batches, drafted."] })] }), about.id);
  return { home: homeD, about: aboutD, off };
});

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { prerenderToNodeStream } = require("react-dom/static");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const toFile = (from, id) => {
  const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
  return p.endsWith(".js") ? p : `${p}.js`;
};
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
const seen = new Map();
async function loadJsx(file, stubs) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      const target = toFile(file, id);
      deps.set(id, isJsx(target) ? await loadJsx(target, stubs) : await import(pathToFileURL(target).href));
    } else if (id === "next/headers") deps.set(id, await import("next/headers"));
    else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
const nothing = { __esModule: true, default: () => null };
const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
const realNav = require("next/navigation.js");
// The bridge renders nothing in a real page (its work is in an effect); here
// it renders its props, so a test can see what the layout handed it.
const bridgeMarker = { __esModule: true, default: (props) => React.createElement("i", { "data-bridge": JSON.stringify(props) }) };
const STUBS = {
  "next/font/local": fontModule,
  "@/app/fonts/fonts": fontModule,
  "../globals.css": {},
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "next/navigation": { ...realNav, usePathname: () => globalThis.__framePath || "/" },
  "./SearchBox": nothing,
  "./cart/CartButton": nothing,
  "@/components/cart/CartContext": { CartProvider: passthrough },
  "@/components/cart/CartDrawer": nothing,
  "@/components/ServiceWorkerRegister": nothing,
  // Phase 4 line 2: plugin slots are async server components (they read the store); not rendered here
  "@/components/plugins/PluginSlot": nothing,
  "@/components/analytics/ConsentBanner": nothing,
  "@/components/analytics/Pixels": nothing,
  "@/components/analytics/ErrorReporter": { __esModule: true, default: () => null, reportClientError: () => {} },
  "@/components/site/SiteNav": nothing,
  "@/components/site/MarketingHome": nothing,
  "@/components/ExperimentPing": nothing,
  "@/components/preview/PreviewBridge": bridgeMarker,
  // client components whose props a real page sends in its payload: render them, so a leak shows
  "@/components/QuizRunner": { __esModule: true, default: ({ quiz }) => React.createElement("pre", { "data-quiz": "" }, JSON.stringify(quiz)) },
  "@/components/BundleAddButton": { __esModule: true, default: (props) => React.createElement("pre", { "data-bundle": "" }, JSON.stringify(props)) },
};
const LayoutModule = await loadJsx(join(ROOT, "app/(storefront)/layout.js"), STUBS);
const Layout = LayoutModule.default;
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"), STUBS)).default;
const ContentPage = (await loadJsx(join(ROOT, "components/ContentPage.js"), STUBS)).default;
const ErrorPage = (await loadJsx(join(ROOT, "app/(storefront)/error.js"), STUBS)).default;
const Map_ = await loadJsx(join(ROOT, "components/sections/index.js"), STUBS);
const withImages = (el) => React.createElement(ImageConfigContext.Provider, { value: imageConfig }, el);
const html = (el) => renderToStaticMarkup(withImages(el));
const htmlAsync = async (el) => {
  const { prelude } = await prerenderToNodeStream(withImages(el));
  let out = "";
  for await (const chunk of prelude) out += chunk;
  return out;
};
const PAGE = React.createElement("p", { id: "page" }, "page body");
const layoutHtml = (T, cookies = {}, path = "/") => asRequest(T, async () => html(await Layout({ children: PAGE })), cookies, path);
const homeHtml = (T, cookies = {}) => asRequest(T, async () => html(await Home()), { _unit: "unit-frame", ...cookies }, "/");
const pageHtml = (T, slug, cookies = {}) =>
  asRequest(T, async () => {
    const { tfetch } = await import("../lib/tenant-request.js");
    const page = await tfetch(() => Res.resolvedContentPage(slug));
    return html(React.createElement(ContentPage, { page }));
  }, cookies, `/${slug}`);
const session = async (T) => inT(T, () => PS.createPreviewSession({ actor: { kind: "merchant", id: "u_frame" } }));
const bridgesIn = (s) => [...s.matchAll(/<i data-bridge="([^"]*)"><\/i>/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const tagWith = (s, re) => s.match(re)?.[0] || "";
const FRAME_ATTRS = /data-doc=|data-field=|data-field-type=|data-bridge=|data-edit-this-page|data-preview-ended|data-preview-bar|data-store-logo-img|data-store-logo-text|data-store-tagline/;

// =====================================================================================
// byte equality: the shopper renders, against the base commit (5bbc819)
// =====================================================================================
// Recorded with FRAME_RECORD=1 on a copy of 5bbc819 (git archive), the same
// stores and the same stubs. A shopper (no cookies, or only a cookie that
// isn't a console's) gets exactly the HTML it got before this item.
const BEFORE = {
  "v4 layout, no cookies": "79ade2b433d32f0fb9a380fd46b8a372af8897530c5e32be0cb1a163dd176d8e",
  "v4 layout, a cart cookie": "79ade2b433d32f0fb9a380fd46b8a372af8897530c5e32be0cb1a163dd176d8e",
  "v4 home page": "67b92590eac9c4e6de604980d52f252024f47d400221d351cd358d29137703e9",
  "v4 about page": "fc6d186ec3df743eb9c63d499fd1474c6ae40459a22290d484c64df371be671f",
};
const shopperRenders = async () => ({
  "v4 layout, no cookies": await layoutHtml(FV),
  "v4 layout, a cart cookie": await layoutHtml(FV, { _cart: "cart_none" }),
  "v4 home page": await homeHtml(FV),
  "v4 about page": await pageHtml(FV, "about"),
});
if (RECORD) {
  const out = {};
  for (const [k, v] of Object.entries(await shopperRenders())) out[k] = sha(v);
  console.log(JSON.stringify(out, null, 2));
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
  process.exit(0);
}

console.log("— 2. the layout: ended preview, console cookie, valid session, no cookies");

await t("no cookies at all: no bridge, no bar, no preview-only attribute, and the shopper HTML (layout, home page, a content page; documents and legacy stores) is byte-equal to the base commit's", async () => {
  const now = await shopperRenders();
  for (const [label, h] of Object.entries(now)) {
    ok(!FRAME_ATTRS.test(h), `${label}: a frame attribute in a shopper's HTML: ${h.match(FRAME_ATTRS)?.[0]}`);
    ok(!/unpublished changes|preview has ended|Edit this page|Draft preview/.test(h), `${label}: preview words`);
  }
  const diff = Object.keys(BEFORE).filter((k) => sha(now[k]) !== BEFORE[k]);
  same(diff, [], "renders that differ from 5bbc819:");
});

await t("a refused session (revoked, expired, unknown sid) renders the ended bar with Exit to /api/preview?exit=1 and the bridge with ok:false and its reason; no preview attributes, no banner", async () => {
  const rv = await session(FV);
  await inT(FV, () => PS.revokePreviewSession({ sid: rv.sid }));
  const ex = await session(FV);
  await inT(FV, () => libsql.execute({ sql: "UPDATE preview_sessions SET expires_at = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), ex.sid] }));
  const unknown = await inT(FV, () => R.previewToken({ sid: "ps_0000000000000fff" }));
  for (const [tok, reason] of [
    [rv.token, "revoked"],
    [ex.token, "expired"],
    [unknown, "not_found"],
  ]) {
    const h = await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: tok });
    const bar = tagWith(h, /<div data-preview-bar="" data-preview-ended=""[^>]*>[\s\S]*?<\/div>/);
    ok(bar, `${reason}: no ended bar: ${h.slice(0, 400)}`);
    eq(text(bar).trim(), "Your preview has ended, so you're seeing the live store. Exit", `${reason}: the bar's words:`);
    ok(bar.includes('href="/api/preview?exit=1"'), `${reason}: Exit link:`);
    same(bridgesIn(h), [{ ok: false, reason }], `${reason}: bridge:`);
    ok(!/unpublished changes|See the live store|data-doc=|data-field=/.test(h), `${reason}: preview banner or attributes`);
    ok(h.includes("Live bar words"), `${reason}: the live chrome serves`);
    ok(!h.includes(tok), `${reason}: the token is in the page`);
  }
  // a tampered token is no preview at all: no bar, no bridge (no console cookie)
  const good = await session(FV);
  const bad = good.token.slice(0, -1) + (good.token.endsWith("0") ? "1" : "0");
  const tampered = await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: bad });
  same(bridgesIn(tampered), [], "tampered: no bridge:");
  ok(!/preview has ended|unpublished changes/.test(tampered), "tampered: no bar");
});

await t("no preview cookie plus _admin (or _platform) on a documents store's live page renders the bridge with reason 'live' and Edit this page, and no bar; a legacy store gets neither", async () => {
  for (const c of [{ _admin: "x" }, { _platform: "x" }]) {
    const h = await layoutHtml(FV, c, "/about");
    same(bridgesIn(h), [{ ok: false, reason: "live" }], `${Object.keys(c)[0]}: bridge:`);
    ok(!/preview has ended|unpublished changes|Draft preview/.test(h), "no bar");
    ok(!/data-doc=|data-field=/.test(h), "no preview attributes on the live page");
    const link = tagWith(h, /<a[^>]*data-edit-this-page=""[^>]*>/);
    eq(link.match(/href="([^"]*)"/)?.[1], "/admin/editor?path=%2Fabout", "Edit this page link:");
    ok(h.includes(">Edit this page</a>"), "its words");
  }
  // _mx (the maintenance pass) is not a console session
  const mx = await layoutHtml(FV, { _mx: "x" });
  same(bridgesIn(mx), [], "_mx: no bridge:");
  ok(!mx.includes("Edit this page"), "_mx: no link");
});

await t("rendered: EditThisPage renders only with no preview and a console cookie, with href /admin/editor?path=…; never without the cookie, never in a preview", async () => {
  eq((await layoutHtml(FV, {}, "/about")).includes("Edit this page"), false, "no cookie:");
  const s = await session(FV);
  const pv = await layoutHtml(FV, { _admin: "x", [Res.PREVIEW_COOKIE]: s.token }, "/about");
  eq(pv.includes("Edit this page"), false, "in a preview:");
  const h = await layoutHtml(FV, { _admin: "x" }, "/policies/returns");
  eq(tagWith(h, /<a[^>]*data-edit-this-page=""[^>]*>/).match(/href="([^"]*)"/)?.[1], "/admin/editor?path=%2Fpolicies%2Freturns", "a policy page:");
  const { editorHref } = await loadJsx(join(ROOT, "components/preview/EditThisPage.js"), STUBS);
  eq(editorHref("//evil.test"), "/admin/editor?path=%2F%2Fevil.test", "the path is only ever a query value:");
  eq(editorHref("x"), "/admin/editor?path=%2F", "not a path:");
});

await t("a valid documents session renders the banner: 'You're seeing your unpublished changes.' and 'See the live store' to /api/preview?exit=1&to=<this address>, no token in the page; the bridge gets the state; an offline route document adds the offline line", async () => {
  const s = await session(FV);
  const h = await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/about");
  ok(text(h).includes("You're seeing your unpublished changes. See the live store"), `banner: ${text(h).slice(0, 300)}`);
  const live = tagWith(h, /<a[^>]*>See the live store<\/a>/);
  eq(live.match(/href="([^"]*)"/)?.[1].replace(/&amp;/g, "&"), "/api/preview?exit=1&to=%2Fabout", "the live-store link:");
  ok(!h.includes(s.token) && !/token=/.test(h), "a token in the page");
  ok(!h.includes("Draft preview"), "the legacy words");
  ok(!h.includes("This page is offline"), "no offline line for a live page");
  const [bridge] = bridgesIn(h);
  eq(bridge.ok, true, "bridge ok:");
  eq(bridge.state.kind, "documents", "state kind:");
  eq(bridge.state.sid, s.sid, "state sid:");
  const rows = await inT(FV, async () => (await libsql.execute("SELECT id, draft_hash FROM documents WHERE draft_hash IS NOT published_hash AND archived_at IS NULL")).rows);
  same(bridge.state.docs, Object.fromEntries(rows.map((r) => [String(r.id), String(r.draft_hash)]).sort()), "state.docs = the drafts' hashes:");
  same(bridge.state.offline, [], "nothing offline:");
  // take the returns page offline (decision 4) with a draft: the banner says so on its address only
  const id = fvDocs.off.id;
  await inT(FV, () => libsql.execute({ sql: "UPDATE documents SET undone_version_id = published_version_id, published_version_id = NULL, published_hash = NULL WHERE id = ?", args: [id] }));
  const off = await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/policies/returns");
  ok(text(off).includes("This page is offline. Publishing it brings it back."), `the offline line: ${text(off).slice(0, 400)}`);
  same(bridgesIn(off)[0].state.offline, [id], "state.offline:");
  ok(tagWith(off, /<main[^>]*>/).includes(`data-doc="${id}"`), "main names the offline page");
  ok(!text(await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/about")).includes("This page is offline"), "not on another page");
  // shoppers: nothing changed for them
  ok(!/offline/i.test(text(await layoutHtml(FV, {}, "/policies/returns"))), "shopper sees no offline line");
});

console.log("— 3. preview-only attributes");

// The field validate reports for a value too long at that path.
const LONG = "x".repeat(5000);
function validateField(kind, patch) {
  const { issues } = Reg.validateDocument({ schema: 1, type: "home", meta: {}, sections: [sec(kind, "sec_probe", patch)] }, { mode: "draft" });
  const hit = issues.filter((i) => i.code === "TOO_LONG");
  eq(hit.length, 1, `${kind}: one TOO_LONG issue:`);
  return hit[0].field;
}
// the element whose text is exactly `value`, and its data-field
function fieldOn(h, value) {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#x27;");
  const m = h.match(new RegExp(`<([a-z0-9]+)((?:\\s[^>]*)?)>${esc}</\\1>`));
  return m ? (m[2].match(/data-field="([^"]*)"/)?.[1] ?? null) : undefined;
}

await t("rendered: in a preview the header, the announcement bar, the footer and <main> carry the right data-doc (home, a content page)", async () => {
  const s = await session(FV);
  const h = await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/");
  ok(/<header data-doc="doc_header"/.test(h), `header: ${tagWith(h, /<header[^>]*>/)}`);
  ok(/<div data-sec="announcement" data-doc="doc_announcement"/.test(h), `announcement: ${tagWith(h, /<div data-sec="announcement"[^>]*>/)}`);
  ok(/<footer data-doc="doc_footer"/.test(h), `footer: ${tagWith(h, /<footer[^>]*>/)}`);
  eq(tagWith(h, /<main[^>]*>/), '<main class="flex-1" data-doc="doc_home">', "main on /:");
  eq(tagWith(await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/about"), /<main[^>]*>/), `<main class="flex-1" data-doc="${fvDocs.about.id}">`, "main on /about:");
  eq(tagWith(await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/products/glow-serum"), /<main[^>]*>/), '<main class="flex-1" data-doc="doc_product_layout">', "main on a product page:");
  eq(tagWith(await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/search"), /<main[^>]*>/), '<main class="flex-1">', "main on a page with no document:");
});

await t("line 6, rendered: in a preview the header and the footer carry the logo slots (an empty hidden picture and the shown words) and the footer a tagline slot; a shopper's page has none of them, open or closed", async () => {
  const s = await session(FV);
  const h = await layoutHtml(FV, { [Res.PREVIEW_COOKIE]: s.token }, "/");
  const imgs = h.match(/<img data-store-logo-img=""[^>]*>/g) || [];
  eq(imgs.length, 2, `logo pictures (header, footer): ${imgs.join(" ")}`);
  ok(imgs.every((x) => /\shidden=""/.test(x) && !/\ssrc=/.test(x)), `empty and hidden with no saved logo: ${imgs.join(" ")}`);
  const words = h.match(/<span data-store-logo-text="">/g) || [];
  eq(words.length, 2, "the words are shown in both:");
  ok(/<p data-store-tagline=""[^>]*>/.test(h), `tagline slot: ${tagWith(h, /<footer[\s\S]{0,4000}?<\/footer>/).slice(0, 300)}`);
  for (const [label, page] of [["live layout", await layoutHtml(FV)], ["home page", await homeHtml(FV)], ["closed layout", await layoutHtml(FC)]]) {
    ok(!/data-store-logo-img|data-store-logo-text|data-store-tagline/.test(page), `${label}: a slot in a shopper's HTML`);
  }
});

await t("rendered: the hero title, a button label, a text paragraph (body.2) and an FAQ question carry data-field equal to validate's field for the same value; the page's title and paragraphs too; live renders carry neither", async () => {
  const want = {
    title: validateField("hero", { title: LONG }),
    button: validateField("hero", { primary: { ...HERO.primary, label: LONG } }),
    body2: validateField("text", { body: ["a", "b", LONG] }),
    faqQ: validateField("faq", { items: [FAQ.items[0], { q: LONG, a: "<p>x</p>" }] }),
    banner: validateField("banner", { button: { ...BANNER.button, label: LONG } }),
  };
  same(want, { title: "title", button: "primary.label", body2: "body.2", faqQ: "items.1.q", banner: "button.label" }, "validate's fields:");
  const s = await session(FV);
  const pv = await homeHtml(FV, { [Res.PREVIEW_COOKIE]: s.token });
  ok(text(pv).includes("Draft glow title"), "the preview shows the draft");
  eq(tagWith(pv, /<h1[^>]*>/).match(/data-field="([^"]*)"/)?.[1], want.title, "hero title:");
  eq(fieldOn(pv, HERO.primary.label), want.button, "hero button label:");
  eq(fieldOn(pv, HERO.subtitle), "subtitle", "hero subtitle:");
  eq(fieldOn(pv, TEXT.body[2]), want.body2, "text paragraph 3:");
  eq(fieldOn(pv, TEXT.body[0]), "body.0", "text paragraph 1:");
  eq(fieldOn(pv, TEXT.title), "title", "text title:");
  eq(fieldOn(pv, FAQ.items[1].q), want.faqQ, "FAQ question 2:");
  ok(/<div class="rte mt-2 text-sm text-sf-text-muted" data-field="items.1.a" data-field-type="rich_text">/.test(pv), "FAQ answer 2 (rich text):");
  eq(fieldOn(pv, BANNER.button.label), want.banner, "banner button:");
  ok(/<section data-sec="hero" data-section-id="sec_hero" data-section-kind="hero"/.test(pv), "the hero keeps data-sec and selects by data-section-id");
  // the FAQ's preview markup is the live accordion's, plus the attributes
  const strip = (x) => x.replace(/ data-field(?:-type)?="[^"]*"/g, "");
  const liveFaq = tagWith(await homeHtml(FV), /<div data-sec="sec_faq"[\s\S]*?<\/section><\/div>/);
  ok(liveFaq, "the live FAQ");
  eq(strip(tagWith(pv, /<div data-sec="sec_faq"[\s\S]*?<\/section><\/div>/)), liveFaq, "FAQ preview markup = live markup:");
  // a content page in the preview
  const ab = await pageHtml(FV, "about", { [Res.PREVIEW_COOKIE]: s.token });
  eq(tagWith(ab, /<h1[^>]*>/).match(/data-field="([^"]*)"/)?.[1], "meta.title", "page title:");
  eq(fieldOn(ab, "Small batches, drafted."), "body.2", "page paragraph 3:");
  // live: neither
  const live = await homeHtml(FV);
  ok(!/data-field=|data-doc=/.test(live), "a live home page carries a preview attribute");
  ok(!/data-field=|data-doc=/.test(await pageHtml(FV, "about")), "a live page carries a preview attribute");
  ok(!/data-field=|data-doc=/.test(await homeHtml(FV, { _admin: "x" })), "a console cookie alone adds none");
});

await t("annotateFields: first match wins in document order, nothing is marked twice, and a section with nothing to mark is returned as it is", () => {
  const el = React.createElement("section", null, React.createElement("h2", null, "Same"), React.createElement("p", null, "Same"));
  const out = html(Map_.annotateFields(el, { kind: "text", settings: { title: "Same", body: ["Same"] } }));
  eq(out, '<section><h2 data-field="title">Same</h2><p data-field="body.0">Same</p></section>');
  const plain = React.createElement("div", null, "nothing");
  eq(Map_.annotateFields(plain, { kind: "text", settings: { title: "Other", body: [] } }), plain, "unchanged element returned as is:");
});

console.log("— 4. after the batch 1 review");

await t("rendered: a documents store whose release pointer names a missing row, or a row that can't be read, renders the error page inside neutral chrome, never 'Opening soon'", async () => {
  await inT(FB, () => libsql.execute("PRAGMA foreign_keys = OFF"));
  for (const [label, setup] of [
    ["a missing row", async () => libsql.execute("UPDATE release_state SET live_release_id = 'rel_missing' WHERE id = 1")],
    [
      "a row that isn't JSON",
      async () => {
        await libsql.execute({ sql: "INSERT OR REPLACE INTO releases (id, content, content_hash, published_at, note, created_at) VALUES ('rel_bad', '{not json', 'h', ?, 'bad', ?)", args: [NOW, NOW] });
        await libsql.execute("UPDATE release_state SET live_release_id = 'rel_bad' WHERE id = 1");
      },
    ],
  ]) {
    await inT(FB, setup);
    const lay = await layoutHtml(FB);
    ok(!lay.includes("Opening soon"), `${label}: the closed page: ${lay.slice(0, 300)}`);
    ok(lay.includes('id="page"'), `${label}: the page renders inside the layout`);
    ok(/<header/.test(lay) && /<footer/.test(lay), `${label}: neutral chrome`);
    ok(!lay.includes("PF fb Store"), `${label}: the store's name in neutral chrome`);
    const meta = await asRequest(FB, () => LayoutModule.generateMetadata());
    ok(!JSON.stringify(meta).includes("Opening soon"), `${label}: closed metadata`);
    let threw = null;
    await homeHtml(FB).catch((e) => (threw = e));
    ok(threw && Res.isContentUnavailable(threw), `${label}: the page itself fails closed (ContentUnavailableError): ${threw?.message}`);
    const err = html(React.createElement(ErrorPage, { error: threw, reset: () => {} }));
    ok(err.includes("Something went wrong"), `${label}: the error page`);
  }
});

await t("rendered: section_render_failed carries the real store id (the render runs outside tfetch)", async () => {
  Reg.defineSection({ kind: "fake_frame_boom", version: 1, label: "Countdown", documentTypes: ["home"], settings: [{ key: "title", kind: "text", label: "Title", max: 80, default: "Ends soon" }] });
  const drop = Map_.registerSectionComponent("fake_frame_boom", () => {
    throw new Error("render exploded");
  });
  try {
    await inT(FJ, async () => {
      const home = await upsert("home", withBody("home", { sections: [sec("hero", "sec_hero", HERO), sec("fake_frame_boom", "sec_boomf")] }), "doc_home");
      await publishAll([home]);
    });
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    let out;
    try {
      out = await asRequest(FJ, async () => htmlAsync(await Home()), { _unit: "unit-frame" });
    } finally {
      console.log = log;
    }
    const failed = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).filter((l) => l.evt === "section_render_failed");
    same(failed.map((l) => [l.tenant, l.sectionId]), [["fj", "sec_boomf"]], "the log line:");
    ok(text(out).includes("Glow from within") && !out.includes("sec_boomf"), "the rest renders, the failed section is left out");
  } finally {
    drop();
    Reg.removeSection("fake_frame_boom");
  }
});

await t("rendered: a closed store's /quiz/<slug> and /bundles/<slug> leak no title, intro, question or bundle copy, in the page render (what an RSC navigation sends) or its metadata; a preview session and an open store still see them", async () => {
  const QUIZ = { title: "Find your serum quiz", intro: "Answer three quick questions", q: "What is your skin type today", opt: "Oily all day" };
  const BUNDLE = { title: "Night ritual set", description: "Everything for a calm night routine" };
  const seed = (T) =>
    inT(T, async () => {
      await libsql.execute({ sql: "INSERT OR REPLACE INTO quizzes (slug, title, intro, questions, enabled, updated_at) VALUES ('skin', ?, ?, ?, 1, ?)", args: [QUIZ.title, QUIZ.intro, JSON.stringify([{ id: "q1", prompt: QUIZ.q, options: [{ id: "o1", label: QUIZ.opt, tags: ["oily"] }, { id: "o2", label: "Dry", tags: ["dry"] }] }]), NOW] });
      await libsql.execute({ sql: "INSERT OR REPLACE INTO bundles (id, slug, title, description, items, bundle_price, enabled, created_at, updated_at) VALUES ('bun-1', 'night', ?, ?, ?, 1500, 1, ?, ?)", args: [BUNDLE.title, BUNDLE.description, JSON.stringify([{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }, { variantId: "gid://shopify/ProductVariant/2", quantity: 1 }]), NOW, NOW] });
    });
  await seed(FC);
  await seed(FV);
  const Quiz = await loadJsx(join(ROOT, "app/(storefront)/quiz/[slug]/page.js"), STUBS);
  const Bundle = await loadJsx(join(ROOT, "app/(storefront)/bundles/[slug]/page.js"), STUBS);
  const words = [QUIZ.title, QUIZ.intro, QUIZ.q, QUIZ.opt, BUNDLE.title, BUNDLE.description];
  const leaks = (s) => words.filter((w) => s.includes(w) || s.includes(w.replace(/'/g, "&#x27;")));
  const render = async (T, mod, slug, cookies = {}) =>
    asRequest(T, async () => {
      const params = Promise.resolve({ slug });
      const meta = await mod.generateMetadata({ params });
      const page = html(await mod.default({ params }));
      return { meta: JSON.stringify(meta), page };
    }, cookies, `/x/${slug}`);
  for (const [mod, slug, label] of [
    [Quiz, "skin", "quiz"],
    [Bundle, "night", "bundle"],
  ]) {
    for (const c of [{}, { _admin: "x" }, { _platform: "x", _mx: "x" }]) {
      const r = await render(FC, mod, slug, c);
      same(leaks(r.page), [], `closed ${label} page (${Object.keys(c).join(",") || "no cookie"}):`);
      same(leaks(r.meta), [], `closed ${label} metadata:`);
      ok(r.page.includes(">Opening soon</h1>"), `closed ${label}: the closed page: ${r.page.slice(0, 200)}`);
      same(JSON.parse(r.meta), { title: { absolute: "PF fc Store · Opening soon" }, description: "Opening soon.", robots: { index: false, follow: false } }, `closed ${label} metadata:`);
    }
    // the full page: the closed layout never renders it either
    ok(!leaks(await layoutHtml(FC)).length, `closed ${label}: layout`);
    // a founder's preview session on the closed store sees it
    const s = await session(FC);
    const pv = await render(FC, mod, slug, { [Res.PREVIEW_COOKIE]: s.token });
    ok(leaks(pv.page).length > 0, `preview: the ${label} should show: ${pv.page.slice(0, 200)}`);
    // an open store: unchanged
    const open = await render(FV, mod, slug);
    ok(leaks(open.page).length > 0 && leaks(open.meta).length > 0, `open store: the ${label} shows`);
  }
});

await t("line 6: PreviewBridge's brandFor draws a palette as the layout draws it saved (brandCssVars on its own kit) and gives null for an unknown id", async () => {
  const PB = await loadJsx(join(ROOT, "components/preview/PreviewBridge.js"), {});
  const { PALETTES } = await import("../lib/themes/palettes.js");
  const { brandCssVars } = await import("../lib/brand.js");
  for (const p of PALETTES) same(PB.brandFor(p.id), { css: brandCssVars(p.brand, { kit: p.kit }), kit: p.kit }, `${p.id}:`);
  for (const bad of ["lime", "", null, undefined, 3, "__proto__"]) eq(PB.brandFor(bad), null, `${String(bad)}:`);
});

await t("line 6, edge safety: everything PreviewBridge pulls in (walked from its imports) uses no node:* module", async () => {
  const seenFiles = new Set();
  const walk = async (file) => {
    if (seenFiles.has(file)) return;
    seenFiles.add(file);
    const src = await readFile(file, "utf8");
    ok(!/from\s+["']node:|require\(["']node:|import\(["']node:/.test(src), `${relative(ROOT, file)} imports a node:* module`);
    for (const [, spec] of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
      if (spec.startsWith("@/")) await walk(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js")));
      else if (spec.startsWith(".")) await walk(resolve(dirname(file), spec + (/\.\w+$/.test(spec) ? "" : ".js")));
      else ok(spec === "react", `${relative(ROOT, file)} imports the package ${spec}`);
    }
  };
  await walk(join(ROOT, "components/preview/PreviewBridge.js"));
  ok(seenFiles.size >= 4, `walked: ${[...seenFiles].map((f) => relative(ROOT, f)).join(", ")}`);
});

await t("edge safety: bridge-core, PreviewBridge, PreviewBanner, EditThisPage and resolve.js import no node:* module", async () => {
  for (const f of ["components/preview/bridge-core.js", "components/preview/PreviewBridge.js", "components/PreviewBanner.js", "components/preview/EditThisPage.js", "lib/content/resolve.js", "lib/documents/paths.js"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!/from\s+["']node:|require\(["']node:|\bBuffer\b|\bprocess\.(?!env)/.test(src), `${f} uses a node API`);
  }
  const core = await readFile(join(ROOT, "components/preview/bridge-core.js"), "utf8");
  ok(!/^import\s/m.test(core), "bridge-core imports nothing");
});

for (const f of dbs) await rm(join(ROOT, f), { force: true });
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
