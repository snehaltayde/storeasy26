// Phase 1 line 6 suite: palette, logo and live preview in onboarding step 3.
//   1. brandModel.js (pure): the form, dirty, the preview's overlay message,
//      the kept unsaved choices, the snippet, the moved save helpers
//   2. createPreviewController's hello option (look mode)
//   3. BrandStepPanel mounted per role (owner, staff, support) with a small
//      hook driver and a mock fetch, no DOM: keep / undo / clear of unsaved
//      choices, the overlay sent to the preview, Save, Skip, 409 with "Load
//      the latest", the logo upload, the preview's waiting words
//   4. shopper markup: Header and Footer carry the logo and tagline slots
//      only in a documents preview (editing)
// The frame side (bridge-core look mode and the brand message) is
// scripts/test-preview-frame.js; the save route is scripts/test-brand-step.js.
//   pnpm test:onboarding-brand
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    return next(spec, ctx);
  },
});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 4).join("\n    ") || e.message}`);
  }
}
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};
const eq = (got, want, m = "") => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${m}\n      expected ${b}\n      got      ${a}`);
};

const M = await import("../components/admin/onboarding/brandModel.js");
const Pal = await import("../lib/themes/palettes.js");
const E = await import("../components/admin/editor/editorModel.js");

// =====================================================================================
console.log("— 1. brandModel (pure)");

const SAVED = M.formOf({ paletteId: "slate", logo: null, description: "Old tagline" });

await t("formOf reads the GET's current; isDirty compares palette, logo, alt (trimmed, only with a logo) and description", () => {
  eq(SAVED, { paletteId: "slate", logo: null, alt: "", description: "Old tagline" }, "saved:");
  eq(M.formOf({ paletteId: null, logo: { media: "/api/media/med_a", alt: "A" }, description: 3 }), { paletteId: null, logo: { media: "/api/media/med_a" }, alt: "A", description: "" }, "own colours, a logo:");
  eq(M.isDirty(SAVED, { ...SAVED }), false, "same:");
  eq(M.isDirty({ ...SAVED, paletteId: "forest" }, SAVED), true, "palette:");
  eq(M.isDirty({ ...SAVED, logo: { media: "/api/media/med_a" } }, SAVED), true, "logo:");
  eq(M.isDirty({ ...SAVED, alt: "x" }, SAVED), false, "an alt with no logo is nothing:");
  const withLogo = { ...SAVED, logo: { media: "/api/media/med_a" }, alt: "A" };
  eq(M.isDirty({ ...withLogo, alt: " A " }, withLogo), false, "alt trimmed:");
  eq(M.isDirty({ ...withLogo, alt: "B" }, withLogo), true, "alt:");
  eq(M.isDirty({ ...SAVED, description: "New" }, SAVED), true, "description:");
  eq(M.isDirty(null, SAVED), false, "no form yet:");
});

await t("overlayMessage: all null while the form equals what is saved; else the palette id, the logo (false for none, the alt falling back to the store name) and the description, never CSS", () => {
  eq(M.overlayMessage(SAVED, SAVED, { storeName: "Acme" }), { type: "storeasy:brand", paletteId: null, logo: null, description: null }, "clean:");
  eq(M.overlayMessage({ ...SAVED, paletteId: "forest" }, SAVED, { storeName: "Acme" }), { type: "storeasy:brand", paletteId: "forest", logo: false, description: "Old tagline" }, "forest:");
  eq(M.overlayMessage({ ...SAVED, logo: { media: "/api/media/med_a" }, alt: "  " }, SAVED, { storeName: "Acme" }).logo, { media: "/api/media/med_a", alt: "Acme" }, "alt falls back to the store name:");
  eq(M.overlayMessage({ ...SAVED, logo: { media: "/api/media/med_a" }, alt: "Mark" }, SAVED, { storeName: "Acme" }).logo, { media: "/api/media/med_a", alt: "Mark" }, "the founder's alt:");
  eq(M.overlayMessage({ ...SAVED, paletteId: "lime", description: "x" }, SAVED).paletteId, null, "an unknown id is never sent:");
  eq(M.overlayMessage({ ...SAVED, logo: { media: "https://evil.test/x.png" } }, SAVED).logo, false, "an address that isn't the library's is never sent:");
  eq(M.overlayMessage({ ...SAVED, description: "y".repeat(300) }, SAVED).description.length, 160, "capped:");
  const owned = M.formOf({ paletteId: null, logo: null, description: "" });
  eq(M.overlayMessage({ ...owned, description: "New" }, owned).paletteId, null, "own colours stay the page's own:");
  ok(!JSON.stringify(M.overlayMessage({ ...SAVED, paletteId: "clay" }, SAVED)).includes("--"), "no CSS in the message");
});

await t("unsaved choices: keepDraft keeps only a dirty form, takeDraft reads it back checked (unknown palette, an outside logo, junk: null; text capped), clearDraft clears; a throwing storage loses only the keeping", () => {
  const mem = new Map();
  const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const forest = { ...SAVED, paletteId: "forest" };
  M.keepDraft(st, forest, SAVED);
  eq(M.takeDraft(st), forest, "kept:");
  M.keepDraft(st, SAVED, SAVED);
  eq(mem.has(M.DRAFT_KEY), false, "a clean form clears it:");
  M.keepDraft(st, forest, SAVED);
  M.clearDraft(st);
  eq(M.takeDraft(st), null, "cleared:");
  for (const raw of ["{", "null", JSON.stringify({ v: 2, form: forest }), JSON.stringify({ v: 1, form: { ...forest, paletteId: "lime" } }), JSON.stringify({ v: 1, form: { ...forest, logo: { media: "javascript:alert(1)" } } })]) eq(M.readDraft(raw), null, `refused: ${raw.slice(0, 60)}`);
  eq(M.readDraft(M.draftText({ ...forest, description: "a\nb" + "z".repeat(400) })).description.length, 160, "capped:");
  eq(M.readDraft(M.draftText({ ...forest, description: "a\nb" })).description, "a b", "one line:");
  const throws = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  M.keepDraft(throws, forest, SAVED);
  eq(M.takeDraft(throws), null, "throwing storage:");
  M.clearDraft(throws);
  M.keepDraft(null, forest, SAVED);
});

await t("snippetOf: the store's name, its address as https and the line (capped); the moved helpers still hold (saveBody, savedLines, viewOf, afterMake, hasHomeFor, paletteStyle)", () => {
  eq(M.snippetOf({ storeName: "Acme", address: "acme.storeasy.app", description: "Soft serums" }), { title: "Acme", url: "https://acme.storeasy.app", text: "Soft serums" }, "snippet:");
  eq(M.snippetOf({ storeName: "Acme", address: null, description: "" }).url, "", "no address:");
  eq(M.saveBody({ paletteId: "ink", logo: { media: "/api/media/m" }, alt: " ", description: "x", canEditDescription: false, revision: 3 }), { paletteId: "ink", logo: { media: "/api/media/m" }, revision: 3 }, "saveBody without the description:");
  eq(M.savedLines({ liveNow: ["description"], storeOpen: true, afterPublish: ["colours"] }), ["Saved.", M.BRAND_WORDS.descriptionLiveNow, M.BRAND_WORDS.afterPublish], "savedLines:");
  eq(M.viewOf({ generated: true, byGenerator: ["doc_home"] }, null), "ready", "viewOf ready:");
  eq(M.viewOf({ generated: false, eligible: true }, { state: "complete" }), "make", "viewOf make:");
  eq(M.afterMake({ empty: false }, { created: ["doc_home"], skipped: [], summary: { paletteId: "slate" } }).generated, true, "afterMake:");
  eq(["ready", "kept", "half", "syncing", "making", "blocked"].map((s) => M.hasHomeFor(s, {})), [true, true, true, false, false, false], "hasHomeFor:");
  eq(M.hasHomeFor("blocked", { reason: "live" }), true, "an open store has its home:");
  eq(M.paletteStyle(Pal.paletteById("forest").brand)["--accent-500"], Pal.paletteById("forest").brand.accent, "paletteStyle:");
});

// =====================================================================================
console.log("— 2. the preview controller's hello");

await t("createPreviewController answers a v1 ready with its hello: the editor's by default, look mode when asked; a v2 ready is taken as before", async () => {
  const run = async (hello) => {
    const posted = [];
    const ctl = E.createPreviewController({ api: { startDocumentsPreview: async () => ({ ok: true, sid: "ps_0000000000000001" }), setShowDesign: async () => ({ ok: true }) }, timers: { setTimeout: () => 0, clearTimeout() {} }, documentId: "doc_design", frame: { setSrc() {}, post: (m) => posted.push(m), currentPath: () => "/" }, ...(hello ? { hello } : {}) });
    await ctl.start();
    ctl.frameLoad();
    ctl.message({ type: "storeasy:ready" });
    ctl.message({ type: "storeasy:ready", v: 2, ok: true, state: { kind: "documents", sid: "ps_0000000000000001", docs: {}, skipped: [], designShown: true }, unfinished: [] });
    return { posted, view: ctl.view() };
  };
  const plain = await run(null);
  eq(plain.posted, [{ type: "storeasy:editor:hello", v: 2 }], "default:");
  const look = await run({ type: "storeasy:editor:hello", v: 2, look: true });
  eq(look.posted, [{ type: "storeasy:editor:hello", v: 2, look: true }], "look:");
  eq(look.view.phase, "shown", "the ready is taken:");
});

// =====================================================================================
console.log("— 3. BrandStepPanel, mounted per role (its hooks run; no DOM)");

const require = createRequire(import.meta.url);
const React = require("react");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) => (await swc.transform(await readFile(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
const isJsx = (f) => /\/(components|app)\//.test(f);
const fileOf = async (from, id) => {
  const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
  if (base.endsWith(".js")) return base;
  try {
    await readFile(`${base}.js`);
    return `${base}.js`;
  } catch {
    return join(base, "index.js");
  }
};
function world(stubs) {
  const cache = new Map();
  return async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const code = await compile(file);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || local.has(id) || !(id.startsWith("@/") || id.startsWith("."))) continue;
      const target = await fileOf(file, id);
      local.set(id, isJsx(target) ? await load(target) : await import(pathToFileURL(target).href));
    }
    new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  };
}
// hooks: each component its own slots; effects after each draw
function driver() {
  const slots = new Map();
  let cur = null;
  let cursor = 0;
  let effects = [];
  let dirty = false;
  const hooks = {
    useState(init) {
      const box = cur;
      const k = cursor++;
      if (!(k in box)) box[k] = typeof init === "function" ? init() : init;
      return [box[k], (v) => {
        const nv = typeof v === "function" ? v(box[k]) : v;
        if (!Object.is(nv, box[k])) (box[k] = nv), (dirty = true);
      }];
    },
    useRef(init) {
      const k = cursor++;
      if (!(k in cur)) cur[k] = { current: init };
      return cur[k];
    },
    useEffect(fn, deps) {
      const box = cur;
      const k = cursor++;
      const prev = box[k];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
      const slot = { deps, cleanup: null };
      box[k] = slot;
      effects.push(() => {
        prev?.cleanup?.();
        const c = fn();
        slot.cleanup = typeof c === "function" ? c : null;
      });
    },
    useMemo(fn, deps) {
      const k = cursor++;
      const prev = cur[k];
      if (prev && deps && deps.every((d, i) => Object.is(d, prev.deps[i]))) return prev.v;
      cur[k] = { deps, v: fn() };
      return cur[k].v;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    useContext: () => null,
  };
  const react = { ...React, ...hooks, default: { ...React, ...hooks } };
  function render(el) {
    const nodes = [];
    effects = [];
    const visit = (n, path) => {
      if (n == null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((c, i) => visit(c, `${path}.${c?.key ?? i}`));
      if (!React.isValidElement(n)) return;
      if (n.type === React.Fragment) return visit(n.props.children, `${path}F`);
      if (typeof n.type === "function") {
        const key = `${path}/${n.type.name}`;
        if (!slots.has(key)) slots.set(key, {});
        cur = slots.get(key);
        cursor = 0;
        return visit(n.type(n.props), key);
      }
      nodes.push(n);
      const name = typeof n.type === "string" ? n.type : n.type?.displayName || "x";
      for (const [k, v] of Object.entries(n.props)) if (k === "children" || React.isValidElement(v) || Array.isArray(v)) visit(v, `${path}/${name}:${k}`);
    };
    visit(el, "r");
    for (const e of effects) e();
    return nodes;
  }
  return { react, render, takeDirty: () => ((d) => ((dirty = false), d))(dirty) };
}
const textOf = (n) => (n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(textOf).join("") : typeof n !== "object" ? String(n) : React.isValidElement(n) ? textOf(n.props.children) : "");

// the browser bits the panel touches: this tab's sessionStorage and beforeunload
const tab = new Map();
const unload = new Set();
globalThis.window = {
  sessionStorage: { getItem: (k) => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: (k) => tab.delete(k) },
  addEventListener: (type, fn) => type === "beforeunload" && unload.add(fn),
  removeEventListener: (type, fn) => type === "beforeunload" && unload.delete(fn),
};
globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

const ok200 = (body) => ({ status: 200, body });
const BRAND = (over = {}) => ok200({ ok: true, brandStep: null, palettes: [], current: { paletteId: "slate", logo: null, description: "Old tagline" }, design: { id: "doc_design", revision: 1 }, storeOpen: false, canEditDescription: true, descriptionMax: 160, ...over });
const MADE = ok200({ ok: true, firstRun: { eligible: false, reason: null, generated: true, byGenerator: ["doc_home", "doc_design"], kept: [], empty: false, noCollections: false, summary: { heroImage: null, collections: [], rails: [], paletteId: "slate" } }, sync: { state: "complete" } });
const SAVE_OK = ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 2 }, liveNow: [], afterPublish: ["colours"], storeOpen: false, brandStep: { paletteId: "forest" } });
const SKIP_OK = ok200({ ok: true, skipped: true, design: null, liveNow: [], afterPublish: [], storeOpen: false, brandStep: { skipped: true } });
const PANEL = join(ROOT, "components/admin/onboarding/BrandStepPanel.js");
const STORE = { name: "Acme Candles", address: "acme.localhost" };

let preview = null;
let previewMounts = 0; // BrandPreview instances made (each one mints a preview session)
let picker = null;
let uploadAnswer = null;
async function mount(props, table) {
  const d = driver();
  const Stub = (name) => ({ __esModule: true, default: Object.defineProperty(() => null, "name", { value: name }) });
  const load = world({
    react: d.react,
    "next/link": { __esModule: true, default: function Link({ href, children }) { return React.createElement("a", { href }, children); } },
    "./BrandPreview": { __esModule: true, default: function BrandPreview(p) { const me = d.react.useRef(0); if (!me.current) me.current = ++previewMounts; preview = p; return null; } },
    "@/components/admin/shared/MediaPicker": { MediaPicker: function MediaPicker(p) { picker = p; return null; } },
    "@/components/admin/SyncProgress": { SyncProgressBody: Stub("SyncProgressBody").default, readSync: async () => null, requestSync: async () => ({ ok: true }), POLL_MS: 600000 },
    "@/lib/media-upload": { uploadImage: async () => uploadAnswer },
  });
  const C = (await load(PANEL)).default;
  const log = [];
  const inflight = new Set();
  const fetchMock = (url, init = {}) => {
    const p = (async () => {
      const method = (init.method || "GET").toUpperCase();
      log.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
      await new Promise((r) => setTimeout(r, 1));
      let a = { "GET /api/admin/first-run": MADE, ...table }[`${method} ${url}`];
      if (typeof a === "function") a = a(log.at(-1).body);
      if (Array.isArray(a)) a = a.length > 1 ? a.shift() : a[0];
      a ||= { status: 404, body: {} };
      return { ok: a.status < 300, status: a.status, json: async () => a.body };
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  };
  let nodes = [];
  const real = globalThis.fetch;
  const flush = async () => {
    globalThis.fetch = fetchMock;
    try {
      for (let round = 0; round < 60; round++) {
        d.takeDirty();
        nodes = d.render(React.createElement(C, props));
        for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
        if (inflight.size) {
          await Promise.allSettled([...inflight]);
          continue;
        }
        if (!d.takeDirty()) return;
      }
      throw new Error("never settled");
    } finally {
      globalThis.fetch = real;
    }
  };
  await flush();
  const nameOf = (n) => n.props["aria-label"] || textOf(n.props.children).trim();
  const v = {
    posts: () => log.filter((l) => l.method === "POST"),
    log,
    flush,
    nodes: () => nodes,
    text: () => nodes.map((n) => (["p", "a", "button", "legend", "h3", "span", "figcaption"].includes(n.type) || n.props?.["data-slot"] === "label" ? textOf(n.props.children) : "")).join(" ").replace(/\s+/g, " "),
    has: (attr) => nodes.some((n) => n.props && attr in n.props && n.props[attr] !== undefined),
    button(name) {
      const b = nodes.find((n) => n.type === "button" && nameOf(n) === name);
      ok(b, `no button "${name}": ${nodes.filter((n) => n.type === "button").map(nameOf).join(" | ")}`);
      return b;
    },
    buttons: () => nodes.filter((n) => n.type === "button").map(nameOf),
    async click(name) {
      const b = v.button(name);
      ok(!b.props.disabled, `"${name}" is disabled`);
      globalThis.fetch = fetchMock;
      await b.props.onClick?.({ preventDefault() {} });
      await flush();
    },
    input: (pred) => nodes.find((n) => n.type === "input" && pred(n.props)),
    async type(id, value) {
      const el = v.input((p) => p.id === id);
      ok(el && !el.props.disabled, `${id} missing or disabled`);
      el.props.onChange({ target: { value } });
      await flush();
    },
    group: () => nodes.find((n) => n.props?.["data-slot"] === "radio-group"),
    radios: () => nodes.filter((n) => n.props?.["data-palette"]),
    async choose(id) {
      ok(!v.group().props.disabled, "palettes disabled");
      v.group().props.onValueChange(id);
      await flush();
    },
  };
  return v;
}
const reset = () => {
  tab.clear();
  unload.clear();
  preview = null;
  picker = null;
};

await t("owner: a palette, a logo and a description change only the form: each is in the message to the preview at once, nothing is POSTed; the unsaved note, the n/160 counter and the snippet follow; a page leave is guarded", async () => {
  reset();
  const v = await mount({ canEdit: true, canSync: true, store: STORE }, { "GET /api/admin/brand-step": BRAND() });
  eq(preview.message, M.CLEAR_MESSAGE, "nothing to draw at first:");
  eq(preview.canEdit, true, "the preview may draw:");
  ok(!v.has("data-brand-dirty"), "clean:");
  ok(v.text().includes("11/160"), `counter: ${v.text()}`);
  await v.choose("forest");
  eq(preview.message, { type: "storeasy:brand", paletteId: "forest", logo: false, description: "Old tagline" }, "forest at once:");
  ok(v.has("data-brand-dirty") && v.text().includes(M.BRAND_WORDS.unsaved), "the unsaved note:");
  eq(unload.size, 1, "beforeunload guarded:");
  await v.click("Choose from your library");
  ok(picker.open, "the library opened");
  picker.onSelect({ url: "/api/media/med_logo9", alt: "" });
  await v.flush();
  eq(preview.message.logo, { media: "/api/media/med_logo9", alt: "Acme Candles" }, "the logo, alt falling back to the store name:");
  await v.type("brand-description", "Hand-poured\ncandles");
  eq(preview.message.description, "Hand-poured candles", "one line:");
  ok(v.text().includes("19/160") && v.text().includes("Acme Candles") && v.text().includes("https://acme.localhost"), `counter and snippet: ${v.text()}`);
  eq(v.posts(), [], "nothing POSTed:");
  eq(M.takeDraft(window.sessionStorage), { paletteId: "forest", logo: { media: "/api/media/med_logo9" }, alt: "", description: "Hand-poured candles" }, "kept for this tab:");
});

await t("unsaved choices survive a step switch or a reload (a new mount reads them back); Undo returns the form to what is saved and clears them", async () => {
  // the previous test left forest + a logo in the tab (its page is gone: so is its leave guard)
  unload.clear();
  const v = await mount({ canEdit: true, canSync: true, store: STORE }, { "GET /api/admin/brand-step": BRAND() });
  eq(v.group().props.value, "forest", "restored:");
  eq(preview.message.paletteId, "forest", "and drawn:");
  ok(v.has("data-brand-dirty"), "still unsaved:");
  await v.click("Undo my changes");
  eq(v.group().props.value, "slate", "back to the saved palette:");
  eq(preview.message, M.CLEAR_MESSAGE, "the preview shows what is saved:");
  eq(tab.has(M.DRAFT_KEY), false, "cleared:");
  eq(unload.size, 0, "no leave guard:");
  eq(v.posts(), [], "Undo POSTs nothing:");
});

await t("Save posts the form (as today) and reloads the preview with the saved draft; the unsaved choices are cleared; Skip posts {skip:true}, discards the unsaved choices and resets the preview; both re-read the steps", async () => {
  reset();
  let changes = 0;
  const v = await mount({ canEdit: true, canSync: true, store: STORE, onChange: () => changes++ }, { "GET /api/admin/brand-step": BRAND(), "POST /api/admin/brand-step": (b) => (b.skip ? SKIP_OK : SAVE_OK) });
  await v.choose("forest");
  await v.click("Save");
  eq(v.posts().map((p) => p.body), [{ paletteId: "forest", logo: null, description: "Old tagline", revision: 1 }], "the save body:");
  eq(preview.saved, 1, "the preview reloads:");
  eq(preview.message, M.CLEAR_MESSAGE, "nothing unsaved to draw:");
  eq(tab.has(M.DRAFT_KEY), false, "cleared:");
  ok(v.text().includes("Saved.") && v.has("data-brand-done"), v.text());
  await v.choose("clay");
  ok(tab.has(M.DRAFT_KEY), "clay kept");
  await v.click("Skip for now");
  eq(v.posts().at(-1).body, { skip: true }, "Skip:");
  eq(v.group().props.value, "forest", "the unsaved clay is gone (forest was saved):");
  eq(preview.message, M.CLEAR_MESSAGE, "the preview is reset:");
  eq(preview.saved, 2, "and reloaded:");
  eq(tab.has(M.DRAFT_KEY), false, "cleared:");
  ok(changes >= 2, `onChange after Save and Skip: ${changes}`);
});

await t("a 409 DOCUMENT_CHANGED keeps its words, takes the current revision, and offers Load the latest, which reads the step again and keeps the founder's unsaved choices on top of what is saved now", async () => {
  reset();
  const v = await mount({ canEdit: true, canSync: true, store: STORE }, {
    "GET /api/admin/brand-step": [BRAND(), BRAND({ current: { paletteId: "navy", logo: null, description: "Newer" }, design: { id: "doc_design", revision: 4 } })],
    "POST /api/admin/brand-step": [{ status: 409, body: { error: "x", code: "DOCUMENT_CHANGED", current: { revision: 4 } } }, SAVE_OK],
  });
  await v.choose("forest");
  await v.click("Save");
  ok(v.text().includes(M.BRAND_WORDS.changed), v.text());
  await v.click("Load the latest");
  eq(v.group().props.value, "forest", "the founder's unsaved palette is kept:");
  eq(v.input((p) => p.id === "brand-description").props.value, "Newer", "the field they didn't touch takes the latest:");
  ok(v.has("data-brand-dirty") && v.text().includes(M.BRAND_WORDS.keptOnLatest), `says so: ${v.text()}`);
  eq(M.takeDraft(window.sessionStorage)?.paletteId, "forest", "still kept for this tab:");
  eq(preview.message.paletteId, "forest", "and drawn:");
  await v.click("Save");
  eq(v.posts().at(-1).body, { paletteId: "forest", logo: null, description: "Newer", revision: 4 }, "the next Save: the choices over the latest, the current revision:");
  // the pure merge
  const old = M.formOf({ paletteId: "slate", logo: null, description: "A" });
  const latest = M.formOf({ paletteId: "navy", logo: { media: "/api/media/med_n", alt: "N" }, description: "B" });
  eq(M.mergeOnLatest({ ...old, description: "Mine" }, old, latest), { paletteId: "navy", logo: { media: "/api/media/med_n" }, alt: "N", description: "Mine" }, "only the changed field wins:");
  eq(M.mergeOnLatest({ ...old, logo: { media: "/api/media/med_m" }, alt: "M" }, old, latest).logo, { media: "/api/media/med_m" }, "a changed logo (with its alt) wins:");
});

await t("logo upload: a file goes through uploadImage and becomes the form's logo (in the preview, not saved); a failed upload says why; an address outside the library is refused", async () => {
  reset();
  const v = await mount({ canEdit: true, canSync: true, store: STORE }, { "GET /api/admin/brand-step": BRAND() });
  const file = () => v.input((p) => p["data-brand-upload"] !== undefined);
  uploadAnswer = { ok: true, media: { url: "/api/media/med_up1", alt: "Mark" } };
  await file().props.onChange({ target: { files: [{ name: "logo.png" }] } });
  await v.flush();
  eq(preview.message.logo, { media: "/api/media/med_up1", alt: "Mark" }, "uploaded:");
  ok(v.buttons().includes("Change logo") && v.buttons().includes("Remove logo"), v.buttons().join("|"));
  eq(v.posts(), [], "an upload saves nothing in the step:");
  await v.click("Remove logo");
  eq(preview.message, M.CLEAR_MESSAGE, "removed: as saved:");
  uploadAnswer = { ok: false, message: "That file is too big." };
  await file().props.onChange({ target: { files: [{ name: "big.png" }] } });
  await v.flush();
  ok(v.text().includes("That file is too big."), v.text());
  uploadAnswer = { ok: true, media: { url: "https://cdn.example/x.png" } };
  await file().props.onChange({ target: { files: [{ name: "x.png" }] } });
  await v.flush();
  ok(v.text().includes(M.BRAND_WORDS.notLibrary), v.text());
  ok(!v.buttons().includes("Remove logo"), "no logo taken");
});

await t("staff: palette and logo can change, the description is disabled with cannotDescribe and never sent", async () => {
  reset();
  const v = await mount({ canEdit: true, canSync: false, store: STORE }, { "GET /api/admin/brand-step": BRAND({ canEditDescription: false }), "POST /api/admin/brand-step": SAVE_OK });
  ok(v.input((p) => p.id === "brand-description").props.disabled, "description disabled");
  ok(v.text().includes(M.BRAND_WORDS.cannotDescribe), v.text());
  await v.choose("forest");
  await v.click("Save");
  eq(v.posts().map((p) => p.body), [{ paletteId: "forest", logo: null, revision: 1 }], "no description sent:");
});

await t("least-trusted: support (and operator-support) sees every control disabled with the reason, the preview shows what is saved (no message drawn), kept choices in the tab are ignored, and nothing is ever POSTed", async () => {
  reset();
  M.keepDraft(window.sessionStorage, { ...SAVED, paletteId: "forest" }, SAVED); // left by someone else in this tab
  const reason = "Your role can look but not change the store's brand.";
  const v = await mount({ canEdit: false, canSync: false, reason, store: STORE }, { "GET /api/admin/brand-step": BRAND({ canEditDescription: false }) });
  ok(v.text().includes(reason), v.text());
  eq(v.group().props.value, "slate", "the saved palette, not the kept one:");
  ok(v.group().props.disabled && v.radios().length === 6 && v.radios().every((r) => r.props.disabled), "palettes disabled");
  for (const b of ["Save", "Skip for now", "Upload a logo", "Choose from your library"]) {
    const n = v.button(b);
    ok(n.props.disabled, `${b} not disabled`);
  }
  ok(v.input((p) => p.id === "brand-description").props.disabled && v.input((p) => p["data-brand-upload"] !== undefined).props.disabled, "fields disabled");
  // the only enabled buttons are view-only ones (scroll to the form, open or close the preview), each tagged data-onboarding="view" (the shell drill's rule)
  const enabled = v.nodes().filter((n) => n.type === "button" && !n.props.disabled);
  ok(enabled.every((n) => n.props["data-onboarding"] === "view" && (n.props["data-brand-scroll"] !== undefined || n.props["data-brand-preview-open"] !== undefined || n.props["data-brand-sheet-close"] !== undefined)), `support has an enabled control that isn't view-only: ${enabled.map((n) => textOf(n.props.children)).join(" | ")}`);
  eq(preview.canEdit, false, "the preview never draws:");
  eq(preview.message, M.CLEAR_MESSAGE, "nothing to draw:");
  ok(!v.nodes().some((n) => n.type === "MediaPicker"), "no library picker");
  eq(picker, null, "the picker is never mounted:");
  eq(v.posts(), [], "nothing POSTed:");
  eq(v.log.map((l) => `${l.method} ${l.url}`), ["GET /api/admin/first-run", "GET /api/admin/brand-step"], "reads only:");
});

await t("until a home page exists the preview waits with its words (no frame, no session); a made store shows it; below 1024px it is a sticky Preview button and a bottom sheet mounted on first open; crossing 1024px never makes a second preview (one session)", async () => {
  reset();
  const syncing = ok200({ ok: true, firstRun: { eligible: false, reason: "catalog_not_confirmed", generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null }, sync: { state: "running" } });
  const w = await mount({ canEdit: true, canSync: true, store: STORE }, { "GET /api/admin/first-run": syncing, "GET /api/admin/brand-step": BRAND() });
  ok(w.text().includes(M.PREVIEW_WORDS.noHome), w.text());
  eq(preview, null, "no preview mounted:");
  // a viewport that crosses 1024px: one BrandPreview (one session) the whole time
  const mql = { matches: false, fns: new Set(), addEventListener(_, fn) { this.fns.add(fn); }, removeEventListener(_, fn) { this.fns.delete(fn); } };
  const resize = async (v, wideNow) => {
    mql.matches = wideNow;
    for (const fn of mql.fns) fn();
    await v.flush();
  };
  globalThis.matchMedia = () => mql;
  try {
    previewMounts = 0;
    const n = await mount({ canEdit: true, canSync: true, store: STORE }, { "GET /api/admin/brand-step": BRAND() });
    ok(n.has("data-brand-preview-open"), "the Preview button");
    eq(preview, null, "not mounted before the first open:");
    await n.click("Preview");
    ok(preview, "mounted on open");
    const slot = () => n.nodes().find((x) => x.props?.["data-brand-sheet"] !== undefined);
    eq(slot().props["data-state"], "open", "the sheet is open:");
    await n.click("Close preview");
    eq(slot().props["data-state"], "closed", "closed:");
    ok(preview, "and still mounted");
    await resize(n, true);
    await resize(n, false);
    await resize(n, true);
    eq(previewMounts, 1, "390 → 1280 → 390 → 1280: one preview, one session:");
    // starting wide: mounted at once, and still one after going narrow
    previewMounts = 0;
    mql.matches = true;
    const w2 = await mount({ canEdit: true, canSync: true, store: STORE }, { "GET /api/admin/brand-step": BRAND() });
    eq(previewMounts, 1, "wide: mounted at once:");
    await resize(w2, false);
    await resize(w2, true);
    eq(previewMounts, 1, "1280 → 390 → 1280: still one:");
  } finally {
    globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  }
});

// =====================================================================================
console.log("— 4. shopper markup");

await t("Header and Footer: the logo slots (header and footer) and the tagline slot render only with editing; a shopper's markup has none of them and is what it was", async () => {
  const { renderToStaticMarkup } = require("react-dom/server");
  const load = world({ react: React, "next/link": { __esModule: true, default: ({ href, children, className }) => React.createElement("a", { href, className }, children) }, "./SearchBox": { __esModule: true, default: () => null }, "./cart/CartButton": { __esModule: true, default: () => null } });
  const Header = (await load(join(ROOT, "components/Header.js"))).default;
  const Footer = (await load(join(ROOT, "components/Footer.js"))).default;
  const SLOT = /data-store-logo-img|data-store-logo-text|data-store-tagline/;
  for (const logo of [{ text1: "Acme", text2: "Co" }, { text1: "Acme", name: "Acme", image: { media: "/api/media/med_l", alt: "" } }]) {
    for (const variant of ["standard", "centered"]) {
      const shop = renderToStaticMarkup(React.createElement(Header, { logo, variant }));
      ok(!SLOT.test(shop), `shopper header (${variant}) has a slot`);
      const ed = renderToStaticMarkup(React.createElement(Header, { logo, variant, editing: true }));
      ok(/<img data-store-logo-img=""/.test(ed) && /<span data-store-logo-text=""/.test(ed), `editing header (${variant}): ${ed.slice(0, 400)}`);
      eq(/<img data-store-logo-img=""[^>]*hidden=""/.test(ed), !logo.image, `${variant}: the picture hidden only without one:`);
    }
    for (const variant of ["columns", "minimal"]) {
      for (const tagline of ["", "Soft serums"]) {
        const shop = renderToStaticMarkup(React.createElement(Footer, { logo, variant, tagline }));
        ok(!SLOT.test(shop), `shopper footer (${variant}) has a slot`);
        eq(shop.includes("Soft serums"), Boolean(tagline), `${variant}: the shopper tagline as before:`);
        const ed = renderToStaticMarkup(React.createElement(Footer, { logo, variant, tagline, editing: true }));
        ok(new RegExp(`<p data-store-tagline=""${tagline ? "" : ' hidden=""'}`).test(ed), `editing footer (${variant}, '${tagline}'): ${ed.slice(0, 300)}`);
        ok(/data-store-logo-img=""/.test(ed), `editing footer logo slot (${variant})`);
      }
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
