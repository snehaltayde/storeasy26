// Settings, integrations and billing on the new UI (docs/plans/phase-2.md
// "Line 7"): who reaches them, what each page hands its screen, and that no
// secret value ever reaches a page, a markup or an audit row.
//   pnpm test:settings-ui
//   1. the pure parts: the section list and old anchors, the onboarding links,
//      the shipping example, the "Shoppers can pay with" line, audit changes
//   2. every settings tab, integrations and billing as staff, support and an
//      operator under a support grant (scripts/support/page-harness.js): only
//      the no-access page, no settings data, no secret flag, domain or audit
//      row; signed out goes to the sign-in page; the layout shows no nav
//   3. the same pages as the admin: secrets only as has_* flags, never a value
//   4. the support-access banner: the sign-in and invite layouts never carry
//      the grant (no operator id, no reason); the signed-in layout does
//   5. the routes: staff and support are refused every read and write; signed
//      out is 401; the integrations Test (a READ_POSTS row) writes nothing;
//      a shipping save reaches the anonymous shopper's cart total; the audit
//      log pages, filters and never shows a secret value
//   6. the screens' markup as the admin, from the props the pages hand them:
//      no secret value, secret fields write-only; Shipping's starter-rates
//      notice and its Keep these rates save
// File databases only; outside services blanked, the network blocked.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-setui-default.db";
process.env.PLATFORM_CACHE_MS = "50";
H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

// ---- 1. pure parts ------------------------------------------------------------------
console.log("— 1. the pure parts");
const SS = await import("../lib/admin/settings-sections.js");
const SET = await import("../lib/admin/settings.js");
const OS = await import("../lib/onboarding/open-step.js");
const AUD = await import("../lib/platform/audit.js");

await t("ten tabs, Team last (line 8's page); sectionFor picks the longest match; Details only for /admin/settings itself", () => {
  eq(SS.SETTINGS_SECTIONS.map((s) => s.id), ["details", "checkout", "shipping", "domains", "tracking", "sync", "privacy", "audit", "help", "team"]);
  eq(SS.SETTINGS_SECTIONS.find((s) => s.id === "audit").action, "audit.read");
  eq(SS.SETTINGS_SECTIONS.find((s) => s.id === "team").action, "team.manage");
  eq(SS.SETTINGS_SECTIONS.filter((s) => s.action === "settings.read").length, 8);
  eq(["/admin/settings", "/admin/settings/", "/admin/settings/checkout", "/admin/settings/team/x", "/admin/settingsx", "/admin/orders"].map((p) => SS.sectionFor(p)?.id ?? null), ["details", "details", "checkout", "team", null, null]);
});
await t("every anchor of the old one-page settings goes to the tab that holds it now", () => {
  const OLD = { "store-profile": "", commerce: "/checkout", payments: "/checkout", tracking: "/tracking", shipping: "/shipping", "catalog-sync": "/sync", password: "", team: "/team", "domains-seo": "/domains", privacy: "/privacy", "audit-log": "/audit", help: "/help" };
  for (const [hash, tail] of Object.entries(OLD)) eq(SS.hashTarget(`#${hash}`), `/admin/settings${tail}`, `#${hash}:`);
  eq([SS.hashTarget(""), SS.hashTarget("#nope")], [null, null]);
});
await t("the onboarding links point at tabs and still come back (?from=onboarding); a tab counts as Settings for the gate", async () => {
  eq(OS.FIX_HREFS, { billing: "/admin/billing", checkoutOff: "/admin/settings/checkout", payments: "/admin/settings/checkout", catalogSync: "/admin/settings/sync", storeProfile: "/admin/settings" });
  for (const h of Object.values(OS.FIX_HREFS)) ok(SS.sectionFor(h) || h === "/admin/billing", `${h} is a tab:`);
  const { OPENING_REPORT } = await import("../lib/admin/documents-api-shapes.js");
  ok(SS.sectionFor(OPENING_REPORT.items[0].href), "the documents API shape's payment link is a tab");
});
await t("the shipping example is the engine's answer in words; an invalid form gives none", () => {
  eq(SET.shippingExample({ flatRate: 49, freeThreshold: 999, codFee: 30, codFeeWaivedAt: 1500, basis: "net" }), [
    "An order of ₹998 paid online pays ₹49 for shipping.",
    "An order of ₹999 or more ships free.",
    "Paying cash on delivery adds ₹30, so that ₹998 order pays ₹79; from ₹1,500 there is no cash-on-delivery fee.",
  ]);
  eq(SET.shippingExample({ flatRate: 79, freeThreshold: "", codFee: 0 }), ["An order of ₹999 paid online pays ₹79 for shipping."]);
  eq(SET.shippingExample({ flatRate: -1 }), []);
});
await t("'Shoppers can pay with' follows the open checks' payment item", () => {
  eq(SET.shoppersPayWith({ level: "ok" }), "Shoppers can pay with cards, UPI and cash on delivery.");
  ok(SET.shoppersPayWith({ level: "info" }).includes("cash on delivery only"));
  ok(SET.shoppersPayWith({ level: "block", message: "Payments are paused." }).startsWith("Shoppers can't pay right now. Payments are paused."));
  eq(SET.shoppersPayWith(null), null);
});
await t("audit changes: the diff redacted again on the way out (a value under a secret-ish key never shows)", () => {
  eq(AUD.auditChanges(JSON.stringify({ verified: true, razorpay_key_secret: "cnyleak0" })), ["verified: true", "razorpay_key_secret: [redacted]"]);
  eq(AUD.auditChanges(JSON.stringify({ nested: { api_token: "cnyleak1", ok: 1 } })), ['nested: {"api_token":"[redacted]","ok":1}']);
  eq([AUD.auditChanges(null), AUD.auditChanges("not json")], [[], []]);
});

// ---- the fixture -------------------------------------------------------------------
const CNY = {
  rzpKeySecret: "cnyrzpsecret7",
  rzpWebhookSecret: "cnyrzpwhook7",
  ga4Secret: "cnyga4secret7",
  capiToken: "cnycapitoken7",
  rzpKeyId: "rzp_test_cnykeyid7",
  metaTest: "cnymetatest7",
  tagline: "cnytagline7",
  supportEmail: "cnysupport7@example.test",
};
const SECRETS = [CNY.rzpKeySecret, CNY.rzpWebhookSecret, CNY.ga4Secret, CNY.capiToken];
const SETTINGS_DATA = [CNY.rzpKeyId, CNY.metaTest, CNY.tagline, CNY.supportEmail];
const store = await H.makeRoleStore({
  name: "setui",
  a: {
    products: 1,
    config: { razorpay_key_id: CNY.rzpKeyId, meta_test_event_code: CNY.metaTest, site: { name: "Setui Store", tagline: CNY.tagline, support_email: CNY.supportEmail } },
    secrets: { razorpay_key_secret: CNY.rzpKeySecret, razorpay_webhook_secret: CNY.rzpWebhookSecret, ga4_api_secret: CNY.ga4Secret, meta_capi_token: CNY.capiToken },
  },
});
const { a, call, users, cookies } = store;
const C = await import("../lib/platform/control.js");
const fresh = () => C.getTenant(a.id, { fresh: true });
const { withTenant } = await import("../lib/tenant-context.js");

// ---- 2. pages for the roles that can't open settings ----------------------------------
console.log("— 2. staff, support and operator support");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: fresh });
const A = "app/(console)/admin/(authed)";
const TABS = ["settings", "settings/checkout", "settings/shipping", "settings/domains", "settings/tracking", "settings/sync", "settings/privacy", "settings/audit", "settings/help", "integrations", "billing"];
const rel = (p) => `${A}/${p}/page.js`;
const lower = (s) => s.toLowerCase();
const leaks = (text, list) => list.filter((c) => lower(text).includes(lower(c)) || text.includes(encodeURIComponent(c)));

for (const caller of ["staff", "support", "operator-support"]) {
  await t(`${caller}: every settings, integrations and billing page is the no-access page, with no settings data`, async () => {
    for (const p of TABS) {
      const run = await pages.run(rel(p), { cookies: cookies[caller], searchParams: { from: "onboarding" } });
      eq([run.error?.message ?? null, run.unresolved, run.redirect], [null, [], null], `${p}:`);
      eq([...new Set(run.props.map((x) => x.component))], ["@/components/admin/settings/NoAccess#NoAccess"], `${p} components:`);
      eq(leaks(run.text, [...SECRETS, ...SETTINGS_DATA, "has_key_secret", "razorpay", a.tenant.domains[0]]), [], `${p} leaks:`);
    }
  });
}
await t("signed out: every page goes to the sign-in page", async () => {
  for (const p of TABS) eq((await pages.run(rel(p), { cookies: {} })).redirect, "/admin/login", `${p}:`);
});
await t("the settings layout: no nav for staff or support (only the page), the admin's tabs for the admin", async () => {
  const L = `${A}/settings/layout.js`;
  for (const caller of ["staff", "support"]) eq((await pages.run(L, { cookies: cookies[caller] })).props, [], `${caller}:`);
  const run = await pages.run(L, { cookies: cookies.admin });
  const nav = run.props.find((x) => x.component.endsWith("#SettingsNav"));
  eq(nav.props.sections.map((s) => s.id), ["details", "checkout", "shipping", "domains", "tracking", "sync", "privacy", "audit", "help", "team"]);
  eq((await pages.run(L, { cookies: {} })).redirect, "/admin/login");
});

// ---- 3. the admin's pages: flags, never values --------------------------------------------
console.log("— 3. the admin's pages");
const adminRuns = {};
await t("as the admin every page renders its screen; no secret value anywhere in its props, only has_* flags", async () => {
  for (const p of TABS) {
    const run = (adminRuns[p] = await pages.run(rel(p), { cookies: cookies.admin }));
    eq([run.error?.message ?? null, run.unresolved, run.redirect], [null, [], null], `${p}:`);
    ok(!run.props.some((x) => x.component.endsWith("#NoAccess")), `${p} is not the no-access page:`);
    eq(leaks(run.text, SECRETS), [], `${p} secret values:`);
    ok(!/"(razorpay_key_secret|razorpay_webhook_secret|ga4_api_secret|meta_capi_token|admin_password)"\s*:/.test(JSON.stringify(run.props.map((x) => x.props), (k, v) => (typeof v === "function" ? undefined : v))), `${p} has no secret key:`);
  }
  const screen = (p, name) => adminRuns[p].props.find((x) => x.component.endsWith(`#${name}`))?.props;
  eq(screen("settings/checkout", "CheckoutForm").initial.payments, { razorpay_key_id: CNY.rzpKeyId, has_key_secret: true, has_webhook_secret: true });
  eq(screen("settings/tracking", "TrackingForm").initial.tracking.has_meta_capi_token, true);
  eq(screen("settings", "DetailsForm").initial.identity.tagline, CNY.tagline);
  eq(Object.keys(screen("settings/checkout", "CheckoutForm").initial.payment).sort(), ["level", "message", "title"]);
  ok(screen("settings/sync", "SyncPanel").gate.allowed === true, "the admin may run sync:");
  eq(screen("integrations", "IntegrationsList").role, "admin");
});

// ---- 4. the banner ---------------------------------------------------------------------
console.log("— 4. the support-access banner");
const N = await import("../lib/admin/notices.js");
const src = (r) => readFileSync(join(ROOT, r), "utf8");
await t("with an open grant: no member, no grant (operator id and reason never read); a signed-in member gets it", async () => {
  const anon = await withTenant(await fresh(), () => N.readNotices());
  eq(anon.grant, null, "no member:");
  eq(leaks(JSON.stringify(anon), [users.operator.id, "permission suite support grant"]), [], "no member leaks:");
  const member = await withTenant(await fresh(), () => N.readNotices({ member: { kind: "merchant", role: "support" } }));
  eq([member.grant?.operator, member.grant?.reason], [users.operator.id, "permission suite support grant"], "a member:");
});
await t("the sign-in and invite layouts ask for incidents only; the signed-in layout passes its member", async () => {
  for (const L of ["app/(console)/admin/(auth)/layout.js", "app/(console)/admin/(invite)/layout.js"]) {
    const s = src(L);
    ok(s.includes("consoleNotices()") && !/consoleNotices\(\{/.test(s), `${L}:`);
    const run = await pages.run(L, { cookies: {} });
    eq([run.error?.message ?? null, run.unresolved], [null, []], `${L} runs:`);
    eq(leaks(run.text, [users.operator.id, "permission suite support grant"]), [], `${L} leaks:`);
  }
  ok(src(`${A}/layout.js`).includes("consoleNotices({ member: actor })"), "the signed-in layout:");
});

// ---- 5. the routes ---------------------------------------------------------------------
console.log("— 5. the routes");
const WRITES = [
  ["settings", "PUT", { shipping: { flatRate: 1, codFee: 0, basis: "net" } }],
  ["domains", "POST", { action: "verify", host: "x.example" }],
  ["integrations", "POST", { action: "revoke", provider: "razorpay" }],
  ["billing", "POST", { action: "subscribe", plan: "starter" }],
];
const READS = [["settings", "GET"], ["domains", "GET"], ["integrations", "GET"], ["integrations", "POST", { action: "test", provider: "razorpay" }], ["billing", "GET"], ["privacy", "GET"], ["help", "GET"], ["audit", "GET"]];
for (const caller of ["staff", "support", "operator-support", "signed-out"]) {
  await t(`${caller}: every settings read and write is refused, and changes nothing`, async () => {
    const before = JSON.stringify((await fresh()).config);
    for (const [path, method, body] of [...READS, ...WRITES]) {
      const r = await call(caller, path, method, { body });
      eq(r.status, caller === "signed-out" ? 401 : 403, `${method} ${path}:`);
      eq(leaks(r.text, [...SECRETS, ...SETTINGS_DATA]), [], `${method} ${path} leaks:`);
    }
    eq(JSON.stringify((await fresh()).config), before, "config unchanged:");
  });
}
const auditCount = async () => (await AUD.listAudit({ tenantId: a.id, limit: 200 })).length;
await t("the integrations Test (a READ_POSTS row) as the admin writes nothing: no config, secret or audit change", async () => {
  const { READ_POSTS } = await import("./support/read-controls.js");
  eq(READ_POSTS.filter((r) => r.path === "/api/admin/integrations").map((r) => r.page), ["/admin/settings/checkout", "/admin/integrations"]);
  const t0 = await fresh();
  const [cfg, sec, n] = [JSON.stringify(t0.config), JSON.stringify(t0.secrets), await auditCount()];
  for (const provider of ["razorpay", "shopify", "typesense", "mail", "ga4"]) {
    const r = await call("admin", "integrations", "POST", { body: { action: "test", provider } });
    eq(r.status, 200, `${provider}:`);
    eq(leaks(r.text, SECRETS), [], `${provider} leaks:`);
  }
  const t1 = await fresh();
  eq([JSON.stringify(t1.config), JSON.stringify(t1.secrets), await auditCount()], [cfg, sec, n]);
});
await t("a Shipping save (only its section) reaches the anonymous shopper's cart total; other sections untouched", async () => {
  const before = (await fresh()).config;
  const r = await call("admin", "settings", "PUT", { body: { shipping: { flatRate: 37, freeThreshold: 5000, codFee: 0, codFeeWaivedAt: "", basis: "net", zones: [] } } });
  eq(r.status, 200);
  eq(leaks(r.text, SECRETS), [], "the answer leaks:");
  const after = await fresh();
  eq([after.config.razorpay_key_id, after.config.meta_test_event_code, after.config.site.tagline], [before.razorpay_key_id, before.meta_test_event_code, before.site.tagline], "other sections:");
  const { createCart, addItem, getCart } = await import("../lib/cart.js");
  const cart = await withTenant(after, async () => {
    await createCart("cart_setui");
    await addItem("cart_setui", "gid://shopify/ProductVariant/91011", 1);
    return getCart("cart_setui");
  });
  eq([cart.subtotal, cart.shipping.total, cart.grandTotal], [100, 37, 137], "the cart:");
});
await t("a secret save: the audit row names the change, never the value; GET /api/admin/audit shows no secret value", async () => {
  const r = await call("admin", "settings", "PUT", { body: { payments: { razorpay_key_id: CNY.rzpKeyId, razorpay_key_secret: "cnynewsecret7", razorpay_webhook_secret: "" } } });
  eq(r.status, 200);
  ok(!r.text.includes("cnynewsecret7"), "the answer:");
  eq((await fresh()).secrets.razorpay_key_secret, "cnynewsecret7", "saved:");
  const g = await call("admin", "audit", "GET", { query: "limit=200&facets=1" });
  eq(g.status, 200);
  eq(leaks(g.text, [...SECRETS, "cnynewsecret7"]), [], "audit leaks:");
  const row = g.body.entries.find((e) => e.action === "settings.write");
  ok(row && row.who === `admin@${a.id}.test` && Array.isArray(row.changes), "who in words, changes as lines:");
  ok(g.body.facets.actions.includes("settings.write") && g.body.facets.actors.some((x) => x.actor === users.admin.id && x.label === `admin@${a.id}.test`), "facets:");
});
await t("the audit log pages with no gap or repeat and filters by who, action and date", async () => {
  for (let i = 0; i < 7; i++) await AUD.audit({ actor: { kind: "merchant", id: users.owner.id }, action: "drill.same", tenantId: a.id, resource: `r${i}` });
  const all = (await call("admin", "audit", "GET", { query: "limit=200" })).body.entries;
  const seen = [];
  let before = null;
  for (let n = 0; n < 50; n++) {
    const r = await call("admin", "audit", "GET", { query: `limit=3${before ? `&before=${encodeURIComponent(before)}` : ""}` });
    seen.push(...r.body.entries.map((e) => e.id));
    before = r.body.next;
    if (!before) break;
  }
  eq(seen, all.map((e) => e.id), "paged ids:");
  const mine = (await call("admin", "audit", "GET", { query: `actor=${users.owner.id}&action=drill.same` })).body.entries;
  eq(mine.length, 7, "who and action:");
  const future = (await call("admin", "audit", "GET", { query: "since=2999-01-01" })).body.entries;
  const past = (await call("admin", "audit", "GET", { query: "until=2000-01-01" })).body.entries;
  eq([future.length, past.length], [0, 0], "dates:");
  const today = new Date().toISOString().slice(0, 10);
  ok((await call("admin", "audit", "GET", { query: `since=${today}` })).body.entries.length >= 7, "since today:");
});

// P2-E: the tenant filter comes before every other filter, so A's admin naming
// B's user, B's action or asking for facets still reads A's rows only
await t("store A's admin filtering the audit log by store B's user, action or facets gets only A's rows and no B email", async () => {
  const bUser = users["owner-b"];
  await AUD.audit({ actor: { kind: "merchant", id: bUser.id, role: "owner" }, action: "drill.bonly", tenantId: store.b.id, resource: "cnybaudres0" });
  const aIds = new Set((await AUD.listAudit({ tenantId: a.id, limit: 200 })).map((r) => r.id));
  const bIds = new Set((await AUD.listAudit({ tenantId: store.b.id, limit: 200 })).map((r) => r.id));
  ok(bIds.size >= 1 && bUser.email, "B has an audit row and a member email:");
  for (const query of [`actor=${bUser.id}`, "action=drill.bonly", `actor=${bUser.id}&action=drill.bonly`, "facets=1&limit=200", `facets=1&actor=${bUser.id}`]) {
    const r = await call("admin", "audit", "GET", { query });
    eq(r.status, 200, `${query} status:`);
    const entries = r.body.entries ?? [];
    ok(entries.every((e) => aIds.has(e.id) && !bIds.has(e.id)), `${query}: a row that is not A's`);
    if (query.includes("actor=") || query.includes("action=")) eq(entries.length, 0, `${query} rows:`);
    for (const c of [bUser.email, "cnybaudres0", "drill.bonly"]) ok(!r.text.includes(c), `${query} leaks ${c}`);
    if (r.body.facets) ok(!r.body.facets.actors.some((x) => x.actor === bUser.id), `${query}: B's user in the facets`);
  }
});

await t("two tabs saving at once both stick: Shipping and Tracking sent together, each key written on its own (patchTenant json_set)", async () => {
  for (let round = 0; round < 3; round++) {
    const rate = 40 + round;
    const code = `TESTCONC${round}`;
    const [s1, s2] = await Promise.all([
      call("admin", "settings", "PUT", { body: { shipping: { flatRate: rate, freeThreshold: 5000, codFee: 0, codFeeWaivedAt: "", basis: "net", zones: [] } } }),
      call("owner", "settings", "PUT", { body: { tracking: { ga4_measurement_id: "", meta_pixel_id: "", meta_test_event_code: code, ga4_api_secret: "", meta_capi_token: "" } } }),
    ]);
    eq([s1.status, s2.status], [200, 200], `round ${round}:`);
    const cfg = (await fresh()).config;
    eq([cfg.shipping_config.flatRate, cfg.meta_test_event_code], [rate, code], `round ${round} both kept:`);
  }
  // and the secrets blob: two secret saves at once keep both
  await Promise.all([
    call("admin", "settings", "PUT", { body: { payments: { razorpay_key_id: CNY.rzpKeyId, razorpay_key_secret: "cnyconcA7", razorpay_webhook_secret: "" } } }),
    call("owner", "settings", "PUT", { body: { tracking: { ga4_measurement_id: "", meta_pixel_id: "", meta_test_event_code: "", ga4_api_secret: "cnyconcB7", meta_capi_token: "" } } }),
  ]);
  const sec = (await fresh()).secrets;
  eq([sec.razorpay_key_secret, sec.ga4_api_secret, sec.meta_capi_token], ["cnyconcA7", "cnyconcB7", CNY.capiToken], "secrets kept:");
});
await t("a stale Details tab can't undo a newer logo text: it sends only what it changed, and site keys are written one by one", async () => {
  eq(SET.changedIdentity({ name: "S", tagline: "new", logo_text1: "Old" }, { name: "S", tagline: "old", logo_text1: "Old" }), { tagline: "new" });
  eq(SET.changedIdentity({ a: "" }, {}), {});
  await call("admin", "settings", "PUT", { body: { identity: { logo_text1: "Fresh", logo_text2: "Logo" } } });
  // the stale tab loaded before that save; the founder changed only the tagline
  const stale = { tagline: "Stale tab tagline", logo_text1: "", logo_text2: "" };
  const r = await call("owner", "settings", "PUT", { body: { identity: SET.changedIdentity(stale, { tagline: CNY.tagline, logo_text1: "", logo_text2: "" }) } });
  eq(r.status, 200);
  const site = (await fresh()).config.site;
  eq([site.tagline, site.logo, site.name, site.support_email], ["Stale tab tagline", { text1: "Fresh", text2: "Logo" }, "Setui Store", CNY.supportEmail]);
  const C2 = await import("../lib/platform/control.js");
  await C2.patchTenant(a.id, { config: { site: { footer_tagline: "only this" } } });
  const after = (await fresh()).config.site;
  eq([after.footer_tagline, after.logo, after.tagline], ["only this", { text1: "Fresh", text2: "Logo" }, "Stale tab tagline"], "a site key on its own leaves the others:");
});
await t("the audit route sends no raw diff, only the redacted lines; one read labels every member", async () => {
  const g = await call("admin", "audit", "GET", { query: "limit=200&facets=1" });
  ok(g.body.entries.length > 0 && g.body.entries.every((e) => !("diff" in e) && Array.isArray(e.changes)), "no diff key:");
  const src = readFileSync(join(ROOT, "app/api/admin/audit/route.js"), "utf8");
  ok(!src.includes("getUser(") && /WHERE id IN \(/.test(src), "one batched users read:");
});
await t("an integration Test answers the founder in plain words: never an env var name or a raw server error", async () => {
  for (const provider of ["shopify", "razorpay", "typesense", "mail", "ga4", "meta"]) {
    const r = await call("admin", "integrations", "POST", { body: { action: "test", provider } });
    ok(!/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(String(r.body?.detail || "")), `${provider}: ${r.body?.detail}`);
  }
});

// ---- 6. markup ---------------------------------------------------------------------------
console.log("— 6. the screens' markup");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const STUBS = {
  "@/components/kit/toast": { useToast: () => ({ success() {}, error() {}, info() {} }) },
  "next/navigation": { useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => globalThis.__setuiPath || "/admin/settings/checkout", useSearchParams: () => new URLSearchParams("from=onboarding") },
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...p }) => React.createElement("a", { href, ...p }, children) },
};
const resolveLocal = (id) => [`${id.slice(2)}.js`, id.slice(2)].find((c) => {
  try {
    readFileSync(join(ROOT, c));
    return true;
  } catch {
    return false;
  }
});
// one module world per set of stubs (the click test below swaps React's hooks)
function loader(stubs) {
  const cache = new Map();
  return async function load(relPath) {
    const file = join(ROOT, relPath);
    if (cache.has(file)) return cache.get(file);
    const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
    const deps = new Map();
    for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
      if (deps.has(id)) continue;
      if (stubs[id]) deps.set(id, stubs[id]);
      else if (/^@\/(components\/(ui|kit|admin\/(settings|offers|integrations|billing|onboarding\/BackToOnboarding))|lib)(\/|$)/.test(id)) deps.set(id, await load(resolveLocal(id)));
      else if (id.startsWith("./") || id.startsWith("../")) deps.set(id, await load(join(dirname(relPath), id).replace(/(\.js)?$/, ".js")));
      else if (id.startsWith("@/")) throw new Error(`${relPath} imports ${id}`);
      else deps.set(id, require(id));
    }
    const mod = { exports: {} };
    new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  };
}
const load = loader(STUBS);
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));
const propsOf = (p, name) => adminRuns[p].props.find((x) => x.component.endsWith(`#${name}`)).props;

await t("the admin's tabs: secret fields are closed (Saved / Replace, no password input with a value), no secret value in the markup", async () => {
  const forms = [
    ["settings", "DetailsForm"],
    ["settings/checkout", "CheckoutForm"],
    ["settings/shipping", "ShippingForm"],
    ["settings/tracking", "TrackingForm"],
  ];
  for (const [p, name] of forms) {
    const M = await load(`components/admin/settings/${name}.js`);
    const s = html(React.createElement(M[name], propsOf(p, name)));
    eq(leaks(s, SECRETS), [], `${name}:`);
    ok(!/type="password"[^>]*value="[^"]+"/.test(s), `${name} has no filled password input:`);
  }
  const { CheckoutForm } = await load("components/admin/settings/CheckoutForm.js");
  const s = html(React.createElement(CheckoutForm, propsOf("settings/checkout", "CheckoutForm")));
  eq((s.match(/>Saved</g) || []).length, 2, "both Razorpay secrets say Saved:");
  eq((s.match(/>Replace</g) || []).length, 2, "and offer Replace:");
  ok(!s.includes('id="st-rzp-key-secret"'), "no key secret input until Replace:");
  ok(s.includes(CNY.rzpKeyId), "the key id itself is shown:");
  ok(/Test keys[\s\S]*<\/form>/.test(s) === false, "Test keys sits outside the form:");
});
// The Shipping tab's starter-rates notice (Phase 2 line 7; its old test went
// with the old settings screen in line 11): shown only while the store is on
// the starter rates, with "Keep these rates" for a role that may write; the
// button saves the rates shown and only { shipping }.
const KEEP = "Keep these rates";
const STARTER_NOTICE = "You haven&#x27;t set your own shipping rates yet";
await t("Shipping: the starter-rates notice and Keep these rates show only on starter rates, and only to a role that may write", async () => {
  const { ShippingForm } = await load("components/admin/settings/ShippingForm.js");
  const base = propsOf("settings/shipping", "ShippingForm");
  const render = (initial, role = base.role) => html(React.createElement(ShippingForm, { ...base, role, initial: { ...base.initial, ...initial } }));
  const starter = render({ shipping_is_default: true });
  ok(starter.includes(STARTER_NOTICE), "the notice on starter rates:");
  ok(starter.includes("Shoppers pay the starter rates below."), "it says what shoppers pay:");
  ok(new RegExp(`<button[^>]*type="button"[^>]*>${KEEP}</button>`).test(starter), "Keep these rates is a plain button (not the form's submit):");
  const own = render({ shipping_is_default: false });
  ok(!own.includes(STARTER_NOTICE) && !own.includes(KEEP), "no notice and no button on the store's own rates:");
  const ro = render({ shipping_is_default: true, readOnly: true });
  ok(ro.includes(STARTER_NOTICE) && !ro.includes(KEEP), "read-only: the notice, never the button:");
  const live = new RegExp(`<button(?![^>]*\\s(aria-disabled="true"|disabled=""))[^>]*>${KEEP}<`);
  ok(live.test(starter), "the admin's button is live:");
  for (const role of ["staff", "support"]) ok(!live.test(render({ shipping_is_default: true }, role)), `${role}, without settings.write, never gets a live Keep button:`);
});
await t("Shipping (clicked): Keep these rates PUTs the rates shown, only { shipping }", async () => {
  // a one-pass hook shim: state is its initial value; the tree is walked to the button
  const hooks = { useState: (i) => [typeof i === "function" ? i() : i, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useCallback: (f) => f, useContext: () => null, useId: () => "id" };
  const shim = { ...React, ...hooks };
  shim.default = shim;
  const loadShim = loader({ ...STUBS, react: shim });
  const { ShippingForm } = await loadShim("components/admin/settings/ShippingForm.js");
  const base = propsOf("settings/shipping", "ShippingForm");
  const initial = { ...base.initial, shipping_is_default: true, shipping: { currency: "INR", basis: "net", flatRate: 79, freeThreshold: 999, codFee: 0, codFeeWaivedAt: null, zones: [] } };
  // the element whose text is the button's words and that has a click (RoleGate passes it through as its child)
  const find = (n) => (!n || typeof n !== "object" ? null : Array.isArray(n) ? n.map(find).find(Boolean) || null : !React.isValidElement(n) ? null : n.props.children === KEEP && n.props.onClick ? n : find(n.props.children));
  const keep = find(ShippingForm({ initial, role: base.role }));
  ok(keep, "the Keep button is in the tree:");
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (calls.push({ url, method: init.method, body: JSON.parse(init.body) }), { ok: true, json: async () => ({ ok: true, settings: { shipping_is_default: false } }) });
  try {
    await keep.props.onClick();
  } finally {
    globalThis.fetch = real;
  }
  eq(calls.map((c) => [c.url, c.method]), [["/api/admin/settings", "PUT"]], "one save:");
  eq(Object.keys(calls[0].body), ["shipping"], "only shipping is sent:");
  eq([calls[0].body.shipping.flatRate, calls[0].body.shipping.freeThreshold], ["79", "999"], "the rates shown:");
});
await t("the integrations and billing screens hold no secret value; the no-access page is words and one marked link", async () => {
  const { IntegrationsList } = await load("components/admin/integrations/IntegrationsList.js");
  eq(leaks(html(React.createElement(IntegrationsList, propsOf("integrations", "IntegrationsList"))), SECRETS), []);
  const { BillingPanel } = await load("components/admin/billing/BillingPanel.js");
  eq(leaks(html(React.createElement(BillingPanel, propsOf("billing", "BillingPanel"))), SECRETS), []);
  const { NoAccess } = await load("components/admin/settings/NoAccess.js");
  const n = html(React.createElement(NoAccess, { role: "support" }));
  ok(/Your role \(support\) can.t .+ ask an owner or admin/.test(n.replace(/&#x27;/g, "'")), "names the role and says who to ask (the shell drill's refusal words):");
  ok(n.includes(SS.NO_ACCESS_WORDS.title.replace("'", "&#x27;")) && (n.match(/<a /g) || []).length === 1 && n.includes("data-read-control"), "no-access markup:");
});
await t("the section nav: a select and the tab links, all marked reads; onboarding's back link kept; the current tab marked", async () => {
  const { SettingsNav } = await load("components/admin/settings/SettingsNav.js");
  const s = html(React.createElement(SettingsNav, { sections: SS.SETTINGS_SECTIONS.map(({ id, label, href }) => ({ id, label, href })) }));
  eq((s.match(/data-read-control/g) || []).length, 11, "one select and ten links:");
  ok(s.includes('href="/admin/settings/checkout?from=onboarding" aria-current="page"') || /aria-current="page"[^>]*href="\/admin\/settings\/checkout\?from=onboarding"/.test(s), "the current tab:");
  ok(s.includes("Back to onboarding"), "back link:");
});

await t("the layout's title: on every tab but Team (line 8's page has its own title and breadcrumb), so no page has two", async () => {
  const { SettingsTitle, SettingsColumn } = await load("components/admin/settings/SettingsFrame.js");
  const at = (path, el) => {
    globalThis.__setuiPath = path;
    try {
      return html(el);
    } finally {
      globalThis.__setuiPath = undefined;
    }
  };
  ok(at("/admin/settings/checkout", React.createElement(SettingsTitle)).includes(">Settings</h1>"), "a tab gets the Settings title:");
  eq(at("/admin/settings/team", React.createElement(SettingsTitle)), "", "Team gets none:");
  ok(at("/admin/settings/team", React.createElement(SettingsColumn, null, "x")).startsWith('<div class="min-w-0">'), "Team's column is full width:");
  ok(at("/admin/settings", React.createElement(SettingsColumn, null, "x")).includes("max-w-3xl"), "a tab's column is capped:");
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(fail ? 1 : 0);
