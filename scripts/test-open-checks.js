// P6-OPEN suite (PUB-12, US-41, PUB-06): "Before you open your store".
//   pnpm test:open-checks
// Every store here is a local file database made by
// scripts/support/tenant-fixture.js (documents mode, a real catalog sync, no
// live release), registered on a local control plane, and every publish goes
// through the real documents API (lib/admin/documents-api.js: parser,
// requireAdmin, the publish service) with a real owner session. Typesense is
// never configured. Nothing here talks to Shopify: the COD test order's
// after-response work (the Shopify push) is collected, never run, and the
// order is cancelled with a stub that is never reached.
//
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;
import { rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

// The checkout route in plain Node, as scripts/test-commerce.js runs it:
// next/server's after() collected instead of run, next/headers answering for
// one simulated request (globalThis.__ocRequest: its cookies).
globalThis.__ocAfter = [];
const NEXT_SERVER = pathToFileURL(require.resolve("next/server.js")).href;
const SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(`import real from ${JSON.stringify(NEXT_SERVER)};
export const { NextRequest, NextResponse } = real;
export const after = (fn) => { globalThis.__ocAfter.push(fn); };`);
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const jar = () => globalThis.__ocRequest?.cookies || {};
export async function cookies() { const c = jar(); return { get: (n) => (Object.hasOwn(c, n) ? { name: n, value: c[n] } : undefined) }; }
export async function headers() { return { get: () => null }; }
export function draftMode() { return { isEnabled: false }; }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: SERVER_STUB, shortCircuit: true, format: "module" };
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (spec === "next/navigation") return next("next/navigation.js", ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-oc-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "storeasy.test";
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "SHOPIFY_STORE_DOMAIN", "NEXT_PUBLIC_RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]) delete process.env[k];

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("oc");
await rm(join(ROOT, ".test-oc-default.db"), { force: true });
const platform = await F.makePlatform({ name: "oc" });
const { withTenant } = await import("../lib/tenant-context.js");
const R = await import("../lib/registry/index.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const Open = await import("../lib/documents/opening.js");
const Pol = await import("../lib/documents/policy-pages.js");
const Pal = await import("../lib/themes/palettes.js");
const Onb = await import("../lib/onboarding/steps.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { scanText } = await import("./support/banned-copy.js");
const { libsql } = await import("../lib/db.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 6).join("\n   ") || e}`);
  }
}
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const eq = (got, want, label = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${label} expected ${canon(want).slice(0, 900)}, got ${canon(got).slice(0, 900)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// ---- stores and people ---------------------------------------------------------------
const owner = await I.createUser({ email: "owner@oc.test", name: "Asha Rao", password: "owner-pass-opening" });
const OWNER = (await S.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const FOUNDER = { kind: "merchant", id: owner.id };
const stores = [];
async function store(name, { config = {}, secrets = {}, catalogShape = "few" } = {}) {
  const h = await F.makeTenant({ name: `oc-${name}`, id: `oc${name.replace(/-/g, "")}`, mode: "documents", sync: "complete", catalogShape, config: { site: { name: `Store ${name}` }, ...config }, secrets });
  await I.addMembership(owner.id, h.id, "owner");
  stores.push(h);
  return h;
}
const request = (h, body) => ({
  cookies: { get: (n) => (n === "_admin" ? { value: OWNER } : undefined) },
  headers: { get: (k) => ({ host: `${h.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const api = (h, body) => h.run(() => handleDocumentsPut(request(h, body)));
const item = (d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash });
const fresh = (h, id) => h.run(() => Docs.getDocument(id));
const publishSet = async (h, docs, flags = {}) => api(h, { publishSet: await Promise.all(docs.map(async (d) => item(await fresh(h, typeof d === "string" ? d : d.id)))), ...flags });
const offerSet = (offer) => offer.publishSet.map((o) => ({ id: o.id, revision: o.revision, draftHash: o.draftHash }));
const livePointer = (h) => h.run(async () => (await libsql.execute("SELECT live_release_id FROM release_state WHERE id = 1")).rows[0]?.live_release_id ?? null);
const dump = (h) =>
  h.run(async () => {
    const out = [];
    for (const table of ["documents", "document_versions", "publish_log", "releases", "release_state"]) out.push((await libsql.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows.map((r) => ({ ...r })));
    return canon(out);
  });

const homeBody = (title) => ({ schema: 1, type: "home", meta: {}, sections: [{ id: "sec_ochero", kind: "hero", v: 1, enabled: true, settings: { title }, blocks: [] }] });
const pageBody = (slug, title) => ({
  schema: 1,
  type: "page",
  meta: { slug, title, description: "", enabled: true, effective_at: null, window_start: null, window_end: null, redirect_from: [] },
  sections: [{ id: `sec_oc${slug.replace(/[^a-z]/g, "").slice(0, 8)}`, kind: "text", v: 1, enabled: true, settings: { title, body: [`${title} words.`] }, blocks: [] }],
});
const makeHome = (h) => h.run(async () => (await Docs.createDocument({ type: "home", body: homeBody(`Welcome to ${h.name}`), actor: FOUNDER })).document);
// a founder-saved page (createDocument by the founder) or a policy starter draft
const makePage = (h, slug, title, actor = FOUNDER) => h.run(async () => (await Docs.createDocument({ type: "page", body: pageBody(slug, title), actor })).document);
const makeStarter = (h, slug, title) => makePage(h, slug, title, Pol.POLICY_STARTER_ACTOR);
// a generated design draft, as the first run writes it (batch 1's writer)
const makeDesign = (h, palette = "forest") =>
  h.run(async () => {
    await Docs.createFirstRunDocuments({ docs: [{ type: "design", id: "doc_design", body: { ...R.emptyBody("design"), settings: Pal.designBodyFor(palette) } }], actor: Docs.FIRST_RUN_ACTOR });
    return Docs.getDocument("doc_design");
  });
const liveAccent = (h) =>
  h.run(async () => {
    const r = await libsql.execute("SELECT v.body FROM documents d JOIN document_versions v ON v.id = d.published_version_id WHERE d.id = 'doc_design'");
    if (!r.rows.length) return null;
    return JSON.parse(String(r.rows[0].body))?.settings?.brand?.accent ?? null;
  });
const byId = (report) => Object.fromEntries(report.items.map((i) => [i.id, i]));
const levels = (report) => Object.fromEntries(report.items.map((i) => [i.id, i.level]));
const checks = async (h, ids) => {
  const r = await api(h, { openingChecks: { ids } });
  eq(r.status, 200, `openingChecks ${JSON.stringify(r.body).slice(0, 300)}:`);
  return r.body;
};
const BANNED_WORDS = /not implemented|mode reserved/i;
// every item's founder words, and its fix
function checkWords(report, label) {
  for (const i of report.items) {
    ok(Open.OPENING_ITEM_IDS.includes(i.id) && Open.OPENING_LEVELS.includes(i.level), `${label}: item ${i.id} ${i.level}`);
    if (i.level !== "ok") ok(i.href || i.who === "support" || (Array.isArray(i.actions) && i.actions.length), `${label}: ${i.id} (${i.level}) has an href, who 'support' or an action: ${JSON.stringify(i)}`);
    for (const text of [i.title, i.message, i.linkLabel, ...(i.actions || []).map((a) => a.label)].filter((x) => x != null)) {
      eq(scanText(text), [], `${label}: banned copy in ${JSON.stringify(text)}:`);
      ok(!BANNED_WORDS.test(text), `${label}: developer words in ${JSON.stringify(text)}`);
      ok(!/\b(?:doc|ver|log|set|rel)_[A-Za-z0-9]+/.test(text), `${label}: an id in ${JSON.stringify(text)}`);
    }
  }
  const order = report.items.map((i) => Open.OPENING_ITEM_IDS.indexOf(i.id));
  ok(order.every((n, k) => !k || n > order[k - 1]), `${label}: items in the fixed order: ${report.items.map((i) => i.id).join(", ")}`);
}

// ---- a. payment (always) ------------------------------------------------------------------
console.log("— payment blocks, flag or not, confirm or not");
const PAY_CASES = [
  ["checkout_mode 'disabled'", { checkout_mode: "disabled" }, { href: "/admin/settings#commerce", who: null }],
  ["checkout_mode 'shopify'", { checkout_mode: "shopify" }, { href: null, who: "support" }],
  ["billing degraded", { billing: { status: "halted", plan: "starter" } }, { href: "/admin/billing", who: null }],
];
const pay = await store("pay");
const PAY_HOME = await makeHome(pay);
for (const [name, cfg, want] of PAY_CASES) {
  await t(`a. ${name}: publishSet [home] is 409 STORE_CANNOT_TAKE_PAYMENT without the flags, with checkOpening and with confirmOpen too; nothing goes live; the payment item is a block with href ${want.href} and who ${want.who}`, async () => {
    const base = { ...pay.tenant.config };
    Object.assign(pay.tenant.config, cfg);
    try {
      const before = await dump(pay);
      for (const flags of [{}, { checkOpening: true }, { checkOpening: true, confirmOpen: true }, { confirmOpen: true }]) {
        const r = await publishSet(pay, [PAY_HOME], flags);
        eq([r.status, r.body.code], [409, "STORE_CANNOT_TAKE_PAYMENT"], `${JSON.stringify(flags)}:`);
        const p = byId(r.body.report).payment;
        eq([p.level, p.href, p.who], ["block", want.href, want.who], `${JSON.stringify(flags)} payment item:`);
        ok(r.body.error.startsWith(Pub.PAYMENT_LEAD) && r.body.error.endsWith(p.message), `words: ${r.body.error}`);
        ok(!/not implemented|mode reserved|Shopify-hosted|disabled for this store/i.test(r.body.error), `no developer words: ${r.body.error}`);
        checkWords(r.body.report, `${name} ${JSON.stringify(flags)}`);
      }
      eq(await livePointer(pay), null, "nothing is live:");
      eq(await dump(pay), before, "nothing was written:");
    } finally {
      pay.tenant.config = base;
    }
  });
}

await t("a. the payment item never echoes checkoutCapability's reason (developer words), for any blocking cause", async () => {
  const A = await import("../lib/commerce/adapter.js");
  const base = { ...pay.tenant.config };
  try {
    for (const [, cfg] of PAY_CASES) {
      pay.tenant.config = { ...base, ...cfg };
      const reason = pay.run(() => A.checkoutCapability().reason);
      const p = byId((await checks(pay, [PAY_HOME.id]))).payment;
      ok(reason && !p.message.includes(reason) && !p.title.includes(reason), `${reason} not echoed: ${p.message}`);
    }
  } finally {
    pay.tenant.config = base;
  }
});

console.log("— maintenance is its own warning; it never hides the payment block");
await t("a. maintenance on PLUS checkout_mode 'disabled' is still 409 STORE_CANNOT_TAKE_PAYMENT (checkOpening, confirmOpen); the report has the payment block AND the maintenance warn (who 'support')", async () => {
  const base = { ...pay.tenant.config };
  pay.tenant.config = { ...base, checkout_mode: "disabled", maintenance: { enabled: true } };
  try {
    const r = await publishSet(pay, [PAY_HOME], { checkOpening: true, confirmOpen: true });
    eq([r.status, r.body.code], [409, "STORE_CANNOT_TAKE_PAYMENT"], "maintenance + disabled:");
    const it = byId(r.body.report);
    eq([it.payment.level, it.payment.href], ["block", "/admin/settings#commerce"], "the real cause:");
    eq([it.maintenance.level, it.maintenance.who, it.maintenance.href], ["warn", "support", null], "maintenance:");
    eq(it.maintenance.message, Open.WORDS.maintenance, "maintenance words:");
    eq(await livePointer(pay), null, "nothing is live:");
  } finally {
    pay.tenant.config = base;
  }
});
await t("a. maintenance on with direct checkout is a warn, not a block: the payment item is not a block, and the publish is not STORE_CANNOT_TAKE_PAYMENT", async () => {
  const base = { ...pay.tenant.config };
  pay.tenant.config = { ...base, maintenance: { enabled: true } };
  try {
    const rep = await checks(pay, [PAY_HOME.id]);
    const it = byId(rep);
    eq(it.maintenance.level, "warn", "maintenance:");
    ok(it.payment.level !== "block", `payment: ${it.payment.level}`);
    ok(!rep.items.some((i) => i.level === "block" && i.id === "maintenance"), "no maintenance block");
    const r = await publishSet(pay, [PAY_HOME], { checkOpening: true, confirmOpen: true });
    ok(r.body.code !== "STORE_CANNOT_TAKE_PAYMENT", `not a payment block: ${r.body.code}`);
    eq(await livePointer(pay), null, "nothing is live (the policies still block):");
  } finally {
    pay.tenant.config = base;
  }
});

// ---- e. the confirm, and every item's words ---------------------------------------------------
console.log("— warnings need confirmOpen; every item has founder words and a fix");
await t("e. with checkOpening, founder-saved privacy and 'terms' pages (and the design) in the set, no test order and no contact: 409 OPENING_CONFIRM_NEEDED listing test_order and contact as warn, privacy and returns as ok; the same set with confirmOpen opens the store", async () => {
  const h = await store("confirm");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy-policy", "Privacy policy");
  const terms = await makePage(h, "terms", "Terms and refunds");
  const set = [home, design, privacy, terms];
  const r = await publishSet(h, set, { checkOpening: true });
  eq([r.status, r.body.code], [409, "OPENING_CONFIRM_NEEDED"], "status:");
  eq(r.body.error, Pub.CONFIRM_MESSAGE, "words:");
  const lv = levels(r.body.report);
  eq([lv.test_order, lv.contact, lv.privacy, lv.returns, lv.design, lv.catalog], ["warn", "warn", "ok", "ok", "ok", "ok"], "levels:");
  eq(r.body.report.items.map((i) => i.id), ["payment", "privacy", "returns", "test_order", "catalog", "contact", "design"], "every item, ok ones included, in order:");
  checkWords(r.body.report, "confirm");
  eq(byId(r.body.report).test_order.message, Onb.TEST_ORDER_CLOSED_HINT, "test order words are onboarding's:");
  eq(byId(r.body.report).test_order.href, "/admin/editor", "test order link:");
  eq(byId(r.body.report).contact.href, "/admin/settings#store-profile", "contact link:");
  eq(await livePointer(h), null, "nothing is live yet:");
  const opened = await publishSet(h, set, { checkOpening: true, confirmOpen: true });
  eq(opened.status, 200, `confirmOpen opens: ${JSON.stringify(opened.body).slice(0, 300)}`);
  ok(await livePointer(h), "the store is open");
  eq(opened.body.published.map((p) => p.id).sort(), set.map((d) => d.id).sort(), "the whole set went live:");
});

await t("words: no item ever says 'not implemented' or 'mode reserved', and banned-copy finds nothing, in every state the report can take (payment block, info, ok; maintenance; starter, missing, saved policies; no products; no design)", async () => {
  const h = await store("words", { catalogShape: "empty" });
  await makeStarter(h, "privacy", "Privacy");
  await makePage(h, "returns", "Returns");
  const base = { ...h.tenant.config };
  for (const cfg of [{}, { checkout_mode: "disabled" }, { checkout_mode: "shopify" }, { billing: { status: "expired" } }, { maintenance: { enabled: true } }]) {
    h.tenant.config = { ...base, ...cfg };
    const rep = await checks(h, []);
    checkWords(rep, `words ${JSON.stringify(cfg)}`);
    eq(byId(rep).catalog.level, "warn", "no products is a warn:");
    eq(byId(rep).catalog.href, "/admin/settings#catalog-sync", "catalog link:");
    eq(byId(rep).catalog.message, Open.WORDS.catalogEmpty, "catalog words:");
  }
  h.tenant.config = { ...base, ...{} };
  const rep = await checks(h, []);
  eq(byId(rep).payment.level, "info", "no Razorpay keys: cash on delivery only:");
  eq([byId(rep).payment.title, byId(rep).payment.href], ["Cash on delivery only", "/admin/settings#payments"], "COD-only item:");
  h.tenant.config = { ...base, razorpay_key_id: "rzp_test_dummy" };
  h.tenant.secrets = { ...h.tenant.secrets, razorpay_key_secret: "dummy-local-secret" };
  eq(byId(await checks(h, [])).payment.level, "ok", "with both Razorpay keys the payment item is ok:");
  h.tenant.config = base;
});

// ---- d. the policies (owner answer OQ-P6-1) ----------------------------------------------------
console.log("— missing policies block (owner answer OQ-P6-1)");
await t("d. with checkOpening and NO policy pages, publishSet [home, doc_design] is 409 OPENING_NEEDS_POLICIES with and without confirmOpen; privacy and returns are blocks with 'startPolicy' actions; the offer adds no page; nothing goes live", async () => {
  const h = await store("nopol");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const before = await dump(h);
  for (const flags of [{ checkOpening: true }, { checkOpening: true, confirmOpen: true }]) {
    const r = await publishSet(h, [home, design], flags);
    eq([r.status, r.body.code], [409, "OPENING_NEEDS_POLICIES"], `${JSON.stringify(flags)}:`);
    eq(r.body.offer, null, "no page is offered:");
    eq(r.body.error, "Your store needs a privacy page and a returns page before it opens, so nothing was published.", "words:");
    const it = byId(r.body.report);
    for (const kind of ["privacy", "returns"]) {
      eq(it[kind].level, "block", `${kind}:`);
      eq(it[kind].actions, [{ type: "startPolicy", kind, label: kind === "privacy" ? "Start a privacy page" : "Start a returns page" }], `${kind} action:`);
      eq(it[kind].message, Open.policyWords(kind).missing, `${kind} words:`);
    }
    ok(it.returns.message.includes("(your terms, returns and refunds)"), "returns says what it covers");
    eq(r.body.report.offer, null, "the report's offer adds nothing:");
    checkWords(r.body.report, `nopol ${JSON.stringify(flags)}`);
  }
  eq(await livePointer(h), null, "nothing is live:");
  eq(await dump(h), before, "nothing was written:");
  // only a founder-saved privacy page in the set: still 409 (returns missing)
  const privacy = await makePage(h, "privacy-policy", "Privacy policy");
  const r2 = await publishSet(h, [home, design, privacy], { checkOpening: true, confirmOpen: true });
  eq([r2.status, r2.body.code], [409, "OPENING_NEEDS_POLICIES"], "privacy alone:");
  eq([levels(r2.body.report).privacy, levels(r2.body.report).returns], ["ok", "block"], "privacy ok, returns blocks:");
  eq(r2.body.error, "Your store needs a returns page before it opens, so nothing was published.", "words:");
  eq(await livePointer(h), null, "still nothing live:");
  // both in the set (and confirmOpen for the warns): the store opens
  const returns = await makePage(h, "refund-policy", "Refunds");
  const r3 = await publishSet(h, [home, design, privacy, returns], { checkOpening: true, confirmOpen: true });
  eq(r3.status, 200, `both pages: ${JSON.stringify(r3.body).slice(0, 300)}`);
  ok(await livePointer(h), "open");
});

console.log("— the review rule (OQ-P6-3)");
await t("d. a starter draft (POLICY_STARTER_ACTOR) not in the set is a block with href /admin/editor?doc=<id>, linkLabel 'Read it' and a markPolicyRead action with its id and revision, and is never in any offer; the same starter placed in the set counts and the store opens", async () => {
  const h = await store("starter");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const starter = await makeStarter(h, "privacy-policy", "Privacy policy");
  const terms = await makePage(h, "terms", "Terms");
  eq((await h.run(() => libsql.execute({ sql: "SELECT updated_by FROM documents WHERE id = ?", args: [starter.id] }))).rows[0].updated_by, Pol.POLICY_STARTER_BY, "the starter mark:");
  const r = await publishSet(h, [home, design, terms], { checkOpening: true, confirmOpen: true });
  eq([r.status, r.body.code], [409, "OPENING_NEEDS_POLICIES"], "status:");
  const p = byId(r.body.report).privacy;
  eq([p.level, p.href, p.linkLabel], ["block", `/admin/editor?doc=${starter.id}`, "Read it"], "the starter item:");
  eq(p.actions, [{ type: "markPolicyRead", id: starter.id, revision: starter.revision, label: "I've read it" }], "I've read it:");
  eq(p.message, "We started a privacy page for you from a template. It's a starting point, not legal advice: read it, change what you need and save it before you open.", "words:");
  eq(r.body.offer, null, "no offer (the starter is the founder's to read):");
  const rep = await checks(h, [home.id, design.id, terms.id]);
  ok(!(rep.offer?.publishSet || []).some((o) => o.id === starter.id), "openingChecks never offers the starter");
  ok(!(r.body.report.offer?.publishSet || []).some((o) => o.id === starter.id), "the publish report never offers it either");
  // the founder places the starter in the set: it counts
  const opened = await publishSet(h, [home, design, terms, starter], { checkOpening: true, confirmOpen: true });
  eq(opened.status, 200, `the starter in the set: ${JSON.stringify(opened.body).slice(0, 300)}`);
  ok(await livePointer(h), "open");
});

await t("d. founder-saved privacy and returns drafts not in the set are info items and the offer adds them (with their revisions and draftHashes); publishing the offer opens the store with both pages live", async () => {
  const h = await store("saved");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy", "Privacy");
  const returns = await makePage(h, "returns-and-refunds", "Returns and refunds");
  const r = await publishSet(h, [home, design], { checkOpening: true, confirmOpen: true });
  eq([r.status, r.body.code], [409, "OPENING_NEEDS_POLICIES"], "status:");
  eq(r.body.error, "Publish your privacy and returns pages with this, so your store opens with them. Nothing was published.", "words:");
  const it = byId(r.body.report);
  eq([it.privacy.level, it.returns.level], ["info", "info"], "info items:");
  eq(it.privacy.message, "Your privacy page goes live too.", "privacy words:");
  eq(it.returns.message, "Your returns page (your terms, returns and refunds) goes live too.", "returns words:");
  eq([it.privacy.href, it.privacy.linkLabel], [`/admin/editor?doc=${privacy.id}`, "Open “Privacy”"], "named, with a link:");
  eq(
    r.body.offer.publishSet,
    [home, design, privacy, returns].map((d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash, label: d.label })),
    "the offer adds both pages:",
  );
  checkWords(r.body.report, "saved");
  const opened = await api(h, { publishSet: offerSet(r.body.offer), checkOpening: true, confirmOpen: true });
  eq(opened.status, 200, `the offer opens: ${JSON.stringify(opened.body).slice(0, 300)}`);
  for (const d of [privacy, returns]) ok((await fresh(h, d.id)).publishedVersionId, `${d.label} is live`);
});

await t("d (pinned contract, known limit): WITHOUT checkOpening a set with no policy pages and no design opens the store", async () => {
  const h = await store("noflag");
  const home = await makeHome(h);
  const r = await publishSet(h, [home]);
  eq(r.status, 200, `opens: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(await livePointer(h), "open");
  eq(await liveAccent(h), null, "no design went live (the platform's default brand):");
  eq((await h.run(() => libsql.execute("SELECT COUNT(*) AS n FROM documents WHERE id = 'doc_design'"))).rows[0].n, 0, "no design draft was made:");
});

// ---- b and c. the design ---------------------------------------------------------------------
console.log("— a left-out design draft (always) and the slate draft (checkOpening)");
await t("b. publishing [home] WITHOUT checkOpening while a generated doc_design draft exists is 409 OPENING_NEEDS_DESIGN with an offer holding doc_design; publishing the offer opens the store with a non-lime live accent", async () => {
  const h = await store("gen");
  const home = await makeHome(h);
  const design = await makeDesign(h, "forest");
  const before = await dump(h);
  const r = await publishSet(h, [home]);
  eq([r.status, r.body.code], [409, "OPENING_NEEDS_DESIGN"], "status:");
  eq(r.body.error, Pub.NEEDS_DESIGN_MESSAGE, "words:");
  eq(offerSet(r.body.offer), [item(home), item(design)], "the offer is the set plus doc_design:");
  eq(byId(r.body.report).design.level, "info", "the design item:");
  eq(await dump(h), before, "nothing was written:");
  const opened = await api(h, { publishSet: offerSet(r.body.offer) });
  eq(opened.status, 200, `the offer opens: ${JSON.stringify(opened.body).slice(0, 300)}`);
  const accent = await liveAccent(h);
  eq(accent, Pal.paletteById("forest").brand.accent, "the forest accent is live:");
  ok(!Pal.isLimeAccent(accent), `not lime: ${accent}`);
});

await t("FIRST_PUBLISH_NEEDS_HOME keeps its shape and its offer now adds an unpublished doc_design draft too", async () => {
  const h = await store("needshome");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy", "Privacy");
  const r = await publishSet(h, [privacy]);
  eq([r.status, r.body.code], [409, "FIRST_PUBLISH_NEEDS_HOME"], "status:");
  eq(Object.keys(r.body).sort(), ["code", "error", "offer"], "its keys:");
  eq(offerSet(r.body.offer), [item(privacy), item(home), item(design)], "set + home + design:");
  // a design already in the set is not added twice
  const r2 = await publishSet(h, [privacy, design]);
  eq(offerSet(r2.body.offer), [item(privacy), item(design), item(home)], "design in the set:");
});

await t("c. with checkOpening, founder-saved privacy and 'terms' pages in the set (confirmOpen for the warns) and NO doc_design row: 409 OPENING_NEEDS_DESIGN, and a slate doc_design draft by system:first-run now exists; publishing the offer opens non-lime", async () => {
  const h = await store("slate");
  const home = await makeHome(h);
  const privacy = await makePage(h, "privacy-policy", "Privacy policy");
  const terms = await makePage(h, "terms", "Terms");
  const rep = await checks(h, [home.id, privacy.id, terms.id]);
  eq([byId(rep).design.level, byId(rep).design.message], ["info", Open.WORDS.designSlate], "the report says Slate:");
  const r = await publishSet(h, [home, privacy, terms], { checkOpening: true, confirmOpen: true });
  eq([r.status, r.body.code], [409, "OPENING_NEEDS_DESIGN"], "status:");
  const row = (await h.run(() => libsql.execute("SELECT updated_by, published_version_id, draft FROM documents WHERE id = 'doc_design'"))).rows[0];
  ok(row, "the design draft exists");
  eq([row.updated_by, row.published_version_id], [Docs.FIRST_RUN_BY, null], "made by the first run, not live:");
  eq(JSON.parse(String(row.draft)).settings.brand.accent, Pal.paletteById(Pal.DEFAULT_PALETTE_ID).brand.accent, "the slate accent:");
  const design = await fresh(h, "doc_design");
  eq(offerSet(r.body.offer), [item(home), item(privacy), item(terms), item(design)], "the offer adds the slate draft:");
  eq(await livePointer(h), null, "nothing live yet:");
  const opened = await api(h, { publishSet: offerSet(r.body.offer), checkOpening: true, confirmOpen: true });
  eq(opened.status, 200, `the offer opens: ${JSON.stringify(opened.body).slice(0, 300)}`);
  const accent = await liveAccent(h);
  ok(accent && !Pal.isLimeAccent(accent), `a non-lime live accent: ${accent}`);
});

// ---- test order ------------------------------------------------------------------------------
console.log("— the test order: a preview COD order (cancelled after) or the manual check-off");
const checkoutRoute = await import("../app/api/checkout/route.js");
const PS = await import("../lib/preview-sessions.js");
const Res = await import("../lib/content/resolve.js");
const { createCart, addItem, getCart, CART_COOKIE } = await import("../lib/cart.js");
const { NextRequest } = require("next/server.js");
const { cancelOrder } = await import("../lib/order-cancel.js");
async function previewCodOrder(h) {
  const cartId = `oc-cart-${h.id}`;
  await h.run(async () => {
    await createCart(cartId);
    await addItem(cartId, h.products[0].variants.nodes[0].id, 1);
  });
  const s = await h.run(() => PS.createPreviewSession({ actor: FOUNDER }));
  const cart = await h.run(() => getCart(cartId));
  const { computeShipping } = await import("../lib/shipping.js");
  const ship = computeShipping({ subtotal: cart.subtotal || 0, discountTotal: cart.discountTotal || 0, paymentMethod: "cod", pincode: "411001", config: undefined });
  const cookies = { [CART_COOKIE]: cartId, [Res.PREVIEW_COOKIE]: s.token };
  const body = {
    action: "cod",
    contact: { email: "snehal@mediastic.in", phone: "9999999999", name: "Open Checks Test" },
    address: { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" },
    idempotencyKey: `oc-${h.id}`,
    expectedTotal: (cart.total || 0) + ship.total,
    expectedShipping: ship.total,
  };
  const req = new NextRequest(`https://${h.id}.test/api/checkout`, {
    method: "POST",
    headers: { host: `${h.id}.test`, "content-type": "application/json", cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
    body: JSON.stringify(body),
  });
  globalThis.__ocRequest = { cookies };
  try {
    const res = await checkoutRoute.POST(req);
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.__ocRequest = null;
    globalThis.__ocAfter.length = 0; // the Shopify push and events are never run
  }
}
await t("test_order: a preview COD order placed while the store is closed (the P3-CLOSED path), then cancelled, turns test_order ok", async () => {
  const h = await store("order");
  const home = await makeHome(h);
  const before = byId(await checks(h, [home.id])).test_order;
  eq([before.level, before.href, before.message], ["warn", "/admin/editor", Onb.TEST_ORDER_CLOSED_HINT], "no order yet:");
  const placed = await previewCodOrder(h);
  eq(placed.status, 200, `the COD order: ${JSON.stringify(placed.body)}`);
  const cancelled = await h.run(() => cancelOrder(placed.body.orderId, { reason: "test order", gql: async () => { throw new Error("Shopify is never called here"); } }));
  ok(cancelled.ok, `cancelled: ${JSON.stringify(cancelled)}`);
  const row = (await h.run(() => libsql.execute({ sql: "SELECT status, email FROM orders WHERE id = ?", args: [placed.body.orderId] }))).rows[0];
  eq([row.status, row.email], ["cancelled", "snehal@mediastic.in"], "the order is cancelled:");
  eq(byId(await checks(h, [home.id])).test_order.level, "ok", "a cancelled test order counts:");
});
await t("test_order: the onboarding manual check-off turns test_order ok too", async () => {
  const h = await store("manual");
  eq(byId(await checks(h, [])).test_order.level, "warn", "before:");
  h.tenant.config = { ...h.tenant.config, onboarding: { manual: { test_order: new Date().toISOString() } } };
  eq(byId(await checks(h, [])).test_order.level, "ok", "after the check-off:");
});
await t("privacy and 'terms' pages in the set turn privacy and returns ok, from the same policyStatus (lib/documents/policy-pages.js) onboarding shares", async () => {
  const h = await store("polset");
  const privacy = await makeStarter(h, "privacy-policy", "Privacy policy");
  const terms = await makeStarter(h, "terms", "Terms");
  const ids = [privacy.id, terms.id];
  const st = Pol.policyStatus(await h.run(() => Pol.readPolicyRows()), ids);
  eq([st.privacy.state, st.returns.state], ["inSet", "inSet"], "policyStatus:");
  const it = byId(await checks(h, ids));
  eq([it.privacy.level, it.returns.level], ["ok", "ok"], "the report:");
  const out = byId(await checks(h, []));
  eq([out.privacy.level, out.returns.level], ["block", "block"], "out of the set they are starters:");
});

// ---- live store: POLICY_PAGE_MISSING; rowsOnly -------------------------------------------------
console.log("— a live store: POLICY_PAGE_MISSING on sets that touch a policy page; rowsOnly runs no opening checks");
await t("live: a set that changes the last returns page's slug answers 200 with a POLICY_PAGE_MISSING warning; a set that does not touch a policy page has none; openingChecks says opening: false", async () => {
  const h = await store("live");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy", "Privacy");
  const returns = await makePage(h, "returns", "Returns");
  const opened = await publishSet(h, [home, design, privacy, returns], { checkOpening: true, confirmOpen: true });
  eq(opened.status, 200, `opened: ${JSON.stringify(opened.body).slice(0, 300)}`);
  eq(opened.body.issues.filter((i) => i.code === "POLICY_PAGE_MISSING"), [], "opening with both pages: no warning:");
  // the founder moves the returns page to /shipping
  const cur = await fresh(h, returns.id);
  await h.run(() => Docs.saveDraft({ id: cur.id, revision: cur.revision, body: { ...cur.body, meta: { ...cur.body.meta, slug: "shipping", title: "Shipping" } }, actor: FOUNDER }));
  const r = await publishSet(h, [returns]);
  eq(r.status, 200, `still succeeds: ${JSON.stringify(r.body).slice(0, 300)}`);
  const w = r.body.issues.filter((i) => i.code === "POLICY_PAGE_MISSING");
  eq(w.map((i) => [i.severity, i.level, i.documentId, i.message]), [["warning", "warns", returns.id, Pub.POLICY_MISSING_WORDS.returns]], "one warning, for returns:");
  eq(Object.keys(w[0]).sort(), ["actions", "anchor", "autoFix", "blockId", "code", "documentId", "field", "level", "message", "sectionId", "severity", "where"], "a publish issue:");
  ok(w[0].actions.length > 0, "it has an action");
  // a set that doesn't touch a policy page: no such warning
  const hc = await fresh(h, home.id);
  await h.run(() => Docs.saveDraft({ id: hc.id, revision: hc.revision, body: homeBody("A new welcome"), actor: FOUNDER }));
  const r2 = await publishSet(h, [home]);
  eq(r2.status, 200, "home publish:");
  eq(r2.body.issues.filter((i) => i.code === "POLICY_PAGE_MISSING"), [], "no warning for a set that touches no policy page:");
  const rep = await checks(h, [home.id]);
  eq([rep.opening, rep.items, rep.offer], [false, [], null], "openingChecks on a live store:");
});
await t("rowsOnly: a set of only product content on a CLOSED store with checkout off runs no opening checks (no payment block) and opens nothing", async () => {
  const h = await store("rows", { config: { checkout_mode: "disabled" } });
  const pc = await h.run(async () => (await Docs.openEntityContent({ type: "product_content", entityId: h.products[0].id, actor: FOUNDER })).document);
  const r = await api(h, { publish: { id: pc.id, draftHash: pc.draftHash }, revision: pc.revision, checkOpening: true });
  eq(r.status, 200, `product content publishes: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(r.body.release, null, "a live row, no release:");
  eq(await livePointer(h), null, "the store stays closed:");
});

// ---- openingChecks ---------------------------------------------------------------------------
console.log("— openingChecks: a read");
await t("openingChecks: a generated doc_design draft and a founder-saved privacy draft not in the set give design info, privacy info, and an offer adding both with their revisions and draftHashes", async () => {
  const h = await store("oc");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy", "Privacy");
  const rep = await checks(h, [home.id]);
  eq(rep.opening, true, "closed:");
  const it = byId(rep);
  eq([it.design.level, it.design.message, it.privacy.level], ["info", Open.WORDS.designDraft, "info"], "info items:");
  eq(it.returns.level, "block", "returns is missing:");
  eq(rep.offer.publishSet, [home, design, privacy].map((d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash, label: d.label })), "the offer:");
  checkWords(rep, "openingChecks");
});
await t("openingChecks: with no doc_design row it writes nothing (no design draft, no row anywhere)", async () => {
  const h = await store("ocnone");
  const home = await makeHome(h);
  const before = await dump(h);
  const rep = await checks(h, [home.id]);
  eq(byId(rep).design.message, Open.WORDS.designSlate, "says Slate:");
  eq(rep.offer, null, "nothing to add:");
  eq(await dump(h), before, "nothing was written:");
});
// P6-FIX2 (from the P6-OPEN-UI review): openingChecks itself answers "nothing
// to open" for a set of product and collection content alone on a closed
// store, the publish's own rowsOnly rule, so no caller sees a report that
// does not apply. A mixed set, an empty one, or an unknown id still reports.
await t("openingChecks (P6-FIX2): a set of only product and collection content on a CLOSED store answers opening:false with no items and no offer; a mixed set, an empty set and an unknown id still get the report; nothing is written", async () => {
  const h = await store("ocrows", { config: { checkout_mode: "disabled" } });
  const home = await makeHome(h);
  await makeDesign(h);
  const collectionId = await h.run(async () => String((await libsql.execute("SELECT id FROM collections ORDER BY id LIMIT 1")).rows[0].id));
  const pc = await h.run(async () => (await Docs.openEntityContent({ type: "product_content", entityId: h.products[0].id, actor: FOUNDER })).document);
  const cc = await h.run(async () => (await Docs.openEntityContent({ type: "collection_content", entityId: collectionId, actor: FOUNDER })).document);
  const before = await dump(h);
  for (const set of [[pc.id], [cc.id], [pc.id, cc.id]]) {
    const rep = await checks(h, set);
    eq([rep.opening, rep.items, rep.offer], [false, [], null], `rows only ${JSON.stringify(set)}:`);
  }
  ok((await livePointer(h)) == null, "the store is closed");
  // the report still applies when the set holds anything else
  for (const set of [[pc.id, home.id], [home.id], [], [pc.id, "doc_nosuch"]]) {
    const rep = await checks(h, set);
    eq(rep.opening, true, `${JSON.stringify(set)} opens:`);
    eq(byId(rep).payment.level, "block", `${JSON.stringify(set)}: checkout off blocks:`);
  }
  // the mixed set's offer keeps the product content in it, with its shape
  const mixed = await checks(h, [pc.id, home.id]);
  eq(mixed.offer.publishSet.slice(0, 2), [pc, home].map((d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash, label: d.label })), "the mixed offer:");
  eq(await dump(h), before, "nothing was written:");
});
await t("openingChecks: a legacy store answers 409 STORE_USES_LEGACY (it checks the mode itself)", async () => {
  const h = await F.makeTenant({ name: "oc-legacy", id: "oclegacy", products: 1 });
  stores.push(h);
  await I.addMembership(owner.id, h.id, "owner");
  const r = await api(h, { openingChecks: { ids: [] } });
  eq([r.status, r.body.code], [409, "STORE_USES_LEGACY"], "legacy:");
});

// ---- the parser and the API ------------------------------------------------------------------
console.log("— checkOpening and confirmOpen through the real API");
await t("API: checkOpening and confirmOpen are accepted as top-level booleans on publish and publishSet (they reach the service), refused on any other op and as non-booleans (400 MALFORMED, nothing written)", async () => {
  const h = await store("parse", { config: { checkout_mode: "disabled" } });
  const home = await makeHome(h);
  // accepted: the payment block proves the request reached the service
  for (const body of [
    { publish: { id: home.id, draftHash: home.draftHash }, revision: home.revision, checkOpening: true, confirmOpen: false },
    { publishSet: [item(home)], checkOpening: false, confirmOpen: true },
  ]) {
    const r = await api(h, body);
    eq([r.status, r.body.code], [409, "STORE_CANNOT_TAKE_PAYMENT"], `${Object.keys(body)[0]} accepted:`);
  }
  const before = await dump(h);
  for (const body of [
    { publish: { id: home.id, draftHash: home.draftHash }, revision: home.revision, checkOpening: "true" },
    { publishSet: [item(home)], confirmOpen: 1 },
    { saveDraft: { id: home.id, body: home.body }, revision: home.revision, checkOpening: true },
    { getDocument: home.id, confirmOpen: true },
    { listChanges: { id: home.id }, checkOpening: false },
    { openingChecks: { ids: [home.id] }, checkOpening: true },
  ]) {
    const r = await api(h, body);
    eq([r.status, r.body.code], [400, "MALFORMED"], `${JSON.stringify(body).slice(0, 120)}:`);
  }
  eq(await dump(h), before, "nothing was written:");
});
await t("API: the editor's flags travel: a spy publish module receives checkOpening and confirmOpen exactly as sent", async () => {
  const Api = await import("../lib/admin/documents-api.js");
  const seen = [];
  Api.setDocumentsApiModules({ Publish: { publish: async (a) => (seen.push([a.checkOpening, a.confirmOpen]), { release: null, setId: null, published: [], skipped: [], issues: [] }) } });
  try {
    const h = stores.find((s) => s.name === "oc-parse");
    const home = await fresh(h, "doc_home");
    await api(h, { publishSet: [item(home)], checkOpening: true, confirmOpen: true });
    await api(h, { publishSet: [item(home)] });
    await api(h, { publish: { id: home.id, draftHash: home.draftHash }, revision: home.revision, checkOpening: true });
  } finally {
    Api.setDocumentsApiModules({});
  }
  eq(seen, [[true, true], [false, false], [true, false]], "flags:");
});

// ---- the rebuild loop -------------------------------------------------------------------------
console.log("— the rules run again inside the rebuild loop");
await t("rebuild: checkout turned off after the first build loses its race is refused on the rebuild (STORE_CANNOT_TAKE_PAYMENT), nothing live", async () => {
  const h = await store("race");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy", "Privacy");
  const terms = await makePage(h, "terms", "Terms");
  let calls = 0;
  Pub.setPublishHooks({
    commit: async () => {
      calls++;
      h.tenant.config = { ...h.tenant.config, checkout_mode: "disabled" };
      return { lost: true, pointer: null, list: null };
    },
  });
  try {
    const r = await publishSet(h, [home, design, privacy, terms], { checkOpening: true, confirmOpen: true });
    eq([r.status, r.body.code], [409, "STORE_CANNOT_TAKE_PAYMENT"], `the rebuild refuses: ${JSON.stringify(r.body).slice(0, 200)}`);
    eq(calls, 1, "one batch sent, then the rebuild's gate refused:");
  } finally {
    Pub.setPublishHooks({});
  }
  eq(await livePointer(h), null, "nothing is live:");
});

// ---- P6-FIX1: review test gaps --------------------------------------------------------------
console.log("— P6-FIX1: rule d's mixed case, test orders on a store with releases");
await t("FIX1 d. a founder-saved privacy draft not in the set plus a missing returns page: 409 OPENING_NEEDS_POLICIES with offer null, although the report's own offer adds the privacy draft; nothing goes live", async () => {
  const h = await store("mixed");
  const home = await makeHome(h);
  const design = await makeDesign(h);
  const privacy = await makePage(h, "privacy-policy", "Privacy policy");
  const before = await dump(h);
  for (const flags of [{ checkOpening: true }, { checkOpening: true, confirmOpen: true }]) {
    const r = await publishSet(h, [home, design], flags);
    eq([r.status, r.body.code], [409, "OPENING_NEEDS_POLICIES"], `${JSON.stringify(flags)}:`);
    eq(r.body.offer, null, "no offer (publishing the privacy draft would not open the store):");
    eq([levels(r.body.report).privacy, levels(r.body.report).returns], ["info", "block"], "privacy info, returns blocks:");
    ok((r.body.report.offer?.publishSet || []).some((o) => o.id === privacy.id), `the report's offer adds the privacy draft: ${JSON.stringify(r.body.report.offer)}`);
    checkWords(r.body.report, `mixed ${JSON.stringify(flags)}`);
  }
  eq(await livePointer(h), null, "nothing is live:");
  eq(await dump(h), before, "nothing was written:");
});

await t("FIX1 test_order: on a store with a release but no live pointer, an order placed after its first release does not count, and one placed before it does", async () => {
  const h = await store("relorder");
  const home = await makeHome(h);
  const sql = (q, args = []) => h.run(() => libsql.execute({ sql: q, args }));
  await sql("INSERT INTO releases (id, content, content_hash, created_at) VALUES ('rel_ocfix1', '{}', 'fix1', '2026-06-01T00:00:00.000Z')");
  eq(await livePointer(h), null, "no live pointer:");
  const order = (id, at) => sql("INSERT INTO orders (id, email, status, payment_method, total, created_at) VALUES (?, 'snehal@mediastic.in', 'cancelled', 'cod', 100, ?)", [id, at]);
  await order("OC-FIX1-AFTER", "2026-07-01T00:00:00.000Z");
  const after = byId(await checks(h, [home.id])).test_order;
  eq([after.level, after.message], ["warn", Onb.TEST_ORDER_CLOSED_HINT], "only an order after the first release:");
  await order("OC-FIX1-BEFORE", "2026-05-01T00:00:00.000Z");
  eq(byId(await checks(h, [home.id])).test_order.level, "ok", "an order before the first release counts:");
});

// ---- cleanup -------------------------------------------------------------------------------
for (const h of stores) await h.cleanup().catch(() => {});
await platform.cleanup().catch(() => {});
await F.removeFixtureFiles("oc").catch(() => {});
await rm(join(ROOT, ".test-oc-default.db"), { force: true });
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(fail ? 1 : 0);
