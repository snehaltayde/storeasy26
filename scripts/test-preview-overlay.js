// P2-PREVIEW suite (PV-03, DOC-05, DOC-04; spec 8.8): the founder's preview on
// a store in documents mode is the live list with every saved draft laid over.
//   1. A documents store with a live release: a valid session shows each dirty
//      document's draft (every type but product_content), everything else live.
//   2. A documents store that has never published: drafts over emptyList(m);
//      without a session it is the closed store (P3-CLOSED, PUB-06).
//   3. Tolerant drafts: an unfinished section shows its placeholder.
//   4. The design draft only after "Show them" (admin route, and the bar's form).
//   5. Refusals: no cookie, a tampered hmac, an expired or revoked session, a
//      token from another store. Old-format tokens: live on documents stores,
//      today's draft preview on legacy stores.
//   6. Failure rows: a preview_sessions read error (live, logged, no 5xx), a
//      missing table (no overlay), a drafts read error, a session write error
//      (5xx with a code).
//   7. product_content is never overlaid (known limit until OVL-02).
//   8. The other-tab note, and the real layout's preview bar.
//   9. The admin route's answers; migration 0022; edge safety.
//   pnpm test:preview-overlay
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();

// next/headers answers for one simulated request at a time (as in
// test-release-readers); outside one, headers() and cookies() throw.
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
process.env.DATABASE_URL = "file:.test-pvo-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pvo-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const TENANTS = ["pd", "pn", "pl", "pa", "pf", "px", "pv"];
const dbs = [".test-pvo-default.db", ".test-pvo-platform.db", ".test-pvo-m21.db", ...TENANTS.map((t) => `.test-pvo-${t}.db`)];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

const C = await import("../lib/platform/control.js");
const SS = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const Res = await import("../lib/content/resolve.js");
const Docs = await import("../lib/content/documents-reader.js");
const L = await import("../lib/documents/release-list.js");
const ids = await import("../lib/documents/ids.js");
const Svc = await import("../lib/documents/service.js");
const { commitPublishBatch } = await import("../lib/documents/commit.js");
const Reg = await import("../lib/registry/index.js");
const PS = await import("../lib/preview-sessions.js");
const { handlePreviewSessionPost, parsePreviewSessionOperation } = await import("../lib/admin/preview-session-api.js");
const { runRequest } = await import("./support/request-cache.js");
const { loadMigrations, runMigrations, checkLedger } = await import("../lib/platform/migrate.js");
const { createClient } = await import("@libsql/client");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");

let pass = 0;
let fail = 0;
async function t(name, fn) {
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
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const same = (got, want, m = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${m}\n      expected ${canon(want).slice(0, 600)}\n      got      ${canon(got).slice(0, 600)}`);
};

// Log lines (slog writes JSON to console.log): captured while fn runs.
async function logsDuring(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => {
    const s = a.map(String).join(" ");
    if (s.startsWith("{")) lines.push(s);
    else orig(...a);
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

// ---- stores ----------------------------------------------------------------------

const P = (n) => `gid://shopify/Product/${n}`;
const COL = (n) => `gid://shopify/Collection/${n}`;
const NOW = "2026-11-04T10:00:00.000Z";

async function tenant(id, { mode = "documents", config = {} } = {}) {
  await C.upsertTenant({
    id,
    name: `PV ${id}`,
    domains: [`${id}.test`],
    dbUrl: `file:.test-pvo-${id}.db`,
    config: { site: { name: `PV ${id} Store` }, site_url: `https://${id}.test`, ...config },
    secrets: { order_link_secret: `${id}-secret` },
  });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, MIGRATIONS);
    const run = (sql, args = []) => libsql.execute({ sql, args });
    await run("INSERT INTO collections (id, handle, title, synced_at, updated_at) VALUES (?, 'whey', 'Whey', ?, ?), (?, 'serums', 'Serums', ?, ?)", [COL(1), NOW, NOW, COL(2), NOW, NOW]);
    for (const [n, handle, title, price] of [
      [1, "glow-serum", "Glow Serum", 1299],
      [2, "night-cream", "Night Cream", 899],
      [3, "whey-gold", "Whey Gold", 2499],
    ]) {
      await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at, updated_at) VALUES (?, ?, ?, ?, ?, 'INR', 1, ?, ?)", [P(n), handle, title, price, price, NOW, NOW]);
      await run("INSERT INTO variants (id, product_id, title, price, currency, available, position) VALUES (?, ?, 'Default', ?, 'INR', 1, 0)", [`gid://shopify/ProductVariant/${n}`, P(n), price]);
    }
    await run("INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0), (?, ?, 1), (?, ?, 0)", [COL(2), P(1), COL(2), P(2), COL(1), P(3)]);
    await run("UPDATE cms_state SET mode = ? WHERE id = 1", [mode]);
  });
  return T;
}

const PD = await tenant("pd"); // documents, with a live release
const PN = await tenant("pn"); // documents, never published
const PL = await tenant("pl", { mode: "legacy" }); // legacy, today's preview
const PA = await tenant("pa"); // documents, another store (cross-store tokens)
const PF = await tenant("pf"); // documents, broken on purpose (failure rows)
const PX = await tenant("px"); // documents, product_content and other tabs
const PV = await tenant("pv"); // documents, but a legacy (v3) release is live (P2-FIX4)
const HOST = (T) => `${T.id}.test`;
const inT = (T, fn) => withTenant(T, fn);

// people: an owner (member of every store), a second owner, support (read-only)
const ownerU = await I.createUser({ email: "asha@pv.test", name: "Asha Rao", password: "owner-pass-pv" });
const otherU = await I.createUser({ email: "ravi@pv.test", name: "Ravi", password: "other-pass-pv" });
const supportU = await I.createUser({ email: "help@pv.test", name: "Help", password: "support-pass-pv" });
for (const T of [PD, PN, PL, PA, PF, PX, PV]) {
  await I.addMembership(ownerU.id, T.id, "owner");
  await I.addMembership(otherU.id, T.id, "owner");
  await I.addMembership(supportU.id, T.id, "support");
}
const sessionToken = async (u) => (await SS.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await sessionToken(ownerU);
const OTHER = await sessionToken(otherU);
const SUPPORT = await sessionToken(supportU);

// The admin route's handler, as the route calls it.
const adminReq = (T, cookie, body, { origin = null } = {}) => ({
  cookies: { get: (name) => (name === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: HOST(T), ...(origin ? { origin } : {}) })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const admin = (T, body, { as = OWNER, origin = null } = {}) => inT(T, () => handlePreviewSessionPost(adminReq(T, as, body, { origin })));
async function newSession(T, as = OWNER) {
  const r = await admin(T, { create: true }, { as });
  if (r.status !== 200) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// One simulated shopper/founder request on T's host with these cookies.
async function asRequest(T, fn, cookies = {}) {
  globalThis.__readRequest = { host: HOST(T), cookies };
  try {
    return await runRequest(() => inT(T, fn));
  } finally {
    globalThis.__readRequest = null;
  }
}
const withToken = (token) => (token ? { [Res.PREVIEW_COOKIE]: token } : {});

// ---- documents and publishing --------------------------------------------------------

const body = (type, { settings, sections, meta } = {}) => {
  const b = Reg.emptyBody(type);
  if (settings) b.settings = { ...(b.settings || {}), ...settings };
  if (sections) b.sections = sections;
  if (meta) b.meta = { ...b.meta, ...meta };
  return b;
};
const sec = (kind, id, settings = {}, extra = {}) => {
  const s = Reg.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings }, ...extra };
};
const pageRow = (b) => ({ slug: b.meta.slug, type: b.type, title: b.meta.title, description: b.meta.description, enabled: b.meta.enabled, effective_at: b.meta.effective_at, window_start: b.meta.window_start, window_end: b.meta.window_end });

async function pointerOf() {
  const r = await libsql.execute("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const row = r.rows[0] || {};
  return { pointer: row.live ?? null, list: row.content ? JSON.parse(String(row.content)) : null };
}

// The documents row holds the body as its draft, and is published at it, so
// a published document is not dirty (draft_hash = published_hash).
async function upsertDocument(id, b) {
  const hash = await Reg.documentHash(b);
  const slug = b.meta?.slug || null;
  await libsql.execute({
    sql: `INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET draft = excluded.draft, draft_hash = excluded.draft_hash, slug = excluded.slug`,
    args: [id, b.type, slug, id, JSON.stringify(b), hash, NOW, NOW],
  });
  const revision = Number((await libsql.execute({ sql: "SELECT revision FROM documents WHERE id = ?", args: [id] })).rows[0].revision);
  return { revision, hash };
}

async function versionOf(id, b) {
  const canonical = R.stableStringify(b);
  return { id: ids.verId(), document_id: id, kind: "published", body: canonical, body_hash: await R.sha256Hex(canonical), schema_version: 1, created_at: NOW };
}

// items: [{ id, body, redirects? }]; journal: [{ id, body }] posts for a new
// journal index. Through the real commitPublishBatch.
async function publish(T, items, { journal } = {}) {
  return inT(T, async () => {
    const live = await pointerOf();
    const prevList = L.isV4List(live.list) ? live.list : L.emptyList(1, Reg.singletonTypes());
    const build = { releaseId: ids.relId(), setId: ids.setId(), pointer: live.pointer, versions: [], documents: [], log: [], actor: "test", now: NOW };
    const changes = [];
    const one = async (id, b) => {
      const { valid, issues } = { valid: Reg.validateDocument(b, { mode: "publish" }).ok, issues: Reg.validateDocument(b, { mode: "publish" }).issues };
      if (!valid) throw new Error(`fixture ${id} does not validate: ${JSON.stringify(issues.filter((i) => i.severity !== "warning")).slice(0, 400)}`);
      const { revision, hash } = await upsertDocument(id, b);
      const v = await versionOf(id, b);
      build.versions.push(v);
      build.documents.push({ id, revision, published_version_id: v.id, published_hash: hash });
      build.log.push({ id: ids.logId(), document_id: id, action: "publish", to_version_id: v.id });
      return v;
    };
    for (const it of items) {
      const v = await one(it.id, it.body);
      const route = Reg.documentType(it.body.type)?.route;
      changes.push({ document: it.id, entry: { version: v.id, hash: v.body_hash }, pages: route ? [pageRow(it.body)] : [], redirects: it.redirects || [] });
    }
    if (journal) {
      const posts = [];
      for (const p of journal) {
        const v = await one(p.id, p.body);
        posts.push({ document: p.id, version: v.id, ...pageRow(p.body), family: "journal" });
      }
      const ib = L.journalIndexBody(posts);
      const { revision } = await upsertDocument("doc_journal_index", ib);
      const v = await versionOf("doc_journal_index", ib);
      build.versions.push(v);
      build.documents.push({ id: "doc_journal_index", revision, published_version_id: v.id, published_hash: v.body_hash });
      changes.push({ index: "journal", entry: { version: v.id, hash: v.body_hash } });
    }
    build.list = L.setEntries(prevList, changes);
    const r = await commitPublishBatch(build);
    if (r.outcome !== "ok") throw new Error(`publish: ${JSON.stringify(r).slice(0, 300)}`);
    return build;
  });
}

// A saved draft, through the real document service (validated, sanitized).
// doc_cart is the exception: the service refuses cart writes until the owner
// rules on its capability (P2-DOCFIX, CART_NOT_AVAILABLE), so its draft row
// is written directly. The overlay must still show a cart draft that exists.
async function saveDraft(T, id, b) {
  if (id === "doc_cart") return inT(T, () => upsertDocument(id, b));
  return inT(T, async () => {
    const rev = Number((await libsql.execute({ sql: "SELECT revision FROM documents WHERE id = ?", args: [id] })).rows[0].revision);
    return Svc.saveDraft({ id, revision: rev, body: b, actor: { kind: "merchant", id: ownerU.id } });
  });
}
async function createDraft(T, type, b, { entityId = null } = {}) {
  return inT(T, async () => {
    const made = await Svc.createDocument({ type, meta: b.meta, entityId, actor: { kind: "merchant", id: ownerU.id } });
    const r = await Svc.saveDraft({ id: made.document.id, revision: made.document.revision, body: b, actor: { kind: "merchant", id: ownerU.id } });
    return r.document;
  });
}
const dirtyIds = (T) => inT(T, async () => (await libsql.execute("SELECT id FROM documents WHERE archived_at IS NULL AND draft_hash IS NOT published_hash ORDER BY id")).rows.map((r) => String(r.id)));

// ---- the live store (pd) -------------------------------------------------------------

const navItems = (label) => [{ label, link: { type: "collection", handle: "serums" } }];
const LIVE = {
  doc_header: body("header", { settings: { mode: "custom", template: "standard", items: navItems("Live header") } }),
  doc_footer: body("footer", { settings: { mode: "custom", template: "columns", items: navItems("Live footer") } }),
  doc_announcement: body("announcement", { settings: { enabled: true, text: "Live bar", link: null } }),
  doc_design: body("design", { settings: { brand: { accent: "#0d9488" }, theme: { kit: "glow", version: 1 } } }),
  doc_home: body("home", { sections: [sec("hero", "sec_hero", { title: "Live hero", subtitle: "Live words" }), sec("new", "sec_new1", { title: "Live new", limit: 4 })] }),
  doc_collections_index: body("collections_index", { settings: { featured: [{ handle: "whey", id: COL(1) }], order: [], hide: [] } }),
  doc_product_layout: body("product_layout", { settings: { template: "classic" }, sections: [sec("product_main", "sec_main"), sec("rich_text", "sec_howto", { title: "Live how to", html: "<p>Live use</p>" })] }),
  doc_collection_layout: body("collection_layout", { settings: { template: "standard" }, sections: [] }),
  doc_cart: body("cart", { settings: { title: "Live picks", products: [{ handle: "whey-gold", id: P(3) }] } }),
  doc_about: body("page", { meta: { slug: "about", title: "Live about" }, sections: [sec("text", "sec_story", { title: "Live story", body: ["Live words."] })] }),
  doc_shipping: body("page", { meta: { slug: "shipping", title: "Live shipping" }, sections: [sec("text", "sec_ship", { title: "Live times", body: ["Two days."] })] }),
  doc_spring: body("campaign", {
    meta: { slug: "spring", title: "Live spring", window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" },
    sections: [sec("text", "sec_sp", { title: "Live sale", body: ["Live offer."] })],
  }),
};
const POST = body("journal", { meta: { slug: "first-post", title: "Live post", window_start: "2025-05-01T00:00:00.000Z" }, sections: [sec("text", "sec_jt", { title: "Live post body", body: ["Live journal words."] })] });

await publish(
  PD,
  Object.entries(LIVE).map(([id, b]) => ({ id, body: b })),
  { journal: [{ id: "doc_jfirst", body: POST }] },
);

// What each dirty document's draft says (every type but design and product_content).
const DRAFT = {
  doc_home: body("home", { sections: [sec("hero", "sec_hero", { title: "Draft hero", subtitle: "Draft words" }), sec("new", "sec_new1", { title: "Draft new", limit: 4 })] }),
  doc_about: body("page", { meta: { slug: "about", title: "Draft about" }, sections: [sec("rich_text", "sec_story", { title: "Draft story", html: "<p>Draft words</p><script>alert(1)</script>" })] }),
  doc_spring: body("campaign", {
    meta: { slug: "spring", title: "Draft spring", window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" },
    sections: [sec("text", "sec_sp", { title: "Draft sale", body: ["Draft offer."] })],
  }),
  doc_jfirst: body("journal", { meta: { slug: "first-post", title: "Draft post", window_start: "2025-05-01T00:00:00.000Z" }, sections: [sec("text", "sec_jt", { title: "Draft post body", body: ["Draft journal words."] })] }),
  doc_announcement: body("announcement", { settings: { enabled: true, text: "Draft bar", link: null } }),
  doc_header: body("header", { settings: { mode: "custom", template: "centered", items: navItems("Draft header") } }),
  doc_footer: body("footer", { settings: { mode: "custom", template: "minimal", items: navItems("Draft footer") } }),
  doc_product_layout: body("product_layout", { settings: { template: "editorial" }, sections: [sec("product_main", "sec_main"), sec("rich_text", "sec_howto", { title: "Draft how to", html: "<p>Draft use</p>" })] }),
  doc_collection_layout: body("collection_layout", { settings: { template: "sidebar" }, sections: [] }),
  doc_cart: body("cart", { settings: { title: "Draft picks", products: [{ handle: "night-cream", id: P(2) }] } }),
  doc_collections_index: body("collections_index", { settings: { featured: [{ handle: "serums", id: COL(2) }], order: [], hide: [] } }),
};
for (const [id, b] of Object.entries(DRAFT)) await saveDraft(PD, id, b);
// a page that was never published, and a design draft
const NEWPAGE = await createDraft(PD, "page", body("page", { meta: { slug: "new-page", title: "Brand new page" }, sections: [sec("text", "sec_np", { title: "New page words", body: ["Not live yet."] })] }));
await saveDraft(PD, "doc_design", body("design", { settings: { brand: { accent: "#7c3aed" }, theme: { kit: "glow", version: 1 } } }));

// Every getter's view of the store, as plain values to compare.
async function view() {
  const page = async (slug) => {
    const p = await Res.resolvedContentPage(slug);
    return p ? { title: p.title, sections: p.sections.map((s) => s.heading ?? s.title ?? null), text: p.sections.flatMap((s) => s.body || []), html: p.sections.map((s) => s.html || "").join("") } : null;
  };
  return {
    hero: (await Res.resolvedHero())?.title ?? null,
    homeSections: (await Res.resolvedHomeSections()).map((s) => s.title),
    homePage: (await Res.resolvedHomePage()).map((s) => s.settings?.title ?? null),
    announcement: (await Res.resolvedAnnouncement()).text,
    header: (await Res.resolvedNav("header"))?.map((i) => i.label) ?? null,
    footer: (await Res.resolvedNav("footer"))?.map((i) => i.label) ?? null,
    pdp: (await Res.resolvedPdpExtras()).map((a) => a.title),
    pdpTemplate: (await Res.resolvedSurfaceTemplateFor("pdp")).template,
    collectionTemplate: (await Res.resolvedSurfaceTemplateFor("collection")).template,
    surfaces: await Res.resolvedSurfaceTemplates(),
    cart: (await Res.resolvedCartUpsell([])).title,
    cartProducts: (await Res.resolvedCartUpsell([])).products.map((p) => p.handle),
    collectionsIndex: (await Res.resolvedCollectionsIndex())?.featured ?? null,
    about: await page("about"),
    shipping: await page("shipping"),
    spring: await page("spring"),
    post: await page("first-post"),
    newPage: await page("new-page"),
    journal: (await Res.resolvedJournalEntries()).map((e) => e.title),
    pageList: (await Res.resolvedContentPageList()).filter((p) => p.source === "custom").map((p) => `${p.slug}:${p.title}`),
    brand: (await Res.resolvedBrand())?.accent ?? null,
  };
}

// =====================================================================================
console.log("— 1. a documents store with a live release");
// =====================================================================================
const LIVE_VIEW = await asRequest(PD, view);
await t("no cookie: every getter serves the live release (the drafts exist but never show)", async () => {
  eq(LIVE_VIEW.hero, "Live hero", "hero:");
  eq(LIVE_VIEW.about.title, "Live about", "about:");
  eq(LIVE_VIEW.newPage, null, "a never-published page does not exist for shoppers:");
  eq(LIVE_VIEW.brand, "#0d9488", "brand:");
  eq((await asRequest(PD, () => Res.contentSource())).preview, false, "preview flag:");
  // the drafts are really there: 11 types + the new page + design
  eq((await dirtyIds(PD)).length, 13, "dirty documents:");
});

let SESSION;
await t("a valid session shows each dirty document's saved draft (home, page, campaign, journal, announcement, header, footer, product_layout, collection_layout, cart, collections_index) and everything else live", async () => {
  SESSION = await newSession(PD);
  ok(/^p\.\d+\.ps_[0-9a-f]{16}\.[0-9a-f]{20}$/.test(SESSION.token), `token shape: ${SESSION.token}`);
  const src = await asRequest(PD, () => Res.contentSource(), withToken(SESSION.token));
  eq(src.preview, true, "preview:");
  eq(src.v, 4, "v:");
  eq(src.overlay.showDesign, false, "showDesign:");
  eq(src.overlay.designDirty, true, "designDirty:");
  same([...src.overlay.documents].sort(), [...Object.keys(DRAFT), NEWPAGE.id].sort(), "overlaid documents:");
  const v = await asRequest(PD, view, withToken(SESSION.token));
  eq(v.hero, "Draft hero", "home (hero):");
  same(v.homeSections, ["Draft new"], "home (sections):");
  same(v.homePage, ["Draft hero", "Draft new"], "home (resolvedHomePage):");
  eq(v.about.title, "Draft about", "page:");
  same(v.about.sections, ["Draft story"], "page sections:");
  ok(v.about.html.includes("Draft words") && !v.about.html.includes("<script"), `the draft is sanitized: ${v.about.html}`);
  eq(v.spring.title, "Draft spring", "campaign:");
  eq(v.post.title, "Draft post", "journal post:");
  same(v.post.sections, ["Draft post body"], "journal post body:");
  same(v.journal, ["Draft post"], "journal listing:");
  eq(v.announcement, "Draft bar", "announcement:");
  same(v.header, ["Draft header"], "header:");
  same(v.footer, ["Draft footer"], "footer:");
  same(v.surfaces, { header: "centered", footer: "minimal" }, "header/footer templates:");
  same(v.pdp, ["Draft how to"], "product_layout:");
  eq(v.pdpTemplate, "editorial", "product_layout template:");
  eq(v.collectionTemplate, "sidebar", "collection_layout:");
  eq(v.cart, "Draft picks", "cart:");
  same(v.cartProducts, ["night-cream"], "cart products:");
  same(v.collectionsIndex, ["serums"], "collections_index:");
  eq(v.newPage.title, "Brand new page", "a never-published page:");
  ok(v.pageList.includes("new-page:Brand new page") && v.pageList.includes("about:Draft about"), `page list: ${v.pageList}`);
  // everything else live
  eq(v.shipping.title, "Live shipping", "an unchanged page stays live:");
  eq(v.brand, "#0d9488", "the design draft is not shown until asked:");
});

await t("the preview changes nothing stored, and a shopper request right after still sees live content", async () => {
  same(await asRequest(PD, view), LIVE_VIEW, "live after a preview:");
});

// =====================================================================================
console.log("— 2. a documents store that has never published");
// =====================================================================================
await t("drafts render over emptyList(m); every other singleton is its code default; no cookie gets the closed store's neutral live content (PUB-06), never a draft", async () => {
  await createDraft(PN, "home", body("home", { sections: [sec("hero", "sec_hero", { title: "First hero" }), sec("rich_text", "sec_rt", { title: "First words", html: "<p>Hello</p>" })] }));
  await createDraft(PN, "page", body("page", { meta: { slug: "about", title: "First about" }, sections: [sec("text", "sec_a", { title: "Us", body: ["We began."] })] }));
  // P3-CLOSED: before the first publish a shopper's request is the closed
  // store (it was DOCUMENTS_UNPUBLISHED, an error page, in phase 2)
  const live = await asRequest(PN, () => Res.contentSource());
  eq(live.mode, "closed", "no cookie: mode:");
  eq(live.preview, false, "no cookie: preview:");
  const shopper = await asRequest(PN, view);
  eq(shopper.hero, null, "no cookie: no hero:");
  same(shopper.homeSections, [], "no cookie: no home sections:");
  eq(shopper.about, null, "no cookie: no about page:");
  ok(!JSON.stringify(shopper).includes("First"), `no cookie: a draft shows: ${JSON.stringify(shopper).slice(0, 300)}`);
  const s = await newSession(PN);
  const src = await asRequest(PN, () => Res.contentSource(), withToken(s.token));
  eq(src.preview, true, "preview:");
  eq(src.releaseId, null, "no release:");
  for (const type of Reg.singletonTypes()) if (type !== "home") eq(src.list.documents[`doc_${type}`], null, `doc_${type} is the code default:`);
  const v = await asRequest(PN, view, withToken(s.token));
  eq(v.hero, "First hero", "home draft:");
  same(v.homeSections, ["First words"], "home sections:");
  eq(v.about.title, "First about", "page draft:");
  eq(v.announcement, "", "announcement: code default:");
  eq(v.header, null, "header: code default (the catalog menu):");
  eq(v.footer, null, "footer: code default:");
  eq(v.brand, null, "brand: code default:");
  same(v.pdp, [], "product layout: code default:");
  eq(v.cart, null, "cart: code default (no suggestions):");
  same(v.journal, [], "journal: none:");
});

// =====================================================================================
console.log("— 3. tolerant drafts (DOC-05)");
// =====================================================================================
await t("a document with one incomplete enabled section previews: its draft renders and the incomplete section shows its placeholder", async () => {
  const before = await asRequest(PD, view);
  const home = body("home", {
    sections: [sec("hero", "sec_hero", { title: "Draft hero two" }), sec("banner", "sec_bn", { title: "", text: "" }), sec("new", "sec_new1", { title: "Draft new two", limit: 4 })],
  });
  const saved = await saveDraft(PD, "doc_home", home);
  ok(saved.issues.some((i) => i.severity === "incomplete" && i.sectionId === "sec_bn"), `the banner is incomplete: ${JSON.stringify(saved.issues)}`);
  const page = body("page", { meta: { slug: "about", title: "Draft about two" }, sections: [sec("rich_text", "sec_rt", { title: "Unwritten", html: "" }), sec("text", "sec_story", { title: "Draft story two", body: ["Still here."] })] });
  await saveDraft(PD, "doc_about", page);
  const sections = await asRequest(PD, () => Res.resolvedHomeSections(), withToken(SESSION.token));
  same(
    sections.map((s) => s.title),
    ["Banner: not finished yet", "Draft new two"],
    "home sections:",
  );
  ok(sections[0].html.includes("Write a short message, with an optional button"), `placeholder: ${sections[0].html}`);
  eq(sections[0].unfinished, true, "marked:");
  eq((await asRequest(PD, () => Res.resolvedHero(), withToken(SESSION.token))).title, "Draft hero two", "the rest of the draft renders:");
  const hp = await asRequest(PD, () => Res.resolvedHomePage(), withToken(SESSION.token));
  same(hp.map((s) => [s.id, !!s.unfinished]), [["sec_hero", false], ["sec_bn", true], ["sec_new1", false]], "resolvedHomePage marks it:");
  eq(hp[1].unfinished.placeholder, "Write a short message, with an optional button", "resolvedHomePage placeholder:");
  const about = await asRequest(PD, () => Res.resolvedContentPage("about"), withToken(SESSION.token));
  eq(about.title, "Draft about two", "page title:");
  same(about.sections.map((s) => s.heading), ["Rich text: not finished yet", "Draft story two"], "page sections:");
  ok(about.sections[0].body[0].startsWith("Write anything: a story, a size guide, a note."), `page placeholder: ${about.sections[0].body[0]}`);
  // shoppers: unchanged, and never a placeholder
  same(await asRequest(PD, view), before, "live unchanged:");
  same(await asRequest(PD, view), LIVE_VIEW, "live is the release:");
});

await t("a draft written around the document service (unsanitized) is sanitized in memory before the preview renders it", async () => {
  const raw = body("campaign", {
    meta: { slug: "spring", title: "Raw spring", window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" },
    sections: [sec("rich_text", "sec_sp", { title: "Raw", html: '<p onclick="steal()">Raw words</p><script>alert(1)</script>' })],
  });
  await inT(PD, () => libsql.execute({ sql: "UPDATE documents SET draft = ?, draft_hash = 'raw' WHERE id = 'doc_spring'", args: [JSON.stringify(raw)] }));
  const p = await asRequest(PD, () => Res.resolvedContentPage("spring"), withToken(SESSION.token));
  eq(p.title, "Raw spring", "the raw draft is previewed:");
  ok(p.sections[0].html.includes("Raw words"), `words kept: ${p.sections[0].html}`);
  ok(!/<script|onclick/i.test(p.sections[0].html), `stripped: ${p.sections[0].html}`);
  ok(/<script/.test(String((await inT(PD, () => libsql.execute("SELECT draft FROM documents WHERE id = 'doc_spring'"))).rows[0].draft)), "the stored row is not rewritten");
  await saveDraft(PD, "doc_spring", DRAFT.doc_spring);
});

// =====================================================================================
console.log("— 4. the design draft and the 'Show them' toggle");
// =====================================================================================
await t("doc_design draft colours are not applied until show_design is toggled on; then they are (and off again)", async () => {
  const tok = withToken(SESSION.token);
  eq(await asRequest(PD, () => Res.resolvedBrand(), tok).then((b) => b.accent), "#0d9488", "before:");
  const on = await admin(PD, { showDesign: { sid: SESSION.sid, on: true } });
  eq(on.status, 200, `toggle on: ${JSON.stringify(on.body)}`);
  const src = await asRequest(PD, () => Res.contentSource(), tok);
  eq(src.overlay.showDesign, true, "session flag:");
  ok(src.overlay.documents.includes("doc_design"), "design overlaid:");
  eq(await asRequest(PD, () => Res.resolvedBrand(), tok).then((b) => b.accent), "#7c3aed", "after Show them:");
  eq(await asRequest(PD, () => Res.resolvedBrand()).then((b) => b.accent), "#0d9488", "shoppers keep the live colours:");
  const off = await admin(PD, { showDesign: { sid: SESSION.sid, on: false } });
  eq(off.status, 200, "toggle off:");
  eq(await asRequest(PD, () => Res.resolvedBrand(), tok).then((b) => b.accent), "#0d9488", "after Hide them:");
});

await t("the preview bar's form (POST /api/preview) flips the session in this browser's cookie only, same origin only", async () => {
  const route = await import(pathToFileURL(join(ROOT, "app/api/preview/route.js")).href);
  const post = (token, fields, { origin = null, referer = "https://pd.test/policies/shipping" } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const headers = new Headers({ host: "pd.test", ...(origin ? { origin } : {}), ...(referer ? { referer } : {}) });
    return route.POST({ headers, cookies: { get: (n) => (n === Res.PREVIEW_COOKIE && token ? { value: token } : undefined) }, formData: async () => form, url: "https://pd.test/api/preview", nextUrl: new URL("https://pd.test/api/preview") });
  };
  const tok = withToken(SESSION.token);
  const r = await post(SESSION.token, { design: "on" });
  eq(r.status, 303, "redirect:");
  eq(r.headers.get("location"), "https://pd.test/policies/shipping", "back to the page:");
  eq((await asRequest(PD, () => Res.contentSource(), tok)).overlay.showDesign, true, "on:");
  const x = await post(SESSION.token, { design: "off" }, { origin: "https://evil.test" });
  eq(x.status, 403, "cross-origin:");
  eq((await asRequest(PD, () => Res.contentSource(), tok)).overlay.showDesign, true, "unchanged by the cross-origin post:");
  const legacy = await inT(PD, () => R.previewToken());
  eq((await post(legacy, { design: "off" })).status, 303, "an old token changes nothing:");
  eq((await asRequest(PD, () => Res.contentSource(), tok)).overlay.showDesign, true, "unchanged by an old token:");
  await post(SESSION.token, { design: "off" });
  eq((await asRequest(PD, () => Res.contentSource(), tok)).overlay.showDesign, false, "off:");
});

// P2-FIX4: /api/preview never sends a browser off the store's own origin.
await t("FIX4 open redirect: every hostile 'to' lands on '/' of the store's own origin (GET with or without a valid token, and the bar's POST); good paths are kept", async () => {
  const route = await import(pathToFileURL(join(ROOT, "app/api/preview/route.js")).href);
  const get = (query) => {
    const u = new URL(`https://pd.test/api/preview${query}`);
    return route.GET({ headers: new Headers({ host: "pd.test" }), nextUrl: u, url: u.href, cookies: { get: () => undefined } });
  };
  const withTo = (to, extra = {}) => {
    const p = new URLSearchParams({ ...extra, to });
    return get(`?${p}`);
  };
  const HOSTILE = [
    "/\\evil.com",
    "/%5Cevil.com",
    "/%5cevil.com",
    "//evil.com",
    "/%2F%2Fevil.com",
    "/%2f/evil.com",
    "/%252F%252Fevil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r\n/evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "https:evil.com",
    "javascript:alert(1)",
    " //evil.com",
    "",
  ];
  const home = "https://pd.test/";
  const s = await newSession(PD);
  // every miss is collected, so a failing run names each input that escaped
  const escaped = [];
  for (const to of HOSTILE) {
    for (const [label, r] of [
      ["no token", await withTo(to)],
      ["a bad token", await withTo(to, { token: "p.1.x" })],
      ["a valid token", await withTo(to, { token: s.token })],
      ["exit", await withTo(to, { exit: "1" })],
    ]) {
      if (r.status !== 302 || r.headers.get("location") !== home) escaped.push(`${JSON.stringify(to)} (${label}) -> ${r.status} ${r.headers.get("location")}`);
    }
  }
  // the exact links from the review, as a browser sends them
  for (const q of ["?to=/%5Cevil.com", "?to=/%5cevil.com", "?to=/%09/evil.com", "?to=%2F%2Fevil.com", "?to=/%0A/evil.com", "?token=bad&to=/%5Cevil.com"]) {
    const loc = (await get(q)).headers.get("location");
    if (loc !== home) escaped.push(`${q} -> ${loc}`);
  }
  if (escaped.length) throw new Error(`${escaped.length} hostile inputs left the store's origin or missed '/': ${escaped.join(" | ")}`);
  // good paths are kept
  for (const [to, want] of [
    ["/products/x?y=1#z", "https://pd.test/products/x?y=1#z"],
    ["/", "https://pd.test/"],
    ["/collections/serums", "https://pd.test/collections/serums"],
    ["/search?q=a%2Fb", "https://pd.test/search?q=a%2Fb"],
  ]) {
    eq((await withTo(to)).headers.get("location"), want, `${to} (no token):`);
    eq((await withTo(to, { token: s.token })).headers.get("location"), want, `${to} (valid token):`);
  }
  // the bar's POST: a hostile form field or Referer lands on '/' too
  const post = (fields, referer) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return route.POST({ headers: new Headers({ host: "pd.test", ...(referer ? { referer } : {}) }), cookies: { get: () => undefined }, formData: async () => form, url: "https://pd.test/api/preview", nextUrl: new URL("https://pd.test/api/preview") });
  };
  for (const to of HOSTILE.filter(Boolean)) eq((await post({ design: "on", to })).headers.get("location"), home, `POST ${JSON.stringify(to)}:`);
  eq((await post({ design: "on" }, "https://pd.test/policies/shipping?x=1")).headers.get("location"), "https://pd.test/policies/shipping?x=1", "POST back to the bar's page:");
  eq((await post({ design: "on" }, "https://evil.com/x")).headers.get("location"), home, "POST with another site's Referer:");
});

// =====================================================================================
console.log("— 5. refusals");
// =====================================================================================
const liveOnly = async (T, cookies, label) => {
  const src = await asRequest(T, () => Res.contentSource(), cookies);
  eq(src.preview, false, `${label}: preview:`);
  eq(src.overlay, undefined, `${label}: overlay:`);
  eq(await asRequest(T, () => Res.resolvedHero(), cookies).then((h) => h.title), "Live hero", `${label}: hero:`);
};
await t("no cookie means live content only; a tampered hmac, an expired session, a revoked session and a token minted for another store are each refused (live only)", async () => {
  await liveOnly(PD, {}, "no cookie");
  const s = await newSession(PD);
  const [p, exp, sid, sig] = s.token.split(".");
  const flip = (c) => (c === "0" ? "1" : "0");
  await liveOnly(PD, withToken(`${p}.${exp}.${sid}.${flip(sig[0])}${sig.slice(1)}`), "tampered hmac");
  await liveOnly(PD, withToken(`${p}.${Number(exp) + 60}.${sid}.${sig}`), "tampered expiry");
  const other = await newSession(PD);
  await liveOnly(PD, withToken(`${p}.${exp}.${other.sid}.${sig}`), "another sid under this signature");
  // expired: the row's expiry passed (the token itself is still in date)
  const e = await newSession(PD);
  await inT(PD, () => libsql.execute({ sql: "UPDATE preview_sessions SET expires_at = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), e.sid] }));
  await liveOnly(PD, withToken(e.token), "expired session");
  // and a token past its own expiry
  const old = await inT(PD, () => R.previewToken({ sid: s.sid, now: Date.now() - 2 * 3600_000 }));
  await liveOnly(PD, withToken(old), "expired token");
  // revoked through the route
  const rv = await newSession(PD);
  eq((await admin(PD, { revoke: rv.sid })).status, 200, "revoke:");
  await liveOnly(PD, withToken(rv.token), "revoked session");
  eq((await admin(PD, { revoke: rv.sid })).status, 404, "revoking twice:");
  // a token for store pa on store pd's host (pa signs with its own secret)
  const fromA = await newSession(PA);
  await liveOnly(PD, withToken(fromA.token), "a token from another store");
  // the same sid copied into pd's table (as if ids collided) still needs pd's signature
  await inT(PD, () => libsql.execute({ sql: "INSERT INTO preview_sessions (id, tenant_id, created_by, created_at, expires_at, show_design) VALUES (?, 'pd', 'x', ?, ?, 0)", args: [fromA.sid, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()] }));
  await liveOnly(PD, withToken(fromA.token), "another store's token, sid present here");
  // a row written for another store, under a correctly signed token here
  const forged = "ps_00000000000000aa";
  await inT(PD, () => libsql.execute({ sql: "INSERT INTO preview_sessions (id, tenant_id, created_by, created_at, expires_at, show_design) VALUES (?, 'pa', 'x', ?, ?, 0)", args: [forged, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()] }));
  await liveOnly(PD, withToken(await inT(PD, () => R.previewToken({ sid: forged }))), "a row of another store");
  await liveOnly(PD, withToken("garbage"), "garbage");
  // the valid one still works (the refusals above are about the token, not the store)
  eq(await asRequest(PD, () => Res.resolvedHero(), withToken(s.token)).then((h) => h.title), "Draft hero two", "the untampered token:");
});

await t("an old-format token on a documents store gives live only; on a legacy store it still gives today's draft preview", async () => {
  const oldTok = await inT(PD, () => R.previewToken());
  ok(/^p\.\d+\.[0-9a-f]{20}$/.test(oldTok), `old format: ${oldTok}`);
  eq(await inT(PD, () => R.verifyPreviewToken(oldTok)), true, "still verifies (open legacy tabs keep working through the deploy):");
  await liveOnly(PD, withToken(oldTok), "old token, documents store");
  // legacy: drafts in the legacy tables, a v3 release live
  await inT(PL, () => S.setBlock("hero", { title: "Legacy live hero" }));
  await inT(PL, () => R.createRelease({ note: "live" }));
  await inT(PL, () => S.setBlock("hero", { title: "Legacy draft hero" }));
  eq(await asRequest(PL, () => Res.resolvedHero()).then((h) => h.title), "Legacy live hero", "legacy shopper:");
  const ltok = await inT(PL, () => R.previewToken());
  const src = await asRequest(PL, () => Res.contentSource(), withToken(ltok));
  eq(src.mode, "draft", "legacy preview mode:");
  eq(src.preview, true, "legacy preview flag:");
  eq(src.overlay, undefined, "no overlay on legacy:");
  eq(await asRequest(PL, () => Res.resolvedHero(), withToken(ltok)).then((h) => h.title), "Legacy draft hero", "legacy preview shows the draft:");
  // the admin route refuses legacy stores: they use the releases preview
  const r = await admin(PL, { create: true });
  eq(r.status, 409, "create on legacy:");
  eq(r.body.code, "STORE_USES_LEGACY", "code:");
  eq(await inT(PL, async () => Number((await libsql.execute("SELECT count(*) AS n FROM preview_sessions")).rows[0].n)), 0, "no session written:");
});

// P2-FIX4: the contentSource branches the review found unpinned.
await t("FIX4: a 'migrating' store with a valid token keeps today's legacy draft preview (old and new token formats)", async () => {
  const ltok = await inT(PL, () => R.previewToken());
  await inT(PL, () => libsql.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1"));
  try {
    const src = await asRequest(PL, () => Res.contentSource(), withToken(ltok));
    eq(src.mode, "draft", "migrating preview mode:");
    eq(src.preview, true, "preview:");
    eq(src.overlay, undefined, "no overlay:");
    eq(await asRequest(PL, () => Res.resolvedHero(), withToken(ltok)).then((h) => h.title), "Legacy draft hero", "the draft shows:");
    const stok = await inT(PL, () => R.previewToken({ sid: "ps_00000000000000bb" }));
    eq((await asRequest(PL, () => Res.contentSource(), withToken(stok))).mode, "draft", "a session-format token too:");
    eq(await asRequest(PL, () => Res.resolvedHero()).then((h) => h.title), "Legacy live hero", "shoppers keep the live release:");
  } finally {
    await inT(PL, () => libsql.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1"));
  }
});

await t("FIX4: when the store's mode can't be read (getCmsMode throws), a valid token gets LIVE content, not drafts (pinned: before P2-PREVIEW it got the legacy draft preview)", async () => {
  const ltok = await inT(PL, () => R.previewToken());
  eq(await asRequest(PL, () => Res.resolvedHero(), withToken(ltok)).then((h) => h.title), "Legacy draft hero", "before: the draft preview:");
  // cms_state readable as a table name, but every read of it fails
  await inT(PL, () => libsql.executeMultiple("ALTER TABLE cms_state RENAME TO cms_state_kept; CREATE TABLE gone (x); CREATE VIEW cms_state AS SELECT * FROM gone; DROP TABLE gone;"));
  try {
    const { CmsModeUnavailableError, getCmsMode } = await import("../lib/cms-mode.js");
    const e = await inT(PL, () => getCmsMode()).then(() => null, (x) => x);
    ok(e instanceof CmsModeUnavailableError, `getCmsMode throws: ${e?.message}`);
    const src = await asRequest(PL, () => Res.contentSource(), withToken(ltok));
    eq(src.preview, false, "no preview:");
    eq(src.mode, "live", "live:");
    eq(await asRequest(PL, () => Res.resolvedHero(), withToken(ltok)).then((h) => h.title), "Legacy live hero", "live content, never the draft:");
  } finally {
    await inT(PL, () => libsql.executeMultiple("DROP VIEW cms_state; ALTER TABLE cms_state_kept RENAME TO cms_state;"));
  }
  eq(await asRequest(PL, () => Res.resolvedHero(), withToken(ltok)).then((h) => h.title), "Legacy draft hero", "repaired:");
});

await t("FIX4: a documents store whose live release is a legacy (v3) one gives a session token live content only", async () => {
  await inT(PV, async () => {
    await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_pv3', ?, 'h3', '', NULL, ?, NULL, ?)", args: [JSON.stringify({ v: 3, blocks: { hero: { title: "V3 live hero" } }, pages: [] }), NOW, NOW] });
    await libsql.execute("UPDATE release_state SET live_release_id = 'rel_pv3' WHERE id = 1");
  });
  await createDraft(PV, "home", body("home", { sections: [sec("hero", "sec_hero", { title: "A v4 draft hero" })] }));
  const s = await newSession(PV);
  const src = await asRequest(PV, () => Res.contentSource(), withToken(s.token));
  eq(src.preview, false, "no preview:");
  eq(src.overlay, undefined, "no overlay:");
  eq(src.mode, "live", "live:");
  eq(src.v, undefined, "the legacy release, not a v4 list:");
  eq(await asRequest(PV, () => Res.resolvedHero(), withToken(s.token)).then((h) => h.title), "V3 live hero", "the live v3 hero, never the draft:");
});

// =====================================================================================
console.log("— 6. failure rows (DOC-04)");
// =====================================================================================
await publish(PF, [{ id: "doc_home", body: LIVE.doc_home }]);
await saveDraft(PF, "doc_home", DRAFT.doc_home);
const PF_SESSION = await newSession(PF);
const pfHero = (cookies) => asRequest(PF, () => Res.resolvedHero(), cookies).then((h) => h.title);

await t("a preview_sessions read failure serves live content (no 5xx) and logs; a drafts read failure likewise", async () => {
  eq(await pfHero(withToken(PF_SESSION.token)), "Draft hero", "before: the overlay works:");
  // break the table: a view over a table that no longer exists
  await inT(PF, () => libsql.executeMultiple("ALTER TABLE preview_sessions RENAME TO preview_sessions_kept; CREATE TABLE gone (x); CREATE VIEW preview_sessions AS SELECT * FROM gone; DROP TABLE gone;"));
  const { result, lines } = await logsDuring(() => pfHero(withToken(PF_SESSION.token)));
  eq(result, "Live hero", "live content:");
  ok(lines.some((l) => l.includes('"evt":"preview_session_read_failed"')), `logged: ${lines}`);
  const src = await asRequest(PF, () => Res.contentSource(), withToken(PF_SESSION.token));
  eq(src.preview, false, "no preview flag (live):");
  await inT(PF, () => libsql.executeMultiple("DROP VIEW preview_sessions; ALTER TABLE preview_sessions_kept RENAME TO preview_sessions;"));
  eq(await pfHero(withToken(PF_SESSION.token)), "Draft hero", "repaired:");
  // the drafts read: documents unreadable for the overlay query only
  const orig = Docs.readDirtyDrafts;
  ok(typeof orig === "function", "readDirtyDrafts exported");
  await inT(PF, () => libsql.executeMultiple("ALTER TABLE documents RENAME TO documents_kept; CREATE TABLE gone (x); CREATE VIEW documents AS SELECT * FROM gone; DROP TABLE gone;"));
  const d = await logsDuring(() => pfHero(withToken(PF_SESSION.token)));
  eq(d.result, "Live hero", "drafts unreadable: live content:");
  ok(d.lines.some((l) => l.includes('"evt":"preview_drafts_read_failed"')), `logged: ${d.lines}`);
  await inT(PF, () => libsql.executeMultiple("DROP VIEW documents; ALTER TABLE documents_kept RENAME TO documents;"));
  eq(await pfHero(withToken(PF_SESSION.token)), "Draft hero", "repaired again:");
});

await t("a missing preview_sessions table means no overlay (and no error, no log)", async () => {
  await inT(PF, () => libsql.executeMultiple("ALTER TABLE preview_sessions RENAME TO preview_sessions_kept;"));
  const { result, lines } = await logsDuring(() => pfHero(withToken(PF_SESSION.token)));
  eq(result, "Live hero", "live:");
  ok(!lines.some((l) => l.includes("preview_session")), `nothing logged: ${lines}`);
  // creating a session on such a store is a 5xx with a code, not a token
  const r = await admin(PF, { create: true });
  ok(r.status >= 500, `create without the table: ${r.status}`);
  eq(r.body.code, "DATABASE_NOT_READY", "code:");
  eq(r.body.token, undefined, "no token:");
  await inT(PF, () => libsql.executeMultiple("ALTER TABLE preview_sessions_kept RENAME TO preview_sessions;"));
});

await t("a session-create write failure returns 5xx with a code and writes nothing", async () => {
  const count = () => inT(PF, async () => Number((await libsql.execute("SELECT count(*) AS n FROM preview_sessions")).rows[0].n));
  const before = await count();
  await inT(PF, () => libsql.execute("CREATE TRIGGER pvo_refuse BEFORE INSERT ON preview_sessions BEGIN SELECT RAISE(ABORT, 'disk said no'); END"));
  const { result: r, lines } = await logsDuring(() => admin(PF, { create: true }));
  ok(r.status >= 500 && r.status < 600, `status ${r.status}`);
  ok(typeof r.body.code === "string" && r.body.code.length > 0, `a code: ${JSON.stringify(r.body)}`);
  ok(/preview didn't update/.test(r.body.error), `founder words: ${r.body.error}`);
  ok(!JSON.stringify(r.body).includes("disk said no"), "no raw database text in the answer");
  eq(r.body.token, undefined, "no token:");
  ok(lines.some((l) => l.includes('"evt":"preview_session_failure"')), "logged");
  eq(await count(), before, "nothing written:");
  // the toggle and revoke writes too
  await inT(PF, () => libsql.execute("DROP TRIGGER pvo_refuse"));
  await inT(PF, () => libsql.execute("CREATE TRIGGER pvo_refuse_u BEFORE UPDATE ON preview_sessions BEGIN SELECT RAISE(ABORT, 'disk said no'); END"));
  const tg = await logsDuring(() => admin(PF, { showDesign: { sid: PF_SESSION.sid, on: true } }));
  ok(tg.result.status >= 500 && tg.result.body.code, `toggle: ${tg.result.status} ${JSON.stringify(tg.result.body)}`);
  await inT(PF, () => libsql.execute("DROP TRIGGER pvo_refuse_u"));
});

// =====================================================================================
console.log("— 7. product_content (known limit until OVL-02)");
// =====================================================================================
await publish(PX, [{ id: "doc_home", body: LIVE.doc_home }]);
await t("a product_content draft is not overlaid", async () => {
  const pc = await createDraft(PX, "product_content", body("product_content", { sections: [sec("rich_text", "sec_pc", { title: "Draft product words", html: "<p>Draft</p>" })] }), { entityId: P(1) });
  ok((await dirtyIds(PX)).includes(pc.id), "the product_content draft is dirty");
  const s = await newSession(PX);
  const src = await asRequest(PX, () => Res.contentSource(), withToken(s.token));
  eq(src.preview, true, "a preview:");
  ok(!src.overlay.documents.includes(pc.id), "not overlaid:");
  ok(!(src.list.drafts instanceof Map && src.list.drafts.has(pc.id)), "no draft body:");
  same(await asRequest(PX, () => Res.resolvedProductOverride(P(1)), withToken(s.token)), { modules: [], badge: "" }, "the product page keeps the neutral v4 answer:");
  same(await asRequest(PX, () => Res.resolvedPdpExtras(), withToken(s.token)), [], "no product words reach the accordions:");
  // the overlay itself refuses the type, even when handed the row
  const row = await inT(PX, async () => (await libsql.execute({ sql: "SELECT id, type, draft, draft_hash FROM documents WHERE id = ?", args: [pc.id] })).rows[0]);
  const o = Docs.overlayList(Docs.previewBaseList(), [{ id: pc.id, type: "product_content", draft: String(row.draft), draft_hash: String(row.draft_hash) }]);
  same(o.documents, [], "overlayList skips product_content:");
  // and the drafts read never returns it
  ok(!(await inT(PX, () => Docs.readDirtyDrafts())).some((r) => r.type === "product_content"), "readDirtyDrafts leaves it out");
});

// =====================================================================================
console.log("— 8. the other-tab note and the preview bar");
// =====================================================================================
await t("the other-tab note appears when a newer session exists for the same user, and not for someone else's", async () => {
  const first = await newSession(PX, OWNER);
  await new Promise((r) => setTimeout(r, 5));
  const otherPerson = await newSession(PX, OTHER);
  const note = async (s) => (await asRequest(PX, () => Res.contentSource(), withToken(s.token))).overlay.otherTab;
  eq(await note(first), false, "someone else's newer session:");
  await new Promise((r) => setTimeout(r, 5));
  const second = await newSession(PX, OWNER);
  eq(await note(first), true, "the older tab:");
  eq(await note(second), false, "the newest tab:");
  eq(await note(otherPerson), false, "the other person:");
  // the newer one revoked or expired: the note goes away
  await admin(PX, { revoke: second.sid });
  eq(await note(first), false, "after the newer one ends:");
  // support (read-only) may preview, and gets its own sessions
  const sup = await admin(PX, { create: true }, { as: SUPPORT });
  eq(sup.status, 200, "support can preview:");
  eq(await note(first), false, "support's session is not the owner's:");
});

// The real layout, compiled with Next's SWC (as test-release-readers does).
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
const toFile = (from, id) => {
  const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
  return p.endsWith(".js") ? p : `${p}.js`;
};
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
async function loadJsx(file, stubs = {}, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs || deps.has(id)) continue;
    if (id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      const target = toFile(file, id);
      deps.set(id, isJsx(target) ? await loadJsx(target, stubs, seen) : await import(pathToFileURL(target).href));
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
const font = () => ({ variable: "" });
const STUBS = {
  "next/font/google": { Geist: font, Geist_Mono: font, Fraunces: font },
  "../globals.css": {},
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "./SearchBox": nothing,
  "./cart/CartButton": nothing,
  "@/components/cart/CartContext": { CartProvider: passthrough },
  "@/components/cart/CartDrawer": nothing,
  "@/components/ServiceWorkerRegister": nothing,
  "@/components/analytics/ConsentBanner": nothing,
  "@/components/analytics/Pixels": nothing,
  "@/components/analytics/ErrorReporter": nothing,
  "@/components/site/SiteNav": nothing,
  "@/components/preview/PreviewBridge": nothing,
};
const Layout = (await loadJsx(join(ROOT, "app/(storefront)/layout.js"), STUBS)).default;
const renderLayout = async () => renderToStaticMarkup(await Layout({ children: React.createElement("p", { id: "page" }, "page body") }));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

await t("the real layout's preview bar: the colours note and toggle while the design draft differs, the other-tab note, nothing for shoppers", async () => {
  const s1 = await newSession(PD);
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await newSession(PD);
  const older = text(await asRequest(PD, () => renderLayout(), withToken(s1.token)));
  ok(older.includes("Draft preview"), "the bar:");
  ok(older.includes("Your new colours are not shown here. Show them"), `colours note: ${older.slice(0, 400)}`);
  ok(older.includes("You opened a newer preview in another tab."), "other-tab note:");
  ok(older.includes("Draft bar"), "the chrome shows the announcement draft:");
  const newer = text(await asRequest(PD, () => renderLayout(), withToken(s2.token)));
  ok(!newer.includes("newer preview"), "no other-tab note on the newest tab:");
  await admin(PD, { showDesign: { sid: s2.sid, on: true } });
  const shown = await asRequest(PD, () => renderLayout(), withToken(s2.token));
  ok(text(shown).includes("Your new colours are shown here. Hide them"), "toggle reads Hide them:");
  ok(/7c3aed/i.test(shown), "the draft accent is in the page's brand variables:");
  const shopper = await asRequest(PD, () => renderLayout());
  ok(!text(shopper).includes("Draft preview") && !text(shopper).includes("colours"), "a shopper sees no bar:");
  ok(!/7c3aed/i.test(shopper) && text(shopper).includes("Live bar"), "a shopper sees the live chrome:");
  // a legacy preview: today's bar, no notes
  const ltok = await inT(PL, () => R.previewToken());
  const legacy = text(await asRequest(PL, () => renderLayout(), withToken(ltok)));
  ok(legacy.includes("Draft preview — this is NOT what shoppers see. Exit preview"), `legacy bar: ${legacy.slice(0, 300)}`);
  ok(!legacy.includes("colours") && !legacy.includes("another tab"), "no documents notes on legacy:");
  // the design draft published (no longer dirty): the note goes away
  await publish(PD, [{ id: "doc_design", body: body("design", { settings: { brand: { accent: "#7c3aed" }, theme: { kit: "glow", version: 1 } } }) }]);
  const after = text(await asRequest(PD, () => renderLayout(), withToken(s1.token)));
  ok(!after.includes("colours"), "no colours note once the design is published:");
});

// =====================================================================================
console.log("— 9. the admin route, migration 0022, edge safety");
// =====================================================================================
await t("admin route: one operation, signed in, same origin; someone else's session is not found", async () => {
  eq(parsePreviewSessionOperation({ create: true, revoke: "ps_0000000000000000" }).code, "AMBIGUOUS_OPERATION", "two ops:");
  eq(parsePreviewSessionOperation({ create: true, block: "hero" }).code, "UNKNOWN_OPERATION", "unknown key:");
  eq(parsePreviewSessionOperation({ showDesign: { sid: "nope", on: true } }).code, "MALFORMED", "bad sid:");
  eq((await admin(PD, { create: true }, { as: null })).status, 401, "signed out:");
  eq((await admin(PD, { create: true }, { origin: "https://evil.test" })).status, 403, "cross-origin:");
  const mine = await newSession(PD, OWNER);
  const theirs = await admin(PD, { showDesign: { sid: mine.sid, on: true } }, { as: OTHER });
  eq(theirs.status, 404, "another person's session:");
  eq(theirs.body.code, "PREVIEW_SESSION_NOT_FOUND", "code:");
  eq((await admin(PD, { revoke: mine.sid }, { as: OTHER })).status, 404, "another person can't revoke it:");
  eq((await asRequest(PD, () => Res.contentSource(), withToken(mine.token))).preview, true, "still good:");
  const made = await admin(PD, { create: true });
  ok(made.body.previewUrl.startsWith("/api/preview?token=p."), `previewUrl: ${made.body.previewUrl}`);
  const row = await inT(PD, async () => (await libsql.execute({ sql: "SELECT * FROM preview_sessions WHERE id = ?", args: [made.body.sid] })).rows[0]);
  eq(String(row.tenant_id), "pd", "tenant-bound row:");
  eq(String(row.created_by), `merchant:${ownerU.id}`, "created_by:");
  eq(String(row.expires_at), made.body.expiresAt, "expires with the token:");
  eq(Number(row.show_design), 0, "show_design starts off:");
});

await t("migration 0022 is additive, re-runs cleanly, and tenant-migrate --check reports a store at 0021 behind and a migrated one current", async () => {
  const M22 = MIGRATIONS.find((m) => m.id === "0022_preview_sessions");
  ok(M22, "0022_preview_sessions is not in migrations/tenant");
  const sql = M22.sql.replace(/--.*$/gm, "");
  for (const m of sql.matchAll(/\b(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW))\s+(\w+)/gi)) ok(/^IF$/i.test(m[2]), `${m[1]} without IF NOT EXISTS`);
  ok(!/\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i.test(sql), "a statement that is not CREATE … IF NOT EXISTS");
  const c = createClient({ url: "file:.test-pvo-m21.db" });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS.filter((m) => m.id < "0022"));
  same((await checkLedger(c, MIGRATIONS)).missing, ["0022_preview_sessions"], "a 0021 store misses exactly 0022:");
  await runMigrations(c, MIGRATIONS);
  await c.executeMultiple(M22.sql); // a second run changes nothing
  ok((await checkLedger(c, MIGRATIONS)).current, "current after 0022");
  const cols = (await c.execute("PRAGMA table_info(preview_sessions)")).rows.map((r) => String(r.name));
  same(cols, ["id", "tenant_id", "created_by", "created_at", "expires_at", "revoked_at", "show_design"], "columns:");
  c.close();
  // the real deploy gate, through the CLI, on this suite's platform (every store here is at 0022)
  const r = spawnSync(process.execPath, ["scripts/tenant-migrate.js", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, PLATFORM_DB_URL: "file:.test-pvo-platform.db", PLATFORM_DB_TOKEN: "", PLATFORM_SECRET: process.env.PLATFORM_SECRET, TURSO_DB_URL: "", DATABASE_URL: "file:.test-pvo-default.db" },
  });
  const out = `${r.stdout}${r.stderr}`;
  eq(r.status, 0, `--check exit (output: ${out.trim().slice(0, 400)}):`);
  ok(out.includes(`✓ pd: current, all ${MIGRATIONS.length} migrations up to 0022_preview_sessions`), `pd current at 0022:\n${out.slice(0, 600)}`);
});

await t("token formats: the new token carries its sid and binds it; the old format still verifies", async () => {
  const s = await newSession(PD);
  same(await inT(PD, () => R.readPreviewToken(s.token)), { exp: Number(s.token.split(".")[1]), sid: s.sid }, "new format:");
  const old = await inT(PD, () => R.previewToken());
  same(await inT(PD, () => R.readPreviewToken(old)), { exp: Number(old.split(".")[1]), sid: null }, "old format:");
  eq(await inT(PA, () => R.readPreviewToken(s.token)), null, "another store:");
});

await t("FIX4: inPreview (lib/tenant-request.js) counts both token formats: a founder's preview reads the store's row fresh, a shopper or a bad token keeps the cached row", async () => {
  const TR = await import("../lib/tenant-request.js");
  const nameNow = (cookies) => asRequest(PD, async () => (await TR.requestResolution()).tenant?.config?.site?.name ?? null, cookies);
  const setName = (n) => C.platformDb().execute({ sql: "UPDATE tenants SET config = json_set(config, '$.site.name', ?) WHERE id = 'pd'", args: [n] });
  const keep = process.env.PLATFORM_CACHE_MS;
  process.env.PLATFORM_CACHE_MS = "600000"; // the cache holds for this test
  const s = await newSession(PD);
  const oldTok = await inT(PD, () => R.previewToken());
  try {
    await setName("PV pd Store");
    await C.getTenant("pd", { fresh: true }); // warm this instance's cache
    eq(await nameNow({}), "PV pd Store", "warm:");
    await setName("Saved just now");
    eq(await nameNow({}), "PV pd Store", "a shopper keeps the cached row:");
    eq(await nameNow(withToken("garbage")), "PV pd Store", "a bad token keeps the cached row:");
    const [p, exp, sid, sig] = s.token.split(".");
    eq(await nameNow(withToken(`${p}.${exp}.${sid}.${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`)), "PV pd Store", "a tampered session token keeps the cached row:");
    eq(await nameNow(withToken(s.token)), "Saved just now", "a session token (p.<exp>.<sid>.<hmac>) reads the row fresh:");
    await setName("Saved again");
    eq(await nameNow(withToken(oldTok)), "Saved again", "an old-format token (p.<exp>.<hmac>) reads the row fresh:");
  } finally {
    await setName("PV pd Store");
    process.env.PLATFORM_CACHE_MS = keep;
    await C.getTenant("pd", { fresh: true });
  }
});

await t("edge safety: no node:* import in lib/preview-sessions.js or anything it and the readers import", async () => {
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:(?!async_hooks["'])[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks)["']/;
  const seen = new Set();
  const walk = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = await readFile(f, "utf8");
    const hit = src.match(nodeImport);
    if (hit) throw new Error(`${relative(ROOT, f)} imports ${hit[1]}`);
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) await walk(resolve(dirname(f), spec.endsWith(".js") ? spec : `${spec}.js`));
  };
  await walk(join(ROOT, "lib/preview-sessions.js"));
  await walk(join(ROOT, "lib/content/documents-reader.js"));
  await walk(join(ROOT, "lib/content/resolve.js"));
  ok(seen.size > 10, "the walk found nothing");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
