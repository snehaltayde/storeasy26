// P4-EDITOR (OVL-04, OVL-01, OVL-06, ED-12, ED-02): the product editor and the
// collection form.
//   1. the entry: /admin/editor?product=<gid> and ?collection=<gid> (the real
//      editor page with its real reads and writes); a read-only person never
//      triggers a write and never waits on a loading line
//   2. the product form's overlay rules: Reset, "Differs from Shopify" after an
//      edit, a reset and a sync; the "Changed in Shopify" notice and its two
//      choices; saving Shopify's value leaves no override; an untouched
//      description is sent as null
//   3. what has a control: only the overlay fields; price, variants and stock
//      read-only with the Shopify link; the Catalog screen's new words
//   4. the title gate forced closed, and open on a Typesense store
//   5. the product and collection forms edit their settings
//   6. shoppers never see editor-only words
//   7. the switcher: every product reachable, a renamed one found, the counts;
//      the editor never reads /api/admin/catalog
//   8. the gallery's first-edit note and "Shopify's images changed"
//   9. a product that left Shopify
//  10. module kinds offered and the caps in plain words
// Real file databases (scripts/support/tenant-fixture.js), the real services,
// the real documents API and real components (Next's own SWC, react-dom/server,
// and a small hook driver to press buttons). Typesense: dummy localhost values
// in this process only; nothing is sent anywhere. Nothing writes to Shopify.
//   pnpm test:product-editor
import "./support/request-cache.js";
import { readFile, readdir } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

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
process.env.DATABASE_URL = "file:.test-pe-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "SHOPIFY_STORE_DOMAIN"]) delete process.env[k];

const started = Date.now();
let pass = 0;
const failures = [];
const F = await import("./support/tenant-fixture.js");
const R = await import("../lib/registry/index.js");
const Docs = await import("../lib/documents/service.js");
const Ids = await import("../lib/documents/ids.js");
const Gate = await import("../lib/catalog/title-gate.js");
const TS = await import("../lib/typesense-search.js");
const Sync = await import("../lib/sync.js");
const EE = await import("../lib/admin/entity-entry.js");
const EM = await import("../components/admin/editor/editorModel.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/sessions.js");

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n       ")}`);
  } finally {
    Gate.setTitleGateForTest(false);
    TS.setSearchAdminClientForTest(null);
    for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION"]) delete process.env[k];
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
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- the JSX loader (Next's SWC) and a small hook driver ------------------------------
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
const navStub = { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), redirect: (to) => { throw new Error(`redirect ${to}`); }, usePathname: () => "/admin/editor", notFound: () => { throw new Error("notFound"); } };
const toastStub = { useToast: () => ({ success() {}, error() {}, info() {} }) };

const SKIP = new Set(["Dialog", "ProductPicker", "RefPicker", "CopyButton", "MediaPicker", "RichTextField", "PreviewPane"]);
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
    useSyncExternalStore(subscribe, getSnapshot) {
      const k = cursor++;
      const box = cur;
      if (!box[k]) {
        box[k] = { unsub: subscribe(() => (dirty = true)) };
      }
      return getSnapshot();
    },
    // a context's default value (no provider in a driven render; the
    // toggle-group of the Phase 2 editor frame reads one)
    useContext(c) {
      return c?._currentValue ?? null;
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
      if (typeof ty === "function" && n.props.open === false) return;
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
async function mount(file, exportName, makeProps, { stubs = {} } = {}) {
  const d = driver();
  const load = world({ react: d.react, "@/components/kit/toast": toastStub, "next/navigation": navStub, ...stubs });
  const mod = await load(join(ROOT, file));
  const C = exportName === "default" ? mod.default : mod[exportName];
  ok(typeof C === "function", `${file} has no ${exportName}`);
  let nodes = [];
  // Phase 2 line 6: the page always hands the editor `can`; a test that
  // names none is a writer's (can.write false makes the store read-only)
  const propsNow = () => {
    const p = makeProps();
    return file.endsWith("DocumentEditor.js") && !p.can ? { ...p, can: { write: true, publish: true, offersWrite: true } } : p;
  };
  const draw = () => (nodes = d.render(React.createElement(C, propsNow())));
  const flush = async () => {
    for (let round = 0; round < 40; round++) {
      d.takeDirty();
      draw();
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
      if (!d.takeDirty()) {
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
    find: (pred) => nodes.find(pred) || null,
    all: (pred) => nodes.filter(pred),
    button(name) {
      const b = nodes.find((n) => n.type === "button" && nameOf(n) === name);
      ok(b, `no button "${name}"; buttons: ${nodes.filter((n) => n.type === "button").map(nameOf).join(" | ")}`);
      return b;
    },
    async click(name) {
      const b = view.button(name);
      ok(!b.props.disabled, `button "${name}" is disabled`);
      await b.props.onClick?.({ preventDefault() {}, target: {} });
      await flush();
    },
  };
  return view;
}

// =====================================================================================
// stores, people, the real API
// =====================================================================================
await F.removeFixtureFiles("pe");
await F.makePlatform({ name: "pe" });
const CONFIG = { site: { name: "PE Store" }, site_url: "https://pe.test", shopify_store_domain: "pe-store.myshopify.com" };
const docs = await F.makeTenant({ name: "pe-docs", id: "pedocs", products: 35, config: CONFIG });
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
await raw(docs).executeMultiple(schema);
await raw(docs).execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
const COL = "gid://shopify/Collection/601";
await raw(docs).execute({ sql: "INSERT INTO collections (id, handle, title, updated_at, synced_at) VALUES (?, 'autumn', 'Autumn', '2026-01-01', '2026-01-01')", args: [COL] });

const ownerU = await I.createUser({ email: "owner@pe.test", name: "Asha Rao", password: "owner-pass-editor" });
const staffU = await I.createUser({ email: "staff@pe.test", name: "Ravi", password: "staff-pass-editor" });
await I.addMembership(ownerU.id, docs.id, "owner");
await I.addMembership(staffU.id, docs.id, "staff");
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const OWNER_ACTOR = { kind: "merchant", id: ownerU.id, role: "owner" };
const STAFF_ACTOR = { kind: "merchant", id: staffU.id, role: "staff" };
const SUPPORT_ACTOR = { kind: "operator-support", id: "op1", role: "support" };
const req = (fx, cookie, body) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (body, as = OWNER) => docs.run(() => handleDocumentsPut(req(docs, as, body)));
const P = (n) => `gid://shopify/Product/${9100 + n}`;
const run = (fn) => docs.run(fn);
const read = (n) => run(() => EE.readEntityContent({ type: "product_content", entityId: P(n) }));
const open = (n, actor = OWNER_ACTOR) => run(() => EE.entityEntry({ type: "product_content", entityId: P(n), actor }));
async function save(id, mutate) {
  const d = (await api({ getDocument: id })).body.document;
  const body = clone(d.body);
  mutate(body);
  const r = await api({ saveDraft: { id, body }, revision: d.revision });
  ok(r.status === 200, `save: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
}
async function publishDoc(id) {
  const d = (await api({ getDocument: id })).body.document;
  const r = await api({ publish: { id, draftHash: d.draftHash }, revision: d.revision });
  ok(r.status === 200, `publish: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
const sync = (n, over) => run(() => Sync.writeProduct(F.fixtureProduct(n, over)));

// ---- the components -------------------------------------------------------------------
const loadPlain = world({ "next/navigation": navStub, "@/components/kit/toast": toastStub });
const PF = await loadPlain(join(ROOT, "components/admin/editor/ProductForm.js"));
const CF = await loadPlain(join(ROOT, "components/admin/editor/CollectionForm.js"));
const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const plain = (m) => m.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/\s+/g, " ").trim();
const formHtml = (props) => html(h(PF.default, { context: { lookupProducts: async () => [] }, ...props }));
// the attributes of the element with this id
const tagOf = (m, id) => m.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0] || null;
const isDisabled = (m, id) => /\sdisabled=""/.test(tagOf(m, id) || "");

// =====================================================================================
console.log("— 1. the entry");
// =====================================================================================

// The real editor page, with only the sign-in and Next's request helpers stubbed.
const pageState = { actor: OWNER_ACTOR };
const DocStub = () => null;
const pageWorld = world({
  "next/navigation": navStub,
  "@/components/kit/toast": toastStub,
  "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
  "@/lib/admin-auth": { adminActor: async () => pageState.actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
  "@/lib/console-request": { tfetch: (fn) => docs.run(fn) },
  "@/components/admin/editor/DocumentEditor": { __esModule: true, default: DocStub },
});
const EditorPage = (await pageWorld(join(ROOT, "app/(console)/admin/(authed)/editor/page.js"))).default;
async function openPage(searchParams, actor = OWNER_ACTOR) {
  pageState.actor = actor;
  const el = await EditorPage({ searchParams: Promise.resolve(searchParams) });
  ok(el && el.type === DocStub, "the page renders the editor");
  return el.props;
}
const docCount = async () => (await sql(docs, "SELECT COUNT(*) AS n, COALESCE(SUM(revision), 0) AS r FROM documents"))[0];

await t("unit: ?product=<gid> opens the deterministic document (made for it), with what Shopify sends now, the price, variants and stock", async () => {
  const p = await openPage({ product: P(1) });
  eq(p.document.id, await Ids.productDocumentId(P(1)), "the deterministic id:");
  eq([p.document.type, p.document.label], ["product_content", "Fixture product 1"], "type and label:");
  eq(p.entity.shopify.title, "Fixture product 1", "Shopify's name:");
  eq(p.entity.shopify.gallery, [{ media: "https://cdn.shopify.com/fixture/fixture-product-1.png", alt: "Fixture product 1" }], "Shopify's images:");
  eq([p.entity.commerce.priceMin, p.entity.commerce.currency, p.entity.commerce.available, p.entity.commerce.variants.length], [100, "INR", true, 1], "price, stock, variants:");
  eq(p.entity.shopifyAdminUrl, "https://admin.shopify.com/store/pe-store/products/9101", "the Shopify link:");
  eq(p.readOnly, null, "an owner can edit:");
  ok((await sql(docs, "SELECT 1 FROM documents WHERE id = ?", [p.document.id])).length === 1, "the document exists");
  const again = await openPage({ product: P(1) });
  eq(again.document.id, p.document.id, "opening it again finds the same one:");
});

await t("unit: ?product=<gid> reuses a phase-3 random-id row; ?collection=<gid> opens the collection's content", async () => {
  const made = await run(() => Docs.openEntityContent({ type: "product_content", entityId: P(2), actor: OWNER_ACTOR }));
  await raw(docs).execute({ sql: "UPDATE documents SET id = 'doc_k3m5p7r9t1v3x5z7' WHERE id = ?", args: [made.document.id] });
  const p = await openPage({ product: P(2) });
  eq(p.document.id, "doc_k3m5p7r9t1v3x5z7", "the phase-3 row:");
  eq((await sql(docs, "SELECT COUNT(*) AS n FROM documents WHERE entity_id = ?", [P(2)]))[0].n, 1, "no second document:");
  const c = await openPage({ collection: COL });
  eq([c.document.id, c.document.type], [await Ids.collectionDocumentId(COL), "collection_content"], "the collection's content:");
  eq(c.entity.shopify, { title: "Autumn", handle: "autumn" }, "Shopify's collection:");
  const gone = await openPage({ product: "gid://shopify/Product/404404" });
  eq(gone.document.id, "doc_home", "a product not in the catalog opens home:");
  eq(gone.note, EE.ENTRY_WORDS.productGone, "with plain words:");
});

await t("unit: a read-only person opening product content never triggers a write and never sees an endless loading line", async () => {
  const before = await docCount();
  // a product with no content yet
  const p = await openPage({ product: P(3) }, SUPPORT_ACTOR);
  eq(await docCount(), before, "nothing written (no document made):");
  eq(p.readOnly, EE.ENTRY_WORDS.readOnly, "the plain words:");
  ok(Array.isArray(p.entity.shopify.gallery) && p.entity.shopify.gallery.length === 1, "Shopify's images are read on the server");
  // an archived document stays archived (openEntityContent would bring it back)
  const d1 = (await api({ getDocument: await Ids.productDocumentId(P(1)) })).body.document;
  const ar = await api({ archive: { id: d1.id }, revision: d1.revision });
  eq(ar.status, 200, "archived:");
  const snap = await docCount();
  const q = await openPage({ product: P(1) }, SUPPORT_ACTOR);
  eq(await docCount(), snap, "still nothing written:");
  ok((await sql(docs, "SELECT archived_at FROM documents WHERE id = ?", [d1.id]))[0].archived_at != null, "the archived row is not brought back");
  eq(q.document.id, d1.id, "the read-only view still opens it:");
  // the owner brings it back (a write, allowed)
  await openPage({ product: P(1) });
  ok((await sql(docs, "SELECT archived_at FROM documents WHERE id = ?", [d1.id]))[0].archived_at == null, "the owner's open brings it back");
  // rendered: the empty, read-only form with Shopify's values, never "Loading Shopify's images…"
  const E = await world({ "next/navigation": navStub, "@/components/kit/toast": toastStub })(join(ROOT, "components/admin/editor/DocumentEditor.js"));
  const m = html(h(E.EditorView, { entry: p.document, load: { status: "missing" }, docs: [], entity: p.entity, readOnly: p.readOnly }));
  ok(!plain(m).includes("Loading Shopify"), "no loading line");
  ok(plain(m).includes(EE.ENTRY_WORDS.readOnly) && plain(m).includes("Nothing has been changed on this product yet"), `the plain words: ${plain(m).slice(0, 300)}`);
  ok(plain(m).includes("https://cdn.shopify.com/fixture/fixture-product-3.png") || m.includes("fixture-product-3.png"), "Shopify's image is shown");
  ok(!/<input[^>]*id="f-doc-title"(?![^>]*disabled)/.test(m), "the name can't be changed");
  // the editor never asks for the entity in the browser
  const src = await readFile(join(ROOT, "components/admin/editor/DocumentEditor.js"), "utf8");
  ok(!/call\("openEntityContent"/.test(src), "DocumentEditor never calls openEntityContent");
});

// =====================================================================================
console.log("— 2. the overlay rules");
// =====================================================================================

const P5 = await Ids.productDocumentId(P(5));
await t("unit: every overlay field has Reset; the 'differs' label is right after an edit, after a reset and after a sync that changes Shopify's value", async () => {
  await open(5);
  // an edit (as the form sends it)
  let e = await read(5);
  await save(P5, (b) => {
    b.settings.title = EM.editOverlay("title", b.settings.title, "Moon serum", e);
    b.settings.display_vendor = EM.editOverlay("display_vendor", b.settings.display_vendor, "Moon Labs", e);
  });
  e = await read(5);
  let body = e.document.body;
  let m = EM.productFormModel({ body, entity: e });
  const f = (k) => m.fields.find((x) => x.key === k);
  eq([f("title").differs, f("title").value, f("display_vendor").differs, f("display_type").differs], [true, "Moon serum", true, false], "after the edit:");
  let markup = formHtml({ body, entity: e });
  for (const k of ["title", "description_html", "gallery", "display_vendor", "display_type"]) ok(new RegExp(`data-reset="${k}"`).test(markup), `Reset on ${k}`);
  ok(/data-overlay="title"[\s\S]*?data-differs=""/.test(markup) && plain(markup).includes("Differs from Shopify") && plain(markup).includes("Shopify title: Fixture product 5"), "rendered: Differs, and Shopify's name beside it");
  // Reset through the form's own button
  const changes = [];
  const v = await mount("components/admin/editor/ProductForm.js", "default", () => ({ body, entity: e, context: { lookupProducts: async () => [] }, on: { edit: (x) => changes.push(x) } }));
  await v.click("Reset to Shopify: name");
  eq(changes.at(-1), { path: "title", value: null }, "Reset sends null (follow Shopify):");
  ok(v.button("Reset to Shopify: description").props.disabled, "nothing to reset on a field that follows Shopify");
  await save(P5, (b) => (b.settings.title = null));
  e = await read(5);
  m = EM.productFormModel({ body: e.document.body, entity: e });
  eq([m.fields[0].following, m.fields[0].differs, m.fields[0].value], [true, false, "Fixture product 5"], "after the reset:");
  ok(/data-overlay="title"[\s\S]*?data-same=""/.test(formHtml({ body: e.document.body, entity: e })), "rendered: Same as Shopify");
  // edit again, then Shopify renames the product to the same name: no longer differs
  await save(P5, (b) => (b.settings.title = EM.editOverlay("title", null, "Moon serum", e)));
  await sync(5, { title: "Moon serum" });
  e = await read(5);
  m = EM.productFormModel({ body: e.document.body, entity: e });
  eq([m.fields[0].following, m.fields[0].differs], [false, false], "a sync to the founder's name: the same as Shopify:");
  // a sync to another name: differs, and the notice is up (the field was edited)
  await sync(5, { title: "Night serum 2" });
  e = await read(5);
  m = EM.productFormModel({ body: e.document.body, entity: e });
  eq([m.fields[0].differs, m.fields[0].shopifyValue], [true, "Night serum 2"], "a sync to another name:");
  eq(m.shopifyTitleLine, "Shopify title: Night serum 2", "Shopify's name is always shown (OVL-06):");
});

await t("unit: the notice appears only for an EDITED field changed in Shopify, and both choices work ('Keep mine', 'Use Shopify's'), clearing the notice and the count before any publish", async () => {
  // product 5: title edited, Shopify changed it (above); brand edited, Shopify's brand unchanged
  let e = await read(5);
  let m = EM.productFormModel({ body: e.document.body, entity: e });
  eq(m.notices.map((n) => n.field), ["title"], "only the edited, changed field:");
  // an unedited field changed in Shopify: no notice
  await sync(5, { title: "Night serum 2", productType: "Serums" });
  e = await read(5);
  eq(EM.productFormModel({ body: e.document.body, entity: e }).notices.map((n) => n.field), ["title"], "the type changed but was never edited: no notice:");
  const markup = formHtml({ body: e.document.body, entity: e });
  ok(/data-shopify-changed="title"/.test(markup) && plain(markup).includes("Keep mine") && plain(markup).includes("Use Shopify's"), "rendered with both choices");
  const counts = async () => (await api({ listProductContent: { limit: 1 } }, STAFF)).body.counts.changedInShopify;
  const before = await counts();
  ok(before >= 1, `counted: ${before}`);
  const logRows = async () => (await sql(docs, "SELECT COUNT(*) AS n FROM publish_log"))[0].n;
  const logs = await logRows();
  // Keep mine: the store call sends resolveShopifyChange 'keep'
  const clicked = [];
  const v = await mount("components/admin/editor/ProductForm.js", "default", () => ({ body: e.document.body, entity: e, context: { lookupProducts: async () => [] }, on: { resolve: (f, c) => clicked.push([f, c]) } }));
  await v.click("Keep mine: name");
  await v.click("Use Shopify's: name");
  eq(clicked, [["title", "keep"], ["title", "shopify"]], "the buttons:");
  let d = (await api({ getDocument: P5 })).body.document;
  let r = await api({ resolveShopifyChange: { id: P5, field: "title", choice: "keep" }, revision: d.revision });
  eq(r.status, 200, "keep:");
  e = await read(5);
  m = EM.productFormModel({ body: e.document.body, entity: e });
  eq([m.notices.length, m.fields[0].value, m.fields[0].differs], [0, "Moon serum", true], "Keep mine: the notice is gone, the name stays the founder's:");
  eq(await counts(), before - 1, "the Changed in Shopify count drops at once:");
  // Shopify changes it again; this time Use Shopify's
  await sync(5, { title: "Night serum 3", productType: "Serums" });
  e = await read(5);
  eq(EM.productFormModel({ body: e.document.body, entity: e }).notices.length, 1, "changed again:");
  d = (await api({ getDocument: P5 })).body.document;
  r = await api({ resolveShopifyChange: { id: P5, field: "title", choice: "shopify" }, revision: d.revision });
  eq(r.status, 200, "Use Shopify's:");
  e = await read(5);
  m = EM.productFormModel({ body: e.document.body, entity: e });
  eq([m.notices.length, e.document.body.settings.title, m.fields[0].following, m.fields[0].value], [0, null, true, "Night serum 3"], "Use Shopify's: the field follows Shopify:");
  eq(await counts(), before - 1, "and the count stays down:");
  eq(await logRows(), logs, "no publish happened:");
});

await t("unit: Reset and 'Use Shopify's' leave the field following Shopify; saving Shopify's value leaves no override; an untouched description is sent as null", async () => {
  await open(6);
  const id = await Ids.productDocumentId(P(6));
  let e = await read(6);
  // saving the Shopify value: the form sends null, and the service stores null anyway
  eq(EM.editOverlay("title", null, "Fixture product 6", e), null, "the form sends null for Shopify's value:");
  eq(EM.editOverlay("gallery", null, [{ media: "https://cdn.shopify.com/fixture/fixture-product-6.png?v=9", alt: "Fixture product 6" }], e), null, "the same image (query string aside):");
  const d0 = await save(id, (b) => (b.settings.title = { value: "Fixture product 6" }));
  eq(d0.body.settings.title, null, "the service stores null:");
  // the description: Shopify's HTML, as an editor sends it back cleaned or re-spaced
  await sync(6, { descriptionHtml: '<p style="color:red">Soft <span>cotton</span></p>' });
  e = await read(6);
  eq(EM.editOverlay("description_html", null, '<p style="color:red">Soft <span>cotton</span></p>', e), null, "Shopify's own text is null:");
  // the form: typing in another field sends the description as null
  const sent = [];
  const v = await mount("components/admin/editor/ProductForm.js", "default", () => ({ body: e.document.body, entity: e, context: { lookupProducts: async () => [] }, on: { edit: (x) => sent.push(x) } }));
  const rte = v.find((n) => n.type?.name === "RichTextField");
  ok(rte && rte.props.value === '<p style="color:red">Soft <span>cotton</span></p>', "the description box shows Shopify's text while following");
  ok(!sent.some((x) => x.path === "description_html"), "the untouched description sends nothing");
  rte.props.onChange("<p>Soft <span>cotton</span></p>");
  const cleaned = await save(id, (b) => (b.settings.description_html = sent.at(-1).value));
  eq(cleaned.body.settings.description_html, null, "an editor's cleaned copy of Shopify's text is stored null (the service cleans, never the client):");
  rte.props.onChange("<p>Softer cotton</p>");
  eq(sent.at(-1).value.value, "<p>Softer cotton</p>", "a real edit is the founder's:");
  const d1 = await save(id, (b) => (b.settings.badge = "New"));
  eq(d1.body.settings.description_html, null, "saved: the untouched description is null:");
  // a real edit, then Reset and Use Shopify's: null again
  await save(id, (b) => (b.settings.description_html = { value: "<p>Softer cotton</p>" }));
  const d2 = await save(id, (b) => (b.settings.description_html = null));
  eq(d2.body.settings.description_html, null, "Reset:");
  await save(id, (b) => (b.settings.display_type = { value: "Towels" }));
  const cur = (await api({ getDocument: id })).body.document;
  const r = await api({ resolveShopifyChange: { id, field: "display_type", choice: "shopify" }, revision: cur.revision });
  eq([r.status, r.body.document.body.settings.display_type], [200, null], "Use Shopify's:");
});

// =====================================================================================
console.log("— 3. what has a control");
// =====================================================================================

await t("unit: only the allowed overlay fields have controls; price, variants and stock render read-only with the Shopify link; the rewritten copy has no 'Shopify owns these'", async () => {
  const e = await read(7);
  const m = formHtml({ body: R.emptyBody("product_content"), entity: e });
  const inputs = [...m.matchAll(/<(input|textarea|select)[^>]*\bid="([^"]+)"/g)].map((x) => x[2]);
  for (const k of ["f-doc-title", "f-doc-display_vendor", "f-doc-display_type", "f-doc-badge", "f-doc-template", "f-doc-pairs-title"]) ok(inputs.includes(k), `a control for ${k}: ${inputs.join(", ")}`);
  for (const bad of ["price", "compare_at_price", "variants", "inventory", "handle", "tags", "vendor", "product_type", "options"]) ok(!inputs.some((i) => i === `f-doc-${bad}` || i.startsWith(`f-doc-${bad}-`)), `no control for ${bad}`);
  const owned = m.match(/<section[^>]*data-shopify-owned=""[\s\S]*?<\/section>/)[0];
  ok(!/<(input|textarea|select|button)\b/.test(owned), "price, variants and stock: nothing to type or press");
  ok(plain(owned).includes("Price: ₹700") && plain(owned).includes("In stock") && plain(owned).includes("Default Title"), `shown: ${plain(owned)}`);
  ok(owned.includes('href="https://admin.shopify.com/store/pe-store/products/9107"') && plain(owned).includes("Change in Shopify"), "the Change in Shopify link (openEntityContent's shopifyAdminUrl)");
  ok(plain(owned).includes(EM.PRODUCT_WORDS.shopifyOwns), "the plain words");
  for (const f of ["components/admin/editor/ProductForm.js", "components/admin/editor/CollectionForm.js", "components/admin/editor/editorModel.js"]) {
    ok(!(await readFile(join(ROOT, f), "utf8")).includes("Shopify owns these"), `${f}: no 'Shopify owns these'`);
  }
  ok(!/Shopify owns|admin; they sync/.test(EM.PRODUCT_WORDS.catalogShopify), "and they are plain");
});

// =====================================================================================
console.log("— 4. the title gate");
// =====================================================================================

await t("unit: with the gate forced closed (setTitleGateForTest) the name and display fields are disabled with the reason; badge and modules stay editable; Reset on the name stays", async () => {
  await open(8);
  const id = await Ids.productDocumentId(P(8));
  let e0 = await read(8);
  await save(id, (b) => (b.settings.title = EM.editOverlay("title", null, "Gated name", e0)));
  Gate.setTitleGateForTest(true);
  const o = await open(8, STAFF_ACTOR);
  eq([o.entity.titleEditable, typeof o.entity.titleBlockedReason], [false, "string"], "the entry says the name is gated:");
  const body = (await api({ getDocument: id })).body.document.body;
  const m = formHtml({ body, entity: o.entity });
  for (const k of ["f-doc-title", "f-doc-display_vendor", "f-doc-display_type"]) ok(isDisabled(m, k), `${k} disabled`);
  ok(plain(m).includes(o.entity.titleBlockedReason), "the reason is shown");
  ok(/data-gated="title"/.test(m), "next to the name");
  ok(!isDisabled(m, "f-doc-badge"), "the badge is editable");
  ok(!/\sdisabled=""/.test(m.match(/<button[^>]*data-add-module="rich_text"[^>]*>/)[0]), "modules can be added");
  ok(!/\sdisabled=""/.test(m.match(/<button[^>]*data-reset="title"[^>]*>/)[0]), "Reset on the gated name stays available");
  // and the service agrees: a new name is refused, the badge saves
  const cur = (await api({ getDocument: id }, STAFF)).body.document;
  const refused = await api({ saveDraft: { id, body: { ...body, settings: { ...body.settings, title: { value: "Another" } } } }, revision: cur.revision }, STAFF);
  eq([refused.status, refused.body.code], [409, "TITLE_NOT_EDITABLE"], "a new name refused:");
  const badge = await api({ saveDraft: { id, body: { ...body, settings: { ...body.settings, badge: "Hot" } } }, revision: cur.revision }, STAFF);
  eq(badge.status, 200, "the badge saves:");
});

await t("unit: with the gate open on a store with Typesense configured (dummy localhost values, no network), the name and display fields are editable", async () => {
  Gate.setTitleGateForTest(null);
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
  process.env.TYPESENSE_COLLECTION = "products";
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (u) => (fetched.push(String(u)), new Response("{}", { status: 599 }));
  try {
    const o = await open(9, STAFF_ACTOR);
    eq([o.entity.titleEditable, o.entity.titleBlockedReason], [true, null], "the entry:");
    const m = formHtml({ body: R.emptyBody("product_content"), entity: o.entity });
    for (const k of ["f-doc-title", "f-doc-display_vendor", "f-doc-display_type"]) ok(!isDisabled(m, k), `${k} editable`);
    ok(!/data-gated=/.test(m) && !/data-title-gate=/.test(m), "no gate words");
    eq(fetched, [], "nothing was sent anywhere:");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// =====================================================================================
console.log("— 5. the product and collection forms edit their settings");
// =====================================================================================

await t("unit: the product form's badge, layout, pairs and module controls edit their settings", async () => {
  // working: each product entry's control edits its setting
  const e = await read(10);
  const edits = [];
  const trees = [];
  const v = await mount("components/admin/editor/ProductForm.js", "default", () => ({ body: R.emptyBody("product_content"), entity: e, context: { lookupProducts: async () => [] }, on: { edit: (x) => edits.push(x), treeChange: (s, meta) => trees.push([s, meta]) } }));
  v.find((n) => n.props?.id === "f-doc-badge").props.onChange({ target: { value: "Lab tested" } });
  v.find((n) => n.props?.id === "f-doc-template").props.onChange({ target: { value: "editorial" } });
  v.find((n) => n.props?.id === "f-doc-pairs-title").props.onChange({ target: { value: "Goes well with your routine" } });
  await v.click("Choose products");
  const picker = v.find((n) => n.type?.name === "ProductPicker");
  ok(picker, "the pairs picker opens");
  picker.props.onConfirm([{ id: P(11), title: "Fixture product 11" }]);
  await v.click("Rich text");
  eq(edits.map((x) => x.path), ["badge", "template", "pairs", "pairs"], "badge, layout, pairs title and products edit their settings:");
  eq(edits.map((x) => x.value), ["Lab tested", "editorial", { title: "Goes well with your routine", products: [] }, { title: null, products: [P(11)] }], "values:");
  eq([trees.length, trees[0][1].op, trees[0][0][0].kind], [1, "add", "rich_text"], "a module is added:");
});

await t("unit: the collection form saves pins and template, and they publish into collection_content_live", async () => {
  const c = await run(() => EE.entityEntry({ type: "collection_content", entityId: COL, actor: OWNER_ACTOR }));
  const id = c.document.id;
  const edits = [];
  const v = await mount("components/admin/editor/CollectionForm.js", "default", () => ({ body: R.emptyBody("collection_content"), entity: c.entity, context: { lookupProducts: async (ids) => ids.map((x) => ({ id: x, title: x })) }, on: { edit: (x) => edits.push(x) } }));
  await v.click("Choose products");
  v.find((n) => n.type?.name === "ProductPicker").props.onConfirm([{ id: P(12) }, { id: P(13) }]);
  v.find((n) => n.props?.id === "f-doc-template").props.onChange({ target: { value: "sidebar" } });
  eq(edits, [{ path: "pinned", value: [P(12), P(13)] }, { path: "template", value: "sidebar" }], "the form's edits:");
  await save(id, (b) => {
    for (const x of edits) b.settings[x.path] = x.value;
  });
  await publishDoc(id);
  const live = (await sql(docs, "SELECT pinned, layout_template FROM collection_content_live WHERE collection_id = ?", [COL]))[0];
  eq([JSON.parse(live.pinned), live.layout_template], [[P(12), P(13)], "sidebar"], "live:");
  // the store's layout again: null
  v.find((n) => n.props?.id === "f-doc-template").props.onChange({ target: { value: "" } });
  eq(edits.at(-1), { path: "template", value: null }, "the store's layout is null:");
});

// =====================================================================================
console.log("— 6. shoppers never see editor-only words");
// =====================================================================================

const E2 = await import("../lib/catalog/effective.js");
const repo = await import("../lib/repo.js");
const { getPdpPairs } = await import("../lib/catalog/upsells.js");
const JSX_RUNTIME = require("react/jsx-runtime");
async function loadComponent(rel, stubs) {
  const code = await compile(join(ROOT, rel));
  const mod = { exports: {} };
  const reqf = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "react/jsx-runtime") return JSX_RUNTIME;
    if (id === "react") return React;
    throw new Error(`${rel}: unstubbed import "${id}"`);
  };
  new Function("require", "module", "exports", code)(reqf, mod, mod.exports);
  return mod.exports;
}
const Link = { __esModule: true, default: ({ href, children, ...p }) => h("a", { href, className: p.className }, children) };
const nothing = { __esModule: true, default: () => null };
const EDITOR_WORDS = [EM.PRODUCT_WORDS.differs, EM.PRODUCT_WORDS.same, "Shopify title:", EM.PRODUCT_WORDS.reset, EM.PRODUCT_WORDS.galleryFirstEdit, EM.PRODUCT_WORDS.shopifyOwns, EM.PRODUCT_WORDS.orphan, EM.PRODUCT_WORDS.keepMine];

await t("unit: a shopper render of an edited product (card and product page) contains no 'differs' text or any editor-only words (negative)", async () => {
  await open(14);
  const id = await Ids.productDocumentId(P(14));
  const e = await read(14);
  await save(id, (b) => {
    b.settings.title = EM.editOverlay("title", null, "Moon tonic", e);
    b.settings.display_type = EM.editOverlay("display_type", null, "Tonics", e);
    b.settings.badge = "Bestseller";
  });
  await publishDoc(id);
  const ProductCard = await loadComponent("components/ProductCard.js", { "next/link": Link, "./FadeImage": { __esModule: true, default: ({ src, alt }) => h("img", { src, alt }) }, "@/lib/format": await import("../lib/format.js") });
  const page = await loadComponent("app/(storefront)/products/[handle]/page.js", {
    "next/link": Link,
    "next/navigation": navStub,
    "@/components/analytics/TrackEvent": nothing,
    "@/components/pdp/PdpLayouts": await loadComponent("components/pdp/PdpLayouts.js", {
      "next/link": Link,
      "@/components/ProductGallery": { __esModule: true, default: ({ images, title }) => h("div", null, images.map((i) => h("img", { key: i.url, src: i.url, alt: i.alt || title }))) },
      "@/components/ProductPurchase": nothing,
      "@/components/WishlistButton": nothing,
      "@/components/plugins/PluginSlot": nothing, // Phase 4 line 2: an async server component
      "@/components/ProductCard": ProductCard,
      "@/lib/sanitize": await import("../lib/sanitize.js"),
    }),
    "@/lib/repo": repo,
    "@/lib/content/resolve": {
      resolvedPdpPairs: (pid, o) => getPdpPairs(pid, o),
      resolvedPdpExtras: async () => [],
      resolvedProductOverride: async () => null,
      resolvedSurfaceTemplateFor: async () => ({ template: "classic" }),
      previewEntityRow: async () => null,
      productPreviewView: async () => {
        throw new Error("no preview view without a draft");
      },
    },
    "@/lib/catalog/effective": E2,
    "@/lib/ids": await import("../lib/ids.js"),
    "@/lib/site": { abs: (p) => `https://pedocs.test${p}`, siteName: () => "PE Store" },
    "@/lib/tenant-request": { tfetch: (fn) => run(fn) },
    "@/lib/storefront-request": { tfetch: (fn) => run(fn) },
  });
  const pdp = renderToStaticMarkup(await page.default({ params: Promise.resolve({ handle: "fixture-product-14" }) }));
  ok(plain(pdp).includes("Moon tonic"), "the product page shows the new name");
  const cards = await run(() => E2.cardRows({ limit: 100 }));
  const list = Array.isArray(cards) ? cards : cards?.products || cards?.rows || [];
  const row = list.find((x) => x.id === P(14) || x.handle === "fixture-product-14");
  ok(row, `the card row: ${JSON.stringify(cards).slice(0, 200)}`);
  const cardHtml = renderToStaticMarkup(h(ProductCard.default, { product: row }));
  ok(plain(cardHtml).includes("Moon tonic"), `the card shows the new name: ${plain(cardHtml)}`);
  for (const w of EDITOR_WORDS) {
    ok(!plain(pdp).includes(w), `product page: no "${w}"`);
    ok(!plain(cardHtml).includes(w), `card: no "${w}"`);
  }
  ok(!/data-differs|data-same|data-shopify-title|data-reset/.test(pdp + cardHtml), "no editor markers");
  // and no storefront file carries the editor's words or its form
  const files = [];
  const walk = async (dir) => {
    for (const ent of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) await walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  };
  await walk("app/(storefront)");
  await walk("components/pdp");
  for (const f of files) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!/editor\/(ProductForm|editorModel|CollectionForm)/.test(src) && !src.includes("Differs from Shopify"), `${f} never imports the editor's form or words`);
  }
});

// =====================================================================================
console.log("— 7. the switcher");
// =====================================================================================

await t("unit: product 31 and later open from the switcher; a renamed product is found by its new name; the counts render in the shell; DocumentEditor no longer fetches /api/admin/catalog", async () => {
  // every product, through the switcher's own read (listProductContent), page by page
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 5; i++) {
    const r = await api({ listProductContent: EM.productListArgs({ cursor }) }, STAFF);
    eq(r.status, 200, "listProductContent:");
    seen.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  eq(new Set(seen.map((x) => x.productId)).size, 35, "all 35 products are reachable:");
  const rows = EM.productRows(seen);
  const p31 = rows.find((r) => r.id === P(31));
  ok(p31 && p31.href === "/admin/editor?product=gid%3A%2F%2Fshopify%2FProduct%2F9131", `product 31's row opens its content: ${JSON.stringify(p31)}`);
  const page = await openPage({ product: decodeURIComponent(p31.href.split("product=")[1]) });
  eq(page.document.id, await Ids.productDocumentId(P(31)), "and it opens:");
  const p35 = await openPage({ product: P(35) });
  eq(p35.document.id, await Ids.productDocumentId(P(35)), "product 35 too:");
  // renamed and published: found by its new name, Shopify's name under it
  const id = p35.document.id;
  await save(id, (b) => (b.settings.title = EM.editOverlay("title", null, "Zebra balm", p35.entity)));
  await publishDoc(id);
  const found = await api({ listProductContent: EM.productListArgs({ query: "zebra" }) }, STAFF);
  eq(found.body.items.map((x) => x.productId), [P(35)], "found by its new name:");
  eq(EM.productRows(found.body.items)[0].secondary, "Shopify title: Fixture product 35", "with Shopify's name under it:");
  // the counts in the shell
  const counts = found.body.counts;
  const E = await world({ "next/navigation": navStub, "@/components/kit/toast": toastStub })(join(ROOT, "components/admin/editor/DocumentEditor.js"));
  const homeState = { id: "doc_home", type: "home", body: { type: "home", sections: [] }, revision: 1, draftHash: "h", document: { id: "doc_home", type: "home", label: "Home page", access: { canPublish: true } }, issues: [], ackCount: 0 };
  const shell = plain(html(h(E.EditorView, { entry: { id: "doc_home", type: "home", label: "Home page" }, load: { status: "ready" }, state: homeState, docs: [], products: { items: found.body.items, counts } })));
  ok(shell.includes(`Products ${counts.all} · Changed in Shopify ${counts.changedInShopify} · No longer in Shopify ${counts.orphaned}`), `the counts line: ${shell.slice(0, 400)}`);
  const sw = plain(html(h(E.EditorView, { entry: { id: "doc_home", type: "home", label: "Home page" }, load: { status: "ready" }, state: homeState, docs: [], showSwitcher: true, products: { items: found.body.items, counts } })));
  ok(sw.includes(`Changed in Shopify (${counts.changedInShopify})`) && sw.includes(`No longer in Shopify (${counts.orphaned})`) && sw.includes("Zebra balm"), `the filters with counts: ${sw.slice(0, 600)}`);
  // the mounted editor: what it reads
  const calls = [];
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => (fetches.push(String(u)), new Response(JSON.stringify({ ok: true, items: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.window = { location: { origin: "https://pedocs.test", host: "pedocs.test", pathname: "/admin/editor", search: "" }, addEventListener() {}, removeEventListener() {}, localStorage: null };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const stubApi = {
    call: async (op, args) => {
      calls.push([op, args]);
      if (op === "listDocuments") return { ok: true, data: { documents: [] } };
      if (op === "listProductContent") return { ok: true, data: { items: found.body.items, nextCursor: null, counts } };
      if (op === "getDocument") return { ok: true, data: { document: { ...clone(homeState.document), body: homeState.body, revision: 1, draftHash: "h" } } };
      return { error: true, code: "X", message: "x" };
    },
    sendKeepalive: () => true,
    startDocumentsPreview: async () => ({ error: true }),
    setShowDesign: async () => ({ error: true }),
  };
  try {
    const v = await mount("components/admin/editor/DocumentEditor.js", "default", () => ({ document: { id: "doc_home", type: "home", label: "Home page", slug: null }, api: stubApi }));
    await v.flush();
    ok(calls.some(([op]) => op === "listProductContent"), `the editor reads products through listProductContent: ${calls.map((c) => c[0]).join(",")}`);
    ok(!fetches.some((u) => u.includes("/api/admin/catalog")), `never /api/admin/catalog: ${fetches.join(" ")}`);
    ok(fetches.some((u) => u.startsWith("/api/admin/refs?")), "the pickers read /api/admin/refs");
    ok(!calls.some(([op]) => op === "openEntityContent"), "no openEntityContent from the browser");
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete globalThis.document;
  }
  const src = await readFile(join(ROOT, "components/admin/editor/DocumentEditor.js"), "utf8");
  ok(!/fetch\(\s*["'`]\/api\/admin\/catalog/.test(src), "DocumentEditor has no fetch of the catalog route");
});

// =====================================================================================
console.log("— 8. the gallery");
// =====================================================================================

await t("unit: the first gallery edit shows the plain note about new Shopify images; a Shopify image change on an edited gallery shows 'Shopify's images changed' with 'Use Shopify's images'", async () => {
  await open(15);
  const id = await Ids.productDocumentId(P(15));
  let e = await read(15);
  let body = e.document.body;
  ok(!formHtml({ body, entity: e }).includes(EM.PRODUCT_WORDS.galleryFirstEdit), "no note while it follows Shopify");
  const edits = [];
  const state = { body };
  const v = await mount("components/admin/editor/ProductForm.js", "default", () => ({ body: state.body, entity: e, context: { lookupProducts: async () => [], pickImage: async () => ({ media: "/api/media/med_lib1", alt: "Library" }) }, on: { edit: (x) => (edits.push(x), (state.body = { ...state.body, settings: { ...state.body.settings, [x.path]: x.value } })) } }));
  await v.click("Add from your library");
  eq(edits.at(-1).path, "gallery", "the first gallery edit:");
  eq(edits.at(-1).value.value.map((g) => g.media), ["/api/media/med_lib1"], "the founder's list:");
  await v.flush();
  const note = v.find((n) => n.props?.["data-gallery-note"] === "");
  ok(note && textOf(note.props.children) === "Your images replace Shopify's for this product. New images added in Shopify won't show until you choose Use Shopify's images.", "the plain note, word for word");
  // saved, then Shopify's images change
  await save(id, (b) => (b.settings.gallery = { value: [{ media: "https://cdn.shopify.com/fixture/fixture-product-15.png", alt: "Mine first" }, { media: "/api/media/med_lib1", alt: "Library" }] }));
  e = await read(15);
  eq(EM.productFormModel({ body: e.document.body, entity: e }).notices, [], "nothing changed yet:");
  await sync(15, { images: { nodes: [{ url: "https://cdn.shopify.com/fixture/new-angle.png", altText: "New angle", width: 800, height: 800 }] } });
  e = await read(15);
  const m = EM.productFormModel({ body: e.document.body, entity: e });
  eq(m.notices.map((n) => [n.field, n.title, n.useShopify, n.keep]), [["gallery", "Shopify's images changed", "Use Shopify's images", "Keep mine"]], "the notice:");
  const clicks = [];
  const w = await mount("components/admin/editor/ProductForm.js", "default", () => ({ body: e.document.body, entity: e, context: { lookupProducts: async () => [] }, on: { resolve: (f, c) => clicks.push([f, c]) } }));
  await w.click("Use Shopify's images: images");
  eq(clicks, [["gallery", "shopify"]], "Use Shopify's images:");
  const cur = (await api({ getDocument: id })).body.document;
  const r = await api({ resolveShopifyChange: { id, field: "gallery", choice: "shopify" }, revision: cur.revision });
  eq([r.status, r.body.document.body.settings.gallery], [200, null], "the gallery follows Shopify again:");
  // a query-string-only change of Shopify's images is no change
  await save(id, (b) => (b.settings.gallery = { value: [{ media: "/api/media/med_lib1", alt: "Library" }] }));
  await sync(15, { images: { nodes: [{ url: "https://cdn.shopify.com/fixture/new-angle.png?v=2", altText: "New angle", width: 800, height: 800 }] } });
  e = await read(15);
  eq(EM.productFormModel({ body: e.document.body, entity: e }).notices, [], "a query string alone is not a change:");
});

// =====================================================================================
console.log("— 9. a product that left Shopify");
// =====================================================================================

await t("unit: an orphan shows its stored base values with Reset and the notice disabled, 'Discard edits' for an owner or admin, and the plain reason (no button) for staff", async () => {
  await open(16);
  const id = await Ids.productDocumentId(P(16));
  let e = await read(16);
  await save(id, (b) => {
    b.settings.title = EM.editOverlay("title", null, "Gone name", e);
    b.settings.display_vendor = EM.editOverlay("display_vendor", null, "Gone Labs", e);
  });
  await sync(16, { title: "Renamed then deleted" });
  for (const tbl of ["product_images", "variants"]) await raw(docs).execute({ sql: `DELETE FROM ${tbl} WHERE product_id = ?`, args: [P(16)] });
  await raw(docs).execute({ sql: "DELETE FROM products WHERE id = ?", args: [P(16)] });
  const o = await open(16);
  eq(o.entity.inShopify, false, "the entry says it left Shopify:");
  const body = (await api({ getDocument: id })).body.document.body;
  const owner = formHtml({ body, entity: o.entity, access: { canPublish: true } });
  ok(plain(owner).includes("No longer in Shopify"), "the label");
  ok(plain(owner).includes("Shopify's name when it left: Fixture product 16") && plain(owner).includes("Shopify's brand when it left: Fixture Labs"), `the stored base values: ${plain(owner).slice(0, 500)}`);
  for (const k of ["title", "description_html", "gallery", "display_vendor", "display_type"]) ok(/\sdisabled=""/.test(owner.match(new RegExp(`<button[^>]*data-reset="${k}"[^>]*>`))[0]), `Reset off on ${k}`);
  ok(!/data-shopify-changed=/.test(owner), "no Changed in Shopify notice");
  ok(/<button[^>]*data-discard=""[^>]*>Discard edits<\/button>/.test(owner), "Discard edits for an owner or admin");
  const staff = formHtml({ body, entity: o.entity, access: { canPublish: false, reason: "Only the store owner or an admin can publish." } });
  ok(!/data-discard=""/.test(staff) && plain(staff).includes("Only an owner or admin can discard these edits."), "staff: the plain reason, no button");
  // the owner's discard (through the store's call in the editor; the API here)
  const cur = (await api({ getDocument: id })).body.document;
  const r = await api({ discardOrphanEdits: { id }, revision: cur.revision });
  eq(r.status, 200, "discarded:");
  eq(r.body.document.body.settings.title ?? null, null, "the edits are gone:");
  const st = await api({ discardOrphanEdits: { id }, revision: r.body.document.revision }, STAFF);
  eq(st.status, 403, "staff can't:");
});

// =====================================================================================
console.log("— 10. modules and caps");
// =====================================================================================

await t("unit: only rich text, text and FAQ modules are offered; an older image-with-text module stays editable; the gallery and description caps are said in plain words before publish fails", async () => {
  eq(EM.moduleOptions("product_content"), ["rich_text", "text", "faq"], "offered:");
  ok(R.allowedKinds("product_content").includes("image_with_text"), "image-with-text stays registered for products");
  const old = R.newSection("image_with_text", { id: "sec_old1" });
  const body = { ...R.emptyBody("product_content"), sections: [old] };
  const m = formHtml({ body, entity: await read(17) });
  const offered = [...m.matchAll(/data-add-module="([a-z_]+)"/g)].map((x) => x[1]);
  eq(offered, ["rich_text", "text", "faq"], "the add buttons:");
  ok(/data-product-module="sec_old1"/.test(m), "the old module is listed, with its form");
  const many = Array.from({ length: 31 }, (_, i) => ({ media: `https://cdn.shopify.com/x/${i}.png`, alt: "" }));
  const caps = EM.capNotes({ settings: { gallery: { value: many }, description_html: { value: `<p>${"a".repeat(20001)}</p>` } } });
  eq(caps.gallery, "You have 31 images; a product can show at most 30 of your own. Remove 1 before you publish, or choose Use Shopify's images.", "gallery:");
  ok(caps.description_html.startsWith("The description is 20,008 characters long; at most 20,000 can go live."), caps.description_html);
  ok(!/[A-Z]{3,}_[A-Z]/.test(caps.gallery + caps.description_html), "no codes");
  const shown = formHtml({ body: { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, gallery: { value: many } } }, entity: await read(17) });
  ok(/data-cap="gallery"/.test(shown) && plain(shown).includes("at most 30 of your own"), "shown in the form");
  eq(EM.capNotes({ settings: { gallery: { value: many.slice(0, 30) } } }), {}, "at the cap: nothing to say:");
});

// =====================================================================================
console.log("— 11. P4-FIX3: the P4-EDITOR review findings");
// =====================================================================================

await t("rendered: when the founder has their own description, Shopify's shows beside it as plain text; the 'Changed in Shopify' notice for the description has no raw HTML", async () => {
  await open(18);
  const id = await Ids.productDocumentId(P(18));
  await sync(18, { descriptionHtml: "<p>Soft <b>cotton</b> &amp; linen</p>" });
  let e = await read(18);
  await save(id, (b) => (b.settings.description_html = EM.editOverlay("description_html", null, "<p>My own words</p>", e)));
  e = await read(18);
  let m = formHtml({ body: e.document.body, entity: e });
  const beside = m.match(/<div[^>]*data-shopify-value="description_html"[\s\S]*?<\/div>/)?.[0];
  ok(beside, `Shopify's description beside the founder's: ${plain(m).slice(0, 400)}`);
  eq(plain(beside), "Shopify's description: Soft cotton & linen", "beside, as plain text:");
  ok(!/&lt;|&gt;|<b>/.test(beside), "no markup in the line");
  // Shopify changes it: the notice reads in plain words
  await sync(18, { descriptionHtml: '<h2>New</h2><p>Organic <em>cotton</em>,&nbsp;now softer.</p><script>alert(1)</script>' });
  e = await read(18);
  m = formHtml({ body: e.document.body, entity: e });
  const notice = m.match(/<section[^>]*data-shopify-changed="description_html"[\s\S]*?<\/section>/)?.[0];
  ok(notice, "the notice is up");
  const words = notice.match(/<p[^>]*data-notice-words="description_html"[^>]*>([\s\S]*?)<\/p>/)[1];
  eq(plain(words), "Shopify changed the description after you edited it. Shopify's description now reads: New Organic cotton, now softer.", "the notice's sentence:");
  ok(!/&lt;|&gt;|<[a-z]/i.test(words) && !words.includes("alert"), `no raw HTML in the sentence: ${words}`);
  // a product that left Shopify: the description it had, as plain text
  const orphan = formHtml({ body: e.document.body, entity: { ...e, inShopify: false, shopify: null } });
  ok(plain(orphan).includes("Shopify's description when it left: Soft cotton & linen"), `when it left: ${plain(orphan).slice(0, 600)}`);
  // a long description: a short line, and the rest behind "Show all"
  const long = `<p>${"Word ".repeat(80)}end.</p>`;
  const short = PF.plainSummary(long);
  ok(short.length <= 161 && short.endsWith("…") && !short.includes("<"), short);
  eq(PF.plainSummary("<style>p{}</style><p>a&lt;b &#8212; &#x41;</p>"), "a<b — A", "entities read back, style text dropped:");
  eq([PF.plainSummary(""), PF.plainSummary(null)], ["", ""], "nothing:");
  // P4-FIX5 (P4-FIX3 review (c)): the cut line has the whole of Shopify's
  // description behind "Show all of Shopify's description"; a short one has none
  const longEntity = { ...e, shopify: { ...e.shopify, description_html: long } };
  const lm = formHtml({ body: e.document.body, entity: longEntity });
  const besideLong = lm.match(/<div[^>]*data-shopify-value="description_html"[\s\S]*?<\/details>/)?.[0];
  ok(besideLong, `the details under Shopify's line: ${plain(lm).slice(0, 300)}`);
  eq(plain(besideLong.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || ""), "Show all of Shopify's description", "its summary:");
  ok(plain(besideLong.match(/<\/summary>([\s\S]*?)<\/details>/)[1]).endsWith("Word end."), "it holds the whole description");
  ok(!plain(m).includes("Show all of Shopify's description"), "a short description has no 'Show all'");
});

await t("unit: a product document opened without the entity answer shows plain words, never 'Loading Shopify's images…'", async () => {
  const body = { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, title: { value: "Mine", base_hash: "b", base_value: "Old" } } };
  const m = formHtml({ body, entity: null });
  ok(plain(m).includes(PF.DESCRIPTION_WORDS.noEntity), `the plain words: ${plain(m)}`);
  ok(!plain(m).includes("Loading Shopify"), "no endless loading line");
  ok(!/<input|<button/.test(m), "no form to type into");
  const E = await world({ "next/navigation": navStub, "@/components/kit/toast": toastStub })(join(ROOT, "components/admin/editor/DocumentEditor.js"));
  const st = { id: "doc_prod_nullentity01", type: "product_content", body, revision: 1, draftHash: "h", document: { id: "doc_prod_nullentity01", type: "product_content", label: "Mine", access: { canPublish: true } }, issues: [], ackCount: 0 };
  const shell = plain(html(h(E.EditorView, { entry: { id: st.id, type: st.type, label: "Mine" }, load: { status: "ready" }, state: st, docs: [], entity: null })));
  ok(shell.includes(PF.DESCRIPTION_WORDS.noEntity) && !shell.includes("Loading Shopify"), `in the editor: ${shell.slice(0, 400)}`);
});

// A stub documents API for the mounted editor: getDocument answers each id
// from `docsById`, held while `holds` has a promise for it.
function editorApi({ docsById, holds = new Map(), calls = [], answers = {} }) {
  return {
    call: async (op, args, extra) => {
      calls.push([op, clone(args ?? null), clone(extra ?? null)]);
      if (op === "listDocuments") return { ok: true, data: { documents: [] } };
      if (op === "listProductContent") return { ok: true, data: { items: [], nextCursor: null, counts: { all: 2, changedInShopify: calls.filter((c) => c[0] === "resolveShopifyChange").length ? 0 : 1, orphaned: 0 } } };
      if (op === "getDocument") {
        if (holds.has(args)) await holds.get(args);
        return docsById[args] ? { ok: true, data: { document: clone(docsById[args]) } } : { error: true, code: "NOT_FOUND", message: "x" };
      }
      if (answers[op]) return answers[op](args, extra);
      return { error: true, code: "X", message: "x" };
    },
    sendKeepalive: () => true,
    startDocumentsPreview: async () => ({ error: true }),
    setShowDesign: async () => ({ error: true }),
  };
}
async function withBrowser(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, items: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.window = { location: { origin: "https://pedocs.test", host: "pedocs.test", pathname: "/admin/editor", search: "" }, addEventListener() {}, removeEventListener() {}, localStorage: null };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete globalThis.document;
  }
}
const prodDoc = (id, entityId, label, settings) => ({ id, type: "product_content", label, slug: null, entityId, body: { type: "product_content", settings: { ...R.emptyBody("product_content").settings, ...settings }, sections: [] }, revision: 2, draftHash: `h-${id}`, publishedVersionId: null, publishedHash: null, access: { canPublish: true, reason: null } });
const shopEntity = (title, extra = {}) => ({ inShopify: true, shopify: { title, handle: title.toLowerCase().replace(/\W+/g, "-"), description_html: `<p>${title}</p>`, vendor: "Labs", product_type: "Serum", gallery: [] }, titleEditable: true, titleBlockedReason: null, shopifyAdminUrl: null, commerce: null, ...extra });

await t("unit: switching products holds the form back until the next document is open, so A's draft is never shown against B's Shopify values", async () => {
  const A = prodDoc("doc_prod_aaaaaaaaaaaaaaaa", "gid://shopify/Product/1", "Alpha mine", { title: { value: "Alpha mine", base_hash: "x", base_value: "Alpha" } });
  const B = prodDoc("doc_prod_bbbbbbbbbbbbbbbb", "gid://shopify/Product/2", "Beta", {});
  let release;
  const holds = new Map();
  const api = editorApi({ docsById: { [A.id]: A, [B.id]: B }, holds });
  await withBrowser(async () => {
    const props = { document: { id: A.id, type: A.type, label: A.label, slug: null }, entity: shopEntity("Alpha"), readOnly: null, api };
    const v = await mount("components/admin/editor/DocumentEditor.js", "default", () => props);
    await v.flush();
    const heading = () => v.find((n) => n.props?.["data-product-heading"] === "");
    const titleLine = () => v.find((n) => n.props?.["data-shopify-title"] === "");
    ok(heading() && textOf(heading().props.children) === "Alpha mine", "A is open with its draft");
    // the page moves to B (the switcher's link): B's entry and entity arrive, B's document is still loading
    holds.set(B.id, new Promise((r) => (release = r)));
    props.document = { id: B.id, type: B.type, label: B.label, slug: null };
    props.entity = shopEntity("Beta");
    await v.flush();
    ok(!v.find((n) => n.props?.["data-product-form"] === ""), `no product form while B loads: ${heading() ? textOf(heading().props.children) : ""} / ${titleLine() ? textOf(titleLine().props.children) : ""}`);
    ok(!v.all((n) => n.type === "input").some((n) => n.props.value === "Alpha mine"), "A's name is not on screen");
    const label = v.find((n) => n.props?.["data-document-label"] === "");
    eq(textOf(label.props.children), "Beta", "the heading names the product being opened:");
    release();
    await v.flush();
    for (let i = 0; i < 5 && !(heading() && textOf(heading().props.children) === "Beta"); i++) await v.flush();
    eq([textOf(heading().props.children), textOf(titleLine().props.children)], ["Beta", "Shopify title: Beta"], "then B's own draft against B's Shopify values:");
  });
});

// P4-FIX5 (P4-FIX3 review): openEntry has a sequence guard, like loadProducts
await t("unit (P4-FIX5): A to B to C with B's document answering after C's never leaves the editor stuck on 'Opening C…': C's own form shows and B's late answer is dropped", async () => {
  const A = prodDoc("doc_prod_aaaaaaaaaaaaaaab", "gid://shopify/Product/11", "Alpha mine", { title: { value: "Alpha mine", base_hash: "x", base_value: "Alpha" } });
  const B = prodDoc("doc_prod_bbbbbbbbbbbbbbbc", "gid://shopify/Product/12", "Beta mine", { title: { value: "Beta mine", base_hash: "y", base_value: "Beta" } });
  const C = prodDoc("doc_prod_cccccccccccccccd", "gid://shopify/Product/13", "Gamma", {});
  let releaseB;
  const holds = new Map();
  const calls = [];
  const api = editorApi({ docsById: { [A.id]: A, [B.id]: B, [C.id]: C }, holds, calls });
  await withBrowser(async () => {
    const props = { document: { id: A.id, type: A.type, label: A.label, slug: null }, entity: shopEntity("Alpha"), readOnly: null, api };
    const v = await mount("components/admin/editor/DocumentEditor.js", "default", () => props);
    await v.flush();
    const heading = () => v.find((n) => n.props?.["data-product-heading"] === "");
    const switchingLine = () => v.find((n) => n.props?.["data-entity-switching"] === "");
    ok(heading() && textOf(heading().props.children) === "Alpha mine", "A is open");
    // to B, whose document is slow
    holds.set(B.id, new Promise((r) => (releaseB = r)));
    props.document = { id: B.id, type: B.type, label: B.label, slug: null };
    props.entity = shopEntity("Beta");
    await v.flush();
    // then to C, which answers at once
    props.document = { id: C.id, type: C.type, label: C.label, slug: null };
    props.entity = shopEntity("Gamma");
    await v.flush();
    for (let i = 0; i < 5 && !(heading() && textOf(heading().props.children) === "Gamma"); i++) await v.flush();
    eq(heading() ? textOf(heading().props.children) : null, "Gamma", "C is open:");
    // B answers last
    releaseB();
    for (let i = 0; i < 5; i++) await v.flush();
    eq(calls.filter((c) => c[0] === "getDocument").map((c) => c[1]), [A.id, B.id, C.id], "each document asked for once:");
    ok(!switchingLine(), `not stuck on 'Opening Gamma…': ${switchingLine() ? textOf(switchingLine().props.children) : ""}`);
    eq([heading() ? textOf(heading().props.children) : null, textOf(v.find((n) => n.props?.["data-shopify-title"] === "").props.children)], ["Gamma", "Shopify title: Gamma"], "C's own draft against C's Shopify values:");
    ok(!v.all((n) => n.type === "input").some((n) => n.props.value === "Beta mine"), "B's late draft is not on screen");
    ok(v.find((n) => n.props?.["data-product-form"] === ""), "C's form is there");
  });
});

// P4-FIX6 (P4-FIX5 review): the SECOND openSeq guard (after `await adopt`).
// B's document has answered and B's store is still opening (its open() is
// hashing an earlier visit's backup) when the founder picks a section of C in
// the preview: C opens with that section selected, its field focused and the
// switch note. B's open then finishes; it must not set the editor ready again
// and clear C's selection, focus and note.
await t("unit (P4-FIX6): B's store still opening when the founder picks C's section: C keeps its selected section, focus and switch note after B's open finishes", async () => {
  const A = prodDoc("doc_prod_aaaaaaaaaaaaaaac", "gid://shopify/Product/21", "Alpha", {});
  const B = prodDoc("doc_prod_bbbbbbbbbbbbbbbd", "gid://shopify/Product/22", "Beta", {});
  const C = {
    id: "doc_home",
    type: "home",
    label: "Home page",
    slug: null,
    entityId: null,
    body: { type: "home", settings: {}, sections: [{ id: "sec_cfix6", kind: "hero", v: 1, settings: { title: "Gamma hero", subtitle: "", highlight: "", badge: "", primary: null, secondary: null, image: null } }] },
    revision: 2,
    draftHash: "h-home",
    publishedVersionId: null,
    publishedHash: null,
    access: { canPublish: true, reason: null },
  };
  const MARK = "Beta backup fix6 marker";
  // an earlier visit's backup of B: B's store hashes it while it opens
  const store = new Map([[`storeasy:unsaved:pedocs.test:${B.id}:old`, JSON.stringify({ v: 1, baseRevision: 1, savedAt: 1, body: { ...clone(B.body), settings: { ...clone(B.body.settings), title: { value: MARK, base_hash: "z", base_value: "Beta" } } } })]]);
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  let releaseB;
  let heldB = false;
  const gate = new Promise((r) => (releaseB = r));
  const subtle = globalThis.crypto.subtle;
  const realDigest = subtle.digest.bind(subtle);
  subtle.digest = async (alg, data) => {
    if (new TextDecoder().decode(data).includes(MARK)) {
      heldB = true;
      await gate;
    }
    return realDigest(alg, data);
  };
  const calls = [];
  const api = editorApi({ docsById: { [A.id]: A, [B.id]: B, [C.id]: C }, calls });
  try {
    await withBrowser(async () => {
      globalThis.window.localStorage = ls;
      const focused = [];
      globalThis.document.getElementById = (id) => ({ focus: () => focused.push(id), scrollIntoView() {} });
      const props = { document: { id: A.id, type: A.type, label: A.label, slug: null }, entity: shopEntity("Alpha"), readOnly: null, api };
      const v = await mount("components/admin/editor/DocumentEditor.js", "default", () => props);
      await v.flush();
      // to B: its document answers at once, its store's open is held
      props.document = { id: B.id, type: B.type, label: B.label, slug: null };
      props.entity = shopEntity("Beta");
      await v.flush();
      for (let i = 0; i < 5 && !heldB; i++) await v.flush();
      ok(heldB, "B's store is still opening (its backup is being checked)");
      // the founder picks C's hero title in the preview
      const pane = () => v.find((n) => n.type?.name === "PreviewPane");
      ok(pane(), "the preview is there");
      pane().props.onPick({ type: "storeasy:pick", doc: C.id, sectionId: "sec_cfix6", kind: "hero", field: "title", offset: null });
      // the page goes to C (the router), C opens at once
      props.document = { id: C.id, type: C.type, label: C.label, slug: null };
      props.entity = null;
      await v.flush();
      const note = () => v.find((n) => n.props?.["data-switch-note"] === "");
      for (let i = 0; i < 5 && !(pane()?.props.select === "sec_cfix6"); i++) await v.flush();
      eq(pane()?.props.select, "sec_cfix6", "C's section is selected:");
      ok(note(), "the switch note shows");
      ok(focused.some((id) => String(id).includes("sec_cfix6")), `C's field was focused: ${JSON.stringify(focused)}`);
      // B's open finishes now
      releaseB();
      for (let i = 0; i < 5; i++) await v.flush();
      eq(calls.filter((c) => c[0] === "getDocument").map((c) => c[1]), [A.id, B.id, C.id], "each document asked for once:");
      eq(pane()?.props.select, "sec_cfix6", "still C's section after B's open finished:");
      ok(note(), "the switch note is still there");
      ok(!v.find((n) => n.props?.["data-entity-switching"] === ""), "not stuck on a switching line");
      ok(!v.all((n) => n.type === "input").some((n) => n.props.value === MARK), "B's backup is not on screen");
    });
  } finally {
    delete subtle.digest;
    releaseB();
  }
});

await t("unit: the shell re-reads the product counts after 'Keep mine' and after 'Use Shopify's'", async () => {
  const A = prodDoc("doc_prod_cccccccccccccccc", "gid://shopify/Product/3", "Mine", { title: { value: "Mine", base_hash: "b", base_value: "Old" } });
  const calls = [];
  const after = (args) => ({ ok: true, data: { document: { ...clone(A), revision: 3, draftHash: "h-after", body: { ...A.body, settings: { ...A.body.settings, title: args.choice === "keep" ? { value: "Mine", base_hash: "c", base_value: "Gamma" } : null } } } } });
  const api = editorApi({ docsById: { [A.id]: A }, calls, answers: { resolveShopifyChange: after } });
  await withBrowser(async () => {
    const lists = () => calls.filter((c) => c[0] === "listProductContent").length;
    for (const name of ["Keep mine: name", "Use Shopify's: name"]) {
      // each time a fresh editor on a document whose name has the notice
      const props = { document: { id: A.id, type: A.type, label: A.label, slug: null }, entity: shopEntity("Gamma"), readOnly: null, api };
      const v = await mount("components/admin/editor/DocumentEditor.js", "default", () => props);
      await v.flush();
      const before = lists();
      ok(v.button(name), `the notice offers ${name}`);
      await v.click(name);
      for (let i = 0; i < 5 && lists() === before; i++) await v.flush();
      ok(calls.some((c) => c[0] === "resolveShopifyChange" && c[1].choice === (name.startsWith("Keep") ? "keep" : "shopify")), `${name} was sent`);
      ok(lists() > before, `${name}: the counts are read again (${before} -> ${lists()})`);
      const shown = v.find((n) => n.props?.["data-product-counts"] !== undefined || /Changed in Shopify \d/.test(textOf(n.props?.children ?? "")));
      ok(shown, "the counts line is in the shell");
      ok(!v.find((n) => n.props?.["data-shopify-changed"] === "title"), "the notice is gone");
    }
  });
});

await t("unit: ?doc=<id> of a product's content gives a read-only person the read-only view (an owner can edit)", async () => {
  await open(22);
  const id = await Ids.productDocumentId(P(22));
  const support = await openPage({ doc: id }, SUPPORT_ACTOR);
  eq([support.document.id, support.readOnly], [id, EE.ENTRY_WORDS.readOnly], "support, through ?doc=:");
  ok(support.entity && support.entity.shopify.title === "Fixture product 22", "with what Shopify sends now");
  const owner = await openPage({ doc: id });
  eq([owner.document.id, owner.readOnly], [id, null], "the owner, through ?doc=:");
  const viaProduct = await openPage({ product: P(22) }, SUPPORT_ACTOR);
  eq(viaProduct.readOnly, support.readOnly, "the same as ?product=:");
});

await t("unit: a read-only person's entry finds a phase-3 random-id document by (type, entity_id), with its edits", async () => {
  const made = await run(() => Docs.openEntityContent({ type: "product_content", entityId: P(19), actor: OWNER_ACTOR }));
  const e = await read(19);
  await save(made.document.id, (b) => (b.settings.title = EM.editOverlay("title", null, "Phase three name", e)));
  await raw(docs).execute({ sql: "UPDATE documents SET id = 'doc_r24r24r24r24r24r2' WHERE id = ?", args: [made.document.id] });
  for (const tbl of ["document_versions"]) await raw(docs).execute({ sql: `UPDATE ${tbl} SET document_id = 'doc_r24r24r24r24r24r2' WHERE document_id = ?`, args: [made.document.id] }).catch(() => null);
  const before = await docCount();
  const o = await open(19, SUPPORT_ACTOR);
  eq(await docCount(), before, "nothing written:");
  eq([o.document.id, o.readOnly], ["doc_r24r24r24r24r24r2", EE.ENTRY_WORDS.readOnly], "the phase-3 row, read only:");
  eq(o.entity.document?.id, "doc_r24r24r24r24r24r2", "its document is in the answer:");
  eq(o.entity.document.body.settings.title?.value, "Phase three name", "with the founder's edit:");
});

await t("rendered: the heading shows the founder's name (Shopify's under it), not Shopify's", async () => {
  const e = await read(20);
  const body = { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, title: { value: "Founder's name", base_hash: "b", base_value: "Fixture product 20" } } };
  const m = formHtml({ body, entity: e });
  eq(plain(m.match(/<h3[^>]*data-product-heading=""[^>]*>[\s\S]*?<\/h3>/)[0]), "Founder's name", "the heading:");
  eq(plain(m.match(/<p[^>]*data-shopify-title=""[^>]*>[\s\S]*?<\/p>/)[0]), "Shopify title: Fixture product 20", "Shopify's name under it:");
  eq(plain(formHtml({ body: R.emptyBody("product_content"), entity: e }).match(/<h3[^>]*data-product-heading=""[^>]*>[\s\S]*?<\/h3>/)[0]), "Fixture product 20", "while it follows Shopify: Shopify's:");
});

await t("rendered: 'Keep mine' and 'Use Shopify's' are disabled for a read-only person", async () => {
  const e = await read(20);
  const body = { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, title: { value: "Founder's name", base_hash: "b", base_value: "An older name" } } };
  const editable = formHtml({ body, entity: e });
  ok(/<button[^>]*data-keep-mine="title"/.test(editable) && !/\sdisabled=""/.test(editable.match(/<button[^>]*data-keep-mine="title"[^>]*>/)[0]), "an editor can press them");
  const ro = formHtml({ body, entity: e, readOnly: EE.ENTRY_WORDS.readOnly });
  for (const k of ["data-keep-mine", "data-use-shopify"]) ok(/\sdisabled=""/.test(ro.match(new RegExp(`<button[^>]*${k}="title"[^>]*>`))[0]), `${k} disabled for a read-only person`);
});

await t("unit: the read-only view honours the title gate", async () => {
  Gate.setTitleGateForTest(true);
  const o = await open(21, SUPPORT_ACTOR);
  eq([o.readOnly, o.entity.titleEditable, typeof o.entity.titleBlockedReason], [EE.ENTRY_WORDS.readOnly, false, "string"], "support, gate closed:");
  const r = await read(21);
  eq(r.titleEditable, false, "readEntityContent:");
  Gate.setTitleGateForTest(false);
  eq((await open(21, SUPPORT_ACTOR)).entity.titleEditable, true, "gate open:");
});

await t("rendered: 'Discard edits' is never offered to a read-only person on a product that left Shopify, even when their role could publish", async () => {
  const body = { ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, title: { value: "Gone", base_hash: "b", base_value: "Was here" } } };
  const gone = { inShopify: false, shopify: null, titleEditable: true, titleBlockedReason: null, shopifyAdminUrl: null, commerce: null };
  ok(/data-discard=""/.test(formHtml({ body, entity: gone, access: { canPublish: true } })), "an owner is offered it");
  const ro = formHtml({ body, entity: gone, access: { canPublish: true }, readOnly: EE.ENTRY_WORDS.readOnly });
  ok(!/data-discard=""/.test(ro), "a read-only person is not");
  ok(plain(ro).includes(EM.PRODUCT_WORDS.discardStaff), "they see why");
});

await t("rendered: the catalog page says the brand and product type shown are set in the editor, and only price, stock and Shopify's own type and vendor stay in Shopify", async () => {
  const marker = (name) => (p) => h("div", { "data-stub": name, "data-props": JSON.stringify(p ?? {}) });
  const catWorld = world({
    "next/navigation": navStub,
    "@/components/kit/toast": toastStub,
    "next/headers": { cookies: async () => ({ get: () => ({ value: "cookie" }) }) },
    "@/lib/admin-auth": { adminActor: async () => OWNER_ACTOR, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
    "@/lib/console-request": { tfetch: (fn) => fn() },
    "@/lib/cms-mode": { getCmsMode: async () => "documents" },
    "@/lib/db": { db: {} },
    "@/lib/quiz": { listQuizzes: async () => [] },
    "@/lib/offers/catalog": { storeCurrency: async () => "INR" },
    "@/lib/admin/catalog-browse": {
      browseProducts: async () => ({ items: [], nextCursor: null, total: 0, counts: { all: 0, edited: 0, changedInShopify: 0, orphaned: 0 } }),
      catalogHeader: async () => ({ lastSyncedAt: null, lastSynced: null, products: 0, sync: null }),
    },
  });
  const CatalogPage = (await catWorld(join(ROOT, "app/(console)/admin/(authed)/catalog/page.js"))).default;
  const page = plain(html(await CatalogPage({ searchParams: Promise.resolve({}) })));
  for (const w of ["brand and product type shoppers see are set in the editor", "only price, stock and Shopify's own type and vendor stay in Shopify"]) ok(page.includes(w), `the header says "${w}": ${page.slice(0, 500)}`);
  ok(page.includes("Price, stock and Shopify's own type and vendor stay in Shopify"), "the editor block says it too");
  ok(!/edited in the editor now\.$|Their pages are edited in the editor;/.test(page), "the old half-true words are gone");
});

console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(failures.length ? 1 : 0);
