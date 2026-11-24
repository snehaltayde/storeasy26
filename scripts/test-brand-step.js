// P6-BRAND suite (GEN-04, US-01): the brand step of "Start your store",
// server side (lib/first-run/brand-step.js behind GET/POST
// /api/admin/brand-step). Extended by P6-START-UI (its rendered tests).
//   pnpm test:brand-step
//
// Run for real: the real route handler (tenantHandler, requireAdmin, real
// sessions and roles), real documents-mode tenant databases made by
// scripts/support/tenant-fixture.js (local files only), the real first-run
// writer (createFirstRunDocuments, the one the generator uses; generate.js is
// not imported), the real control plane, and storage re-read after every
// refusal. No server is started, no port is used, nothing goes to Shopify or
// Typesense.
//
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;

import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// next/headers answers for one simulated storefront request at a time (as in
// test-design-doc), for resolvedLogo after a publish; outside one it throws,
// as the real module does outside a request.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__readRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() {
  const r = req();
  return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) };
}
export async function cookies() {
  const r = req();
  return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) };
}
`);
// P6-START-UI (review M14): brand-step.js's own documents service, wrapped so
// the suite sees the very body objects the step hands createDocument and
// saveDraft (before they are stored as JSON), to prove settings.brand is a
// copy and never the frozen palette object. Everything else is the real module.
const SERVICE_URL = pathToFileURL(join(ROOT, "lib/documents/service.js")).href;
const SERVICE_SPY =
  "data:text/javascript," +
  encodeURIComponent(`
import * as R from ${JSON.stringify(SERVICE_URL)};
export * from ${JSON.stringify(SERVICE_URL)};
const seen = (a) => { (globalThis.__bsWrites ||= []).push(a && a.body); };
export async function createDocument(a, ...rest) { seen(a); return R.createDocument(a, ...rest); }
export async function saveDraft(a, ...rest) { seen(a); return R.saveDraft(a, ...rest); }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec === "../documents/service.js" && String(ctx.parentURL || "").endsWith("/lib/first-run/brand-step.js")) return { url: SERVICE_SPY, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-bs-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";

const { runRequest } = await import("./support/request-cache.js");
const F = await import("./support/tenant-fixture.js");
const { rm } = await import("node:fs/promises");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 4).join("\n   ") || e.message}`);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (got, want, label = "") => {
  if (!same(got, want)) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

await F.removeFixtureFiles("bs");
await rm(join(ROOT, ".test-bs-default.db"), { force: true });
const plat = await F.makePlatform({ name: "bs" });
const C = plat.control;
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const R = await import("../lib/registry/index.js");
const B = await import("../lib/brand.js");
const M = await import("../lib/media.js");
const Res = await import("../lib/content/resolve.js");
const Pal = await import("../lib/themes/palettes.js");
const { withTenant } = await import("../lib/tenant-context.js");
const BS = await import("../lib/first-run/brand-step.js");
const route = await import("../app/api/admin/brand-step/route.js");

// ---- stores -----------------------------------------------------------------------------
const SITE = { name: "Brand Step Store", tagline: "Old tagline" };
const stores = {};
const fixtures = [];
async function store(key, { mode = "documents", config = {} } = {}) {
  const fx = await F.makeTenant({ name: `bs-${key}`, id: `bs${key}`, mode, config: { site: { ...SITE }, site_url: `https://bs${key}.test`, ...config } });
  fixtures.push(fx);
  stores[key] = fx;
  return fx;
}
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const inS = async (fx, fn) => withTenant(await C.getTenant(fx.id, { fresh: true }), fn);
// Everything a brand-step write could touch in a store, to prove a refusal
// changed nothing: its content tables and its control-plane config.
const dump = async (fx) => {
  const out = {};
  for (const table of ["documents", "document_versions", "document_refs", "publish_log", "release_state", "releases", "cms_state"]) out[table] = await sql(fx, `SELECT * FROM ${table} ORDER BY rowid`);
  out.config = (await C.getTenant(fx.id, { fresh: true })).config;
  return JSON.stringify(out);
};
const unchanged = async (fx, before, label) => eq(await dump(fx), before, `${label}: storage changed:`);
const configOf = async (fx) => (await C.getTenant(fx.id, { fresh: true })).config;
const designRow = async (fx) => (await sql(fx, "SELECT * FROM documents WHERE id = 'doc_design'"))[0] || null;
const designSettings = async (fx) => {
  const r = await designRow(fx);
  return r ? JSON.parse(r.draft).settings : null;
};

// ---- people -----------------------------------------------------------------------------
const ownerU = await I.createUser({ email: "owner@bs.test", name: "Owner Person", password: "bs-owner-pass-1" });
const staffU = await I.createUser({ email: "staff@bs.test", name: "Staff Person", password: "bs-staff-pass-1" });
const supportU = await I.createUser({ email: "help@bs.test", name: "Support Person", password: "bs-support-pass-1" });
const tok = async (u) => (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const SUPPORT = await tok(supportU);
const OWNER_BY = `merchant:${ownerU.id}`;
async function members(fx) {
  await I.addMembership(ownerU.id, fx.id, "owner");
  await I.addMembership(staffU.id, fx.id, "staff");
  await I.addMembership(supportU.id, fx.id, "support");
}

// ---- the route --------------------------------------------------------------------------
const PATH = "/api/admin/brand-step";
const routeReq = (fx, cookie, body) => ({
  cookies: { get: (n) => (n === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test`, origin: `https://${fx.id}.test` })[k.toLowerCase()] ?? null },
  url: `https://${fx.id}.test${PATH}`,
  nextUrl: { pathname: PATH },
  json: async () => body,
});
const call = async (method, fx, body, as = OWNER) => {
  const res = await route[method](routeReq(fx, as, body), {});
  return { status: res.status, body: await res.json() };
};
const get = (fx, as) => call("GET", fx, undefined, as);
const post = (fx, body, as) => call("POST", fx, body, as);

// ---- helpers ----------------------------------------------------------------------------
const FR = Docs.FIRST_RUN_ACTOR;
const designBody = (paletteId, over = {}) => ({ ...R.emptyBody("design"), settings: { ...R.emptyBody("design").settings, ...Pal.designBodyFor(paletteId), ...over } });
const homeBody = () => ({ ...R.emptyBody("home"), sections: [{ id: "sec_bshome1", kind: "text", v: 1, enabled: true, settings: { title: "Welcome", body: ["Words for shoppers."] }, blocks: [] }] });
const seedSlate = (fx, { home = false } = {}) =>
  inS(fx, () =>
    Docs.createFirstRunDocuments({
      docs: [...(home ? [{ type: "home", id: "doc_home", body: homeBody() }] : []), { type: "design", id: "doc_design", body: designBody("slate") }],
      actor: FR,
    }),
  );
const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n & 255, (n >> 8) & 255, 2, 3, 4, 5, 6, 7]);
let pngN = 1;
const upload = (fx) => inS(fx, () => M.saveMedia({ filename: `logo-${pngN}.png`, mime: "image/png", bytes: PNG(pngN++), alt: "" }));
const forest = Pal.paletteById("forest");
const FOREST_FROZEN = JSON.stringify(forest.brand);
async function publishIn(fx, ids) {
  return inS(fx, async () => {
    const items = [];
    for (const id of ids) {
      const d = await Docs.getDocument(id);
      items.push({ id: d.id, revision: d.revision, draftHash: d.draftHash });
    }
    return Pub.publish({ ids: items, actor: { kind: "merchant", id: ownerU.id } });
  });
}
async function asShopper(fx, fn) {
  globalThis.__readRequest = { host: `${fx.id}.test`, cookies: {} };
  try {
    return await runRequest(() => inS(fx, fn));
  } finally {
    globalThis.__readRequest = null;
  }
}
// Counts the control-plane writes to the tenants table (patchTenant ends in
// upsertTenant's one INSERT … ON CONFLICT).
function countTenantWrites() {
  const db = C.platformDb();
  const execute = db.execute.bind(db);
  const batch = db.batch.bind(db);
  const seen = { writes: 0 };
  const isWrite = (s) => /^\s*(INSERT|UPDATE|DELETE)\b[\s\S]*\btenants\b/i.test(typeof s === "string" ? s : s?.sql || "");
  db.execute = async (s, ...rest) => {
    if (isWrite(s)) seen.writes++;
    return execute(s, ...rest);
  };
  db.batch = async (list, ...rest) => {
    for (const s of list || []) if (isWrite(s)) seen.writes++;
    return batch(list, ...rest);
  };
  seen.stop = () => {
    db.execute = execute;
    db.batch = batch;
  };
  return seen;
}

// ========================================================================================
// P6-START-UI: the start page, rendered. The client parts (FirstRun.js,
// BrandStep.js) are compiled with Next's SWC and driven by a small hook
// driver (the one test-media-picker uses): each component is called with its
// own hook slots, effects run after each draw, and fetch is a mock that
// answers like GET/POST /api/admin/first-run, /api/admin/brand-step and
// /api/admin/sync. The page (start/page.js) is compiled the same way with its
// server modules stubbed.
// ========================================================================================
async function renderedTests() {
  const { readFile, readdir } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { resolve: resolvePath } = await import("node:path");
  const require = createRequire(import.meta.url);
  const React = require("react");
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const { scanText, BANNED } = await import("./support/banned-copy.js");
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
    const loaded = [];
    async function load(file) {
      if (cache.has(file)) return cache.get(file);
      loaded.push(file);
      const mod = { exports: {} };
      cache.set(file, mod.exports);
      const code = await compile(file);
      const local = new Map();
      for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
        if (id in stubs || local.has(id)) continue;
        const target0 = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolvePath(dirname(file), id) : null;
        if (!target0) continue;
        const target = target0.endsWith(".js") ? target0 : (await exists(`${target0}.js`)) ? `${target0}.js` : join(target0, "index.js");
        local.set(id, isJsxFile(target) ? await load(target) : await import(pathToFileURL(target).href));
      }
      new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
      cache.set(file, mod.exports);
      return mod.exports;
    }
    load.loaded = loaded;
    return load;
  }

  // the hook driver (as in test-media-picker)
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
        if (typeof ty === "function") {
          const key = `${path}/${ty.name}`;
          if (!slots.has(key)) slots.set(key, {});
          cur = slots.get(key);
          cursor = 0;
          return visit(ty(n.props), key);
        }
        nodes.push(n);
        const name = typeof ty === "string" ? ty : ty?.displayName || "x";
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
  const nameOf = (n) => n.props["aria-label"] || textOf(n.props.children).trim();

  // fetch, answered from a table: "METHOD url" -> { status, body } or a function of the body
  function mockFetch(table) {
    const log = [];
    const inflight = new Set();
    const fetch = (url, init = {}) => {
      const p = answer(url, init);
      inflight.add(p);
      p.finally(() => inflight.delete(p)).catch(() => {});
      return p;
    };
    const answer = async (url, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      const body = init.body ? JSON.parse(init.body) : undefined;
      log.push({ method, url, body });
      // answer a little later, as a network does, so the page draws while a request is out
      await new Promise((r) => setTimeout(r, 2));
      let a = table[`${method} ${url}`];
      if (typeof a === "function") a = a(body, log);
      if (Array.isArray(a)) a = a.length > 1 ? a.shift() : a[0];
      if (!a) a = { status: 404, body: { error: "not here" } };
      if (a.network) throw new TypeError("fetch failed");
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    };
    return { fetch, log, inflight, posts: () => log.filter((l) => l.method === "POST") };
  }

  let pickerProps = null;
  const stubs = (d) => ({
    react: d.react,
    "next/link": { __esModule: true, default: function Link({ href, className, children }) { return React.createElement("a", { href, className }, children); } },
    "@/components/admin/shared/MediaPicker": {
      MediaPicker: function MediaPicker(p) {
        pickerProps = p;
        return null;
      },
    },
  });
  async function mount(file, props, table, { exportName = "default", extraStubs = {} } = {}) {
    const d = driver();
    const load = world({ ...stubs(d), ...extraStubs });
    const mod = await load(join(ROOT, file));
    const C = exportName === "default" ? mod.default : mod[exportName];
    ok(typeof C === "function", `${file} has no ${exportName}`);
    const net = mockFetch(table);
    const realFetch = globalThis.fetch;
    let nodes = [];
    const draw = () => {
      globalThis.fetch = net.fetch;
      nodes = d.render(React.createElement(C, props));
      return nodes;
    };
    const flush = async () => {
      globalThis.fetch = net.fetch;
      try {
        for (let round = 0; round < 60; round++) {
          d.takeDirty();
          draw();
          for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
          if (net.inflight.size) {
            await Promise.allSettled([...net.inflight]);
            for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
            continue;
          }
          if (!d.takeDirty()) {
            draw();
            for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
            if (!d.takeDirty() && !net.inflight.size) return nodes;
          }
        }
        throw new Error("the component never settled");
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    await flush();
    const v = {
      net,
      flush,
      nodes: () => nodes,
      all: () => nodes.filter((n) => typeof n.type === "string").map((n) => (["p", "a", "button", "legend", "label", "h2", "span"].includes(n.type) ? textOf(n.props.children) : "")).join(" ").replace(/\s+/g, " "),
      stateOf: (attr) => nodes.find((n) => n.props && attr in n.props)?.props[attr],
      buttons: () => nodes.filter((n) => n.type === "button").map(nameOf),
      links: () => nodes.filter((n) => n.type === "a").map((n) => [textOf(n.props.children).trim(), n.props.href]),
      button(name) {
        const b = nodes.find((n) => n.type === "button" && nameOf(n) === name);
        ok(b, `no button "${name}"; buttons: ${v.buttons().join(" | ")}`);
        return b;
      },
      async click(name) {
        const b = v.button(name);
        ok(!b.props.disabled, `button "${name}" is disabled`);
        globalThis.fetch = net.fetch;
        try {
          await b.props.onClick?.({ preventDefault() {} });
        } finally {
          globalThis.fetch = realFetch;
        }
        await flush();
      },
      input: (pred) => nodes.find((n) => n.type === "input" && pred(n.props)),
      async change(pred, value) {
        const el = v.input(pred);
        ok(el, "no such field");
        ok(!el.props.disabled, "the field is disabled");
        el.props.onChange({ target: { value, checked: true } });
        await flush();
      },
    };
    return v;
  }

  const ok200 = (body) => ({ status: 200, body });
  const syncView = (state, over = {}) => ({
    state,
    firstSync: over.firstSync ?? state !== "complete",
    linked: true,
    products: { done: 12, total: 40 },
    collections: { done: 0 },
    headline: { running: "Bringing in your products from Shopify", failed: "Your products didn't finish coming in", complete: "Your products are in", none: "Your products aren't in yet", stalled: "It stopped partway" }[state],
    detail: null,
    message: state === "failed" ? "Shopify didn't answer. Try again." : null,
    canRetry: state === "failed" || state === "stalled",
    canStart: state === "none" || state === "complete",
    ...over,
  });
  const SUMMARY = { heroImage: { productTitle: "Lavender Soy Candle" }, collections: ["Candles", "Gifts"], rails: ["Candles", "Gift Sets"], paletteId: "slate" };
  const generated = (over = {}) => ({ eligible: false, reason: null, generated: true, byGenerator: ["doc_home", "doc_design"], kept: [], empty: false, noCollections: false, summary: SUMMARY, ...over });
  const firstRunGet = (firstRun, sync) => ({ "GET /api/admin/first-run": ok200({ ok: true, firstRun, sync }) });
  const BRAND_GET = (over = {}) =>
    ok200({
      ok: true,
      brandStep: null,
      palettes: Pal.PALETTES.map((p) => ({ id: p.id, label: p.label, brand: { ...p.brand } })),
      current: { paletteId: "slate", logo: null, description: "Old tagline" },
      design: { id: "doc_design", revision: 1 },
      storeOpen: false,
      canEditDescription: true,
      descriptionMax: 160,
      ...over,
    });
  const brandTable = (over = {}) => ({ "GET /api/admin/brand-step": BRAND_GET(over) });
  const FR = "components/admin/first-run/FirstRun.js";
  const BSF = "components/admin/first-run/BrandStep.js";
  const POLL = 600_000; // never fires inside a test unless asked
  const states = {}; // state -> rendered text, for the banned-copy scan
  const noBanned = (label, text) => {
    const hits = scanText(text, { claims: false });
    eq(hits, [], `${label}: banned copy`);
    ok(!/\bpnpm\b|\bmigrat|\bnpm\b|sync script|node scripts|--hosted|\bCLI\b/i.test(text), `${label}: a developer word in ${text}`);
  };

  console.log("— P6-START-UI: FirstRun, rendered");

  await t("RENDERED: generated store (GET): the ready view names the product photo, the collection rows and the palette from the server's summary, says nothing is public yet, and links to the editor and the brand step", async () => {
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(generated(), syncView("complete", { firstSync: false })), ...brandTable() });
    eq(v.stateOf("data-first-run"), "ready", "state:");
    const text = v.all();
    ok(text.includes("A home page with your store name, a photo of Lavender Soy Candle, rows for Candles and Gift Sets, a grid of your collections, a row of your newest products, and the Slate colours."), text);
    ok(text.includes("Nothing is public yet."), "closed line");
    ok(v.links().some(([l, h]) => l === "Edit the home page" && h === "/admin/editor?doc=doc_home"), JSON.stringify(v.links()));
    ok(v.links().some(([l, h]) => l === "Change colours and logo" && h === "#brand"), JSON.stringify(v.links()));
    eq(v.net.posts(), [], "no POST on a generated store:");
    ok(!text.includes("We kept"), "nothing kept");
    states.ready = text;
    // the words come from the summary, not fixed text
    const w = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(generated({ summary: { heroImage: { productTitle: "Brass Lamp" }, collections: [], rails: ["Lamps"], paletteId: "forest" } }), syncView("complete", { firstSync: false })), ...brandTable() });
    ok(w.all().includes("A home page with your store name, a photo of Brass Lamp, a row for Lamps, a row of your newest products, and the Forest colours."), w.all());
    ok(!w.all().includes("Lavender") && !w.all().includes("Slate colours"), "no words of another store");
  });

  await t("RENDERED: a generated store whose latest sync is RUNNING still shows the ready view, with a small sync note (SyncProgress's body) and no second progress UI", async () => {
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(generated({ reason: "catalog_not_confirmed" }), syncView("running", { firstSync: false })), ...brandTable() });
    eq(v.stateOf("data-first-run"), "ready", "state:");
    ok(v.stateOf("data-first-run-note") === "sync", "the sync note");
    ok(v.all().includes("Bringing in your products from Shopify"), v.all());
    eq(v.nodes().filter((n) => n.props?.role === "progressbar").length, 1, "one progress bar:");
    ok(v.all().includes("Lavender Soy Candle"), "the ready copy stays");
    eq(v.net.posts(), [], "no POST:");
    states.readySyncing = v.all();
    // and a failed later sync: the ready view with SyncProgress's own retry
    const f = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(generated({ reason: "catalog_not_confirmed" }), syncView("failed", { firstSync: false })), ...brandTable(), "POST /api/admin/sync": ok200({ ok: true, sync: syncView("running", { firstSync: false }) }) });
    eq(f.stateOf("data-first-run"), "ready", "failed sync, still ready:");
    await f.click("Try again");
    eq(f.net.posts().map((p) => [p.url, p.body]), [["/api/admin/sync", { retry: true }]], "the retry is the sync's own:");
  });

  await t("RENDERED: a skipped founder doc_home shows the 'kept' line (POST answer and GET), and founder_started shows the kept view with its links", async () => {
    // GET: the founder's home and the generator's design
    const g = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet({ eligible: false, reason: "founder_started", generated: true, byGenerator: [], kept: ["doc_home"], empty: false, noCollections: false, summary: null }, syncView("complete", { firstSync: false })), ...brandTable() });
    eq(g.stateOf("data-first-run"), "kept", "state:");
    ok(g.all().includes("We kept the home page you already started."), g.all());
    ok(g.links().some(([l]) => l === "Edit the home page") && g.links().some(([l]) => l === "Change colours and logo"), JSON.stringify(g.links()));
    eq(g.net.posts(), [], "no POST:");
    states.kept = g.all();
    // a POST whose writer skipped the founder's home (made in the meantime)
    const p = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, {
      ...firstRunGet({ eligible: true, reason: null, generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null }, syncView("complete", { firstSync: false })),
      "POST /api/admin/first-run": ok200({ ok: true, ran: true, generated: true, created: ["doc_design"], refilled: [], unchanged: [], skipped: [{ id: "doc_home", reason: "founder" }], products: 3, collections: 2, summary: SUMMARY }),
      ...brandTable(),
    });
    ok(p.all().includes("We kept the home page you already started."), p.all());
    ok(!p.all().includes("Lavender"), "no 'made' words for a home that wasn't made");
    // the writer kept the founder's design but made the home
    const q = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, {
      ...firstRunGet({ eligible: true, reason: null, generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null }, syncView("complete", { firstSync: false })),
      "POST /api/admin/first-run": ok200({ ok: true, ran: true, generated: true, created: ["doc_home"], refilled: [], unchanged: [], skipped: [{ id: "doc_design", reason: "founder" }], products: 3, collections: 2, summary: { ...SUMMARY, paletteId: null } }),
      ...brandTable(),
    });
    eq(q.stateOf("data-first-run"), "ready", "ready:");
    ok(q.all().includes("We kept the colours you already chose.") && q.all().includes("a photo of Lavender Soy Candle"), q.all());
  });

  await t("RENDERED: syncing (first sync running) shows SyncProgress and makes nothing; sync failed shows its own retry", async () => {
    const notYet = { eligible: false, reason: "catalog_not_confirmed", generated: false, byGenerator: [], kept: [], empty: true, noCollections: true, summary: null };
    const s = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(notYet, syncView("running")), ...brandTable() });
    eq(s.stateOf("data-first-run"), "syncing", "state:");
    ok(s.all().includes("Bringing in your products from Shopify") && s.all().includes("Your starting store is made as soon as your products are in."), s.all());
    eq(s.net.posts(), [], "no POST while syncing:");
    states.syncing = s.all();
    const f = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(notYet, syncView("failed")), ...brandTable(), "POST /api/admin/sync": ok200({ ok: true, sync: syncView("running") }) });
    eq(f.stateOf("data-first-run"), "sync-failed", "state:");
    ok(f.all().includes("Shopify didn't answer."), f.all());
    states.syncFailed = f.all();
    await f.click("Try again");
    eq(f.net.posts().map((p) => [p.url, p.body]), [["/api/admin/sync", { retry: true }]], "SyncProgress's retry:");
    ok(f.all().includes("Bringing in your products from Shopify"), "running again");
    // a role that can't run a sync sees no retry
    const r = await mount(FR, { canEdit: false, canSync: false, pollMs: POLL }, { ...firstRunGet(notYet, syncView("failed")), ...brandTable() });
    ok(!r.buttons().includes("Try again"), r.buttons().join("|"));
  });

  await t("RENDERED (US-01): when the sync finishes, the page reads the first run again and makes the store with ONE POST, then shows the ready view", async () => {
    const notYet = { eligible: false, reason: "catalog_not_confirmed", generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null };
    const eligible = { ...notYet, eligible: true, reason: null };
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: 40 }, {
      "GET /api/admin/first-run": [ok200({ ok: true, firstRun: notYet, sync: syncView("running") }), ok200({ ok: true, firstRun: eligible, sync: syncView("complete", { firstSync: false }) })],
      "GET /api/admin/sync": ok200({ ok: true, sync: syncView("complete", { firstSync: false }) }),
      "POST /api/admin/first-run": ok200({ ok: true, ran: true, generated: true, created: ["doc_home", "doc_design"], refilled: [], unchanged: [], skipped: [], products: 3, collections: 2, summary: SUMMARY }),
      ...brandTable(),
    });
    eq(v.stateOf("data-first-run"), "syncing", "first:");
    // the poll timer (5 ms here) fires outside a draw: answer it with the mock too
    const real = globalThis.fetch;
    try {
      for (let i = 0; i < 20 && v.stateOf("data-first-run") !== "ready"; i++) {
        globalThis.fetch = v.net.fetch;
        await new Promise((r) => setTimeout(r, 15));
        await v.flush();
      }
    } finally {
      globalThis.fetch = real;
    }
    ok(v.net.log.some((l) => l.url === "/api/admin/sync" && l.method === "GET"), "SyncProgress's readSync polled");
    eq(v.stateOf("data-first-run"), "ready", `then: ${v.all()}`);
    eq(v.net.posts().map((p) => p.url), ["/api/admin/first-run"], "one POST:");
    ok(v.all().includes("a photo of Lavender Soy Candle"), v.all());
  });

  await t("RENDERED: eligible and not made: ONE POST, then the ready view from the POST's summary; a failed POST says so with a retry that posts again", async () => {
    const eligible = { eligible: true, reason: null, generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null };
    const made = ok200({ ok: true, ran: true, generated: true, created: ["doc_home", "doc_design"], refilled: [], unchanged: [], skipped: [], products: 3, collections: 2, summary: SUMMARY });
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(eligible, syncView("complete", { firstSync: false })), "POST /api/admin/first-run": made, ...brandTable() });
    eq(v.net.posts().map((p) => [p.url, p.body]), [["/api/admin/first-run", {}]], "one POST:");
    eq(v.stateOf("data-first-run"), "ready", "ready:");
    ok(v.all().includes("rows for Candles and Gift Sets"), v.all());
    await v.flush();
    eq(v.net.posts().length, 1, "still one POST after more draws:");
    // the POST fails (a 500, then a network failure), then works
    const f = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, {
      ...firstRunGet(eligible, syncView("complete", { firstSync: false })),
      "POST /api/admin/first-run": [{ status: 500, body: { ok: false, error: "We couldn't make your starting store just now. Nothing was saved. Try again." } }, { network: true }, made],
      ...brandTable(),
    });
    eq(f.stateOf("data-first-run"), "make-failed", "failed:");
    ok(f.all().includes("We couldn't make your starting store. Try again."), f.all());
    eq(f.net.posts().length, 1, "no retry by itself:");
    states.makeFailed = f.all();
    await f.click("Try again");
    eq(f.stateOf("data-first-run"), "make-failed", "the network failure too:");
    await f.click("Try again");
    eq(f.stateOf("data-first-run"), "ready", "then ready:");
    eq(f.net.posts().length, 3, "one POST per click:");
    // a race answer (200, ran:false, reason race) is a failure with a retry too
    const r = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(eligible, syncView("complete", { firstSync: false })), "POST /api/admin/first-run": ok200({ ok: true, ran: false, generated: false, reason: "race", message: "x" }), ...brandTable() });
    eq(r.stateOf("data-first-run"), "make-failed", "race:");
    // the store changed (founder_started): read again, never POST again
    const c = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, {
      "GET /api/admin/first-run": [ok200({ ok: true, firstRun: eligible, sync: syncView("complete", { firstSync: false }) }), ok200({ ok: true, firstRun: { ...eligible, eligible: false, reason: "founder_started", generated: true, kept: ["doc_home"] }, sync: syncView("complete", { firstSync: false }) })],
      "POST /api/admin/first-run": ok200({ ok: true, ran: false, generated: false, reason: "founder_started", message: "x" }),
      ...brandTable(),
    });
    eq(c.stateOf("data-first-run"), "kept", "re-read:");
    eq(c.net.posts().length, 1, "one POST:");
    // a re-read that still says "can be made" never POSTs by itself again: it offers the retry
    const s = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, {
      ...firstRunGet(eligible, syncView("complete", { firstSync: false })),
      "POST /api/admin/first-run": ok200({ ok: true, ran: false, generated: false, reason: "catalog_not_confirmed", message: "x" }),
      ...brandTable(),
    });
    eq(s.net.posts().length, 1, "one POST after a stale re-read:");
    eq(s.stateOf("data-first-run"), "make-failed", "the retry is offered:");
    ok(s.buttons().includes("Try again"), s.buttons().join("|"));
  });

  await t("RENDERED (P6-FIX3): a half-finished first run (the POST's ran:false with homeWritten) says the home page was made and the colours were not, with Try again where it helps, never 'We couldn't make your starting store'", async () => {
    const eligible = { eligible: true, reason: null, generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null };
    // the route's real half-finished shape (scripts/test-first-run.js pins it)
    const half = (reason, message) => ok200({ ok: true, ran: false, generated: true, homeWritten: true, reason, message });
    const RACE = "Your home page was made, but your colours were not, because your store changed at the same time. Try again.";
    const made = ok200({ ok: true, ran: true, generated: true, created: ["doc_design"], refilled: [], unchanged: ["doc_home"], skipped: [], products: 3, collections: 2, summary: SUMMARY });
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(eligible, syncView("complete", { firstSync: false })), "POST /api/admin/first-run": [half("race", RACE), made], ...brandTable() });
    eq(v.stateOf("data-first-run"), "half", `state: ${v.all()}`);
    const text = v.all();
    ok(text.includes(RACE), `the half-finished words: ${text}`);
    ok(/home page was made/.test(text) && /colours were not/.test(text), text);
    ok(!text.includes("We couldn't make your starting store") && !/nothing was saved/i.test(text), `false words: ${text}`);
    ok(v.buttons().includes("Try again"), v.buttons().join("|"));
    ok(v.links().some(([l, h]) => l === "Edit the home page" && h === "/admin/editor?doc=doc_home"), `the made home is linked: ${JSON.stringify(v.links())}`);
    eq(v.net.posts().length, 1, "no retry by itself:");
    states.half = text;
    await v.click("Try again");
    eq(v.net.posts().length, 2, "Try again posts once more:");
    eq(v.stateOf("data-first-run"), "ready", "then ready:");
    // every reason has its own words; only the ones a retry can help get Try again
    for (const [reason, retry, editLink] of [["migrating", true, true], ["catalog_not_confirmed", true, true], ["live", false, true], ["legacy", false, false], ["something_new", true, true]]) {
      const w = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(eligible, syncView("complete", { firstSync: false })), "POST /api/admin/first-run": half(reason, "x"), ...brandTable() });
      eq(w.stateOf("data-first-run"), "half", `${reason}, state:`);
      ok(w.all().includes("Your home page was made, but your colours were not"), `${reason}: ${w.all()}`);
      ok(!w.all().includes("We couldn't make your starting store"), `${reason}: false words`);
      eq(w.buttons().includes("Try again"), retry, `${reason}, Try again:`);
      eq(w.links().some(([l]) => l === "Edit the home page"), editLink, `${reason}, the edit link:`);
      noBanned(`half ${reason}`, w.all());
    }
    // the live words say the shoppers' store hasn't changed
    const lv = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(eligible, syncView("complete", { firstSync: false })), "POST /api/admin/first-run": half("live", "x"), ...brandTable() });
    ok(lv.all().includes("because your store opened at the same time. Your live store hasn't changed."), lv.all());
    // a race that wrote nothing (no homeWritten) still fails with today's words
    const r = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(eligible, syncView("complete", { firstSync: false })), "POST /api/admin/first-run": ok200({ ok: true, ran: false, generated: false, reason: "race", message: "x" }), ...brandTable() });
    eq(r.stateOf("data-first-run"), "make-failed", "a race with nothing written:");
  });

  await t("RENDERED (US-04): an empty catalog says 'Add products in Shopify', has SyncProgress's start button and the conditional refill note", async () => {
    const empty = generated({ empty: true, noCollections: true, summary: { heroImage: null, collections: [], rails: [], paletteId: "slate" } });
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(empty, syncView("complete", { firstSync: false })), ...brandTable(), "POST /api/admin/sync": ok200({ ok: true, sync: syncView("running", { firstSync: false }) }) });
    eq(v.stateOf("data-first-run-note"), "empty", "note:");
    const text = v.all();
    ok(text.includes("Your Shopify store has no products yet. Add products in Shopify, then sync again."), text);
    ok(text.includes("If you haven't changed your home page, product rows appear after your next sync. Otherwise add them in the editor."), text);
    ok(text.includes("A home page with your store name and the Slate colours."), `no product words on an empty store: ${text}`);
    ok(!text.includes("collections in Shopify yet"), "not the no-collections words");
    ok(v.buttons().includes("Refresh from Shopify"), v.buttons().join("|"));
    states.empty = text;
    await v.click("Refresh from Shopify");
    eq(v.net.posts().map((p) => [p.url, p.body]), [["/api/admin/sync", {}]], "the sync's own start:");
  });

  await t("RENDERED (US-04): products but no collections explains collections, and shows no empty-catalog words", async () => {
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(generated({ noCollections: true, summary: { heroImage: { productTitle: "Tea Mug" }, collections: [], rails: [], paletteId: "slate" } }), syncView("complete", { firstSync: false })), ...brandTable() });
    eq(v.stateOf("data-first-run-note"), "no-collections", "note:");
    ok(v.all().includes("Your products have no collections in Shopify yet, so your home page shows your newest products. Add collections in Shopify to get collection rows."), v.all());
    ok(!v.all().includes("no products yet"), "not empty");
    states.noCollections = v.all();
  });

  await t("RENDERED: a read-only actor on an eligible store makes NO POST and is told why; an open store says so instead of 'Nothing is public yet.'", async () => {
    const eligibleRO = { eligible: false, reason: "cannot_edit", generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null };
    const v = await mount(FR, { canEdit: false, canSync: false, pollMs: POLL }, { ...firstRunGet(eligibleRO, syncView("complete", { firstSync: false })), ...brandTable({ canEditDescription: false }) });
    eq(v.net.posts(), [], "no POST:");
    ok(v.all().includes("Only someone who can edit this store can make its starting pages."), v.all());
    states.readOnly = v.all();
    // even if the GET said eligible (it never does for this role), canEdit false never POSTs
    const w = await mount(FR, { canEdit: false, canSync: false, pollMs: POLL }, { ...firstRunGet({ ...eligibleRO, eligible: true, reason: null }, syncView("complete", { firstSync: false })), ...brandTable() });
    eq(w.net.posts(), [], "no POST:");
    const o = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(generated({ reason: "live" }), syncView("complete", { firstSync: false })), ...brandTable({ storeOpen: true }) });
    ok(!o.all().includes("Nothing is public yet.") && o.all().includes("Your store is open."), o.all());
  });

  await t("RENDERED: an OPEN store (generated:false, reason live, the server's real shape) shows the 'already open' view with both links while a later sync runs and after it failed or stalled, never the 'made as soon as your products are in' words", async () => {
    // describeFirstStore stops at the live check before reading rows
    const open = { eligible: false, reason: "live", generated: false, byGenerator: [], kept: [], empty: false, noCollections: false, summary: null };
    const already = "Your store is already open, so the starting store wasn't made again. Your live store hasn't changed.";
    for (const st of ["running", "retrying", "failed", "stalled", "complete"]) {
      const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { ...firstRunGet(open, syncView(st, { firstSync: false })), ...brandTable({ storeOpen: true }), "POST /api/admin/sync": ok200({ ok: true, sync: syncView("running", { firstSync: false }) }) });
      eq(v.stateOf("data-first-run"), "blocked", `${st}, state:`);
      ok(v.all().includes(already), `${st}: ${v.all()}`);
      ok(!v.all().includes("Your starting store is made as soon as your products are in."), `${st}: no waiting words`);
      ok(v.links().some(([l]) => l === "Edit the home page") && v.links().some(([l]) => l === "Change colours and logo"), `${st}: ${JSON.stringify(v.links())}`);
      eq(v.net.posts(), [], `${st}, no POST:`);
      if (st === "complete") ok(v.stateOf("data-first-run-note") !== "sync", "no sync note once complete");
      else ok(v.stateOf("data-first-run-note") === "sync", `${st}: the small sync note`);
      if (st === "failed") {
        await v.click("Try again");
        eq(v.net.posts().map((p) => [p.url, p.body]), [["/api/admin/sync", { retry: true }]], "the retry is the sync's own:");
        eq(v.stateOf("data-first-run"), "blocked", "still the open view:");
      }
    }
  });

  await t("RENDERED: a GET that fails says so in plain words", async () => {
    const v = await mount(FR, { canEdit: true, canSync: true, pollMs: POLL }, { "GET /api/admin/first-run": { status: 503, body: { ok: false, error: "x", code: "DB_UNAVAILABLE" } }, ...brandTable() });
    eq(v.stateOf("data-first-run"), "load-failed", "state:");
    ok(v.all().includes("We couldn't load your starting store just now."), v.all());
    ok(!/DB_UNAVAILABLE|503/.test(v.all()), "no code");
    states.loadFailed = v.all();
  });

  await t("RENDERED: banned-copy scanText finds no BANNED string (pnpm, migrate, a sync command) on any state", async () => {
    ok(BANNED.length > 10, "the rules loaded");
    const want = ["ready", "readySyncing", "kept", "syncing", "syncFailed", "makeFailed", "half", "empty", "noCollections", "readOnly", "loadFailed"];
    for (const k of want) {
      ok(typeof states[k] === "string" && states[k].length > 20, `state ${k} was not rendered`);
      noBanned(k, states[k]);
    }
    // the scan itself catches a developer word
    ok(scanText("Run pnpm sync to bring products in", { claims: false }).length > 0, "the scan works");
  });

  console.log("— P6-START-UI: BrandStep, rendered");

  await t("RENDERED: BrandStep lists the 6 palettes with labels and swatches drawn from brandCssVars, preselects slate, and shows the alt hint and the closed-store line", async () => {
    const v = await mount(BSF, { canEdit: true }, { ...brandTable({ current: { paletteId: "slate", logo: { media: "/api/media/med_logo1" }, description: "Old tagline" } }) });
    const radios = v.nodes().filter((n) => n.type === "input" && n.props.name === "palette");
    eq(radios.map((r) => r.props.value), Pal.PALETTES.map((p) => p.id), "palettes:");
    eq(radios.filter((r) => r.props.checked).map((r) => r.props.value), ["slate"], "preselected:");
    for (const p of Pal.PALETTES) ok(v.all().includes(p.label), `label ${p.label}`);
    const swatches = v.nodes().filter((n) => n.type === "span" && n.props.style && n.props.style["--accent-500"]);
    eq(swatches.length, 6, "six swatches:");
    const forestSw = swatches.find((s) => s.props.style["--background"] === Pal.paletteById("forest").brand.background && s.props.style["--accent-500"] === Pal.paletteById("forest").brand.accent);
    ok(forestSw, "forest's swatch draws its own variables");
    const vars = B.brandCssVars(Pal.paletteById("navy").brand, { kit: "pulse-1" });
    ok(vars.includes(`--accent-500:${swatches[2].props.style["--accent-500"]};`) && vars.includes(`--sf-text:${swatches[2].props.style["--sf-text"]};`), "navy's swatch is brandCssVars");
    ok(v.all().includes("If empty, your store name is used."), "alt hint");
    ok(v.all().includes("Nothing shows to shoppers until you open your store."), "closed line");
    ok(!v.all().includes("Your description shows now"), "no live-now line while closed");
    const desc = v.input((p) => p.id === "brand-description");
    eq([desc.props.value, desc.props.maxLength, Boolean(desc.props.disabled)], ["Old tagline", 160, false], "description:");
    noBanned("brand step", v.all());
  });

  await t("RENDERED: Save with no change is one click and posts {paletteId, logo, description, revision}; after it the preview link and 'Review and open your store'", async () => {
    const table = { ...brandTable(), "POST /api/admin/brand-step": ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 2 }, liveNow: [], afterPublish: [], storeOpen: false, brandStep: { paletteId: "slate" } }) };
    const v = await mount(BSF, { canEdit: true }, table);
    await v.click("Save");
    eq(v.net.posts().map((p) => p.body), [{ paletteId: "slate", logo: null, description: "Old tagline", revision: 1 }], "body:");
    ok(v.links().some(([l, h]) => l === "See it in the preview" && h === "/admin/editor"), JSON.stringify(v.links()));
    ok(v.links().some(([l, h]) => l === "Review and open your store" && h === "/admin/editor?doc=doc_home"), JSON.stringify(v.links()));
    noBanned("saved", v.all());
  });

  await t("RENDERED: choosing a palette, a library logo with an alt and a new description posts them; Remove logo then Save posts logo:null; Skip posts {skip:true}", async () => {
    const answer = ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 2 }, liveNow: ["description"], afterPublish: ["colours", "logo"], storeOpen: false, brandStep: { paletteId: "forest" } });
    const v = await mount(BSF, { canEdit: true }, { ...brandTable(), "POST /api/admin/brand-step": (body) => (body.skip ? ok200({ ok: true, skipped: true, design: null, liveNow: [], afterPublish: [], storeOpen: false, brandStep: { skipped: true } }) : answer) });
    await v.change((p) => p.name === "palette" && p.value === "forest", "forest");
    await v.click("Choose a logo");
    ok(pickerProps?.open === true, "the library picker opened");
    pickerProps.onSelect({ url: "/api/media/med_abc123", alt: "", id: "med_abc123" });
    await v.flush();
    await v.change((p) => p.id === "brand-logo-alt", "Candle Co logo");
    await v.change((p) => p.id === "brand-description", "Hand-poured candles");
    await v.click("Save");
    eq(v.net.posts().at(-1).body, { paletteId: "forest", logo: { media: "/api/media/med_abc123", alt: "Candle Co logo" }, description: "Hand-poured candles", revision: 1 }, "save body:");
    ok(v.all().includes("Your colours and logo are saved. They show after you publish."), v.all());
    ok(v.all().includes("Your description is saved. Shoppers see it once you open your store."), v.all());
    // an empty alt is left out (the store name is used)
    await v.change((p) => p.id === "brand-logo-alt", "");
    await v.click("Save");
    eq(v.net.posts().at(-1).body.logo, { media: "/api/media/med_abc123" }, "empty alt:");
    eq(v.net.posts().at(-1).body.revision, 2, "the revision the save answered:");
    await v.click("Remove logo");
    ok(v.all().includes("No logo yet."), "removed from the form");
    await v.click("Save");
    eq(v.net.posts().at(-1).body.logo, null, "Remove logo:");
    await v.click("Skip for now");
    eq(v.net.posts().at(-1).body, { skip: true }, "Skip:");
    ok(v.all().includes("Skipped."), v.all());
    // a picked file that isn't a library address is never sent
    await v.click("Choose a logo");
    pickerProps.onSelect({ url: "https://elsewhere.example/x.png", alt: "" });
    await v.flush();
    ok(v.all().includes("Choose a picture from your library for the logo."), v.all());
    ok(v.buttons().includes("Choose a logo"), "no logo taken");
  });

  await t("RENDERED: 'Your description shows now' shows only when storeOpen, with a link to the editor's publish", async () => {
    const closed = await mount(BSF, { canEdit: true }, brandTable({ storeOpen: false }));
    ok(!closed.all().includes("Your description shows now."), closed.all());
    const open = await mount(BSF, { canEdit: true }, { ...brandTable({ storeOpen: true }), "POST /api/admin/brand-step": ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 2 }, liveNow: ["description"], afterPublish: ["colours"], storeOpen: true, brandStep: {} }) });
    ok(open.all().includes("Your description shows now. Colours and logo show after you publish."), open.all());
    ok(!open.all().includes("Nothing shows to shoppers"), "not the closed line");
    ok(open.links().some(([l, h]) => l === "Publish in the editor" && h === "/admin/editor?doc=doc_home"), JSON.stringify(open.links()));
    await open.change((p) => p.id === "brand-description", "New words");
    await open.click("Save");
    ok(open.all().includes("Your description shows now.") && open.links().some(([l]) => l === "Review and publish"), open.all());
  });

  await t("RENDERED: a role that can't change the description sees it disabled with a plain note and never sends it", async () => {
    const v = await mount(BSF, { canEdit: true }, { ...brandTable({ canEditDescription: false }), "POST /api/admin/brand-step": ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 2 }, liveNow: [], afterPublish: [], storeOpen: false, brandStep: {} }) });
    ok(v.input((p) => p.id === "brand-description").props.disabled, "disabled");
    ok(v.all().includes("Only the store owner or an admin can change the store's description."), v.all());
    await v.click("Save");
    ok(!("description" in v.net.posts()[0].body), JSON.stringify(v.net.posts()[0].body));
  });

  await t("RENDERED: a read-only actor sees the step with no Save or Skip button, nothing to choose, and makes no POST", async () => {
    const v = await mount(BSF, { canEdit: false }, brandTable({ canEditDescription: false }));
    ok(!v.buttons().includes("Save") && !v.buttons().includes("Skip for now") && !v.buttons().includes("Choose a logo"), v.buttons().join("|"));
    ok(v.nodes().filter((n) => n.type === "input" && n.props.name === "palette").every((r) => r.props.disabled), "palettes disabled");
    ok(v.all().includes("Your role can look at this page but not change it."), v.all());
    eq(v.net.posts(), [], "no POST:");
    // and on the whole page
    const page = await mount(FR, { canEdit: false, canSync: false, pollMs: POLL }, { ...firstRunGet(generated(), syncView("complete", { firstSync: false })), ...brandTable({ canEditDescription: false }) });
    ok(!page.buttons().includes("Save"), page.buttons().join("|"));
    eq(page.net.posts(), [], "no POST on the page:");
  });

  await t("UNIT: a partial brand step (503 BRAND_STEP_PARTIAL) is retried with the 503's design.revision, and a retry that changed nothing still says the colours show after Publish", async () => {
    const posts = [];
    const v = await mount(BSF, { canEdit: true }, {
      ...brandTable(),
      "POST /api/admin/brand-step": [
        { status: 503, body: { error: "Your colours and logo were saved, but this step wasn't marked as done. Try saving again.", code: "BRAND_STEP_PARTIAL", design: { id: "doc_design", revision: 7 }, retryable: true } },
        ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 7 }, liveNow: [], afterPublish: [], storeOpen: false, brandStep: { paletteId: "clay" } }),
      ],
    });
    await v.change((p) => p.name === "palette" && p.value === "clay", "clay");
    await v.click("Save");
    ok(v.all().includes("Your colours and logo were saved, but this step wasn't marked as done."), v.all());
    await v.click("Save");
    for (const p of v.net.posts()) posts.push(p.body.revision);
    eq(posts, [1, 7], "revisions sent:");
    ok(v.all().includes("Your colours and logo are saved. They show after you publish."), `after the retry: ${v.all()}`);
    // pure helpers
    const M = await world(stubs(driver()))(join(ROOT, BSF));
    eq(M.savedLines({ ok: true, liveNow: [], afterPublish: [] }, { carried: true }), ["Saved.", M.BRAND_WORDS.afterPublish], "carried:");
    eq(M.savedLines({ ok: true, liveNow: [], afterPublish: [] }), ["Saved."], "not carried:");
    eq(M.saveBody({ paletteId: "ink", logo: null, alt: "", description: "x", canEditDescription: true, revision: 7 }), { paletteId: "ink", logo: null, description: "x", revision: 7 }, "saveBody:");
  });

  await t("RENDERED: a stale revision (409 DOCUMENT_CHANGED) says so in plain words and takes the current revision for the next Save", async () => {
    const v = await mount(BSF, { canEdit: true }, {
      ...brandTable(),
      "POST /api/admin/brand-step": [{ status: 409, body: { error: "The design was changed somewhere else", code: "DOCUMENT_CHANGED", current: { revision: 4 } } }, ok200({ ok: true, skipped: false, design: { id: "doc_design", revision: 5 }, liveNow: [], afterPublish: ["colours"], storeOpen: false, brandStep: {} })],
    });
    await v.click("Save");
    ok(v.all().includes("changed somewhere else"), v.all());
    await v.click("Save");
    eq(v.net.posts().map((p) => p.body.revision), [1, 4], "revisions:");
  });

  console.log("— P6-START-UI: the page");

  const PAGE = join(ROOT, "app/(console)/admin/(authed)/start/page.js");
  async function renderPage({ actor, mode }) {
    const load = world({
      "next/navigation": { redirect: (to) => { throw Object.assign(new Error(`REDIRECT ${to}`), { redirectTo: to }); } },
      "@/lib/admin-auth": { adminActor: async () => actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
      "@/lib/cms-mode": { getCmsMode: async () => mode },
    });
    const mod = await load(PAGE);
    try {
      await mod.default({});
      return { redirect: null, loaded: load.loaded };
    } catch (e) {
      if (e.redirectTo) return { redirect: e.redirectTo, loaded: load.loaded };
      throw e;
    }
  }

  // Phase 1 line 3: "Start your store" is the onboarding page's Brand step
  // (FirstRun and BrandStep render there); /admin/start only redirects.
  await t("RENDERED (Phase 1 line 3): /admin/start redirects to /admin/onboarding?step=brand for every caller and every store mode (the onboarding page decides who sees what)", async () => {
    for (const actor of [null, { role: "owner" }, { role: "staff" }, { role: "support" }]) {
      for (const mode of ["legacy", "migrating", "documents"]) eq((await renderPage({ actor, mode })).redirect, "/admin/onboarding?step=brand", `${JSON.stringify(actor)} ${mode}:`);
    }
  });

  await t("the page reads nothing (a redirect only) and passes the legacy-routes literal-link walk; the client parts import no Node-only module", async () => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const page = await readFile(PAGE, "utf8");
    eq(strip(page).match(/from "[^"]+"/g), ['from "next/navigation"'], "its only import:");
    ok(!page.includes("@/lib/tenant-request"), "never the cached path");
    const LEGACY = /["'`](\/admin\/(?:catalog|home|upsells)(?:[/?#][^"'`$]*)?|\/admin\/storefront(?:[?#][^"'`$]*)?)["'`$]/;
    for (const f of [PAGE, join(ROOT, FR), join(ROOT, BSF)]) ok(!LEGACY.test(strip(await readFile(f, "utf8"))), `${f}: a literal link to an old screen`);
    for (const f of [FR, BSF]) {
      const src = await readFile(join(ROOT, f), "utf8");
      ok(src.startsWith('"use client";'), `${f} is a client part`);
      ok(!/from "(node:|@\/lib\/(db|first-run|documents|platform|admin\/settings))/.test(src), `${f} imports a server module`);
    }
    const E = await import("../lib/admin/editor-entry.js");
    const FRm = await world(stubs(driver()))(join(ROOT, FR));
    const BSm = await world(stubs(driver()))(join(ROOT, BSF));
    eq([FRm.EDIT_HOME_HREF, BSm.PUBLISH_HREF], [E.EDITOR_PUBLISH_HREF, E.EDITOR_PUBLISH_HREF], "the editor's publish address:");
    ok((await readdir(join(ROOT, "app/(console)/admin/(authed)/start"))).includes("page.js"), "the redirect page exists");
  });
}

try {
  // ======================================================================================
  console.log("— GEN-04: Save on a generated store");

  const A = await store("a");
  await members(A);
  const seeded = await seedSlate(A);
  const logo = await upload(A);
  const LOGO = { media: M.mediaUrl(logo.id), alt: "" };

  await t("the seeded store is the first-run writer's: a slate doc_design by system:first-run, closed, no release", async () => {
    eq(seeded.created, ["doc_design"], "created:");
    const row = await designRow(A);
    eq(row.updated_by, Docs.FIRST_RUN_BY, "updated_by:");
    eq(Pal.paletteIdOfBrand(JSON.parse(row.draft).settings.brand), "slate", "palette:");
    eq((await sql(A, "SELECT live_release_id FROM release_state WHERE id = 1"))[0].live_release_id, null, "closed:");
  });

  await t("GET on the generated slate store preselects slate, lists six palettes with labels, shows the tagline, no logo, closed", async () => {
    const r = await get(A);
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq(r.body.current.paletteId, "slate", "preselected:");
    eq(r.body.palettes.map((p) => [p.id, p.label]), Pal.PALETTES.map((p) => [p.id, p.label]), "palettes:");
    for (const p of r.body.palettes) eq(p.brand, { ...Pal.paletteById(p.id).brand }, `${p.id} brand:`);
    eq(r.body.current.logo, null, "logo:");
    eq(r.body.current.description, "Old tagline", "description:");
    eq(r.body.storeOpen, false, "storeOpen:");
    eq(r.body.canEditDescription, true, "the owner may change the description:");
    eq(r.body.design, { id: "doc_design", revision: 1 }, "design:");
    eq(r.body.brandStep, null, "no record yet:");
    eq(r.body.descriptionMax, 160, "max:");
  });

  let afterSave;
  await t("ACCEPTANCE: saving forest with a library logo gives a founder doc_design draft: brand = the forest palette, logo set, theme unchanged, updated_by the merchant, still closed, no release", async () => {
    const releasesBefore = (await sql(A, "SELECT COUNT(*) AS n FROM releases"))[0].n;
    const r = await post(A, { paletteId: "forest", logo: LOGO });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 400)}:`);
    const s = await designSettings(A);
    eq(s.brand, { ...forest.brand }, "brand:");
    eq(s.logo, LOGO, "logo:");
    eq(s.theme, { kit: "pulse", version: 1 }, "theme unchanged:");
    const row = await designRow(A);
    eq(row.updated_by, OWNER_BY, "updated_by:");
    eq(row.revision, 2, "revision:");
    eq(row.published_version_id, null, "not published:");
    eq((await sql(A, "SELECT live_release_id FROM release_state WHERE id = 1"))[0].live_release_id, null, "still closed:");
    eq((await sql(A, "SELECT COUNT(*) AS n FROM releases"))[0].n, releasesBefore, "no release written:");
    eq((await sql(A, "SELECT COUNT(*) AS n FROM publish_log"))[0].n, 0, "no publish:");
    eq(r.body.design, { id: "doc_design", revision: 2 }, "answer design:");
    eq(r.body.afterPublish, ["colours", "logo"], "after publish:");
    eq(r.body.liveNow, [], "nothing live now:");
    eq(r.body.storeOpen, false, "storeOpen:");
    eq(r.body.skipped, false, "skipped:");
    const step = (await configOf(A)).onboarding.brand_step;
    eq([step.skipped, step.paletteId, typeof step.at], [false, "forest", "string"], "brand_step:");
    eq(JSON.stringify(forest.brand), FOREST_FROZEN, "the frozen palette brand is not changed:");
    ok(Object.isFrozen(forest.brand), "still frozen:");
    // the library knows the draft uses the logo file (MED-03), so it can't be deleted unasked
    const uses = await inS(A, () => M.mediaUsage(logo.id));
    ok(uses.length > 0, `logo usage: ${JSON.stringify(uses)}`);
    afterSave = s;
  });

  await t("ACCEPTANCE: a following createFirstRunDocuments call with a slate design skips doc_design with reason 'founder', and forest stays", async () => {
    const r = await seedSlate(A);
    eq(r.skipped, [{ id: "doc_design", reason: "founder" }], "skipped:");
    eq(r.written, false, "nothing written:");
    eq(await designSettings(A), afterSave, "forest stays:");
  });

  await t("GET after the save preselects forest and shows the logo", async () => {
    const r = await get(A);
    eq([r.body.current.paletteId, r.body.current.logo, r.body.design.revision], ["forest", LOGO, 2], "current:");
    eq(r.body.brandStep.paletteId, "forest", "record:");
  });

  await t("saving the same palette and logo again writes no new revision (an open editor is not disturbed)", async () => {
    const r = await post(A, { paletteId: "forest", logo: LOGO });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq((await designRow(A)).revision, 2, "revision:");
    eq(r.body.afterPublish, [], "nothing new to publish:");
  });

  await t("ACCEPTANCE: logo:null removes an existing logo (Remove logo); a save that leaves logo out keeps it", async () => {
    const r = await post(A, { paletteId: "forest", logo: null });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq((await designSettings(A)).logo, null, "logo removed:");
    eq(r.body.afterPublish, ["logo"], "only the logo changed:");
    eq((await get(A)).body.current.logo, null, "GET shows no logo:");
    eq((await post(A, { paletteId: "forest", logo: LOGO })).status, 200, "put back:");
    const k = await post(A, { paletteId: "navy" });
    eq(k.status, 200);
    eq((await designSettings(A)).logo, LOGO, "left out = kept:");
    eq(k.body.afterPublish, ["colours"], "only colours changed:");
  });

  await t("Save with no change on a generated slate store (one click) still makes the design the founder's, so a later generation skips it", async () => {
    const K = await store("keep");
    await members(K);
    await seedSlate(K);
    const before = JSON.parse((await designRow(K)).draft).settings;
    const r = await post(K, { paletteId: "slate" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    const row = await designRow(K);
    eq([row.updated_by, row.revision], [OWNER_BY, 2], "taken over:");
    eq(JSON.parse(row.draft).settings, before, "content unchanged:");
    eq(r.body.afterPublish, [], "nothing new to publish:");
    eq((await seedSlate(K)).skipped, [{ id: "doc_design", reason: "founder" }], "the generator skips it:");
  });

  // ======================================================================================
  console.log("— the description (one merged control-plane write)");

  await t("ACCEPTANCE: the description writes config.site.tagline and brand_step in ONE config write, and an onboarding.manual check-off written just before survives", async () => {
    // the request's own tenant snapshot predates the check-off (written just
    // before the save): the save must merge into the LATEST config
    const stale = await C.getTenant(A.id, { fresh: true });
    await C.patchTenant(A.id, { config: { onboarding: { ...(stale.config.onboarding || {}), manual: { catalog: "2026-11-05T10:00:00.000Z" } } } });
    const spy = countTenantWrites();
    let r;
    try {
      r = await withTenant(stale, () => BS.saveBrandStep({ paletteId: "forest", description: "  Handmade candles from Pune  " }, { kind: "merchant", id: ownerU.id, role: "owner" }));
    } finally {
      spy.stop();
    }
    eq(spy.writes, 1, "control-plane writes:");
    const cfg = await configOf(A);
    eq(cfg.site.tagline, "Handmade candles from Pune", "tagline (trimmed by the Settings rule):");
    eq(cfg.site.name, SITE.name, "the rest of config.site kept:");
    eq(cfg.onboarding.manual, { catalog: "2026-11-05T10:00:00.000Z" }, "the check-off survives:");
    eq([cfg.onboarding.brand_step.paletteId, cfg.onboarding.brand_step.skipped], ["forest", false], "brand_step:");
    eq(r.liveNow, ["description"], "live now:");
    eq(cfg.site_url, `https://${A.id}.test`, "other config keys kept:");
  });

  await t("through the route: the answer names what is live now and what waits for Publish; an unchanged description is not rewritten", async () => {
    const r = await post(A, { paletteId: "clay", description: "A new line" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.liveNow, r.body.afterPublish], [["description"], ["colours"]], "lists:");
    eq((await configOf(A)).site.tagline, "A new line", "tagline:");
    const again = await post(A, { paletteId: "clay", description: "A new line" });
    eq(again.body.liveNow, [], "unchanged description is not live-now:");
  });

  await t("the description is one line of at most 160 characters: 161 is refused with nothing written; an existing longer tagline sent back unchanged is kept", async () => {
    const before = await dump(A);
    const r = await post(A, { paletteId: "clay", description: "x".repeat(161) });
    eq([r.status, r.body.code], [400, "DESCRIPTION_TOO_LONG"], `answer ${JSON.stringify(r.body)}:`);
    ok(/160 characters/.test(r.body.error) && /Nothing was saved/.test(r.body.error), r.body.error);
    await unchanged(A, before, "too long");
    eq((await post(A, { paletteId: "clay", description: "y".repeat(160) })).status, 200, "160 is fine:");
    const long = "z".repeat(250);
    const cur = await configOf(A);
    await C.patchTenant(A.id, { config: { site: { ...cur.site, tagline: long } } });
    eq((await get(A)).body.current.description, long, "shown unchanged:");
    const k = await post(A, { paletteId: "clay", description: long });
    eq(k.status, 200, `kept: ${JSON.stringify(k.body).slice(0, 200)}`);
    eq((await configOf(A)).site.tagline, long, "kept as it is:");
    const nl = await post(A, { paletteId: "clay", description: "Line one\nline two" });
    eq(nl.status, 200);
    eq((await configOf(A)).site.tagline, "Line one line two", "a line break becomes a space:");
  });

  // ======================================================================================
  console.log("— Skip");

  const Sk = await store("skip");
  await members(Sk);
  await seedSlate(Sk, { home: true });

  await t("ACCEPTANCE: skip records skipped:true (no paletteId with no earlier save, so startingPaletteId is slate) and leaves the seeded slate design intact; resolvedLogo is null after publishing it", async () => {
    const rowBefore = await designRow(Sk);
    const r = await post(Sk, { skip: true });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.skipped, r.body.liveNow, r.body.afterPublish], [true, [], []], "answer:");
    eq(await designRow(Sk), rowBefore, "the design is untouched:");
    const step = (await configOf(Sk)).onboarding.brand_step;
    eq(Object.keys(step).sort(), ["at", "skipped"], "record keys:");
    eq(step.skipped, true, "skipped:");
    eq(Pal.startingPaletteId((await configOf(Sk)).onboarding), "slate", "starting palette:");
    const p = await publishIn(Sk, ["doc_home", "doc_design"]);
    ok(p.release, `published: ${JSON.stringify(p).slice(0, 300)}`);
    eq(await asShopper(Sk, () => Res.resolvedLogo()), null, "resolvedLogo:");
    eq(Pal.paletteIdOfBrand(await asShopper(Sk, () => Res.resolvedBrand())), "slate", "the shopper sees slate:");
  });

  await t("on the open store the answer says storeOpen, so the console can say the description shows now", async () => {
    const r = await post(Sk, { paletteId: "slate", description: "Open now" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.storeOpen, r.body.liveNow], [true, ["description"]], "answer:");
    eq((await get(Sk)).body.storeOpen, true, "GET:");
  });

  const Fs = await store("fs");
  await members(Fs);
  await seedSlate(Fs);

  await t("ACCEPTANCE: saving forest then skipping leaves brand_step { skipped:true, paletteId:'forest' } and startingPaletteId === 'forest'", async () => {
    eq((await post(Fs, { paletteId: "forest" })).status, 200, "save:");
    const designAfterSave = await designRow(Fs);
    const r = await post(Fs, { skip: true, paletteId: "ink" });
    eq(r.status, 200);
    const onb = (await configOf(Fs)).onboarding;
    eq([onb.brand_step.skipped, onb.brand_step.paletteId], [true, "forest"], "record:");
    eq(Pal.startingPaletteId(onb), "forest", "starting palette:");
    eq(await designRow(Fs), designAfterSave, "skip writes no document (the paletteId it was sent is ignored):");
  });

  // ======================================================================================
  console.log("— GET preselection");

  const N = await store("none");
  await members(N);
  await t("ACCEPTANCE: GET with no design preselects DEFAULT_PALETTE_ID; a founder's own colours preselect nothing; a partial brand that draws like a palette is preselected", async () => {
    const r = await get(N);
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.current.paletteId, r.body.design], [Pal.DEFAULT_PALETTE_ID, null], "no design:");
    await inS(N, () => Docs.createDocument({ type: "design", body: designBody("slate", { brand: { accent: "#7c3aed", background: "#ffffff", foreground: "#111111" } }), actor: { kind: "merchant", id: ownerU.id } }));
    eq((await get(N)).body.current.paletteId, null, "own colours:");
    const d = await inS(N, () => Docs.getDocument("doc_design"));
    const partial = { accent: "#1e3a8a", background: "#ffffff", foreground: "#0f172a" };
    await inS(N, () => Docs.saveDraft({ id: "doc_design", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, brand: partial } }, actor: { kind: "merchant", id: ownerU.id } }));
    eq((await get(N)).body.current.paletteId, "navy", "partial navy:");
  });

  await t("with no design at all, Save creates doc_design under the founder, on the palette's kit", async () => {
    const E = await store("empty");
    await members(E);
    const r = await post(E, { paletteId: "stone" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    const row = await designRow(E);
    eq([row.updated_by, row.revision], [OWNER_BY, 1], "created:");
    const s = JSON.parse(row.draft).settings;
    eq([s.brand, s.theme, s.logo], [{ ...Pal.paletteById("stone").brand }, { kit: "pulse", version: 1 }, null], "settings:");
    eq(r.body.afterPublish, ["colours"], "after publish:");
  });

  await t("a design on another look keeps it; a design with no look gets the palette's kit", async () => {
    const G = await store("glow");
    await members(G);
    await inS(G, () => Docs.createFirstRunDocuments({ docs: [{ type: "design", id: "doc_design", body: designBody("slate", { theme: { kit: "glow", version: 1 } }) }], actor: FR }));
    eq((await post(G, { paletteId: "clay" })).status, 200);
    eq((await designSettings(G)).theme, { kit: "glow", version: 1 }, "glow kept:");
    const H = await store("notheme");
    await members(H);
    await inS(H, () => Docs.createFirstRunDocuments({ docs: [{ type: "design", id: "doc_design", body: designBody("slate", { theme: null }) }], actor: FR }));
    eq((await post(H, { paletteId: "clay" })).status, 200);
    eq((await designSettings(H)).theme, { kit: "pulse", version: 1 }, "the palette's kit:");
  });

  // ======================================================================================
  console.log("— refusals write nothing");

  const Rf = await store("refuse");
  await members(Rf);
  await seedSlate(Rf);
  const rfLogo = await upload(Rf);

  await t("ACCEPTANCE: an https logo address is refused (the logo kind) with nothing written", async () => {
    for (const media of ["https://elsewhere.example/logo.png", "/other/path.png", "//cdn.example/x.png", `/api/media/${rfLogo.id}?x=1`]) {
      const before = await dump(Rf);
      const r = await post(Rf, { paletteId: "forest", logo: { media, alt: "" } });
      eq(r.status, 422, `${media}: ${JSON.stringify(r.body).slice(0, 300)}`);
      ok(r.body.issues.some((i) => i.code === "LOGO_INVALID"), `${media} code: ${JSON.stringify(r.body.issues)}`);
      ok(/picture from your own library/.test(r.body.errors.join(" ")), r.body.errors.join(" "));
      await unchanged(Rf, before, media);
    }
  });

  await t("a library address whose file is not in the library is refused with nothing written", async () => {
    const before = await dump(Rf);
    const r = await post(Rf, { paletteId: "forest", logo: { media: "/api/media/med_nothere1", alt: "" } });
    eq(r.status, 422, JSON.stringify(r.body).slice(0, 300));
    ok(r.body.issues.some((i) => i.code === "LOGO_NOT_IN_LIBRARY"), JSON.stringify(r.body.issues));
    await unchanged(Rf, before, "not in library");
  });

  await t("ACCEPTANCE: an unknown paletteId is a 400 with nothing written (also a missing one, and junk)", async () => {
    for (const body of [{ paletteId: "lime" }, { paletteId: "toString" }, {}, { paletteId: "forest", logo: "x" }, { paletteId: "forest", description: 5 }, "nope", null]) {
      const before = await dump(Rf);
      const r = await post(Rf, body);
      eq(r.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      ok(/Nothing was saved|nothing was saved/.test(r.body.error), r.body.error);
      await unchanged(Rf, before, JSON.stringify(body));
    }
    eq((await post(Rf, { paletteId: "lime" })).body.code, "PALETTE_UNKNOWN", "code:");
  });

  await t("ACCEPTANCE: a legacy tenant is refused with 409 STORE_USES_LEGACY and nothing written; GET too", async () => {
    const L = await store("legacy", { mode: "legacy" });
    await members(L);
    const before = await dump(L);
    for (const body of [{ paletteId: "forest" }, { skip: true }, { paletteId: "forest", description: "New" }]) {
      const r = await post(L, body);
      eq([r.status, r.body.code], [409, "STORE_USES_LEGACY"], `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      ok(/current Storefront editor/.test(r.body.error) && /nothing was saved/.test(r.body.error), r.body.error);
    }
    await unchanged(L, before, "legacy");
    eq((await get(L)).body.code, "STORE_USES_LEGACY", "GET:");
  });

  await t("a store moving to the new editor is refused with 409 STORE_MIGRATING and nothing written", async () => {
    const Mv = await store("moving");
    await members(Mv);
    await raw(Mv).execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
    const before = await dump(Mv);
    const r = await post(Mv, { paletteId: "forest" });
    eq([r.status, r.body.code], [409, "STORE_MIGRATING"], JSON.stringify(r.body));
    await unchanged(Mv, before, "moving");
  });

  await t("ACCEPTANCE: a stale revision returns 409 with the current document and does not overwrite a concurrent editor save", async () => {
    const g = await get(Rf);
    const rev = g.body.design.revision;
    // the editor saves first (another tab or a teammate)
    const d = await inS(Rf, () => Docs.getDocument("doc_design"));
    const editorBrand = { ...d.body.settings.brand, accent: "#7c2d12" };
    await inS(Rf, () => Docs.saveDraft({ id: "doc_design", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, brand: editorBrand } }, actor: { kind: "merchant", id: staffU.id } }));
    const before = await dump(Rf);
    const r = await post(Rf, { paletteId: "forest", revision: rev, description: "Should not land" });
    eq([r.status, r.body.code], [409, "DOCUMENT_CHANGED"], JSON.stringify(r.body).slice(0, 300));
    eq(r.body.current?.revision, rev + 1, "the current document rides along:");
    ok(/changed somewhere else/.test(r.body.error), r.body.error);
    await unchanged(Rf, before, "stale");
    eq((await designSettings(Rf)).brand, editorBrand, "the editor's save stands:");
    // with the current revision it goes through
    eq((await post(Rf, { paletteId: "forest", revision: rev + 1 })).status, 200, "current revision:");
  });

  await t("ACCEPTANCE: a staff actor without the settings permission sending a changed description gets 403 in plain words and NOTHING is written", async () => {
    const before = await dump(Rf);
    const r = await post(Rf, { paletteId: "ink", description: "Staff words" }, STAFF);
    eq([r.status, r.body.code], [403, "DESCRIPTION_NOT_ALLOWED"], JSON.stringify(r.body));
    ok(/Only the store owner or an admin/.test(r.body.error) && /nothing was saved/.test(r.body.error), r.body.error);
    await unchanged(Rf, before, "staff description");
    // the same staff member may save colours with the description unchanged (or left out)
    const cur = (await configOf(Rf)).site.tagline;
    const ok1 = await post(Rf, { paletteId: "ink", description: cur }, STAFF);
    eq(ok1.status, 200, `unchanged description: ${JSON.stringify(ok1.body).slice(0, 200)}`);
    eq((await designRow(Rf)).updated_by, `merchant:${staffU.id}`, "staff's save:");
    eq((await get(Rf, STAFF)).body.canEditDescription, false, "GET tells the console:");
  });

  await t("a read-only (support) actor can read the step but not save or skip", async () => {
    eq((await get(Rf, SUPPORT)).status, 200, "GET:");
    const before = await dump(Rf);
    for (const body of [{ paletteId: "forest" }, { skip: true }]) eq((await post(Rf, body, SUPPORT)).status, 403, `${JSON.stringify(body)}:`);
    await unchanged(Rf, before, "support");
    eq((await post(Rf, { paletteId: "forest" }, null)).status, 401, "signed out:");
  });

  // ======================================================================================
  console.log("— every palette passes the design type's publish rules");

  const Pp = await store("palettes");
  await members(Pp);
  await seedSlate(Pp);
  await t("ACCEPTANCE: every palette saved through the step passes the design type's publish rules (validateDocument publish mode, checkBrand 0 errors)", async () => {
    for (const p of Pal.PALETTES) {
      const r = await post(Pp, { paletteId: p.id });
      eq(r.status, 200, `${p.id}: ${JSON.stringify(r.body).slice(0, 200)}`);
      const row = await designRow(Pp);
      const body = JSON.parse(row.draft);
      eq(body.settings.brand, { ...p.brand }, `${p.id} brand:`);
      const v = R.validateDocument(body, { mode: "publish", documentId: "doc_design" });
      ok(v.ok, `${p.id} publish validation: ${JSON.stringify(v.issues)}`);
      eq(v.issues.filter((i) => i.severity === "error"), [], `${p.id} errors:`);
      const kit = `${body.settings.theme.kit}-${body.settings.theme.version}`;
      eq(B.checkBrand(body.settings.brand, { kit }).errors.length, 0, `${p.id} checkBrand errors:`);
      eq((await get(Pp)).body.current.paletteId, p.id, `${p.id} preselected after saving:`);
    }
    for (const p of Pal.PALETTES) ok(Object.isFrozen(p.brand), `${p.id} brand still frozen`);
    eq(JSON.stringify(forest.brand), FOREST_FROZEN, "forest unchanged:");
  });

  // ======================================================================================
  console.log("— the module and route conventions");

  await t("brand-step.js never publishes and never imports the generator; the route is nodejs and resolves the store through tenantHandler", async () => {
    const { readFile } = await import("node:fs/promises");
    const lib = (await readFile(join(ROOT, "lib/first-run/brand-step.js"), "utf8")).replace(/^\s*\/\/.*$/gm, "");
    ok(!/generate\.js|documents\/publish|\bpublish\(/.test(lib), "brand-step.js must not publish or import generate.js");
    const src = await readFile(join(ROOT, "app/api/admin/brand-step/route.js"), "utf8");
    ok(/export const runtime = "nodejs";/.test(src), "runtime nodejs");
    ok((src.match(/tenantHandler\(/g) || []).length >= 2, "GET and POST through tenantHandler");
    ok(!/\/admin\/(catalog|home|upsells|storefront)/.test(src + lib), "no legacy console links");
  });

  // ======================================================================================
  console.log("— P6-START-UI: the step's own guards (review M14, M8)");

  await t("M14: the body saved carries a COPY of the palette's brand, never the frozen palette object (createDocument and saveDraft)", async () => {
    const Cp = await store("copy");
    await members(Cp);
    globalThis.__bsWrites = [];
    eq((await post(Cp, { paletteId: "navy" })).status, 200, "create:");
    eq((await post(Cp, { paletteId: "clay" })).status, 200, "save:");
    const bodies = globalThis.__bsWrites;
    eq(bodies.length, 2, "createDocument then saveDraft:");
    for (const [i, id] of [[0, "navy"], [1, "clay"]]) {
      const brand = bodies[i]?.settings?.brand;
      ok(brand && brand !== Pal.paletteById(id).brand, `${id}: settings.brand is the palette's own frozen object`);
      ok(!Object.isFrozen(brand), `${id}: settings.brand is frozen`);
      eq(brand, { ...Pal.paletteById(id).brand }, `${id} brand:`);
      brand.accent = "#000000"; // a saved body can be changed without touching the palette
      eq(Pal.paletteById(id).brand.accent, { navy: "#1e3a8a", clay: "#9a3412" }[id], `${id} palette unchanged:`);
    }
    globalThis.__bsWrites = null;
  });

  await t("M8: saveBrandStep itself refuses a caller without storefront.write (support, no role), Save and Skip, with nothing written", async () => {
    const Gd = await store("guard");
    await members(Gd);
    await seedSlate(Gd);
    for (const actor of [{ kind: "merchant", id: supportU.id, role: "support" }, { kind: "merchant", id: "nobody" }, null]) {
      for (const body of [{ paletteId: "forest" }, { skip: true }, { paletteId: "forest", description: "Not mine" }]) {
        const before = await dump(Gd);
        let threw = null;
        try {
          await inS(Gd, () => BS.saveBrandStep(body, actor));
        } catch (e) {
          threw = e;
        }
        ok(threw instanceof Docs.DocumentError, `${JSON.stringify(actor)} ${JSON.stringify(body)}: not refused (${threw?.message})`);
        eq([threw.status, threw.code], [403, "BRAND_STEP_NOT_ALLOWED"], `${JSON.stringify(actor)} ${JSON.stringify(body)}:`);
        await unchanged(Gd, before, `${JSON.stringify(actor)} ${JSON.stringify(body)}`);
      }
    }
    // the same call with an editor's role goes through
    const r = await inS(Gd, () => BS.saveBrandStep({ paletteId: "forest" }, { kind: "merchant", id: staffU.id, role: "staff" }));
    eq(r.ok, true, "staff may:");
  });

  await renderedTests();
} finally {
  for (const c of raws.values()) c.close();
  for (const fx of fixtures) await fx.cleanup().catch(() => {});
  await plat.cleanup().catch(() => {});
  await F.removeFixtureFiles("bs").catch(() => {});
  await rm(join(ROOT, ".test-bs-default.db"), { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
