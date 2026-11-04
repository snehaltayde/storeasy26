// P4-PICKER (MED-03, OVL-04, ED-12, MED-02): the editor's library picker, the
// gallery, pairs and pinned-products controls, and the media screen's
// archive, "Where it's used" and refused delete.
//   1. the library picker: MediaPicker's choice becomes { media:
//      "/api/media/<id>", alt } in ImageControl; the picker lists what the
//      real GET /api/admin/media answers, which leaves archived files out;
//      the editor passes pickImage to every form (EditorView)
//   2. GalleryControl: add from the library and from Shopify, reorder by
//      buttons, remove, alt text, "Use Shopify's images" clears the overlay
//   3. PairsControl and ProductListControl: order kept, effective titles with
//      the Shopify title as secondary text, the catalog picker's choice
//   4. MediaAdmin, through the real /api/admin/media route on file
//      databases: Archive, Unarchive, "Show archived files", "Where it's
//      used", a delete refused because the file is used (plain reason, no
//      way round it on a documents store; today's choice on a legacy store)
//   5. every control: labelled, and every action a button (keyboard)
// Components run with Next's own SWC: react-dom/server for markup, and a
// small hook driver (the component called as a function, hooks kept per
// place in the tree, effects run after each render) to press buttons and
// type. File databases only (scripts/support/tenant-fixture.js).
//   pnpm test:media-picker
import "./support/request-cache.js";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-mp-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const started = Date.now();
let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n       ")}`);
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n       expected ${y}\n       got      ${x}`);
};

// ---- the JSX loader (Next's SWC), with a choice of React -------------------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
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
const isJsxFile = (file) => /\/(components|app)\//.test(file) && !/(Model|documentsApi|store|previewMachine)\.js$/.test(file) && !/\/app\/api\//.test(file);
const exists = (f) => readFile(f).then(
  () => true,
  () => false,
);
function world(stubs) {
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const code = await compile(file);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || local.has(id)) continue;
      const target0 = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
      if (!target0) continue;
      const target = target0.endsWith(".js") ? target0 : (await exists(`${target0}.js`)) ? `${target0}.js` : join(target0, "index.js");
      local.set(id, isJsxFile(target) ? await load(target) : await import(pathToFileURL(target).href));
    }
    new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  }
  return load;
}

const toasts = [];
const toastStub = { useToast: () => ({ success: (m) => toasts.push(["success", m]), error: (m) => toasts.push(["error", m]), info: (m) => toasts.push(["info", m]) }) };
const navStub = { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), redirect: () => {}, usePathname: () => "/admin/editor" };

// ---- the hook driver ------------------------------------------------------------------
// One driver per mounted tree. Function components are called with their own
// hook slots (by their place in the tree); a component named in `skip` is not
// called: its props are kept on the node, and the elements in them are walked
// (a closed dialog's are not).
const SKIP = new Set(["Dialog", "ProductPicker", "RefPicker", "CopyButton", "MediaUploadStatus"]);
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
      return [
        box[k],
        (v) => {
          const nv = typeof v === "function" ? v(box[k]) : v;
          if (!Object.is(nv, box[k])) {
            box[k] = nv;
            dirty = true;
          }
        },
      ];
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
      const v = fn();
      cur[k] = { deps, v };
      return v;
    },
    useCallback(fn, deps) {
      return hooks.useMemo(() => fn, deps);
    },
    useContext() {
      return null;
    },
  };
  const react = { ...React, ...hooks, default: { ...React, ...hooks } };
  function render(el) {
    const nodes = [];
    effects = [];
    const visit = (n, path) => {
      if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
      if (Array.isArray(n)) return n.forEach((c, i) => visit(c, `${path}.${c?.key ?? i}`));
      if (!React.isValidElement(n)) return;
      const ty = n.type;
      if (ty === React.Fragment) return visit(n.props.children, `${path}F`);
      if (typeof ty === "function" && !SKIP.has(ty.name)) {
        const key = `${path}/${ty.name}`;
        if (!slots.has(key)) slots.set(key, {});
        cur = slots.get(key);
        cursor = 0;
        return visit(ty(n.props), key);
      }
      nodes.push(n);
      const name = typeof ty === "string" ? ty : ty.name;
      if (typeof ty === "function" && n.props.open === false) return; // a closed dialog shows nothing
      for (const [k, v] of Object.entries(n.props)) if (k === "children" || React.isValidElement(v) || Array.isArray(v)) visit(v, `${path}/${name}:${k}`);
    };
    visit(el, "r");
    for (const e of effects) e();
    return nodes;
  }
  return {
    react,
    render,
    takeDirty() {
      const d = dirty;
      dirty = false;
      return d;
    },
  };
}
const textOf = (n) => {
  if (n == null || typeof n === "boolean") return "";
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (!React.isValidElement(n)) return "";
  return textOf(n.props.children);
};
const nameOf = (n) => n.props["aria-label"] || n.props.label || textOf(n.props.children).trim();

// Mount a component of a world built for this driver. view.el() is the element
// to render (it reads the latest props), so a test can feed onChange back.
async function mount(file, exportName, makeProps, { stubs = {}, inflight = null } = {}) {
  const d = driver();
  const load = world({ react: d.react, "@/components/console/Toast": toastStub, "next/navigation": navStub, ...stubs });
  const mod = await load(join(ROOT, file));
  const C = exportName === "default" ? mod.default : mod[exportName];
  ok(typeof C === "function", `${file} has no ${exportName}`);
  let nodes = [];
  const draw = () => {
    nodes = d.render(React.createElement(C, makeProps()));
    return nodes;
  };
  const flush = async () => {
    for (let round = 0; round < 40; round++) {
      d.takeDirty();
      draw();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      if (inflight && inflight.size) await Promise.allSettled([...inflight]);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      if (!d.takeDirty() && !(inflight && inflight.size)) {
        draw();
        return nodes;
      }
    }
    throw new Error("the component never settled");
  };
  await flush();
  const view = {
    flush,
    nodes: () => nodes,
    text: () => nodes.filter((n) => typeof n.type === "string").map((n) => (typeof n.props.children === "string" || typeof n.props.children === "number" ? String(n.props.children) : "")).join(" "),
    all: () => nodes.map((n) => textOf(n)).join(" "),
    find: (pred) => nodes.find(pred) || null,
    button(name) {
      const b = nodes.find((n) => n.type === "button" && nameOf(n) === name);
      ok(b, `no button "${name}" on screen; buttons: ${nodes.filter((n) => n.type === "button").map(nameOf).join(" | ")}`);
      return b;
    },
    hasButton: (name) => nodes.some((n) => n.type === "button" && nameOf(n) === name),
    async click(name) {
      const b = view.button(name);
      ok(!b.props.disabled, `button "${name}" is disabled`);
      const r = b.props.onClick?.({ preventDefault() {}, target: {} });
      await r;
      await flush();
      return r;
    },
    async type(id, value) {
      const el = nodes.find((n) => n.props?.id === id && (n.type === "input" || n.type === "textarea"));
      ok(el, `no field #${id}`);
      ok(!el.props.disabled, `field #${id} is disabled`);
      el.props.onChange({ target: { value, checked: value } });
      await flush();
    },
  };
  return view;
}

// =====================================================================================
// stores and the real media route
// =====================================================================================
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("mp");
const plat = await F.makePlatform({ name: "mp" });
const R = await import("../lib/registry/index.js");
const M = await import("../lib/media.js");
const Docs = await import("../lib/documents/service.js");
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const route = await import("../app/api/admin/media/route.js");

const CONFIG = { site: { name: "MP Store" }, site_url: "https://mp.test" };
const docs = await F.makeTenant({ name: "mp-docs", id: "mpdocs", config: CONFIG });
const legacy = await F.makeTenant({ name: "mp-legacy", id: "mplegacy", config: CONFIG });
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
for (const fx of [docs, legacy]) await raw(fx).executeMultiple(schema);
await raw(docs).execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");

const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n & 255, (n >> 8) & 255, 2, 3, 4, 5, 6, 7]);
let pngN = 1;
const upload = (fx, name, alt = "") => fx.run(() => M.saveMedia({ filename: name, mime: "image/png", bytes: PNG(pngN++), alt }));
const archivedAt = async (fx, id) => {
  const r = await sql(fx, "SELECT archived_at FROM media WHERE id = ?", [id]);
  return r.length ? r[0].archived_at : "gone";
};

const owner = await I.createUser({ email: "owner@mp.test", name: "Owner", password: "mp-owner-pass-1" });
for (const id of ["mpdocs", "mplegacy"]) await I.addMembership(owner.id, id, "owner");
const tok = (await Sess.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const routeReq = (tenantId, body, path) => ({
  cookies: { get: (n) => (n === "_admin" ? { value: tok } : undefined) },
  headers: { get: (k) => ({ host: `${tenantId}.test` })[k.toLowerCase()] ?? null },
  url: `https://${tenantId}.test${path}`,
  nextUrl: { pathname: path.split("?")[0] },
  json: async () => body,
});
// A browser fetch that lands on the real route handler of one store. Every
// call is recorded; `inflight` lets the hook driver wait for answers.
function storeFetch(tenantId) {
  const calls = [];
  const inflight = new Set();
  const fetch = (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    const path = String(url);
    ok(path.startsWith("/api/admin/media"), `unexpected fetch ${path}`);
    const p = (async () => {
      const res = await route[method](routeReq(tenantId, body, path), {});
      const data = await res.json();
      return { ok: res.status < 400, status: res.status, json: async () => data };
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  };
  return { fetch, calls, inflight };
}
const withFetch = async (f, fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
};

const Fields = await import("../components/admin/editor/fields/inspectorModel.js");
const field = (type, key) => {
  const s = R.documentType(type).settings.find((x) => x.key === key);
  const { controlOf } = Set_;
  return { key, path: key, anchor: Fields.idOf(null, key), control: s.kind, label: s.label, setting: controlOf(s) };
};
const Set_ = await import("../lib/registry/settings.js");

// =====================================================================================
console.log("— 1. the library picker in the editor");
// =====================================================================================

// the glue, plain: no React
const ssr = world({ "@/components/console/Toast": toastStub, "next/navigation": navStub });
const Idx = await ssr(join(ROOT, "components/admin/editor/fields/index.js"));

await t("unit: mediaPick turns MediaPicker's { url, alt, id } into { media: '/api/media/<id>', alt }; anything that isn't a library file gives null", () => {
  eq(Idx.mediaPick({ url: "/api/media/med_abc", alt: "A jar", id: "med_abc" }), { media: "/api/media/med_abc", alt: "A jar" }, "the picker's answer:");
  eq(Idx.mediaPick({ url: "https://mp.test/api/media/med_abc?w=400" }), { media: "/api/media/med_abc", alt: "" }, "an absolute address with a query, no id:");
  eq(Idx.mediaPick({ url: "https://cdn.shopify.com/x.jpg", alt: "x" }), null, "not a library file:");
  eq(Idx.mediaPick({ url: "/api/mediax/med_abc" }), null, "a look-alike:");
  eq(Idx.mediaPick(null), null, "nothing chosen:");
});

await t("unit: createLibraryPicker resolves pick() with the choice, or null when closed; a second pick() closes the first with null", async () => {
  const opens = [];
  const p = Idx.createLibraryPicker((o) => opens.push(o));
  const a = p.pick({ path: "image" });
  ok(p.isOpen() && p.path() === "image", "open for the field");
  p.select({ url: "/api/media/med_1", alt: "One", id: "med_1" });
  eq(await a, { media: "/api/media/med_1", alt: "One" }, "chosen:");
  const b = p.pick({ path: "gallery" });
  const c = p.pick({ path: "gallery" });
  eq(await b, null, "the first of two:");
  p.close();
  eq(await c, null, "closed:");
  eq(opens, [true, false, true, false, true, false], "open, closed, open, closed by the second pick, open, closed:");
  ok(!p.isOpen(), "closed at the end");
});

await t("unit (test-media-picker): choosing a library image in ImageControl stores {media: '/api/media/<id>', alt}; archived files are not offered (the real GET /api/admin/media, through the real MediaPicker)", async () => {
  const kept = await upload(docs, "kept-jar.png", "Amber jar");
  const old = await upload(docs, "old-jar.png", "Old jar");
  await docs.run(() => M.archiveMedia(old.id));
  // the real MediaPicker, its fetch answered by the real route of this store
  const sf = storeFetch("mpdocs");
  const picker = Idx.createLibraryPicker(() => {});
  const chosen = [];
  await withFetch(sf.fetch, async () => {
    const view = await mount("components/admin/cms/MediaPicker.js", "MediaPicker", () => ({ open: true, onClose: picker.close, onSelect: (sel) => (chosen.push(sel), picker.select(sel)) }), { inflight: sf.inflight });
    eq(sf.calls.map((c) => [c.method, c.url]), [["GET", "/api/admin/media"]], "the picker reads the library:");
    const offered = view.nodes().filter((n) => n.type === "button" && typeof n.props.title === "string").map((n) => n.props.title.split(" — ")[0]);
    ok(offered.includes("kept-jar.png"), `the kept file is offered: ${offered}`);
    ok(!offered.includes("old-jar.png"), `the archived file is not offered: ${offered}`);
    // ImageControl, with the editor's pickImage
    const changes = [];
    const ctl = await mount("components/admin/editor/fields/controls.js", "ImageControl", () => ({
      field: { key: "image", path: "image", label: "Image", control: "image", setting: { key: "image", kind: "image", label: "Image" } },
      value: null,
      onChange: (v) => changes.push(v),
      issues: [],
      owner: "sec_h1",
      context: { pickImage: picker.pick },
    }));
    const pending = ctl.button("Choose from your library").props.onClick();
    ok(picker.isOpen(), "the button opens the library");
    const pick = view.nodes().find((n) => n.type === "button" && n.props.title?.startsWith("kept-jar.png"));
    pick.props.onClick();
    await pending;
    eq(chosen, [{ url: `/api/media/${kept.id}`, alt: "Amber jar", id: kept.id }], "MediaPicker's answer:");
    eq(changes, [{ media: `/api/media/${kept.id}`, alt: "Amber jar" }], "ImageControl stores:");
    // and the stored value is a valid image setting that indexes the file
    const hero = { ...R.newSection("hero", { id: "sec_h1" }) };
    hero.settings = { ...hero.settings, title: "Hi", image: changes[0] };
    const v = R.validateDocument({ ...R.emptyBody("home"), sections: [hero] });
    ok(!v.issues.some((i) => i.field?.startsWith("image")), `no issue on the image: ${JSON.stringify(v.issues)}`);
  });
});

// The editor gives every form pickImage (DocumentEditor), and the product's
// gallery, pairs and pins under its settings.
const EditorWorld = world({ "@/components/console/Toast": toastStub, "next/navigation": navStub });
const Editor = await EditorWorld(join(ROOT, "components/admin/editor/DocumentEditor.js"));
const h = React.createElement;
const homeState = () => {
  const hero = R.newSection("hero", { id: "sec_h1" });
  return {
    id: "doc_home",
    type: "home",
    body: { ...R.emptyBody("home"), sections: [hero] },
    revision: 2,
    draftHash: "h2",
    document: { id: "doc_home", type: "home", label: "Home page", publishedVersionId: null, access: { canPublish: true, reason: null } },
    status: "saved",
    issues: [],
    ackCount: 0,
  };
};
const editorHtml = (props) => renderToStaticMarkup(h(Editor.EditorView, { load: { status: "ready" }, docs: [{ id: "doc_home", type: "home", label: "Home page", live: true }], entry: { id: props.state.id, type: props.state.type, label: props.state.document.label }, ...props }));

await t("rendered: the editor passes pickImage to the forms, so an image field offers 'Choose from your library' (absent without it, as before)", () => {
  const s = homeState();
  const withPick = editorHtml({ state: s, selection: "sec_h1", pickImage: async () => null });
  ok(withPick.includes("Choose from your library"), "the button shows with the editor's picker");
  const without = editorHtml({ state: s, selection: "sec_h1" });
  ok(!without.includes("Choose from your library"), "and not without it");
  const src = readFileSync(join(ROOT, "components/admin/editor/DocumentEditor.js"));
  ok(/pickImage=\{picker\.pick\}/.test(src), "DocumentEditor hands EditorView its picker");
  ok(/<MediaPicker open=\{pickerOpen\} onClose=\{picker\.close\} onSelect=\{picker\.select\} \/>/.test(src), "and opens the existing MediaPicker with the picker's select");
});

await t("rendered: a product's document shows the gallery and the pairs controls with Shopify's images beside them; a collection's shows the pinned products", () => {
  const prod = {
    id: "doc_prod_1",
    type: "product_content",
    body: { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, pairs: { title: null, products: ["gid://shopify/Product/2"] } } },
    revision: 1,
    draftHash: "x",
    document: { id: "doc_prod_1", type: "product_content", label: "Jar", entityId: "gid://shopify/Product/1", access: { canPublish: true } },
    issues: [{ sectionId: null, field: "pairs.products.0", code: "DUPLICATE", severity: "error", message: "This product is in the list twice. Remove one." }],
    ackCount: 0,
  };
  const m = editorHtml({ state: prod, pickImage: async () => null, entity: { inShopify: true, shopify: { title: "Jar", gallery: [{ media: "https://cdn.shopify.com/s/a.jpg", alt: "Front" }] } } });
  ok(m.includes("data-gallery-control") && m.includes("https://cdn.shopify.com/s/a.jpg"), "the gallery, with Shopify's image");
  ok(m.includes("Add from your library"), "the library button");
  ok(m.includes("data-pairs-control") && m.includes("Pairs well with"), "the pairs control");
  // the issue sits under the row it is about (AU-02)
  ok(/id="f-doc-pairs-products-0"[^>]*aria-describedby="f-doc-pairs-products-0--notes"/.test(m) && m.includes("This product is in the list twice. Remove one."), "the pair's issue under its row");
  const coll = { ...prod, id: "doc_coll_1", type: "collection_content", body: R.emptyBody("collection_content"), document: { ...prod.document, id: "doc_coll_1", type: "collection_content", entityId: "gid://shopify/Collection/1" }, issues: [] };
  const c = editorHtml({ state: coll, entity: { inShopify: true, shopify: { title: "Summer" } } });
  ok(c.includes("Pinned products") && c.includes("Shown first on the collection page, in this order."), "the pinned products control");
  ok(!c.includes("data-gallery-control"), "no gallery on a collection");
  const home = editorHtml({ state: homeState() });
  ok(!home.includes("data-entity-fields"), "nothing new on other documents");
});

// =====================================================================================
console.log("— 2. GalleryControl");
// =====================================================================================

const SHOPIFY = [
  { media: "https://cdn.shopify.com/s/files/front.jpg?v=1", alt: "Front" },
  { media: "https://cdn.shopify.com/s/files/back.jpg?v=1", alt: "Back" },
];
async function gallery(initial, { pick = null, shopify = SHOPIFY } = {}) {
  const state = { value: initial, changes: [] };
  const view = await mount("components/admin/editor/fields/GalleryControl.js", "default", () => ({
    field: field("product_content", "gallery"),
    value: state.value,
    onChange: (v) => {
      state.changes.push(v);
      state.value = v;
    },
    issues: [],
    owner: null,
    context: { pickImage: pick, shopify: shopify ? { gallery: shopify } : null },
  }));
  return { state, view };
}
const listOf = (v) => (v && Array.isArray(v.value) ? v.value.map((x) => `${x.media}|${x.alt}`) : v);

await t("unit: GalleryControl adds from the library and from Shopify, reorders by buttons, removes and edits alt; 'Use Shopify's images' clears the overlay", async () => {
  const picks = [{ media: "/api/media/med_lib1", alt: "Lifestyle" }];
  const { state, view } = await gallery(null, { pick: async () => picks.shift() ?? null });
  ok(view.all().includes("Shoppers see Shopify's images."), "following Shopify at first");
  ok(!view.hasButton("Use Shopify's images"), "nothing to clear yet");
  // add from the library
  await view.click("Add from your library");
  eq(listOf(state.value), ["/api/media/med_lib1|Lifestyle"], "the library image starts the list:");
  // add a Shopify image
  await view.click("Add Shopify image 2 to your list");
  eq(listOf(state.value), ["/api/media/med_lib1|Lifestyle", "https://cdn.shopify.com/s/files/back.jpg?v=1|Back"], "a Shopify image added:");
  ok(view.button("Shopify image 2 is in your list").props.disabled, "an image in the list can't be added twice");
  // reorder
  await view.click("Move image 2 up");
  eq(listOf(state.value), ["https://cdn.shopify.com/s/files/back.jpg?v=1|Back", "/api/media/med_lib1|Lifestyle"], "moved up:");
  ok(view.button("Move image 1 up").props.disabled && view.button("Move image 2 down").props.disabled, "the ends can't move further");
  await view.click("Move image 1 down");
  eq(listOf(state.value), ["/api/media/med_lib1|Lifestyle", "https://cdn.shopify.com/s/files/back.jpg?v=1|Back"], "moved down:");
  // alt text
  await view.type("f-doc-gallery-value-1-alt", "The back label");
  eq(listOf(state.value), ["/api/media/med_lib1|Lifestyle", "https://cdn.shopify.com/s/files/back.jpg?v=1|The back label"], "alt edited:");
  // remove
  await view.click("Remove image 1");
  eq(listOf(state.value), ["https://cdn.shopify.com/s/files/back.jpg?v=1|The back label"], "removed:");
  // what is stored validates, and the overlay's base (set by the service) is kept
  state.value = { ...state.value, base_hash: "abc", base_value: SHOPIFY };
  await view.flush();
  await view.type("f-doc-gallery-value-0-alt", "Back");
  eq([state.value.base_hash, state.value.base_value.length], ["abc", 2], "the base is left as the service set it:");
  const body = { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, gallery: { value: state.value.value } } };
  eq(R.validateDocument(body).issues.filter((i) => i.field?.startsWith("gallery")), [], "the stored gallery validates:");
  // Use Shopify's images
  await view.click("Use Shopify's images");
  eq(state.value, null, "cleared: the product follows Shopify again:");
  ok(view.all().includes("Shoppers see Shopify's images."), "and says so");
});

await t("unit: GalleryControl 'Start from Shopify's images' copies them in order; the cap stops adding; a closed library adds nothing; a product gone from Shopify says so", async () => {
  const { state, view } = await gallery(null, { pick: async () => null });
  await view.click("Add from your library");
  eq(state.changes, [], "closing the library without a choice changes nothing:");
  await view.click("Start from Shopify's images");
  eq(listOf(state.value), ["https://cdn.shopify.com/s/files/front.jpg?v=1|Front", "https://cdn.shopify.com/s/files/back.jpg?v=1|Back"], "copied in Shopify's order:");
  const full = { value: Array.from({ length: 30 }, (_, i) => ({ media: `/api/media/med_${i}`, alt: "" })) };
  const capped = await gallery(full, { pick: async () => ({ media: "/api/media/med_new", alt: "" }) });
  ok(capped.view.button("Add from your library").props.disabled, "the library button is off at 30");
  ok(capped.view.all().includes("30 of 30 images. The list is full: remove one to add another."), "and says why");
  const gone = await mount("components/admin/editor/fields/GalleryControl.js", "default", () => ({ field: field("product_content", "gallery"), value: null, onChange() {}, issues: [], owner: null, context: { shopify: null, shopifyMissing: true } }));
  ok(gone.all().includes("Shopify's images can't be shown: this product isn't in your Shopify catalog now."), "gone from Shopify");
});

await t("unit (P4-FIX2): addImage refuses an image already in the list (the same address, any size) and an image past the cap; the control adds nothing for a library pick that is already there", async () => {
  const G = await world({})(join(ROOT, "components/admin/editor/fields/GalleryControl.js"));
  const list = [{ media: "https://cdn.shopify.com/s/files/front.jpg?v=1", alt: "Front" }, { media: "/api/media/med_a", alt: "" }];
  // duplicates: the same address, or the same image at another size
  eq(G.addImage(list, { media: "/api/media/med_a", alt: "again" }), list, "the same library file:");
  eq(G.addImage(list, { media: "https://cdn.shopify.com/s/files/front.jpg?v=2&width=400", alt: "" }), list, "the same Shopify image at another size:");
  ok(G.addImage(list, { media: "/api/media/med_a", alt: "" }) === list, "the same list back, unchanged");
  eq(G.addImage(list, { media: "/api/media/med_b", alt: "New" }).map((x) => x.media), ["https://cdn.shopify.com/s/files/front.jpg?v=1", "/api/media/med_a", "/api/media/med_b"], "a new image is added at the end:");
  // the cap: 30 is full, 29 takes one more; no cap given, no limit
  const files = (n) => Array.from({ length: n }, (_, i) => ({ media: `/api/media/med_${i}`, alt: "" }));
  eq(G.addImage(files(30), { media: "/api/media/med_new", alt: "" }, 30).length, 30, "full at 30:");
  eq(G.addImage(files(31), { media: "/api/media/med_new", alt: "" }, 30).length, 31, "over the cap (an old list): nothing added, nothing cut:");
  eq(G.addImage(files(29), { media: "/api/media/med_new", alt: "" }, 30).length, 30, "29 takes one more:");
  eq(G.addImage(files(30), { media: "/api/media/med_new", alt: "" }).length, 31, "no cap given:");
  // through the control: a library pick of an image already in the list
  const start = { value: [{ media: "/api/media/med_lib1", alt: "Lifestyle" }] };
  const { state, view } = await gallery(start, { pick: async () => ({ media: "/api/media/med_lib1", alt: "Other words" }) });
  await view.click("Add from your library");
  eq(state.changes, [], "nothing changed:");
  eq(listOf(state.value), ["/api/media/med_lib1|Lifestyle"], "the list as it was:");
});

// =====================================================================================
console.log("— 3. PairsControl and ProductListControl");
// =====================================================================================

const P = (n) => `gid://shopify/Product/${n}`;
const CATALOG = {
  [P(1)]: { id: P(1), handle: "jar", title: "Amber jar", shopify_title: "AMBER JAR 250ML" },
  [P(2)]: { id: P(2), handle: "lid", title: "Bamboo lid", shopify_title: "Bamboo lid" },
  [P(3)]: { id: P(3), handle: "brush", title: "Brush" },
};
function catalog() {
  const asked = [];
  const lookupProducts = async (ids) => {
    asked.push([...ids]);
    return ids.map((id) => CATALOG[id] || { id, missing: true });
  };
  return { asked, lookupProducts };
}
const rows = (view) =>
  view
    .nodes()
    .filter((n) => n.type === "li" && n.props["data-pick"])
    .map((li) => {
      const parts = [];
      const walk = (x) => {
        if (Array.isArray(x)) return x.forEach(walk);
        if (!React.isValidElement(x)) return;
        if (x.props["data-pick-title"] != null) parts.push(textOf(x.props.children));
        if (x.props["data-pick-shopify"] != null) parts.push(`(${textOf(x.props.children)})`);
        walk(x.props.children);
      };
      walk(li.props.children);
      return parts.join(" ");
    });

await t("unit: ProductListControl keeps the order, shows each product's effective title with the Shopify title as secondary text, and moves, removes and picks through the catalog picker", async () => {
  const cat = catalog();
  const state = { value: [P(2), P(1), P(9)], changes: [] };
  const view = await mount("components/admin/editor/fields/ProductListControl.js", "default", () => ({
    field: field("collection_content", "pinned"),
    value: state.value,
    onChange: (v) => {
      state.changes.push(v);
      state.value = v;
    },
    issues: [],
    owner: null,
    context: { lookupProducts: cat.lookupProducts },
  }));
  eq(cat.asked, [[P(2), P(1), P(9)]], "one lookup for the names:");
  eq(rows(view), ["1. Bamboo lid", "2. Amber jar (Shopify title: AMBER JAR 250ML)", "3. No longer in your Shopify catalog"], "rows in order, Shopify's name only where it differs:");
  await view.click("Move Amber jar up");
  eq(state.value, [P(1), P(2), P(9)], "moved:");
  eq(rows(view)[0], "1. Amber jar (Shopify title: AMBER JAR 250ML)", "the row moved with its names:");
  await view.click("Remove product 3");
  eq(state.value, [P(1), P(2)], "the missing one removed:");
  // the catalog picker (RefPicker multi): what it confirms becomes the list, in its order
  await view.click("Change the products");
  const picker = view.find((n) => n.type?.name === "ProductPicker");
  ok(picker && picker.props.multi === true && picker.props.max === 24, "the catalog picker, several at once, up to 24");
  eq(picker.props.selectedIds, [P(1), P(2)], "it starts from the list:");
  picker.props.onConfirm([CATALOG[P(3)], CATALOG[P(1)]]);
  await view.flush();
  eq(state.value, [P(3), P(1)], "the picker's order:");
  eq(cat.asked.length, 1, "picked products need no second lookup:");
  eq(rows(view), ["1. Brush", "2. Amber jar (Shopify title: AMBER JAR 250ML)"], "and their names show:");
  picker.props.onConfirm([]);
  await view.flush();
  eq(state.value, null, "an empty list stores nothing (no pins):");
  const v = R.validateDocument({ ...R.emptyBody("collection_content"), settings: { ...R.emptyBody("collection_content").settings, pinned: [P(3), P(1)] } });
  eq(v.issues, [], "a picked list validates:");
});

await t("unit: PairsControl keeps the order, effective titles with the Shopify title as secondary text; an empty title is the default title; nothing at all stores null", async () => {
  const cat = catalog();
  const state = { value: { title: null, products: [P(1), P(3)] } };
  const view = await mount("components/admin/editor/fields/PairsControl.js", "default", () => ({
    field: field("product_content", "pairs"),
    value: state.value,
    onChange: (v) => (state.value = v),
    issues: [],
    owner: null,
    context: { lookupProducts: cat.lookupProducts },
  }));
  eq(rows(view), ["1. Amber jar (Shopify title: AMBER JAR 250ML)", "2. Brush"], "rows:");
  const title = view.find((n) => n.props?.id === "f-doc-pairs-title");
  eq([title.props.placeholder, title.props.value], ["Pairs well with", ""], "the default title shows while empty:");
  ok(view.all().includes("Leave it empty to use “Pairs well with”."), "and says so");
  await view.type("f-doc-pairs-title", "Complete the routine");
  eq(state.value, { title: "Complete the routine", products: [P(1), P(3)] }, "title typed:");
  await view.click("Move Brush up");
  eq(state.value, { title: "Complete the routine", products: [P(3), P(1)] }, "order:");
  await view.type("f-doc-pairs-title", "");
  eq(state.value, { title: null, products: [P(3), P(1)] }, "an empty title is the default:");
  const v = R.validateDocument({ ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, pairs: state.value } });
  eq(v.issues.filter((i) => i.field?.startsWith("pairs")), [], "validates:");
  await view.click("Remove Brush");
  await view.click("Remove Amber jar");
  eq(state.value, null, "no title and no product: none:");
});

// =====================================================================================
console.log("— 4. MediaAdmin, through the real /api/admin/media route");
// =====================================================================================

const listFor = (fx) => fx.run(async () => (await M.listMedia()).map((m) => ({ ...m, url: M.mediaUrl(m.id) })));
async function mediaAdmin(fx) {
  const sf = storeFetch(fx.id);
  const initial = await listFor(fx);
  const view = await withFetch(sf.fetch, () => mount("components/admin/MediaAdmin.js", "default", () => ({ initial }), { inflight: sf.inflight }));
  const act = (fn) => withFetch(sf.fetch, fn);
  const files = () => view.nodes().filter((n) => n.props?.["data-media-file"]).map((n) => `${n.props["data-media-file"]}${n.props["data-archived"] != null ? " (archived)" : ""}`);
  return { sf, view, act, files };
}

await t("unit: MediaAdmin archive and unarchive call the API and the archived filter shows them", async () => {
  const a = await upload(docs, "unused-a.png");
  const b = await upload(docs, "unused-b.png");
  const { sf, view, act, files } = await mediaAdmin(docs);
  ok(files().includes(a.id) && files().includes(b.id), "both listed");
  toasts.length = 0;
  await act(() => view.click("Archive"));
  const arch = sf.calls.filter((c) => c.method === "PATCH");
  eq(arch.length, 1, "one PATCH:");
  const archivedId = arch[0].body.id;
  eq(arch[0].body, { id: archivedId, archived: true }, "archive asks the API:");
  ok((await archivedAt(docs, archivedId)) != null, "the store holds it as archived");
  ok(!files().some((f) => f.startsWith(archivedId)), "hidden from the list");
  ok(toasts.some(([k, m]) => k === "success" && /is archived\. It's hidden from the image picker, and pages that use it still show it\./.test(m)), `plain words: ${JSON.stringify(toasts)}`);
  // the filter
  const box = view.find((n) => n.props?.id === "media-show-archived");
  ok(view.find((n) => n.type === "label" && n.props.htmlFor === "media-show-archived" && textOf(n.props.children) === "Show archived files"), "the box has a visible label");
  await act(async () => {
    box.props.onChange({ target: { checked: true } });
    await view.flush();
  });
  eq(sf.calls.at(-1), { method: "GET", url: "/api/admin/media?archived=include", body: null }, "lists archived files too:");
  ok(files().includes(`${archivedId} (archived)`), `shown and marked: ${files()}`);
  ok(view.all().includes("Archived: hidden from the image picker. Pages that use it still show it."), "with what archived means");
  await act(() => view.click("Unarchive"));
  eq(sf.calls.filter((c) => c.method === "PATCH").at(-1).body, { id: archivedId, archived: false }, "unarchive asks the API:");
  eq(await archivedAt(docs, archivedId), null, "back in the library");
  ok(files().includes(archivedId), "and listed as a plain file");
  // turning the filter off lists without archived files again
  await act(async () => {
    view.find((n) => n.props?.id === "media-show-archived").props.onChange({ target: { checked: false } });
    await view.flush();
  });
  eq(sf.calls.at(-1).url, "/api/admin/media", "the filter off:");
});

await t("unit (P4-FIX4): MediaAdmin says '<file> was archived. It's back in your library now.' when an upload's bytes match an archived file (the real saveMedia brings it back); a plain duplicate says 'reused'", async () => {
  const n = pngN++;
  const first = await docs.run(() => M.saveMedia({ filename: "amber-jar.png", mime: "image/png", bytes: PNG(n) }));
  await sql(docs, "UPDATE media SET archived_at = ? WHERE id = ?", ["2026-11-01T00:00:00Z", first.id]);
  ok((await archivedAt(docs, first.id)) != null, "archived first");
  const sf = storeFetch(docs.id);
  const initial = await listFor(docs);
  // the upload itself is the real saveMedia on this store (the upload route spreads its answer)
  const uploaded = [];
  const uploadStub = {
    uploadImage: async (file) => {
      const media = await docs.run(() => M.saveMedia({ filename: file.name, mime: "image/png", bytes: PNG(n) }));
      uploaded.push(media);
      return { ok: true, media };
    },
  };
  const view = await withFetch(sf.fetch, () => mount("components/admin/MediaAdmin.js", "default", () => ({ initial }), { inflight: sf.inflight, stubs: { "@/lib/media-upload": uploadStub } }));
  const pick = async (name) =>
    withFetch(sf.fetch, async () => {
      const input = view.find((n2) => n2.type === "input" && n2.props?.type === "file");
      ok(input, "the file input");
      input.props.onChange({ target: { files: [{ name }] } });
      await view.flush();
    });
  toasts.length = 0;
  await pick("amber-jar-again.png");
  eq(uploaded.length, 1, "one upload:");
  eq([uploaded[0].id, uploaded[0].deduped, uploaded[0].unarchived], [first.id, true, true], "the store brought the archived file back:");
  eq(await archivedAt(docs, first.id), null, "no longer archived");
  eq(toasts, [["success", "amber-jar-again.png was archived. It's back in your library now."]], "the founder is told:");
  // the same bytes again: a plain duplicate, no longer archived
  toasts.length = 0;
  await pick("amber-jar-third.png");
  eq([uploaded[1].deduped, uploaded[1].unarchived ?? false], [true, false], "a plain duplicate:");
  eq(toasts, [["success", "amber-jar-third.png was already in the library — reused"]], "reused:");
});

await t("unit: MediaAdmin, delete of a used file shows the plain reason and where it is used, offers Archive it instead and no way round it (documents store); 'Where it's used' lists pages by name", async () => {
  // a fresh store's view: one used file only
  await sql(docs, "DELETE FROM media");
  const used = await upload(docs, "hero-jar.png", "Jar");
  const hero = R.newSection("hero", { id: "sec_mp1" });
  hero.settings = { ...hero.settings, title: "Hello", image: { media: `/api/media/${used.id}`, alt: "Jar" } };
  await docs.run(() => Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [hero] }, actor: { kind: "merchant", id: owner.id } }));
  const { sf, view, act } = await mediaAdmin(docs);
  // where it's used
  await act(() => view.click("Where it’s used"));
  eq(sf.calls.at(-1), { method: "PUT", url: "/api/admin/media", body: { id: used.id } }, "the usage read:");
  const usedBy = view.find((n) => n.props?.["data-media-used-by"] === used.id);
  ok(usedBy && textOf(usedBy.props.children).includes("Home page (draft)"), `the page by name and state: ${usedBy && textOf(usedBy.props.children)}`);
  ok(!/doc_|med_|ver_|block:|release:/.test(textOf(usedBy.props.children)), "no ids or codes");
  // delete
  await view.click(`Delete hero-jar.png`);
  const confirm = view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete");
  ok(confirm, "the confirm dialog");
  await act(async () => {
    await confirm.props.onClick();
    await view.flush();
  });
  eq(sf.calls.filter((c) => c.method === "DELETE").map((c) => c.body), [{ id: used.id, force: false }], "one plain delete, never forced:");
  const refused = view.find((n) => n.props?.["data-delete-refused"] != null);
  ok(refused, "the refusal shows");
  const words = textOf(refused.props.children);
  ok(words.startsWith("This file is still used, so it wasn't deleted. Remove it from the places below first."), `the console's fixed words (P4-FIX2): ${words}`);
  ok(words.includes("Used by:") && words.includes("Home page (draft)"), "where it is used");
  ok(!view.hasButton("Delete anyway"), "no way round it");
  ok(view.hasButton("Archive it instead"), "archive offered instead");
  eq(await archivedAt(docs, used.id), null, "the file is kept");
  await act(() => view.click("Archive it instead"));
  ok((await archivedAt(docs, used.id)) != null, "archived instead");
  ok(!view.find((n) => n.props?.["data-delete-refused"] != null), "the refusal closed");
});

await t("unit: MediaAdmin on a legacy store keeps today's choice for a used file (delete anyway), in plain words; a refusal of any other kind shows its words", async () => {
  const f = await upload(legacy, "banner.png");
  await raw(legacy).execute({ sql: "INSERT INTO cms_blocks (key, value) VALUES ('hero', ?)", args: [JSON.stringify({ image: `/api/media/${f.id}` })] });
  const { sf, view, act } = await mediaAdmin(legacy);
  await view.click("Delete banner.png");
  await act(async () => {
    await view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete").props.onClick();
    await view.flush();
  });
  ok(view.hasButton("Delete anyway"), "today's choice stays on a legacy store");
  const all = view.all();
  ok(all.includes("A section of your home page") && !all.includes("block:hero"), "in plain words, no codes");
  await act(async () => {
    await view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete anyway").props.onClick();
    await view.flush();
  });
  eq(sf.calls.filter((c) => c.method === "DELETE").map((c) => c.body.force), [false, true], "the forced delete only after the choice:");
  eq(await archivedAt(legacy, f.id), "gone", "deleted on the legacy store, as today");
  // a store being moved: the plain words, no archive offer
  await raw(legacy).execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  try {
    const g = await upload(legacy, "moving.png");
    const m2 = await mediaAdmin(legacy);
    await m2.view.click("Delete moving.png");
    await m2.act(async () => {
      await m2.view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete").props.onClick();
      await m2.view.flush();
    });
    const refused = m2.view.find((n) => n.props?.["data-delete-refused"] != null);
    ok(refused && textOf(refused.props.children).includes(M.MIGRATING_MESSAGE), "the moving store's words");
    ok(!m2.view.hasButton("Archive it instead") && !m2.view.hasButton("Delete anyway"), "nothing to do but wait");
    eq(await archivedAt(legacy, g.id), null, "kept");
  } finally {
    await raw(legacy).execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
  }
});

await t("unit (P4-FIX2): on a legacy store, a file used by an old section AND a page draft gets no 'Delete anyway' (the server always refuses it), and the refusal is in fixed plain words with no codes", async () => {
  const f = await upload(legacy, "promo.png");
  const src = `/api/media/${f.id}`;
  await raw(legacy).execute({ sql: "INSERT INTO cms_blocks (key, value) VALUES ('promo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [JSON.stringify({ image: src })] });
  const now = new Date().toISOString();
  const draft = JSON.stringify({ type: "home", sections: [{ id: "sec_x", kind: "hero", settings: { image: { media: src, alt: "" } } }] });
  await raw(legacy).execute({ sql: "INSERT INTO documents (id, type, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_home', 'home', 'Home page', ?, 'dh_fix2', 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET draft = excluded.draft", args: [draft, now, now] });
  try {
    const usage = await legacy.run(() => M.mediaUsage(f.id));
    ok(usage.some((u) => u.document) && usage.some((u) => !u.document), `mixed usage: ${JSON.stringify(usage)}`);
    const { sf, view, act } = await mediaAdmin(legacy);
    await view.click("Delete promo.png");
    await act(async () => {
      await view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete").props.onClick();
      await view.flush();
    });
    ok(!view.hasButton("Delete anyway"), "no choice that can't succeed");
    const refused = view.find((n) => n.props?.["data-delete-refused"] != null);
    ok(refused, "the refusal shows");
    const words = textOf(refused.props.children);
    ok(words.startsWith("This file is still used, so it wasn't deleted. Remove it from the places below first."), `fixed words: ${words}`);
    ok(words.includes("A section of your home page") && words.includes("Home page (draft)"), `the places, in plain words: ${words}`);
    const all = view.all();
    ok(!/block:|still referenced|doc_|med_/.test(all), `no codes or server text: ${all.slice(0, 400)}`);
    eq(sf.calls.filter((c) => c.method === "DELETE").map((c) => c.body.force), [false], "never forced:");
    eq(await archivedAt(legacy, f.id), null, "kept");
    // the helpers
    const MA = await world({ "@/components/console/Toast": toastStub })(join(ROOT, "components/admin/MediaAdmin.js"));
    eq(MA.canForceDelete(usage), false, "canForceDelete, mixed:");
    eq(MA.canForceDelete(usage.filter((u) => !u.document)), true, "canForceDelete, old sections only:");
    eq(MA.refusalWords("MEDIA_IN_USE", "still referenced by block:promo"), MA.MEDIA_WORDS.inUse, "never the server's text for a used file:");
    eq(MA.refusalWords("SOMETHING_NEW", "raw words: block:x"), MA.MEDIA_WORDS.failed, "an unknown refusal:");
  } finally {
    await raw(legacy).execute("DELETE FROM documents WHERE id = 'doc_home' AND draft_hash = 'dh_fix2'");
    await raw(legacy).execute("DELETE FROM cms_blocks WHERE key = 'promo'");
  }
});

await t("unit (P4-FIX2): a forced delete the server refuses after the choice (a page started using the file meanwhile) closes the choice and shows the fixed words, never the server's text", async () => {
  const f = await upload(legacy, "race.png");
  const src = `/api/media/${f.id}`;
  await raw(legacy).execute({ sql: "INSERT INTO cms_blocks (key, value) VALUES ('race', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [JSON.stringify({ image: src })] });
  try {
    const { sf, view, act } = await mediaAdmin(legacy);
    await view.click("Delete race.png");
    await act(async () => {
      await view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete").props.onClick();
      await view.flush();
    });
    ok(view.hasButton("Delete anyway"), "an old section only: the choice is offered");
    // a page draft starts using it before the founder confirms
    const now = new Date().toISOString();
    await raw(legacy).execute({ sql: "INSERT INTO documents (id, type, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_race', 'page', 'About us', ?, 'dh_race', 1, 1, ?, ?)", args: [JSON.stringify({ type: "page", sections: [{ image: src }] }), now, now] });
    await act(async () => {
      await view.nodes().find((n) => n.type === "button" && nameOf(n) === "Delete anyway").props.onClick();
      await view.flush();
    });
    eq(sf.calls.filter((c) => c.method === "DELETE").map((c) => c.body.force), [false, true], "the forced delete was asked:");
    ok(!view.hasButton("Delete anyway"), "the choice closed");
    const refused = view.find((n) => n.props?.["data-delete-refused"] != null);
    ok(refused && textOf(refused.props.children).startsWith("This file is still used, so it wasn't deleted."), "fixed words");
    ok(!/block:|still referenced|doc_|med_/.test(view.all()), "no codes or server text");
    eq(await archivedAt(legacy, f.id), null, "kept");
  } finally {
    await raw(legacy).execute("DELETE FROM documents WHERE id = 'doc_race'");
    await raw(legacy).execute("DELETE FROM cms_blocks WHERE key = 'race'");
  }
});

await t("unit: usageLine says every kind of use in plain words, never an id", async () => {
  const MA = await world({ "@/components/console/Toast": toastStub })(join(ROOT, "components/admin/MediaAdmin.js"));
  const cases = [
    [{ where: "live:doc_home", label: "live", document: "doc_home", name: "Home page" }, "Home page (live)"],
    [{ where: "older version:doc_x", label: "older version", document: "doc_x", name: null }, "A page (an earlier version)"],
    [{ where: "live release:rel_1", release: "rel_1" }, "What your store shows now"],
    [{ where: "retained release:rel_0", release: "rel_0" }, "An earlier published version of your store"],
    [{ where: "brand settings", config: "brand" }, "Your brand settings"],
    [{ where: "block:hero" }, "A section of your home page"],
    [{ where: "page:about" }, "Your page “about”"],
    [{ where: "product modules:gid://shopify/Product/1" }, "A product's extra content"],
    [{ where: "scheduled release:rel_2" }, "A scheduled update of your store"],
    [{ where: "something new" }, "Another part of your store"],
  ];
  for (const [u, want] of cases) eq(MA.usageLine(u), want, `${u.where}:`);
  for (const [, words] of cases) ok(!/doc_|rel_|gid:|med_/.test(words), `no id in ${words}`);
  ok(MA.documentsUsage([cases[0][0], cases[2][0], cases[4][0]]) && !MA.documentsUsage([cases[5][0]]), "a documents store's usage is told from a legacy one's");
});

// =====================================================================================
console.log("— 5. keyboard and labels");
// =====================================================================================

await t("rendered: every new control's text box has a visible label, and every action is a button with a name", async () => {
  const W = world({ "@/components/console/Toast": toastStub });
  const G = await W(join(ROOT, "components/admin/editor/fields/GalleryControl.js"));
  const Pa = await W(join(ROOT, "components/admin/editor/fields/PairsControl.js"));
  const PL = await W(join(ROOT, "components/admin/editor/fields/ProductListControl.js"));
  const MA = await W(join(ROOT, "components/admin/MediaAdmin.js"));
  const pages = {
    gallery: renderToStaticMarkup(h(G.default, { field: field("product_content", "gallery"), value: { value: [{ media: "/api/media/med_1", alt: "A" }, { media: "https://cdn.shopify.com/s/b.jpg", alt: "" }] }, onChange() {}, issues: [], owner: null, context: { pickImage: async () => null, shopify: { gallery: SHOPIFY } } })),
    pairs: renderToStaticMarkup(h(Pa.default, { field: field("product_content", "pairs"), value: { title: "X", products: [P(1)] }, onChange() {}, issues: [], owner: null, context: { lookupProducts: async () => [] } })),
    pinned: renderToStaticMarkup(h(PL.default, { field: field("collection_content", "pinned"), value: [P(1), P(2)], onChange() {}, issues: [], owner: null, context: { lookupProducts: async () => [] } })),
    media: renderToStaticMarkup(h(MA.default, { initial: [{ id: "med_1", filename: "a.png", mime: "image/png", size: 2000, alt: "", url: "/api/media/med_1", variants: [] }, { id: "med_2", filename: "b.png", mime: "image/png", size: 2000, alt: "", url: "/api/media/med_2", variants: [], archived_at: "2026-11-01T00:00:00Z" }] })),
  };
  for (const [name, html] of Object.entries(pages)) {
    const inputs = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)].filter((m) => !/type="file"/.test(m[2]));
    ok(name === "pinned" || inputs.length > 0, `${name}: has fields`);
    for (const m of inputs) {
      const id = /\sid="([^"]+)"/.exec(m[2])?.[1];
      const labelled = (id && html.includes(`for="${id}"`)) || /aria-label="[^"]+"/.test(m[2]);
      ok(labelled, `${name}: a field without a label: ${m[0].slice(0, 120)}`);
      if (name !== "media") ok(id && html.includes(`for="${id}"`), `${name}: the label is visible (label for=): ${id}`);
    }
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    ok(buttons.length > 0, `${name}: has buttons`);
    for (const b of buttons) {
      const named = /aria-label="[^"]+"/.test(b[1]) || b[2].replace(/<[^>]*>/g, "").trim().length > 0;
      ok(named, `${name}: a button without a name: ${b[0].slice(0, 160)}`);
      ok(/type="button"/.test(b[1]), `${name}: a button that isn't type=button: ${b[0].slice(0, 120)}`);
    }
    ok(!/<div[^>]*onclick/i.test(html) && !/role="button"/.test(html), `${name}: no clickable non-buttons`);
  }
  ok(pages.media.includes("Archive") && pages.media.includes("Unarchive"), "media: archive and unarchive are buttons");
});

// ---- done -------------------------------------------------------------------------------
function readFileSync(p) {
  return require("node:fs").readFileSync(p, "utf8");
}
for (const c of raws.values()) c.close();
for (const fx of [docs, legacy]) await fx.cleanup();
await plat.cleanup();
await F.removeFixtureFiles("mp");
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${failures.length} failed (${secs} s)`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
process.exit(0);
