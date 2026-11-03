// Browser drill for ED-01, the full-width editor. Drives desktop Chrome
// headless over the DevTools protocol (Node's global WebSocket, no new
// dependency) against a RUNNING design harness, signs in with the local test
// password from .design-env (never printed), and measures the real page:
// tree, preview and inspector widths, what each device button renders, the
// tree drawer by keyboard, and no sideways page scroll. Exits 1 if any
// acceptance check fails, so it can fail.
//
// Not part of `pnpm test`: it needs a running server and a real browser.
//   node scripts/dev-design.js seed
//   (start Next on a free port with the same environment dev-design.js sets)
//   node scripts/drill-editor-layout.js --base http://localhost:3037 [--shots docs/cms-reviews/drills/ED-01] [--shot-widths 1440,1280,1024,900] [--json out.json]
// Other options: --widths 1440,1280 --height 900 --pages home,product,collection
//   --classic-scrollbars  scrollbars that take room (15px), like Windows or a
//                         Mac set to always show them, instead of hiding them
// It signs in with a local test password, so it refuses any --base that is not
// this machine (localhost, 127.0.0.1, [::1] or a *.localhost name).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = arg("base");
if (!BASE) {
  console.error("Usage: node scripts/drill-editor-layout.js --base http://localhost:<port> [--shots <dir>] [--json <file>] [--pages home,product,collection]");
  process.exit(2);
}
// The local test password goes to whatever --base says: only ever this machine.
const isLocalBase = (base) => {
  try {
    const u = new URL(base);
    const h = u.hostname.toLowerCase();
    return (u.protocol === "http:" || u.protocol === "https:") && (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost"));
  } catch {
    return false;
  }
};
if (!isLocalBase(BASE)) {
  console.error(`Refusing --base ${BASE}: this drill signs in with the local test password, so it only runs against this machine (localhost, 127.0.0.1, [::1] or *.localhost).`);
  process.exit(2);
}
const SHOTS = arg("shots");
const SHOT_WIDTHS = new Set((arg("shot-widths") || "1440,1280,1024,900").split(",").map(Number));
const JSON_OUT = arg("json");
const PAGES = (arg("pages") || "home,product,collection").split(",");
const PORT = Number(arg("cdp-port") || 9400 + Math.floor(Math.random() * 400));
const WIDTHS = (arg("widths") || "1440,1280,1279,1100,1024,900,768").split(",").map(Number);
const HEIGHT = Number(arg("height") || 900);
const CLASSIC = args.includes("--classic-scrollbars");
// Chrome on a Mac uses overlay scrollbars that take no room. Styling the
// scrollbar makes it a classic one, 15px wide, in every document and frame.
const CLASSIC_CSS = "::-webkit-scrollbar{width:15px;height:15px;background:#eee}::-webkit-scrollbar-thumb{background:#999}";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the acceptance numbers (spec ED-01) ---------------------------------------
const MIN = { desktopAt1440: 900, tree: 220, preview: 600, inspector: 280 };
const STATED = { Mobile: 375, Tablet: 768, Desktop: 1280 };

// ---- Chrome ------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "drill-ed01-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", ...(CLASSIC ? [] : ["--hide-scrollbars"]), "about:blank"],
  { stdio: "ignore" }
);
let ws;
let seq = 0;
const pending = new Map();
const listeners = new Set();
async function connect() {
  let targets = [];
  for (let i = 0; i < 60 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    } catch {}
    if (!targets.some((t) => t.type === "page")) await sleep(200);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("Chrome did not start");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    // the long-tree check leaves unsaved sections behind: leave without asking
    if (m.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, timeout = 45000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await evaluate(expression);
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${expression.slice(0, 100)}`);
};
const viewport = (width) => send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
async function navigate(url) {
  const loaded = new Promise((r) => {
    const fn = (m) => m.method === "Page.loadEventFired" && (listeners.delete(fn), r());
    listeners.add(fn);
  });
  await send("Page.navigate", { url });
  await Promise.race([loaded, sleep(45000)]);
}
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
async function press(key, times = 1) {
  for (let i = 0; i < times; i++) {
    const p = { key, code: key, windowsVirtualKeyCode: KEYS[key] };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p });
    if (key === "Enter") await send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...p });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
    await sleep(60);
  }
}
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const m = await send("Page.getLayoutMetrics");
  const w = m.cssLayoutViewport.clientWidth;
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: HEIGHT, scale: w > 1100 ? 0.5 : 0.6 } });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
}

// ---- results -----------------------------------------------------------------
const results = [];
let failed = 0;
function check(page, width, name, okay, detail) {
  results.push({ page, width, name, ok: !!okay, detail });
  if (!okay) failed++;
  console.log(`${okay ? "✓" : "✗"} ${page} @${width}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// One read of the page. Prefers the shell's data attributes, and falls back to
// the pre-ED-01 structure so the drill reports numbers on old code too.
const MEASURE = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const shown = r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; return { x: Math.round(r.x), w: Math.round(r.width * 10) / 10, h: Math.round(r.height), shown }; };
  // what the founder can actually see of an element: its box cut by every
  // ancestor that clips, and by the window
  const visible = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); let l = r.left, rt = r.right; for (let p = el.parentElement; p; p = p.parentElement) { if (getComputedStyle(p).overflowX !== 'visible') { const pr = p.getBoundingClientRect(); l = Math.max(l, pr.left); rt = Math.min(rt, pr.right); } } l = Math.max(l, 0); rt = Math.min(rt, innerWidth); return Math.max(0, Math.round((rt - l) * 10) / 10); };
  const frame = document.querySelector('iframe[title*="preview" i]');
  const oldPane = frame ? frame.closest('.min-w-0') : null;
  const oldGrid = oldPane ? oldPane.parentElement : null;
  const oldKids = oldGrid ? [...oldGrid.children] : [];
  const sectionsH2 = [...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'Sections');
  const tree = document.querySelector('[data-editor-pane="tree"]') || (sectionsH2 ? sectionsH2.closest('section') : null);
  const preview = document.querySelector('[data-editor-pane="preview"]') || oldPane;
  const inspector = document.querySelector('[data-editor-pane="inspector"]') || (oldKids.length ? oldKids[oldKids.length - 1] : null);
  let inner = null;
  try { inner = frame && frame.contentWindow ? frame.contentWindow.innerWidth : null; } catch {}
  const caption = document.querySelector('[data-frame-caption]');
  const consoleNav = [...document.querySelectorAll('aside')].find((a) => a.querySelector('a[href="/admin/dashboard"]'));
  const se = document.scrollingElement;
  return {
    tree: box(tree), preview: box(preview), inspector: box(inspector), frame: box(frame), seen: visible(frame), frameBox: box(frame ? frame.parentElement : null),
    frameInner: inner, frameCss: frame ? frame.offsetWidth : null,
    caption: caption ? caption.textContent.trim() : null,
    consoleNav: box(consoleNav),
    treeToggle: !!document.querySelector('[data-tree-toggle]'),
    treeToggleShown: (() => { const b = document.querySelector('[data-tree-toggle]'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && getComputedStyle(b).display !== 'none'; })(),
    menuButton: !!document.querySelector('[data-console-menu]'),
    pageScrollX: se.scrollWidth - se.clientWidth,
    pageScrollY: se.scrollHeight - se.clientHeight,
    shellBottom: (() => { const e = document.querySelector('[data-editor-shell]'); return e ? Math.round(e.getBoundingClientRect().bottom) : null; })(),
    viewH: innerHeight,
    scrollbar: (() => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;top:-999px;width:100px;height:100px;overflow:scroll'; document.body.appendChild(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w; })(),
    inspectorScrollX: (() => { const e = document.querySelector('[data-editor-pane="inspector"]'); return e ? e.scrollWidth - e.clientWidth : null; })(),
    inspectorBar: (() => { const e = document.querySelector('[data-editor-pane="inspector"]'); if (!e) return null; const cs = getComputedStyle(e); return e.offsetWidth - e.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth); })(),
    topBar: (() => { const h = document.querySelector('[data-editor-shell] > header'); return h ? Math.round(h.getBoundingClientRect().height) : null; })(),
    storeName: (() => { const e = document.querySelector('[data-store-name]'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).display !== 'none' ? e.textContent.trim() : ''; })(),
  };
})()`;

const device = (label) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

async function settleFrame() {
  await waitFor(`!!document.querySelector('iframe[title*="preview" i]')`);
  await waitFor(`(() => { try { const f = document.querySelector('iframe[title*="preview" i]'); return f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentWindow.location.href !== 'about:blank'; } catch { return false; } })()`);
  await sleep(600);
}

// Console paths live here as plain strings: test:shopify-boundary treats an admin
// path glued straight onto a variable as a possible Shopify Admin REST call.
const PAGE_URL = { home: "/admin/storefront/designer", product: "/admin/storefront/designer/product", collection: "/admin/storefront/designer/collection", overview: "/admin/storefront" };
const CTX = {
  product: ["storeasy-designer-ctx-pdp", { id: "gid://p/1", handle: "glow-serum", title: "Radiance Glow Serum 30ml" }],
  collection: ["storeasy-designer-ctx-collection", { id: "gid://c/2", handle: "serums", title: "Serums" }],
};

async function measurePage(page, width) {
  await viewport(width);
  if (CTX[page]) {
    await navigate(`${BASE}${PAGE_URL[page]}`);
    await evaluate(`sessionStorage.setItem(${JSON.stringify(CTX[page][0])}, ${JSON.stringify(JSON.stringify(CTX[page][1]))})`);
  }
  await navigate(`${BASE}${PAGE_URL[page]}`);
  await settleFrame();
  const per = {};
  for (const d of ["Mobile", "Tablet", "Desktop"]) {
    if (!(await device(d))) throw new Error(`no ${d} button`);
    await sleep(350);
    per[d] = await evaluate(MEASURE);
  }
  if (SHOT_WIDTHS.has(width)) await shot(`after-${page}-${width}`);
  const m = per.Desktop;
  const hasTree = page === "home";

  if (width === 1440) check(page, width, `Desktop preview at least ${MIN.desktopAt1440}px on screen`, m.seen >= MIN.desktopAt1440, `frame ${m.seen}px seen, preview pane ${m.preview?.w}px`);
  if (width >= 1280) {
    if (hasTree) check(page, width, `tree docked, at least ${MIN.tree}px`, m.tree?.shown && m.tree.w >= MIN.tree, `tree ${m.tree?.shown ? m.tree.w : "not shown"}`);
    if (hasTree) check(page, width, "no Sections drawer button while the tree is docked", !m.treeToggleShown, `button shown ${m.treeToggleShown}`);
    check(page, width, `inspector at least ${MIN.inspector}px`, m.inspector?.shown && m.inspector.w >= MIN.inspector, `inspector ${m.inspector?.w}px`);
  }
  if (width === 1280 || width < 1280) check(page, width, `Desktop preview at least ${MIN.preview}px`, m.seen >= MIN.preview && m.preview?.w >= MIN.preview, `frame ${m.seen}px seen, pane ${m.preview?.w}px`);
  if (width < 1280 && hasTree) check(page, width, "tree is a drawer, not a pane", !m.tree?.shown && m.treeToggleShown, `tree ${m.tree?.shown ? `shown ${m.tree.w}px` : "hidden"}, drawer button ${m.treeToggle}`);
  if (width >= 1024) check(page, width, "the editor fits the window: the page itself does not scroll", m.pageScrollY <= 0, `page scrolls ${m.pageScrollY}px`);
  if (width >= 1024) check(page, width, "the editor fills the window down to its bottom edge", m.shellBottom != null && Math.abs(m.shellBottom - m.viewH) <= 2 && m.frame?.h >= m.viewH * 0.6, `editor ends at ${m.shellBottom}px of ${m.viewH}px, frame ${m.frame?.h}px tall`);
  if (width >= 1024) check(page, width, "inspector beside the preview", m.inspector?.shown && m.preview && m.inspector.x >= m.preview.x + m.preview.w - 1, `preview ends ${m.preview ? m.preview.x + m.preview.w : "?"}, inspector starts ${m.inspector?.x}`);
  check(page, width, "console navigation folded away, menu button present", !m.consoleNav?.shown && m.menuButton, `sidebar ${m.consoleNav?.shown ? `${m.consoleNav.w}px` : "hidden"}, menu ${m.menuButton}`);
  if (CLASSIC) check(page, width, "classic scrollbars are on and take room", m.scrollbar >= 15, `scrollbar ${m.scrollbar}px`);
  if (width >= 1280) check(page, width, "the store's name is in the top bar, which stays one row", !!m.storeName && m.topBar <= 60, `name "${m.storeName}", top bar ${m.topBar}px tall`);
  else check(page, width, "below 1280 the store's name is only in the menu", m.storeName === "", `name ${JSON.stringify(m.storeName)}`);
  check(page, width, "the inspector's content fits its pane: nothing cut off sideways", m.inspectorScrollX != null && m.inspectorScrollX <= 0, `sideways overflow ${m.inspectorScrollX}px, scrollbar ${m.inspectorBar}px`);

  for (const d of ["Mobile", "Tablet", "Desktop"]) {
    const x = per[d];
    const inner = x.frameInner;
    const onScreen = x.seen;
    const actual = Math.abs(onScreen - STATED[d]) < 1.5;
    const pct = x.caption?.match(/(\d+)%/);
    const labelled = !actual && pct && Math.abs(Number(pct[1]) - (onScreen / STATED[d]) * 100) <= 1;
    check(page, width, `${d} renders at ${STATED[d]}px`, inner === STATED[d], `page inside is ${inner}px wide`);
    check(page, width, `${d} actual size, or scaled and labelled`, actual || labelled, `on screen ${onScreen}px, caption "${x.caption ?? "none"}"`);
    check(page, width, `${d}: the page's whole width is in view, not cut off`, x.frame && x.seen >= x.frame.w - 1, `frame box ${x.frame?.w}px, in view ${x.seen}px`);
    const inside = (b) => b && x.preview && b.x >= x.preview.x - 0.5 && b.x + b.w <= x.preview.x + x.preview.w + 0.5;
    check(page, width, `${d}: the frame stays inside the preview pane`, inside(x.frame) && inside(x.frameBox), `pane ${x.preview?.x}+${x.preview?.w}, frame ${x.frame?.x}+${x.frame?.w}, its box ${x.frameBox?.x}+${x.frameBox?.w}`);
    check(page, width, `${d}: no sideways page scroll`, x.pageScrollX <= 0, `scroll ${x.pageScrollX}px`);
  }
  check(page, width, "negative: Desktop never narrower than Mobile", per.Desktop.seen >= per.Mobile.seen && per.Desktop.frameInner >= per.Mobile.frameInner, `Desktop ${per.Desktop.seen}px on screen / ${per.Desktop.frameInner}px page, Mobile ${per.Mobile.seen}px / ${per.Mobile.frameInner}px`);
  return per;
}

// The tree drawer, by keyboard only: Tab reaches the button, Enter opens it,
// focus is inside, Tab stays inside, Escape closes, focus goes back.
async function drawerByKeyboard(width) {
  await viewport(width);
  await navigate(`${BASE}${PAGE_URL.home}`);
  await settleFrame();
  await evaluate(`document.activeElement && document.activeElement.blur(), true`);
  let tabs = 0;
  let onToggle = false;
  while (tabs < 40 && !onToggle) {
    await press("Tab");
    tabs++;
    onToggle = await evaluate(`!!(document.activeElement && document.activeElement.matches('[data-tree-toggle]'))`);
  }
  check("home", width, "keyboard: Tab reaches the Sections button", onToggle, `after ${tabs} Tab presses`);
  if (!onToggle) return;
  await press("Enter");
  await sleep(400);
  const opened = await evaluate(`(() => { const d = document.querySelector('dialog[open]'); return { open: !!d, focusInside: !!(d && d.contains(document.activeElement)), hasTree: !!(d && [...d.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'Sections')), hasAdd: !!(d && [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Add section')), expanded: document.querySelector('[data-tree-toggle]').getAttribute('aria-expanded'), treesInPage: [...document.querySelectorAll('h2')].filter((h) => h.textContent.trim() === 'Sections').length }; })()`);
  check("home", width, "keyboard: Enter opens the drawer with the tree, focus inside", opened.open && opened.focusInside && opened.hasTree && opened.hasAdd && opened.expanded === "true", JSON.stringify(opened));
  check("home", width, "the open drawer holds the only copy of the tree", opened.treesInPage === 1, `${opened.treesInPage} trees in the page`);
  await shot(`after-home-${width}-drawer`);
  let escaped = 0;
  for (let i = 0; i < 12; i++) {
    await press("Tab");
    const where = await evaluate(`(() => { const d = document.querySelector('dialog[open]'); const a = document.activeElement; if (!a || a === document.body) return 'none'; return d && d.contains(a) ? 'inside' : 'outside:' + (a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30)); })()`);
    if (where.startsWith("outside")) escaped++;
  }
  check("home", width, "keyboard: Tab never leaves the open drawer", escaped === 0, `${escaped} of 12 Tab presses landed outside`);
  const state = `({ open: !!document.querySelector('dialog[open]'), focusBack: !!(document.activeElement && document.activeElement.matches('[data-tree-toggle]')), expanded: document.querySelector('[data-tree-toggle]').getAttribute('aria-expanded') })`;
  await press("Escape");
  await sleep(400);
  const closed = await evaluate(state);
  check("home", width, "keyboard: Escape closes it and focus returns to the button", !closed.open && closed.focusBack && closed.expanded === "false", JSON.stringify(closed));

  // pick Hero inside the drawer: the drawer closes and the inspector shows Hero
  await press("Enter");
  await sleep(400);
  await evaluate(`(() => { const d = document.querySelector('dialog[open]'); const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Hero'); b.focus(); return true; })()`);
  await press("Enter");
  await sleep(400);
  const picked = await evaluate(`(() => { const s = ${state}; return { ...s, hero: !!document.querySelector('[data-editor-pane="inspector"] #ins-hero-title') }; })()`);
  check("home", width, "keyboard: picking a section in the drawer closes it and opens the section in the inspector, focus back on the button", picked.hero && !picked.open && picked.focusBack && picked.expanded === "false", JSON.stringify(picked));
  await shot(`after-home-${width}-picked`);

  // a control in the tree that is not a pick (Add section) keeps the drawer open
  await press("Enter");
  await sleep(400);
  const added = await evaluate(`(() => { const d = document.querySelector('dialog[open]'); const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add section'); if (!b) return { open: !!d, button: false }; b.click(); return new Promise((r) => setTimeout(() => r({ open: !!document.querySelector('dialog[open]'), button: true, list: !!document.querySelector('dialog[open] [aria-label="Section types"]') }), 300)); })()`);
  check("home", width, "a tree control that is not a pick (Add section) keeps the drawer open", added.open && added.button && added.list, JSON.stringify(added));
  await evaluate(`(() => { const d = document.querySelector('dialog[open]'); const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Add section'); b && b.click(); return true; })()`);
  await evaluate(`(() => { const d = document.querySelector('dialog[open]'); const c = d && d.querySelector('button[aria-label^="Close"]'); c && c.focus(); return !!c; })()`);
  await press("Enter");
  await sleep(400);

  // the close button works by keyboard too
  await press("Enter");
  await sleep(400);
  const first = await evaluate(`(() => { const d = document.querySelector('dialog[open]'); return d ? (document.activeElement.getAttribute('aria-label') || '') : null; })()`);
  await evaluate(`(() => { const d = document.querySelector('dialog[open]'); const c = d && d.querySelector('button[aria-label^="Close"]'); c && c.focus(); return !!c; })()`);
  await press("Enter");
  await sleep(400);
  const viaButton = await evaluate(`({ open: !!document.querySelector('dialog[open]'), focusBack: !!(document.activeElement && document.activeElement.matches('[data-tree-toggle]')) })`);
  check("home", width, "keyboard: the drawer opens on its close button, which closes it, focus returns", first === "Close sections" && !viaButton.open && viaButton.focusBack, `first focus in drawer: "${first}", after: ${JSON.stringify(viaButton)}`);

  // widening the window with the drawer open docks the tree and closes the drawer,
  // and the page in the frame is resized, not reloaded
  await evaluate(`(() => { try { document.querySelector('iframe[title*="preview" i]').contentWindow.__drillMark = 1; return true; } catch { return false; } })()`);
  await press("Enter");
  await sleep(300);
  await viewport(1440);
  await sleep(600);
  const docked = await evaluate(`(() => { const t = document.querySelector('[data-editor-pane="tree"]'); const r = t && t.getBoundingClientRect(); return { open: !!document.querySelector('dialog[open]'), treeShown: !!(r && r.width > 0), sectionsHeadings: [...document.querySelectorAll('h2')].filter((h) => h.textContent.trim() === 'Sections').length }; })()`);
  check("home", width, "widening past 1280 with the drawer open: drawer closes, tree docks, one tree", !docked.open && docked.treeShown && docked.sectionsHeadings === 1, JSON.stringify(docked));
  const kept = await evaluate(`(() => { try { const f = document.querySelector('iframe[title*="preview" i]'); return { mark: f.contentWindow.__drillMark === 1, inner: f.contentWindow.innerWidth, caption: document.querySelector('[data-frame-caption]').textContent.trim() }; } catch (e) { return { error: String(e) }; } })()`);
  check("home", width, "resizing the window refits the frame without reloading the page in it", kept.mark && kept.inner === 1280 && /71%/.test(kept.caption), JSON.stringify(kept));
}

async function consoleMenu(width) {
  await viewport(width);
  await navigate(`${BASE}${PAGE_URL.home}`);
  // the button is in the server HTML before React hydrates; the preview frame
  // only mounts after hydration, so wait for it before clicking
  await settleFrame();
  const has = await evaluate(`!!document.querySelector('[data-console-menu]')`);
  if (!has) return check("home", width, "console menu opens the store navigation", false, "no menu button");
  await evaluate(`document.querySelector('[data-console-menu]').click(), true`);
  await sleep(400);
  const r = await evaluate(`(() => { const d = document.querySelector('dialog[open]'); return { open: !!d, links: d ? d.querySelectorAll('a[href^="/admin/"]').length : 0, designer: !!(d && d.querySelector('a[href="/admin/storefront/designer"]')) }; })()`);
  check("home", width, "console menu opens the store navigation", r.open && r.links > 10 && r.designer, JSON.stringify(r));
  await shot(`after-home-${width}-console-menu`);
  await press("Escape");
  await sleep(300);
  await evaluate(`document.activeElement && document.activeElement.blur(), true`);
  let tabs = 0;
  let onMenu = false;
  while (tabs < 20 && !onMenu) {
    await press("Tab");
    tabs++;
    onMenu = await evaluate(`!!(document.activeElement && document.activeElement.matches('[data-console-menu]'))`);
  }
  await press("Enter");
  await sleep(400);
  const kb = await evaluate(`(() => { const d = document.querySelector('dialog[open]'); return { open: !!d, focusInside: !!(d && d.contains(document.activeElement)) }; })()`);
  await press("Escape");
  await sleep(400);
  const back = await evaluate(`({ open: !!document.querySelector('dialog[open]'), focusBack: !!(document.activeElement && document.activeElement.matches('[data-console-menu]')) })`);
  check("home", width, "keyboard: the menu button opens the navigation, Escape closes it, focus returns", onMenu && kb.open && kb.focusInside && !back.open && back.focusBack, `Tab presses ${tabs}, opened ${JSON.stringify(kb)}, after Escape ${JSON.stringify(back)}`);
}

// A store with many sections: the tree scrolls inside its own pane (or the
// drawer, below 1280), the page itself never scrolls, and the last section is
// reachable. The sections are added in the editor and never saved.
async function longTree(width, count = 24) {
  await viewport(width);
  await navigate(`${BASE}${PAGE_URL.home}`);
  await settleFrame();
  const docked = width >= 1280;
  if (!docked) {
    await evaluate(`document.querySelector('[data-tree-toggle]').click(), true`);
    await sleep(400);
  }
  const rows = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = () => document.querySelector('dialog[open]') || document.querySelector('[data-editor-pane="tree"]');
    for (let i = 0; i < ${count}; i++) {
      const add = root() && [...root().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add section');
      if (!add) return -1;
      add.click();
      await wait(80);
      const kind = root().querySelector('[aria-label="Section types"] button');
      if (!kind) return -2;
      kind.click();
      await wait(80);
    }
    return root().querySelectorAll('[data-tree-pick]').length;
  })()`);
  await sleep(300);
  const r = await evaluate(`(() => {
    const se = document.scrollingElement;
    const d = document.querySelector('dialog[open]');
    const pane = d ? [...d.querySelectorAll('div')].find((x) => getComputedStyle(x).overflowY === 'auto') : document.querySelector('[data-editor-pane="tree"]');
    if (!pane) return { pane: false };
    const before = { client: pane.clientHeight, scroll: pane.scrollHeight, bottom: Math.round(pane.getBoundingClientRect().bottom) };
    pane.scrollTop = pane.scrollHeight;
    const picks = pane.querySelectorAll('[data-tree-pick]');
    const last = picks[picks.length - 1].getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    return { pane: true, drawer: !!d, ...before, pageScrollY: se.scrollHeight - se.clientHeight, lastInView: last.top >= pr.top - 1 && last.bottom <= pr.bottom + 1, viewH: innerHeight };
  })()`);
  check("home", width, `long tree (${rows} rows): the page itself does not scroll`, r.pane && r.pageScrollY <= 0, JSON.stringify(r));
  check("home", width, `long tree: it scrolls inside its own ${docked ? "pane" : "drawer"}, which ends inside the window, and the last section is reachable`, r.pane && r.drawer === !docked && r.scroll > r.client && r.bottom <= r.viewH + 1 && r.lastInView, JSON.stringify(r));
  await shot(`after-home-${width}-long-tree`);
}

// Ordinary console pages keep their capped layout and the sidebar.
async function ordinaryPage(width) {
  await viewport(width);
  await navigate(`${BASE}${PAGE_URL.overview}`);
  await waitFor(`!!document.querySelector('main')`);
  await sleep(500);
  const r = await evaluate(`(() => { const m = document.querySelector('main'); const a = [...document.querySelectorAll('aside')].find((x) => x.querySelector('a[href="/admin/dashboard"]')); return { main: Math.round(m.getBoundingClientRect().width), maxWidth: getComputedStyle(m).maxWidth, sidebar: a ? Math.round(a.getBoundingClientRect().width) : 0, menu: !!document.querySelector('[data-console-menu]') }; })()`);
  check("storefront", width, "other console pages unchanged: sidebar shown, page capped at 1024px", r.sidebar >= 60 && r.main <= 1024 && !r.menu, JSON.stringify(r));
}

// ---- run ---------------------------------------------------------------------
const out = { base: BASE, at: new Date().toISOString(), pages: {} };
try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  if (CLASSIC) {
    const css = JSON.stringify(CLASSIC_CSS);
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const add = () => { const s = document.createElement('style'); s.textContent = ${css}; (document.head || document.documentElement).appendChild(s); }; if (document.head) add(); else document.addEventListener('DOMContentLoaded', add); })()`,
    });
  }
  await viewport(1440);
  const pw = readFileSync(join(ROOT, ".design-env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("DESIGN_ADMIN_PASSWORD="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!pw) throw new Error(".design-env has no DESIGN_ADMIN_PASSWORD: run node scripts/dev-design.js seed first");
  await navigate(`${BASE}/admin/login`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await evaluate(
      `fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"",password:${JSON.stringify(pw)}})}).then(async (r) => ({ status: r.status, retry: Number(r.headers.get("Retry-After") || 0) }))`
    );
    if (r.status === 200) break;
    if (r.status === 429 && attempt < 2) {
      console.log(`sign-in rate limited, waiting ${r.retry}s`);
      await sleep((r.retry + 1) * 1000);
      continue;
    }
    throw new Error(`sign-in failed with ${r.status}`);
  }

  for (const page of PAGES) {
    out.pages[page] = {};
    for (const w of WIDTHS) {
      try {
        out.pages[page][w] = await measurePage(page, w);
      } catch (e) {
        check(page, w, "page measured", false, e.message);
      }
    }
  }
  if (PAGES.includes("home")) {
    for (const w of [1024, 1279]) {
      try {
        await drawerByKeyboard(w);
      } catch (e) {
        check("home", w, "drawer by keyboard", false, e.message);
      }
    }
    try {
      await consoleMenu(1440);
      await ordinaryPage(1440);
    } catch (e) {
      check("home", 1440, "console menu", false, e.message);
    }
    // last: these leave unsaved sections in the editor
    for (const w of [1280, 1024]) {
      try {
        await longTree(w);
      } catch (e) {
        check("home", w, "long tree", false, e.message);
      }
    }
  }
} catch (e) {
  failed++;
  console.error(`✗ drill stopped: ${e.message}`);
} finally {
  try {
    await send("Browser.close");
  } catch {}
  await sleep(300);
  try {
    chrome.kill("SIGTERM");
  } catch {}
  rmSync(profile, { recursive: true, force: true });
}
out.results = results;
out.passed = results.filter((r) => r.ok).length;
out.failed = failed;
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
console.log(`\n${out.passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
