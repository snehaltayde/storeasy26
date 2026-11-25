// P5-PANEL suite (COM-02): the console bundle form (components/admin/bundles/
// BundleForm.js) and the Catalog > Bundles panel that uses it
// (the old CommercePanels BundlesPanel, gone since Phase 2 line 11; the
// bundles screens are components/admin/bundles/). P5-SOURCES registered it
// as a placeholder; P5-PANEL fills it in and P5-EDITOR extends it.
//   1. source scan: no typed variant-id placeholder, no slug input, no rupee
//      sign or 'INR', no legacy compat.problems, in BundleForm.js and in the
//      (the old BundlesPanel's sections went with it in Phase 2 line 11)
//   2. full mode renders Name, Products (picked rows), Price, Description and
//      'Save as draft' / 'Save and show to shoppers'; compact mode renders
//      only Name, Products, Price and 'Create bundle'
//   3. a failing check, through the REAL bundle route on a file database in
//      USD, renders bundle-words reasons per product row and under the price,
//      and never "component N:" or a rupee sign
//   4. picking a product already in the list adds to its quantity; compact
//      'Create bundle' waits for a passing check, then sends enable: true and
//      mustPass: true and the bundle is saved turned on; a full-mode edit
//      sends no slug and no on/off and shows the shoppers' link
//   5. (the old panel's section, removed in Phase 2 line 11)
//   6. P5-EDITOR: the editor's inline create (components/admin/editor/fields/
//      BundleControl.js): the Dialog holds only Name, Products and Price and
//      says the bundle goes live now; 'Create bundle' waits for a passing
//      check; the new bundle is picked as { id }; no 'Create a bundle'
//      without offers.write. And the form fixes from the P5-PANEL review:
//      'Save and show to shoppers' waits for the check with a name typed; the
//      saving keeps its cents; a quantity can be cleared and 1.5 is shown as
//      a reason; a row stored by a web name is named
//   7. P5-FIX2: Disable and Delete ask first when the home lookup failed;
//      the create Dialog never names an earlier name's page; a full grid has
//      no 'Create a bundle'; a quantity under 1 counts as empty
// Components run with Next's own SWC and a small hook driver (copied from
// scripts/test-media-picker.js). File databases only.
//   pnpm test:bundle-form
import "./support/request-cache.js";
import { readFile } from "node:fs/promises";
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
process.env.DATABASE_URL = "file:.test-bf-default.db";
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

// ---- the JSX loader (Next's SWC) ---------------------------------------------------------
const require = createRequire(import.meta.url);
const React = require("react");
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
const isJsxFile = (file) => /\/(components|app)\//.test(file) && !/\/app\/api\//.test(file);
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
const toastStub = { useToast: () => ({ success() {}, error() {}, info() {} }) };
const navStub = { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), redirect: () => {}, usePathname: () => "/admin/catalog" };

// ---- the hook driver (as scripts/test-media-picker.js) -------------------------------------
// VariantPicker is not called: its node and props are kept, so a test can
// "pick" by calling its onConfirm.
const SKIP = new Set(["Dialog", "VariantPicker", "RefPicker"]);
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
        const key = `${path}/${ty.name}${n.key != null ? `#${n.key}` : ""}`;
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

async function mount(file, exportName, makeProps, { inflight = null } = {}) {
  const d = driver();
  const load = world({ react: d.react, "@/components/kit/toast": toastStub, "next/navigation": navStub });
  const mod = await load(join(ROOT, file));
  const C = mod[exportName];
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
    all: () => nodes.filter((n) => typeof n.type === "string").map((n) => textOf(n)).join(" "),
    find: (pred) => nodes.find(pred) || null,
    filter: (pred) => nodes.filter(pred),
    button(name) {
      const b = nodes.find((n) => n.type === "button" && nameOf(n) === name);
      ok(b, `no button "${name}" on screen; buttons: ${nodes.filter((n) => n.type === "button").map(nameOf).join(" | ")}`);
      return b;
    },
    buttons: () => nodes.filter((n) => n.type === "button").map(nameOf),
    hasButton: (name) => nodes.some((n) => n.type === "button" && nameOf(n) === name),
    async click(name) {
      const b = view.button(name);
      ok(!b.props.disabled, `button "${name}" is disabled`);
      await b.props.onClick?.({ preventDefault() {}, target: {} });
      await flush();
    },
    async type(id, value) {
      const el = nodes.find((n) => n.props?.id === id && (n.type === "input" || n.type === "textarea"));
      ok(el, `no field #${id}`);
      el.props.onChange({ target: { value } });
      await flush();
    },
    async pick(variantId, label) {
      const p = nodes.find((n) => typeof n.type === "function" && n.type.name === "VariantPicker");
      ok(p, "no VariantPicker");
      p.props.onConfirm({ variantId, label });
      await flush();
    },
    dialogText: () => nodes.filter((n) => typeof n.type === "function" && n.type.name === "Dialog" && n.props.open).map((n) => textOf(n.props.children)).join(" "),
    labels: () => nodes.filter((n) => n.type === "label").map((n) => textOf(n.props.children).trim()),
  };
  return view;
}

// ---- a store on a file database and the real bundle route --------------------------------
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("bf");
const plat = await F.makePlatform({ name: "bf" });
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const B = await import("../lib/bundles.js");
const route = await import("../app/api/admin/bundles/route.js");

const store = await F.makeTenant({ name: "bf-store", id: "bfstore", products: 6 });
const rawClient = store.client();
const raw = async (q, args = []) => (await rawClient.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
// a USD store, so a rupee sign could only come from a hard-coded one
await raw("UPDATE products SET currency = 'USD'");
await raw("UPDATE variants SET currency = 'USD'");
const V = (n) => `gid://shopify/ProductVariant/${9100 + n}1`;

const owner = await I.createUser({ email: "owner@bf.test", name: "Owner", password: "bf-owner-pass-1" });
await I.addMembership(owner.id, "bfstore", "owner");
const tok = (await Sess.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const routeReq = (body, path) => ({
  cookies: { get: (n) => (n === "_admin" ? { name: n, value: tok } : undefined) },
  headers: { get: (k) => ({ host: "bfstore.test" })[k.toLowerCase()] ?? null },
  url: `https://bfstore.test${path}`,
  nextUrl: new URL(`https://bfstore.test${path}`),
  json: async () => body,
});
// A browser fetch that lands on the real bundle route. Every call is kept.
function storeFetch() {
  const calls = [];
  const inflight = new Set();
  const fetch = (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: String(url), body });
    ok(String(url).startsWith("/api/admin/bundles"), `unexpected fetch ${url}`);
    const p = (async () => {
      const res = await route[method](routeReq(body, String(url)), { params: Promise.resolve({}) });
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
const FORM = "components/admin/bundles/BundleForm.js";

// =====================================================================================
console.log("— 1. source scan");

await t("BundleForm.js holds no typed variant-id placeholder, no slug input, no rupee sign or 'INR', and no compat.problems", async () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const form = strip(await readFile(join(ROOT, FORM), "utf8"));
  ok(!form.includes("gid://"), "a typed variant-id placeholder");
  ok(!/placeholder="[^"]*(handle|ProductVariant)/i.test(form), "a handle placeholder");
  ok(!/bundle-slug|label="Slug"|setForm\(\{[^}]*slug:/i.test(form), "a slug input");
  ok(!/<Input[^>]*slug/i.test(form), "an Input bound to the slug");
  ok(!form.includes("₹"), "a rupee sign");
  ok(!/\bINR\b/.test(form), "'INR'");
  ok(!/\.problems\b|problems\b/.test(form), "the legacy problems");
  ok(!/component \$\{|component \d/.test(form), '"component N" words');
  ok(!/const inr\b|\binr\(/.test(form), "the old inr() formatter");
  ok(/formatMoney\(/.test(form), "it formats money through formatMoney");
  ok(/from "@\/lib\/commerce\/bundle-words"/.test(form), "it takes its words from bundle-words");
});

// =====================================================================================
console.log("— 2. full and compact modes");

await t("full mode (new bundle) renders Name, Products, Price, Description and 'Save as draft' / 'Save and show to shoppers'; no slug field", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD" }), f);
    eq(v.labels(), ["Name", "Price", "Description"], "field labels");
    ok(v.find((n) => n.props?.["data-bundle-products"] === "") && /Products/.test(v.all()), "the Products list");
    ok(v.hasButton("Add product"), "products are added through the picker");
    ok(v.find((n) => typeof n.type === "function" && n.type.name === "VariantPicker"), "the picker is there");
    eq(v.filter((n) => n.type === "input").map((n) => n.props.id), ["bundle-name", "bundle-price"], "the only inputs before a product is picked (no slug, no typed product)");
    ok(v.find((n) => n.type === "textarea" && n.props.id === "bundle-desc"), "the description");
    for (const b of ["Save as draft", "Save and show to shoppers"]) ok(v.hasButton(b), `button ${b}`);
    ok(!v.hasButton("Create bundle") && !v.hasButton("Save changes"), "no compact or edit button");
    ok(v.button("Save and show to shoppers").props.disabled, "show to shoppers waits for a passing check");
    eq(f.calls.length, 0, "no check before a product is picked");
  });
});

await t("compact mode renders only Name, Products, Price and 'Create bundle'", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", compact: true }), f);
    eq(v.labels(), ["Name", "Price"], "field labels");
    ok(/Products/.test(v.all()) && v.hasButton("Add product"), "products");
    ok(!v.find((n) => n.type === "textarea"), "no description");
    eq(v.buttons().filter((b) => !/^Remove /.test(b)), ["Add product", "Create bundle"], "buttons");
    ok(v.button("Create bundle").props.disabled, "disabled until a check passes");
    ok(!/Shoppers' link/.test(v.all()), "no link before saving");
  });
});

// =====================================================================================
console.log("— 3. a failing check, through the real route");

await t("a failing check renders bundle-words reasons per product row and under the price, in USD, and no 'component N:' text", async () => {
  await raw("UPDATE variants SET available = 0 WHERE id = ?", [V(1)]);
  try {
    const f = storeFetch();
    await withFetch(f.fetch, async () => {
      const initial = { id: "bun-x", slug: "kit", title: "Kit", description: "", bundle_price: 1000, items: [{ variantId: V(1), quantity: 1 }, { variantId: "gid://shopify/ProductVariant/404", quantity: 1 }, { variantId: V(3), quantity: 1 }] };
      const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", initial }), f);
      const check = f.calls.find((c) => c.body?.check);
      ok(check, "the live check ran");
      eq(check.body.check.items.map((i) => i.variantId), initial.items.map((i) => i.variantId), "the check sends the picked rows");
      const rowReason = (i) => {
        const row = v.find((n) => n.props?.["data-bundle-row"] === i);
        ok(row, `row ${i}`);
        const said = v.nodes().find((n) => n.props?.["data-bundle-row-reason"] === "" && v.nodes().indexOf(n) > v.nodes().indexOf(row) && (i === 2 || v.nodes().indexOf(n) < v.nodes().indexOf(v.find((m) => m.props?.["data-bundle-row"] === i + 1))));
        return said ? textOf(said.props.children) : "";
      };
      eq([rowReason(0), rowReason(1), rowReason(2)], ["Sold out", "No longer available", ""], "per row");
      // P5-FIX1 (ruling 1): with a product missing the sum is not the real one,
      // so there is no "Price must be lower than …" under the price; the
      // missing row says "No longer available" (replace it)
      const price = v.find((n) => n.props?.["data-bundle-price-reason"] === "");
      ok(!price || !/Price must be lower/.test(textOf(price.props.children)), "no price reason on a false sum");
      const all = v.all();
      ok(!/component \d|₹|INR|not in the catalog|doesn't save/i.test(all), `legacy words on screen: ${all}`);
      ok(/Fixture product 3/.test(all), "row titles come from the check");
      ok(/Shoppers' link: \/bundles\/kit/.test(all.replace(/\s+/g, " ")), "the edit shows the shoppers' link");
      ok(!v.hasButton("Save as draft") && v.hasButton("Save changes"), "an edit has one Save changes");
    });
  } finally {
    await raw("UPDATE variants SET available = 1 WHERE id = ?", [V(1)]);
  }
});

// =====================================================================================
console.log("— 4. picking, creating and editing");

await t("picking a product already in the list adds to its quantity instead of a second row", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD" }), f);
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    eq(v.filter((n) => n.props?.["data-bundle-row"] != null).length, 2, "two rows");
    eq(v.filter((n) => n.type === "input" && /^Quantity of /.test(n.props["aria-label"] || "")).map((n) => n.props.value), [2, 1], "quantities");
    const last = f.calls.filter((c) => c.body?.check).at(-1);
    eq(last.body.check.items, [{ variantId: V(1), quantity: 2 }, { variantId: V(2), quantity: 1 }], "the check sends the merged rows");
  });
});

await t("compact 'Create bundle' waits for a passing check, then sends enable: true and mustPass: true, and the bundle is saved turned on with a derived slug", async () => {
  const f = storeFetch();
  const saved = [];
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", compact: true, onSaved: (b) => saved.push(b) }), f);
    await v.type("bundle-name-compact", "Duo Pack");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    ok(v.button("Create bundle").props.disabled, "one product: still disabled");
    ok(/Pick at least two products/.test(v.all()), "too few, in bundle-words");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price-compact", "350");
    ok(v.button("Create bundle").props.disabled, "350 is not below 300: disabled");
    ok(/Price must be lower than \$300/.test(v.all()), "says why");
    await v.type("bundle-price-compact", "250");
    ok(!v.button("Create bundle").props.disabled, "a passing check enables it");
    ok(/Shoppers save \$50/.test(v.all()), `the saving: ${v.all()}`);
    await v.click("Create bundle");
    const create = f.calls.find((c) => c.body?.create);
    eq(create.body.create, { title: "Duo Pack", items: [{ variantId: V(1), quantity: 1 }, { variantId: V(2), quantity: 1 }], bundle_price: 250, enable: true, mustPass: true }, "what is sent");
    eq(saved.length, 1, "onSaved once");
    eq([saved[0].slug, Number(saved[0].enabled)], ["duo-pack", 1], "saved turned on, with a derived slug");
    const row = (await raw("SELECT slug, enabled FROM bundles WHERE id = ?", [saved[0].id]))[0];
    eq([row.slug, Number(row.enabled)], ["duo-pack", 1], "the row");
    ok(/Shoppers' link: \/bundles\/duo-pack/.test(v.all()), "the link is shown after saving");
    ok(v.button("Create bundle").props.disabled, "it can't be created twice");
    await store.run(() => B.deleteBundle(saved[0].id));
  });
});

await t("full mode: 'Save as draft' creates it turned off; the edit's 'Save changes' sends no slug and no on/off and keeps a live bundle live", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD" }), f);
    await v.type("bundle-name", "Draft Kit");
    await v.click("Add product");
    await v.pick(V(3), "Fixture product 3");
    await v.click("Add product");
    await v.pick(V(4), "Fixture product 4");
    await v.type("bundle-price", "600");
    await v.type("bundle-desc", "Two things");
    await v.click("Save as draft");
    const draft = f.calls.find((c) => c.body?.create);
    eq([draft.body.create.enable, draft.body.create.mustPass, draft.body.create.description], [false, false, "Two things"], "draft");
    ok(v.hasButton("Save changes"), "after saving, the form edits that bundle");
    ok(/Shoppers' link: \/bundles\/draft-kit/.test(v.all()), "derived link");
    const id = (await raw("SELECT id, enabled FROM bundles WHERE slug = 'draft-kit'"))[0];
    eq(Number(id.enabled), 0, "saved turned off");
    await store.run(() => B.setBundleEnabled(id.id, true));
    await v.type("bundle-price", "650");
    await v.click("Save changes");
    const edit = f.calls.find((c) => c.body?.bundle);
    eq(Object.keys(edit.body.bundle).sort(), ["bundle_price", "description", "id", "items", "title"], "an edit sends no slug and no enable");
    const row = (await raw("SELECT slug, enabled, bundle_price, description FROM bundles WHERE id = ?", [id.id]))[0];
    eq([row.slug, Number(row.enabled), Number(row.bundle_price), row.description], ["draft-kit", 1, 650, "Two things"], "kept live, new price");
    await store.run(() => B.deleteBundle(id.id));
  });
});

// =====================================================================================
console.log("— 6. P5-EDITOR: the editor's inline create, and the form fixes");

const CONTROL = "components/admin/editor/fields/BundleControl.js";
const M = await import("../components/admin/editor/fields/inspectorModel.js");
const cardField = { key: "bundle", path: "bundle", control: "bundle", label: "Bundle", setting: { key: "bundle", kind: "bundle", required: true } };
const gridField = { key: "bundles", path: "bundles", control: "bundle_list", label: "Bundles to show", setting: { key: "bundles", kind: "bundle_list", required: true, max: 12 } };
const LIVE_NOW = (slug) => `The bundle is saved and turned on now: its discount works in the cart and its page /bundles/${slug} opens right away, even if you don't publish. It shows on your home page after you publish.`;
const qtyInputs = (v) => v.filter((n) => n.type === "input" && /^Quantity of /.test(n.props["aria-label"] || ""));
const typeQty = async (v, i, value) => {
  qtyInputs(v)[i].props.onChange({ target: { value } });
  await v.flush();
};

await t("the inline-create Dialog shows only Name, Products and Price, says the bundle is turned on now even before publishing, keeps 'Create bundle' off while the check fails, and picks the new bundle as { id }", async () => {
  const f = storeFetch();
  let value = null;
  const refreshed = [];
  await withFetch(f.fetch, async () => {
    const v = await mount(CONTROL, "BundleControl", () => ({ field: cardField, value, onChange: (x) => (value = x), issues: [], owner: "sec_ic1", context: { bundles: { status: "ready", items: [] }, canCreateBundles: true, currency: "USD", refreshBundles: () => refreshed.push(1) } }), f);
    ok(!v.dialogText(), "no Dialog before the click");
    const labelsBefore = v.labels();
    const inputsBefore = v.filter((n) => n.type === "input").map((n) => n.props.id);
    await v.click("Create a bundle");
    const said = v.dialogText();
    ok(said.includes(LIVE_NOW("bundle")), `the live-now sentence: ${said}`);
    ok(/turned on now/.test(said) && /even if you don't publish/.test(said), "turned on now … even if you don't publish");
    const added = v.labels().slice(labelsBefore.length);
    eq(added, ["Name", "Price"], "the Dialog's fields are Name and Price (and the Products list)");
    eq(v.filter((n) => n.type === "input").map((n) => n.props.id).filter((id) => !inputsBefore.includes(id)), ["bundle-name-compact", "bundle-price-compact"], "only the name and price inputs");
    ok(!v.find((n) => n.type === "textarea"), "no description");
    ok(/Products/.test(v.all()) && v.hasButton("Add product"), "the Products list");
    ok(!v.hasButton("Save as draft") && !v.hasButton("Save and show to shoppers"), "compact: no draft");
    await v.type("bundle-name-compact", "Gym Kit");
    ok(v.dialogText().includes(LIVE_NOW("gym-kit")), "the page follows the name");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price-compact", "300");
    ok(/Price must be lower than \$300/.test(v.all()), "the check fails, in words");
    ok(v.button("Create bundle").props.disabled, "Create bundle is off while the check fails");
    eq(f.calls.filter((c) => c.body?.create).length, 0, "nothing created");
    await v.type("bundle-price-compact", "250");
    ok(!v.button("Create bundle").props.disabled, "on once it passes");
    await v.click("Create bundle");
    const create = f.calls.filter((c) => c.body?.create);
    eq(create.length, 1, "one create");
    eq([create[0].body.create.enable, create[0].body.create.mustPass], [true, true], "turned on, must pass");
    const rowNow = (await raw("SELECT id, slug, enabled FROM bundles WHERE title = 'Gym Kit'"))[0];
    eq([rowNow.slug, Number(rowNow.enabled)], ["gym-kit", 1], "saved turned on, at the page the Dialog named");
    eq(value, { id: rowNow.id }, "the new bundle is picked as { id } only");
    eq(refreshed.length, 1, "the editor's bundles are read again");
    ok(!v.dialogText(), "the Dialog closed");
    await store.run(() => B.deleteBundle(rowNow.id));
  });
});

await t("a grid's inline create adds the new bundle at the end; without offers.write there is no 'Create a bundle' and the sentence says to ask an owner", async () => {
  for (const name of ["BundleControl", "BundleListControl"]) {
    const v = await mount(CONTROL, name, () => ({ field: name === "BundleControl" ? cardField : gridField, value: name === "BundleControl" ? null : [], onChange: () => {}, issues: [], owner: "sec_no1", context: { bundles: { status: "ready", items: [] }, canCreateBundles: false, currency: "USD" } }));
    ok(!v.hasButton("Create a bundle"), `${name}: no Create a bundle`);
    ok(v.all().includes("Ask an owner to create bundles."), `${name}: the sentence`);
  }
  const f = storeFetch();
  let value = [{ id: "bun-first" }];
  await withFetch(f.fetch, async () => {
    const v = await mount(CONTROL, "BundleListControl", () => ({ field: gridField, value, onChange: (x) => (value = x), issues: [], owner: "sec_ic2", context: { bundles: { status: "ready", items: [] }, canCreateBundles: true, currency: "USD" } }), f);
    await v.click("Create a bundle");
    await v.type("bundle-name-compact", "Grid Pair");
    await v.click("Add product");
    await v.pick(V(3), "Fixture product 3");
    await v.click("Add product");
    await v.pick(V(4), "Fixture product 4");
    await v.type("bundle-price-compact", "600");
    await v.click("Create bundle");
    const made = (await raw("SELECT id FROM bundles WHERE title = 'Grid Pair'"))[0];
    eq(value, [{ id: "bun-first" }, { id: made.id }], "added at the end as { id }");
    await store.run(() => B.deleteBundle(made.id));
  });
});

await t("the Dialog's page name is the one createBundle derives (lib/bundles.js slugBase)", async () => {
  for (const title of ["Gym Kit", "  Café  Duo!! ", "💪", "x".repeat(80), "Starter-stack 2"]) eq(M.bundleSlugGuess(title), B.slugWithSuffix(B.slugBase(title), 1), `"${title}"`);
});

await t("P5-PANEL review: 'Save and show to shoppers' stays off while the check fails, with a name typed", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD" }), f);
    await v.type("bundle-name", "Named kit");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price", "900");
    ok(/Price must be lower than \$300/.test(v.all()), "the check fails");
    ok(v.button("Save and show to shoppers").props.disabled, "off while it fails, though the name is there");
    await v.type("bundle-price", "250");
    ok(!v.button("Save and show to shoppers").props.disabled, "on once it passes");
  });
});

await t("P5-PANEL review: the saving keeps its cents ($49.48, never $49), and says what the cart takes off", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", compact: true }), f);
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price-compact", "250.52");
    const saving = textOf(v.find((n) => n.props?.["data-bundle-saving"] === "").props.children);
    eq(saving, "The products add up to $300. Shoppers save $49.48. The cart takes off $49, as it rounds to a whole amount.", "the saving line");
    await v.type("bundle-price-compact", "250");
    eq(textOf(v.find((n) => n.props?.["data-bundle-saving"] === "").props.children), "The products add up to $300. Shoppers save $50.", "a whole saving says nothing more");
    eq(M.bundleSlugGuess("") , "bundle", "an empty name");
  });
});

await t("P5-PANEL review: a quantity can be cleared while typing (no keystroke makes it 1), nothing is checked or saved while it is empty, and a typed 1.5 shows the bad_quantity reason", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", compact: true }), f);
    await v.type("bundle-name-compact", "Qty kit");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price-compact", "250");
    ok(!v.button("Create bundle").props.disabled, "passes first");
    const checks = () => f.calls.filter((c) => c.body?.check).length;
    const n = checks();
    await typeQty(v, 0, "");
    eq(qtyInputs(v)[0].props.value, "", "the box stays empty");
    eq(checks(), n, "no check while it is empty");
    ok(v.button("Create bundle").props.disabled, "nothing can be created while it is empty");
    ok(/Enter how many of this product, 1 or more\./.test(v.all()), "the row says so");
    await typeQty(v, 0, "3");
    eq(qtyInputs(v)[0].props.value, 3, "typing 3 into the cleared box gives 3, not 13");
    eq(f.calls.filter((c) => c.body?.check).at(-1).body.check.items[0].quantity, 3, "checked with 3");
    await typeQty(v, 0, "1.5");
    eq(qtyInputs(v)[0].props.value, 1.5, "1.5 is kept as typed");
    eq(f.calls.filter((c) => c.body?.check).at(-1).body.check.items[0].quantity, 1.5, "and checked as 1.5");
    const row0 = v.nodes().indexOf(v.find((n) => n.props?.["data-bundle-row"] === 0));
    const row1 = v.nodes().indexOf(v.find((n) => n.props?.["data-bundle-row"] === 1));
    const reason = v.nodes().find((n, i) => i > row0 && i < row1 && n.props?.["data-bundle-row-reason"] === "");
    ok(reason && /The quantity must be a whole number, 1 or more/.test(textOf(reason.props.children)), `row 1 shows the bad_quantity reason: ${reason ? textOf(reason.props.children) : "none"}`);
    ok(v.button("Create bundle").props.disabled, "1.5 can't be created");
  });
});

await t("P5-PANEL review: a stored row that holds a web name (not a picked product) is named: 'Pick product 1 again', nothing is checked until it is picked", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const initial = { id: "bun-legacy", slug: "legacy-kit", title: "Legacy kit", description: "", bundle_price: 250, items: [{ variantId: "old-handle", quantity: 1 }, { variantId: V(2), quantity: 1 }] };
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", initial }), f);
    eq(f.calls.filter((c) => c.body?.check).length, 0, "no check (the route would refuse the whole check)");
    const banner = v.find((n) => n.props?.["data-bundle-pick-again"] === "");
    ok(banner, "a banner names the row");
    eq(textOf(banner.props.children), "Pick product 1 again: it was saved by its web name, not picked from your catalog.", "the banner");
    ok(/“old-handle”/.test(v.all()) && /Pick this product again with Change: it was saved by its web name\./.test(v.all()), "the row shows what it holds and what to do");
    ok(!/Checking…/.test(v.all()), "no row waits on a check that can't come");
    ok(v.button("Save changes").props.disabled, "it can't be saved as it is");
    eq(M.bundleSlugGuess("Legacy kit"), "legacy-kit", "guess");
    await v.button("Change").props.onClick();
    await v.flush();
    await v.pick(V(1), "Fixture product 1");
    ok(!v.find((n) => n.props?.["data-bundle-pick-again"] === ""), "picked again: the banner goes");
    ok(f.calls.some((c) => c.body?.check), "and the check runs");
    ok(!v.button("Save changes").props.disabled, "and it can be saved");
  });
});

// =====================================================================================
console.log("— 7. P5-FIX2: the batch 2 review findings");


await t("P5-FIX2: the create Dialog never names an earlier name's page: after a Cancel with a name typed, and after a create, it opens again on /bundles/bundle", async () => {
  const f = storeFetch();
  let value = null;
  await withFetch(f.fetch, async () => {
    const v = await mount(CONTROL, "BundleControl", () => ({ field: cardField, value, onChange: (x) => (value = x), issues: [], owner: "sec_rs1", context: { bundles: { status: "ready", items: [] }, canCreateBundles: true, currency: "USD", refreshBundles: () => {} } }), f);
    await v.click("Create a bundle");
    await v.type("bundle-name-compact", "Old Name");
    ok(v.dialogText().includes(LIVE_NOW("old-name")), "the page follows the name");
    await v.click("Cancel");
    ok(!v.dialogText(), "closed");
    await v.click("Create a bundle");
    ok(v.dialogText().includes(LIVE_NOW("bundle")) && !v.dialogText().includes("/bundles/old-name"), `opened again: ${v.dialogText()}`);
    // and after a create
    await v.type("bundle-name-compact", "Made Kit");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price-compact", "250");
    await v.click("Create bundle");
    const made = (await raw("SELECT id FROM bundles WHERE title = 'Made Kit'"))[0];
    ok(made && value?.id === made.id, "created and picked");
    ok(!v.dialogText(), "closed after the create");
    await v.click("Create a bundle");
    ok(v.dialogText().includes(LIVE_NOW("bundle")) && !v.dialogText().includes("/bundles/made-kit"), `opened again after a create: ${v.dialogText()}`);
    await store.run(() => B.deleteBundle(made.id));
  });
});

await t("P5-FIX2: a full grid (12) has 'Create a bundle' off with 'A grid shows at most 12 bundles.', so no bundle is made live and left unplaced", async () => {
  const twelve = Array.from({ length: 12 }, (_, j) => ({ id: `bun-x${j}` }));
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(CONTROL, "BundleListControl", () => ({ field: gridField, value: twelve, onChange: () => {}, issues: [], owner: "sec_full", context: { bundles: { status: "ready", items: [] }, canCreateBundles: true, currency: "USD" } }), f);
    ok(v.button("Create a bundle").props.disabled, "off");
    ok(v.all().includes("A grid shows at most 12 bundles."), "says why");
    ok(!v.dialogText(), "no Dialog");
    const v11 = await mount(CONTROL, "BundleListControl", () => ({ field: gridField, value: twelve.slice(1), onChange: () => {}, issues: [], owner: "sec_11", context: { bundles: { status: "ready", items: [] }, canCreateBundles: true, currency: "USD" } }), f);
    ok(!v11.button("Create a bundle").props.disabled && !v11.all().includes("A grid shows at most"), "on with one place left");
  });
});

await t("P5-FIX2: a quantity under 1 (0 or negative) is treated as empty: the row asks for a quantity, nothing is checked or saved, and the box never disagrees with what is stored", async () => {
  const f = storeFetch();
  await withFetch(f.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD", compact: true }), f);
    await v.type("bundle-name-compact", "Zero kit");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await v.type("bundle-price-compact", "250");
    ok(!v.button("Create bundle").props.disabled, "passes first");
    const checks = () => f.calls.filter((c) => c.body?.check).length;
    for (const typed of ["0", "-2", "0.5"]) {
      const n = checks();
      await typeQty(v, 0, typed);
      eq(qtyInputs(v)[0].props.value, Number(typed), `${typed}: the box keeps what was typed`);
      eq(checks(), n, `${typed}: no check (it would be clamped to 1)`);
      ok(v.button("Create bundle").props.disabled, `${typed}: nothing can be created`);
      ok(/Enter how many of this product, 1 or more\./.test(v.all()), `${typed}: the row asks for a quantity`);
    }
    await typeQty(v, 0, "2");
    eq(f.calls.filter((c) => c.body?.check).at(-1).body.check.items[0].quantity, 2, "checked with 2 once it is 1 or more");
    ok(!/Enter how many of this product/.test(v.all()), "the ask goes");
  });
  // full mode: Save as draft waits too
  const f2 = storeFetch();
  await withFetch(f2.fetch, async () => {
    const v = await mount(FORM, "BundleForm", () => ({ currency: "USD" }), f2);
    await v.type("bundle-name", "Zero draft");
    await v.click("Add product");
    await v.pick(V(1), "Fixture product 1");
    await v.click("Add product");
    await v.pick(V(2), "Fixture product 2");
    await typeQty(v, 1, "0");
    ok(v.button("Save as draft").props.disabled && v.button("Save and show to shoppers").props.disabled, "no save with a 0");
    eq(f2.calls.filter((c) => c.body?.create).length, 0, "nothing created");
  });
});

// ---- done -------------------------------------------------------------------------------
rawClient.close();
await store.cleanup();
await plat.cleanup();
await F.removeFixtureFiles("bf");
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${failures.length} failed (${secs} s)`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
process.exit(0);
