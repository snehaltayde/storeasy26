// Phase 1 line 7: open the store from onboarding step 4.
//   1. openStep (pure): every item with its own fix, gated per role; the home
//      line; Settings and Billing links come back with ?from=onboarding; Open
//      only with storefront.publish and nothing blocking; the done facts
//   2. the whole flow as the page runs it: the editor's own client
//      (createDocumentsApi + createPublishFlow) and the page's console calls,
//      all through a fetch that hands each request to the real route module
//      (documents, settings, policy-start, onboarding) with a real session.
//      Starter unread -> Open not allowed; turning checkout on unblocks;
//      contact saves keep the other fields; mark read -> the flow can
//      confirm; confirm -> a live release, publish_log rows for every
//      published id with that release, an audit row, the starter never in
//      the set; the done facts
//   3. the role matrix (docs/plans/phase-1.md line 7 §3): staff and support
//      403 on publishSet and the settings PUT with nothing written, support
//      on the policy starter, signed out 401, support's GET with every action
//      disabled and no Razorpay key in it
//   4. source guard: components/admin/onboarding/ never imports
//      lib/documents/publish* and reaches /api/admin/documents only through
//      documentsApi
// File databases only (scripts/support/tenant-fixture.js). Nothing here
// reaches Shopify, Typesense, Razorpay or a hosted database.
//   pnpm test:onboarding-open
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation|cache)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
delete process.env.CHECKOUT_MODE;
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-oo-default.db";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "SHOPIFY_STORE_DOMAIN", "NEXT_PUBLIC_RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]) delete process.env[k];

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

const O = await import("../lib/onboarding/open-step.js");
const S = await import("../lib/onboarding/steps.js");
const { roleAllows, ROLES } = await import("../lib/platform/authz.js");

// =========================================================================================
console.log("— 1. openStep (pure)");

const REPORT = [
  { id: "payment", level: "block", title: "Checkout is turned off", message: "m", href: O.FIX_HREFS.checkoutOff, who: null, linkLabel: "Open Settings" },
  { id: "privacy", level: "block", title: "Privacy page", message: "m", href: null, who: null, actions: [{ type: "startPolicy", kind: "privacy", label: "Start a privacy page" }] },
  { id: "returns", level: "block", title: "Returns page", message: "m", href: "/admin/editor?doc=doc_ret", who: null, linkLabel: "Read it", actions: [{ type: "markPolicyRead", id: "doc_ret", revision: 3, label: "I've read it" }] },
  { id: "test_order", level: "warn", title: "No test order yet", message: "m", href: "/admin/editor", who: null, linkLabel: "Open your preview" },
  { id: "catalog", level: "warn", title: "No products yet", message: "m", href: O.FIX_HREFS.catalogSync, who: null, linkLabel: "Open Settings" },
  { id: "contact", level: "warn", title: "No contact details", message: "m", href: O.FIX_HREFS.storeProfile, who: null, linkLabel: "Open Settings" },
  { id: "design", level: "info", title: "Colours and logo", message: "m", href: "/admin/editor?doc=doc_design", who: null, linkLabel: "Choose your colours" },
];
const closed = (over = {}) => ({ open: false, hasHome: true, opening: { items: REPORT }, testOrderMarked: false, ...over });
const itemOf = (m, id) => m.facts.items.find((i) => i.id === id);

await t("every item is listed with its own fix: the home line first; checkout off -> Turn on checkout and Add Razorpay keys (a Settings link, never a key field); start / read a policy; the preview and the test-order mark; Settings links with ?from=onboarding; contact -> the inline form; design keeps its editor link", async () => {
  const m = O.openStep(closed(), "owner");
  eq(m.facts.items.map((i) => i.id), ["home", "payment", "privacy", "returns", "test_order", "catalog", "contact", "design"], "order:");
  const pay = itemOf(m, "payment");
  eq(pay.fixes.map((f) => [f.kind, f.label, f.href ?? null, f.allowed]), [["cod_on", "Turn on checkout", null, true], ["link", "Add Razorpay keys", "/admin/settings/checkout?from=onboarding", true]], "payment:");
  eq(pay.message, O.OPEN_WORDS.checkoutOff, "checkout-off words:");
  eq(itemOf(m, "privacy").fixes.map((f) => [f.kind, f.policyKind, f.allowed]), [["policy_start", "privacy", true]], "privacy:");
  const r = itemOf(m, "returns").fixes[0];
  eq([r.kind, r.label, r.docId, r.revision, r.editHref, r.allowed, r.markRead.label, r.markRead.allowed], ["policy_read", "Read it", "doc_ret", 3, "/admin/editor?doc=doc_ret", true, "I've read it", true], "returns starter:");
  ok(itemOf(m, "privacy").legalNote && itemOf(m, "returns").legalNote, "not legal advice on both");
  eq(itemOf(m, "test_order").fixes.map((f) => [f.kind, f.href ?? null]), [["link", "/admin/editor"], ["test_order", null]], "test order:");
  eq(itemOf(m, "catalog").fixes.map((f) => [f.kind, f.href]), [["link", "/admin/settings/sync?from=onboarding"]], "catalog:");
  eq([itemOf(m, "contact").fixes.map((f) => f.kind), itemOf(m, "contact").message], [["contact_form"], O.OPEN_WORDS.contactMissing], "contact:");
  eq(itemOf(m, "design").fixes.map((f) => [f.kind, f.href, f.allowed]), [["link", "/admin/editor?doc=doc_design", true]], "design:");
  ok(!JSON.stringify(m).includes("razorpay_key"), "no key field anywhere");
});

await t("payment: COD only -> the info line and the same optional Razorpay link; billing paused -> Billing with ?from=onboarding; Shopify checkout -> Storeasy's team fixes this; maintenance the same", async () => {
  const cod = O.openStep(closed({ opening: { items: [{ id: "payment", level: "info", title: "Cash on delivery only", message: "m", href: O.FIX_HREFS.payments, who: null }] } }), "owner");
  eq(itemOf(cod, "payment").fixes.map((f) => [f.kind, f.label, f.href]), [["link", "Add Razorpay keys", "/admin/settings/checkout?from=onboarding"]], "cod:");
  const bill = O.openStep(closed({ opening: { items: [{ id: "payment", level: "block", title: "Payments are paused", message: "m", href: O.FIX_HREFS.billing, who: null }] } }), "owner");
  eq(itemOf(bill, "payment").fixes.map((f) => [f.kind, f.href]), [["link", "/admin/billing?from=onboarding"]], "billing:");
  const shop = O.openStep(closed({ opening: { items: [{ id: "payment", level: "block", title: "x", message: "m", href: null, who: "support" }, { id: "maintenance", level: "warn", title: "y", message: "m", href: null, who: "support" }] } }), "owner");
  eq(shop.facts.items.slice(1).map((i) => i.fixes), [[{ kind: "support", label: "Storeasy's team fixes this." }], [{ kind: "support", label: "Storeasy's team fixes this." }]], "support items:");
});

await t("home missing: a blocking 'Make your home page in step 3' line and Open disabled with the reason, never a dialog ending in noHome", async () => {
  for (const hasHome of [false, null]) {
    const m = O.openStep(closed({ hasHome, opening: { items: [] } }), "owner");
    eq([m.state, itemOf(m, "home").level, itemOf(m, "home").fixes], ["blocked", "block", [{ kind: "step", step: "brand", label: "Make your home page in step 3", allowed: true }]], `hasHome ${hasHome}:`);
    eq(m.actions.find((a) => a.id === "open_store"), { id: "open_store", allowed: false, reason: O.OPEN_WORDS.fixFirst }, "Open:");
  }
});

await t("Open: allowed only with storefront.publish and nothing blocking; staff gets the owner-or-admin words, support the read-only words; a failed read leaves Open out", async () => {
  const ready = closed({ opening: { items: REPORT.filter((i) => i.level !== "block") } });
  for (const role of ROLES) {
    const a = O.openStep(ready, role).actions.find((x) => x.id === "open_store");
    eq(a.allowed, roleAllows(role, "storefront.publish"), `${role}:`);
  }
  eq(O.openStep(ready, "staff").actions.find((x) => x.id === "open_store").reason, O.OPEN_REASON, "staff:");
  eq(O.openStep(ready, "support").actions.find((x) => x.id === "open_store").reason, O.READ_ONLY_REASON, "support:");
  eq(O.openStep(closed(), "owner").actions.find((x) => x.id === "open_store").reason, O.OPEN_WORDS.fixFirst, "blocked owner:");
  const unread = O.openStep(closed({ opening: null }), "owner", { unreadable: S.UNREADABLE });
  eq([unread.state, unread.problem, unread.actions.some((a) => a.id === "open_store")], ["ready", S.UNREADABLE, false], "unread:");
});

await t("staff: Settings links, Turn on checkout, the contact form and the test-order mark disabled with a reason; policy start and read allowed. support: every control disabled with the read-only reason except reading a draft", async () => {
  const staff = O.openStep(closed(), "staff");
  const fx = staff.facts.items.flatMap((i) => i.fixes);
  for (const f of fx.filter((x) => x.kind === "link" && x.href.startsWith("/admin/settings"))) eq([f.allowed, f.reason], [false, O.OPEN_WORDS.settingsReason], `staff ${f.href}:`);
  for (const kind of ["cod_on", "contact_form", "test_order"]) eq(fx.find((f) => f.kind === kind).allowed, false, `staff ${kind}:`);
  ok(fx.find((f) => f.kind === "policy_start").allowed && fx.find((f) => f.kind === "policy_read").markRead.allowed, "staff may start and mark read");
  const sup = O.openStep(closed(), "support");
  const sfx = sup.facts.items.flatMap((i) => i.fixes).flatMap((f) => (f.markRead ? [f, { ...f.markRead, kind: "markRead" }] : [f]));
  for (const f of sfx.filter((x) => "allowed" in x && !(x.kind === "link" && !x.href.startsWith("/admin/settings")) && x.kind !== "step")) {
    if (f.kind === "policy_read") eq(f.allowed, true, "support reads a draft:");
    else eq([f.kind, f.allowed, f.reason], [f.kind, false, O.READ_ONLY_REASON], `support ${f.kind}:`);
  }
  for (const a of sup.actions) eq(a.allowed, a.id === "policy_view", `support action ${a.id}:`);
});

await t("done (open store): 'Your store is open.', the store address and the live link; nothing to press", async () => {
  const m = O.openStep({ open: true, storeAddress: "acme.test", liveUrl: "/api/preview?exit=1&to=%2F", testOrderMarked: true }, "owner");
  eq(m, { state: "done", words: "Your store is open.", facts: { items: [], testOrderMarked: true, storeAddress: "acme.test", liveUrl: "/api/preview?exit=1&to=%2F" }, actions: [] }, "done:");
  const viaSteps = S.deriveSteps({ supported: true, open: true, cmsMode: "documents", storeAddress: "acme.test", liveUrl: "/x" }, "owner").steps[3];
  eq([viaSteps.state, viaSteps.facts.storeAddress, viaSteps.facts.liveUrl], ["done", "acme.test", "/x"], "through deriveSteps:");
  eq(S.WORDS.open, O.OPEN_WORDS, "steps.js words are open-step's:");
  eq(O.fromOnboarding("/admin/settings#payments"), "/admin/settings?from=onboarding#payments", "fromOnboarding:");
  eq(O.fromOnboarding("/admin/settings/checkout"), "/admin/settings/checkout?from=onboarding", "fromOnboarding on a tab:");
});

// =========================================================================================
console.log("— 2. the flow, end to end through the real routes");

const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("oo");
const plat = await F.makePlatform({ name: "oo" });
const C = plat.control;
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const Docs = await import("../lib/documents/service.js");
const R = await import("../lib/registry/index.js");
const Pol = await import("../lib/documents/policy-pages.js");
const { createDocumentsApi, DOCUMENTS_URL } = await import("../components/admin/editor/documentsApi.js");
const { createPublishFlow } = await import("../components/admin/editor/publish/publishModel.js");
const ROUTES = {
  "/api/admin/documents": await import("../app/api/admin/documents/route.js"),
  "/api/admin/settings": await import("../app/api/admin/settings/route.js"),
  "/api/admin/policy-start": await import("../app/api/admin/policy-start/route.js"),
  "/api/admin/onboarding": await import("../app/api/admin/onboarding/route.js"),
};

const stores = {};
const mk = async (key, opts) => (stores[key] = await F.makeTenant({ name: `oo-${key}`, id: `oo${key}`, mode: "documents", sync: "complete", catalogShape: "few", ...opts }));
await mk("main", { config: { checkout_mode: "disabled", site: { name: "Store main", tagline: "Kept tagline" } } });
await mk("roles", { config: { checkout_mode: "disabled", razorpay_key_id: "rzp_test_oocanarykey", site: { name: "Store roles" } }, secrets: { razorpay_key_secret: "oo-secret-canary" } });
const raw = async (key, q, args = []) => {
  const c = stores[key].client();
  try {
    return (await c.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
  } finally {
    c.close();
  }
};
const inS = async (key, fn) => (await import("../lib/tenant-context.js")).withTenant(await C.getTenant(`oo${key}`, { fresh: true }), fn);
const homeBody = () => ({ ...R.emptyBody("home"), sections: [{ ...R.newSection("text", { id: "sec_oo_home" }), settings: { ...R.newSection("text", { id: "sec_oo_home" }).settings, title: "Hello", body: ["Hi."] } }] });
for (const key of ["main", "roles"]) await inS(key, () => Docs.createDocument({ type: "home", body: homeBody(), actor: { kind: "merchant", id: "usr_oo", role: "owner" } }));

const users = {};
const mkUser = async (email, role, store) => {
  const u = await I.createUser({ email, name: role, password: `${role}-oo-pass-1` });
  await I.addMembership(u.id, store, role);
  return (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
};
users.owner = await mkUser("owner@oo.test", "owner", "oomain");
for (const role of ["owner", "staff", "support"]) users[`roles_${role}`] = await mkUser(`${role}-roles@oo.test`, role, "ooroles");

// A fetch the browser would make, handed to the route module for that path.
const fetchAs = (key, tok) => async (url, init = {}) => {
  const u = new URL(url, `https://oo${key}.test`);
  const mod = ROUTES[u.pathname];
  const method = (init.method || "GET").toUpperCase();
  if (!mod?.[method]) throw new Error(`no route ${method} ${u.pathname}`);
  const body = init.body == null ? undefined : JSON.parse(init.body);
  const res = await mod[method](
    {
      method,
      cookies: { get: (n) => (n === "_admin" && tok ? { name: n, value: tok } : undefined) },
      headers: { get: (k) => ({ host: `oo${key}.test`, "content-type": "application/json" })[k.toLowerCase()] ?? null },
      url: u.href,
      nextUrl: u,
      json: async () => body,
    },
    { params: Promise.resolve({}) },
  );
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: () => res.json() };
};
const client = (key, tok) => {
  const fetch = fetchAs(key, tok);
  const api = createDocumentsApi({ fetch });
  const json = async (url, method = "GET", body) => {
    const r = await fetch(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  return { fetch, api, json, step4: async () => (await json("/api/admin/onboarding")).body.steps?.[3] };
};
const flowFor = (c) => createPublishFlow({ call: c.api.call, fetch: c.fetch });
const settle = async (flow) => {
  for (let i = 0; i < 50 && flow.getState().order.some((id) => flow.getState().lists[id]?.status === "loading"); i++) await new Promise((r) => setImmediate(r));
};
const auditOf = async (tenant, action) => (await C.platformDb().execute({ sql: "SELECT action, resource, diff FROM audit_log WHERE tenant_id = ? AND action = ? ORDER BY at", args: [tenant, action] })).rows.map((r) => ({ ...r }));
const cfgOf = async (key) => (await C.getTenant(`oo${key}`, { fresh: true })).config;
const owner = client("main", users.owner);
const fixOf = (st, id, kind) => st.facts.items.find((i) => i.id === id)?.fixes.find((f) => f.kind === kind);

let starterIds = [];
await t("checkout off: step 4 blocks on payment and both policy pages; the flow opens on 'Before you open your store' and can't confirm; Turn on checkout (PUT settings commerce) unblocks payment with an audit row", async () => {
  const st = await owner.step4();
  eq(st.state, "blocked", "blocked:");
  eq(st.facts.blocking.map((b) => b.id), ["payment", "privacy", "returns"], "blocking:");
  eq(st.actions.find((a) => a.id === "open_store"), { id: "open_store", allowed: false, reason: O.OPEN_WORDS.fixFirst }, "Open:");
  const flow = flowFor(owner);
  await flow.open([{ id: "doc_home" }]);
  await settle(flow);
  eq([flow.getState().phase, flow.canConfirm()], ["opening", false], "flow:");
  ok(fixOf(st, "payment", "cod_on")?.allowed, "Turn on checkout offered");
  const before = (await auditOf("oomain", "settings.write")).length;
  const put = await owner.json("/api/admin/settings", "PUT", { commerce: { checkout_mode: "direct" } });
  eq([put.status, put.body.ok], [200, true], JSON.stringify(put.body).slice(0, 200));
  eq((await cfgOf("main")).checkout_mode, "direct", "saved:");
  eq((await auditOf("oomain", "settings.write")).length, before + 1, "audit row:");
  const after = await owner.step4();
  const pay = after.facts.items.find((i) => i.id === "payment");
  eq([pay.level, pay.fixes.map((f) => f.kind)], ["info", ["link"]], "COD only now, with the optional Razorpay link:");
  eq(after.facts.blocking.map((b) => b.id), ["privacy", "returns"], "still blocking:");
});

await t("start both policy pages: each becomes 'Read it' with the draft; the draft reads through documentsApi getDocument; Open still not allowed and the flow never puts a starter in the set", async () => {
  for (const kind of ["privacy", "returns"]) eq((await owner.json("/api/admin/policy-start", "POST", { kind })).status, 200, `${kind}:`);
  const st = await owner.step4();
  const reads = ["privacy", "returns"].map((id) => fixOf(st, id, "policy_read"));
  ok(reads.every((r) => r && r.allowed && typeof r.docId === "string"), JSON.stringify(reads));
  starterIds = reads.map((r) => r.docId);
  const doc = await owner.api.call("getDocument", reads[0].docId);
  ok(doc.ok && doc.data.document.body.sections.length > 0, "the draft text");
  eq(st.actions.find((a) => a.id === "open_store").allowed, false, "Open:");
  const flow = flowFor(owner);
  await flow.open([{ id: "doc_home" }]);
  await settle(flow);
  ok(!flow.getState().items.some((it) => starterIds.includes(it.id)), `a starter in the set: ${JSON.stringify(flow.getState().items.map((i) => i.id))}`);
  eq(flow.canConfirm(), false, "can't confirm:");
});

await t("contact form: only the fields the founder filled in are sent; another admin's support email survives a phone-only save; the store name and tagline are kept; the item is then ok with no form", async () => {
  ok(fixOf(await owner.step4(), "contact", "contact_form")?.allowed, "the form is offered");
  eq([O.contactIdentity("", " +91 98765 43210 "), O.contactIdentity("hi@oomain.test", ""), O.contactIdentity("", "")], [{ support_phone: "+91 98765 43210" }, { support_email: "hi@oomain.test" }, {}], "contactIdentity:");
  // another admin saves an email in Settings meanwhile (the founder's form still shows: it was read before)
  await C.patchTenant("oomain", { config: { site: { ...(await cfgOf("main")).site, support_email: "admin@oomain.test" } } });
  eq((await owner.json("/api/admin/settings", "PUT", { identity: O.contactIdentity("", "+91 98765 43210") })).status, 200, "phone-only save:");
  const site = (await cfgOf("main")).site;
  eq([site.name, site.tagline, site.support_email, site.support_phone], ["Store main", "Kept tagline", "admin@oomain.test", "+91 98765 43210"], "the other admin's email survives:");
  const st = await owner.step4();
  eq([st.facts.items.find((i) => i.id === "contact").level, fixOf(st, "contact", "contact_form")], ["ok", undefined], "ok, no form:");
});

await t("buildSettingsPatch: an absent support field keeps its value; Settings' own form, which sends both, still clears one emptied on purpose", async () => {
  const { buildSettingsPatch } = await import("../lib/admin/settings.js");
  const cur = { site: { name: "S", support_email: "a@b.test", support_phone: "123" } };
  eq(buildSettingsPatch({ identity: { name: "S" } }, cur).patch.config.site, { name: "S", support_email: "a@b.test", support_phone: "123" }, "absent:");
  eq(buildSettingsPatch({ identity: { name: "S", support_email: "", support_phone: "123" } }, cur).patch.config.site, { name: "S", support_email: null, support_phone: "123" }, "emptied email:");
  eq(buildSettingsPatch({ identity: { name: "S", support_email: "a@b.test", support_phone: "" } }, cur).patch.config.site, { name: "S", support_email: "a@b.test", support_phone: null }, "emptied phone:");
  // through the route, as SettingsAdmin sends it (every identity field, the emptied one as "")
  const before = (await cfgOf("main")).site;
  eq((await owner.json("/api/admin/settings", "PUT", { identity: { name: before.name, support_email: before.support_email, support_phone: "" } })).status, 200, "route:");
  eq((await cfgOf("main")).site.support_phone, null, "cleared on purpose:");
  await C.patchTenant("oomain", { config: { site: { ...(await cfgOf("main")).site, support_phone: "+91 98765 43210" } } });
});

await t("I've read it on both: nothing blocks, Open is allowed; the flow folds both pages in, loads every list and can confirm; confirm sends confirmOpen and the store opens: a live release, publish_log rows for every published id with that release, a storefront.publish audit row, the starter drafts only as founder-read pages", async () => {
  let st = await owner.step4();
  for (const id of ["privacy", "returns"]) {
    const r = fixOf(st, id, "policy_read");
    eq((await owner.json("/api/admin/policy-start", "POST", { markRead: { id: r.docId, revision: r.revision } })).status, 200, `${id} read:`);
  }
  st = await owner.step4();
  eq([st.state, st.actions.find((a) => a.id === "open_store").allowed], ["ready", true], "ready:");
  // an unrelated draft page: it must stay a draft
  const other = await inS("main", () => Docs.createDocument({ type: "page", body: { ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug: "our-story", title: "Our story" } }, actor: { kind: "merchant", id: "usr_oo", role: "owner" } }));
  const otherId = other.document.id;
  const flow = flowFor(owner);
  await flow.open([{ id: "doc_home" }]);
  await settle(flow);
  const s = flow.getState();
  eq([s.phase, s.items.map((i) => i.id).sort()], ["opening", ["doc_home", ...starterIds].sort()], "home plus both read pages:");
  ok(s.order.every((id) => s.lists[id]?.status === "loaded"), "every list loaded");
  eq(flow.canConfirm(), true, "can confirm:");
  ok(!s.items.some((i) => i.id === otherId), "the unrelated draft is not in the set");
  const auditBefore = (await auditOf("ooroles", "storefront.publish")).length + (await auditOf("oomain", "storefront.publish")).length;
  // no design document yet: the server makes the starting-colours draft and
  // asks once more with it in the offer (OPENING_NEEDS_DESIGN); the flow folds
  // it in and the founder confirms again
  let out = await flow.confirm();
  if (out?.phase === "opening" && out.reason === "design") {
    await settle(flow);
    ok(flow.getState().items.some((i) => i.id === "doc_design"), "the design draft is folded in");
    eq(flow.canConfirm(), true, "can confirm again:");
    out = await flow.confirm();
  }
  eq(out?.phase, "done", JSON.stringify(out).slice(0, 300));
  const live = (await raw("main", "SELECT live_release_id FROM release_state WHERE id = 1"))[0]?.live_release_id;
  ok(live, "a live release");
  const logs = await raw("main", "SELECT document_id, release_id FROM publish_log");
  eq(logs.map((l) => l.document_id).sort(), ["doc_design", "doc_home", ...starterIds].sort(), "publish_log ids (home, the read pages, the design):");
  eq(out.published.map((p) => p.id).sort(), logs.map((l) => l.document_id).sort(), "every published id has its row:");
  ok(logs.every((l) => l.release_id === live), "every row names the release");
  eq((await auditOf("oomain", "storefront.publish")).length + (await auditOf("ooroles", "storefront.publish")).length, auditBefore + 1, "one audit row:");
  eq((await raw("main", "SELECT COUNT(*) AS n FROM publish_log WHERE document_id = ?", [otherId]))[0].n, 0, "no publish_log row for the unrelated draft:");
  eq((await raw("main", "SELECT published_version_id FROM documents WHERE id = ?", [otherId]))[0].published_version_id, null, "no live version for it:");
  const pages = await raw("main", `SELECT updated_by FROM documents WHERE id IN (${starterIds.map(() => "?").join(",")})`, starterIds);
  ok(pages.every((p) => p.updated_by !== `${Pol.POLICY_STARTER_ACTOR.kind}:${Pol.POLICY_STARTER_ACTOR.id}`), `a starter went live: ${JSON.stringify(pages)}`);
});

await t("done: step 4 says 'Your store is open.' with the store address and the live link", async () => {
  const st = await owner.step4();
  eq([st.state, st.words, st.facts.storeAddress, st.facts.liveUrl], ["done", "Your store is open.", "oomain.test", "/api/preview?exit=1&to=%2F"], "done:");
});

// =========================================================================================
console.log("— 3. the role matrix");

const rolesSnapshot = async () => ({
  releases: await raw("roles", "SELECT id FROM releases"),
  log: await raw("roles", "SELECT * FROM publish_log"),
  live: await raw("roles", "SELECT live_release_id FROM release_state"),
  audit: (await auditOf("ooroles", "storefront.publish")).length,
});
const homeItem = async (key) => {
  const d = await inS(key, () => Docs.getDocument("doc_home"));
  return { id: d.id, revision: d.revision, draftHash: d.draftHash };
};

await t("staff and support: publishSet 403 with no release, publish_log or audit row; settings PUT 403 with checkout_mode unchanged", async () => {
  const before = await rolesSnapshot();
  for (const role of ["staff", "support"]) {
    const c = client("roles", users[`roles_${role}`]);
    const r = await c.api.call("publishSet", [await homeItem("roles")], { checkOpening: true, confirmOpen: true });
    ok(r.error && !r.ok, `${role} publish: ${JSON.stringify(r)}`);
    const raw403 = await c.fetch(DOCUMENTS_URL, { method: "PUT", body: JSON.stringify({ publishSet: [await homeItem("roles")], checkOpening: true, confirmOpen: true }) });
    eq(raw403.status, 403, `${role} publish status:`);
    eq((await c.json("/api/admin/settings", "PUT", { commerce: { checkout_mode: "direct" } })).status, 403, `${role} settings:`);
    eq((await c.json("/api/admin/onboarding", "POST", { step: "test_order" })).status, 403, `${role} test order:`);
  }
  eq(await rolesSnapshot(), before, "nothing written:");
  eq((await cfgOf("roles")).checkout_mode, "disabled", "checkout_mode unchanged:");
});

await t("support: the policy starter 403; reading a draft is allowed; GET step 4 lists every item with every control disabled and the reason; no Razorpay key id or secret in the answer", async () => {
  const own = client("roles", users.roles_owner);
  eq((await own.json("/api/admin/policy-start", "POST", { kind: "privacy" })).status, 200, "owner starts privacy:");
  const sup = client("roles", users.roles_support);
  eq((await sup.json("/api/admin/policy-start", "POST", { kind: "returns" })).status, 403, "support start:");
  const res = await sup.json("/api/admin/onboarding");
  eq(res.status, 200, "support GET:");
  const text = JSON.stringify(res.body);
  for (const c of ["rzp_test_oocanarykey", "oo-secret-canary", "razorpay_key"]) ok(!text.includes(c), `leaked ${c}`);
  const st = res.body.steps[3];
  eq(st.facts.items.map((i) => i.id), ["home", "payment", "privacy", "returns", "test_order", "catalog", "contact", "design"], "every item:");
  const read = fixOf(st, "privacy", "policy_read");
  eq([read.allowed, read.markRead.allowed, read.markRead.reason], [true, false, O.READ_ONLY_REASON], "support reads, can't mark:");
  ok((await sup.api.call("getDocument", read.docId)).ok, "support reads the draft");
  for (const f of st.facts.items.flatMap((i) => i.fixes)) {
    if (f.kind === "policy_read" || f.kind === "support" || f.kind === "step" || (f.kind === "link" && !/^\/admin\/(settings|billing)/.test(f.href))) continue;
    eq([f.kind, f.allowed, f.reason], [f.kind, false, O.READ_ONLY_REASON], `support ${f.kind}:`);
  }
  for (const a of st.actions) ok(a.id === "policy_view" ? a.allowed : !a.allowed && a.reason, `support action ${a.id}`);
});

await t("signed out: 401 on the onboarding GET, the documents publish, the settings PUT and the policy starter", async () => {
  const anon = client("roles", null);
  eq((await anon.json("/api/admin/onboarding")).status, 401, "GET:");
  eq((await anon.fetch(DOCUMENTS_URL, { method: "PUT", body: JSON.stringify({ publishSet: [await homeItem("roles")], checkOpening: true }) })).status, 401, "publish:");
  eq((await anon.json("/api/admin/settings", "PUT", { commerce: { checkout_mode: "direct" } })).status, 401, "settings:");
  eq((await anon.json("/api/admin/policy-start", "POST", { kind: "returns" })).status, 401, "policy start:");
});

// =========================================================================================
console.log("— 4. source guard");

await t("components/admin/onboarding/ never imports lib/documents/publish*, and reaches /api/admin/documents only through documentsApi", async () => {
  const dir = join(ROOT, "components/admin/onboarding");
  const files = (await readdir(dir)).filter((f) => /\.(js|jsx|ts|tsx)$/.test(f));
  ok(files.length >= 4, `files: ${files}`);
  const resolveSpec = (spec, from) => (spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : spec);
  let usesApi = false;
  for (const f of files) {
    const path = join(dir, f);
    const src = await readFile(path, "utf8");
    const specs = [...src.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\bexport\s+[^'"]*?\sfrom\s+["']([^"']+)["']/g)].map((m) => m[1] || m[2] || m[3]);
    for (const s of specs) {
      const target = resolveSpec(s, path).replace(/\\/g, "/");
      ok(!/\/lib\/documents\/publish/.test(target), `${f} imports ${s}`);
      if (/components\/admin\/editor\/documentsApi/.test(target)) usesApi = true;
    }
    ok(!src.includes("/api/admin/documents") && !src.includes("DOCUMENTS_URL"), `${f} names the documents API itself`);
  }
  ok(usesApi, "step 4 uses documentsApi");
});

await plat.cleanup?.().catch?.(() => {});
await F.removeFixtureFiles("oo");
console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
