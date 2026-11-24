// Phase 1 line 3: the four-step onboarding page, WP-A (model, API, nav, redirects).
//   1. deriveSteps (pure): the state table, one fixture per row; an open store
//      is all done; the _default store; current and doneCount; resume rules
//      (?step); the actions per role; the shop domain only with settings.read;
//      a failed read is never done
//   2. readOnboardingFacts on real fixture stores (file databases): each
//      table row from real rows, and a failed SQL read leaves its step not done
//   3. GET/POST /api/admin/onboarding with real sessions: every role, the
//      least-trusted cases (support keys and actions, signed out, another
//      store's session, cross-origin), the test-order check-off's audit row
//   4. the nav and the redirects (/admin, /admin/setup, /admin/start)
//   5. FirstRun mounted: canEdit=false never POSTs
// Nothing here reaches Shopify, Typesense or a hosted database.
//   pnpm test:onboarding
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stubUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  // a redirect throws, as Next's does; the page tests read where it went
  "next/navigation": stubUrl(`export * from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("next/navigation.js")).href)}; export function redirect(to) { throw Object.assign(new Error(\`REDIRECT \${to}\`), { redirectTo: to }); }`),
  // pages run inside the suite's own withTenant
  "@/lib/console-request": stubUrl("export const tfetch = (fn) => fn();"),
};
registerHooks({
  resolve(spec, ctx, next) {
    if (STUBS[spec]) return { url: STUBS[spec], shortCircuit: true };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
delete process.env.CHECKOUT_MODE;
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-onb-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
for (const k of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN", "SHOPIFY_ADMIN_TOKEN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]) delete process.env[k];

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

const S = await import("../lib/onboarding/steps.js");
const { roleAllows, ROLES } = await import("../lib/platform/authz.js");

// =========================================================================================
console.log("— 1. deriveSteps (pure)");

// A closed documents store with nothing done: each fixture below changes only what its row needs.
const view = (state, extra = {}) => ({ state, firstSync: true, linked: true, canStart: state === "none" || state === "complete", canRetry: ["failed", "stalled", "retrying"].includes(state), message: null, detail: "d", headline: "h", ...extra });
const base = (over = {}) => ({
  supported: true,
  shopDomain: null,
  linked: false,
  sync: { hasComplete: false, anyRun: false, products: 0, view: view("none", { canStart: false, linked: false }) },
  cmsMode: "documents",
  brandRecorded: false,
  designBranded: false,
  hasHome: false,
  open: false,
  opening: { items: [{ id: "privacy", level: "block", title: "Privacy page" }, { id: "returns", level: "block", title: "Returns page" }, { id: "test_order", level: "warn", title: "No test order yet" }] },
  testOrderMarked: false,
  ...over,
});
const OK_OPENING = { items: [{ id: "privacy", level: "ok", title: "Privacy page" }, { id: "returns", level: "ok", title: "Returns page" }, { id: "test_order", level: "warn", title: "No test order yet" }] };
const step = (facts, id, role = "owner") => S.deriveSteps(facts, role).steps.find((s) => s.id === id);
const st = (facts, id) => step(facts, id).state;
const synced = (over = {}) => ({ hasComplete: true, anyRun: true, products: 24, view: view("complete", { firstSync: false }), ...over });

await t("the shape: supported, open, current, doneCount, total 4, and four steps in order, each with a label, a state, words, facts and actions", async () => {
  const m = S.deriveSteps(base(), "owner");
  eq(Object.keys(m), ["supported", "open", "openKnown", "current", "doneCount", "total", "steps"], "keys:");
  eq(m.steps.map((s) => [s.id, s.label]), [["connect", "Connect Shopify"], ["import", "Import products"], ["brand", "Brand"], ["open", "Open your store"]], "steps:");
  for (const s of m.steps) {
    ok(S.STEP_STATES.includes(s.state), `${s.id} state ${s.state}`);
    ok(typeof s.words === "string" && s.words.length > 10, `${s.id} words`);
    ok(s.facts && typeof s.facts === "object" && Array.isArray(s.actions), `${s.id} facts/actions`);
  }
  eq([m.supported, m.open, m.openKnown, m.total, m.doneCount, m.current], [true, false, true, 4, 0, "connect"], "a fresh store:");
});

await t("connect: done when linked, or any complete sync, or products > 0; in progress when a domain is recorded but not linked; never blocked; ready otherwise", async () => {
  eq(st(base({ linked: true }), "connect"), "done", "linked:");
  eq(st(base({ sync: synced({ products: 0 }) }), "connect"), "done", "a complete sync (no products):");
  eq(st(base({ sync: { hasComplete: false, anyRun: false, products: 3, view: view("complete") } }), "connect"), "done", "products:");
  const ip = step(base({ shopDomain: "acme.myshopify.com" }), "connect");
  eq(ip.state, "in_progress", "domain only:");
  ok(/nothing for you to do yet/.test(ip.words), `the founder has nothing to do yet: ${ip.words}`);
  eq(st(base(), "connect"), "ready", "nothing:");
  ok(/never changes anything in Shopify/.test(step(base(), "connect").words), "honest words: nothing written to Shopify");
  for (const f of [base(), base({ shopDomain: "x.myshopify.com" }), base({ cmsMode: "migrating" }), base({ cmsMode: "odd" })]) ok(st(f, "connect") !== "blocked", "connect is never blocked");
});

await t("import: done on a complete run ever, or legacy products (no runs); in progress while the latest run is running or retrying; blocked until connect is done, or while the store is being moved; ready (with the problem) on failed/stalled; ready with no run", async () => {
  eq(st(base({ sync: synced() }), "import"), "done", "complete:");
  eq(st(base({ sync: { hasComplete: false, anyRun: false, products: 5, view: view("complete") } }), "import"), "done", "legacy products:");
  const doneEmpty = step(base({ sync: synced({ products: 0 }) }), "import");
  eq([doneEmpty.state, doneEmpty.words], ["done", S.WORDS.import.noProducts], "no products: done, says to add them in Shopify:");
  eq(st(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 2, view: view("running") } }), "import"), "in_progress", "running:");
  eq(st(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 2, view: view("retrying") } }), "import"), "in_progress", "retrying:");
  const bc = step(base(), "import");
  eq([bc.state, bc.blockedBy, bc.words], ["blocked", "connect", S.WORDS.import.blockedConnect], "connect not done:");
  const bu = step(base({ linked: true, cmsMode: "migrating" }), "import");
  eq([bu.state, bu.blockedBy], ["blocked", "updating"], "being moved:");
  const failed = step(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 0, view: view("failed", { message: "Shopify didn't answer." }) } }), "import");
  eq([failed.state, failed.problem], ["ready", "Shopify didn't answer."], "failed:");
  eq(failed.actions.map((a) => a.id), ["retry_sync"], "failed offers Try again:");
  eq(step(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 0, view: view("stalled", { message: "It stopped." }) } }), "import").problem, "It stopped.", "stalled:");
  const ready = step(base({ linked: true, sync: { hasComplete: false, anyRun: false, products: 0, view: view("none") } }), "import");
  eq([ready.state, ready.problem, ready.actions.map((a) => a.id)], ["ready", undefined, ["start_sync"]], "no run:");
  eq(step(base({ linked: true, sync: synced(), cmsMode: "migrating" }), "import").state, "done", "a done import stays done while the store moves:");
});

await t("brand: done when the brand step is recorded (or the design has a brand/theme) and doc_home exists; in progress with exactly one; blocked when the CMS mode is not documents; ready with neither", async () => {
  eq(st(base({ brandRecorded: true, hasHome: true }), "brand"), "done", "recorded + home:");
  eq(st(base({ designBranded: true, hasHome: true }), "brand"), "done", "branded design + home:");
  eq(st(base({ brandRecorded: true }), "brand"), "in_progress", "recorded only:");
  eq(st(base({ hasHome: true }), "brand"), "in_progress", "home only:");
  eq(st(base({ designBranded: true }), "brand"), "in_progress", "branded only:");
  for (const mode of ["migrating", "odd"]) {
    const b = step(base({ cmsMode: mode }), "brand");
    eq([b.state, b.blockedBy, b.actions], ["blocked", "updating", []], `${mode}:`);
  }
  eq(st(base(), "brand"), "ready", "neither:");
});

await t("open: done on a live release (and then every step is done); blocked by any opening item at level block, the reasons are their titles; ready when nothing blocks; open is not gated on steps 1-3", async () => {
  const blocked = step(base(), "open");
  eq(blocked.state, "blocked", "policies missing:");
  eq(blocked.facts.blocking, [{ id: "privacy", title: "Privacy page" }, { id: "returns", title: "Returns page" }], "the blocking items:");
  ok(blocked.words.includes("Privacy page, Returns page"), `the reasons in the words: ${blocked.words}`);
  const ready = step(base({ opening: OK_OPENING }), "open");
  eq(ready.state, "ready", "nothing blocks (steps 1-3 not done):");
  const m = S.deriveSteps(base({ opening: OK_OPENING }), "owner");
  eq(m.steps.map((s) => s.state), ["ready", "blocked", "ready", "ready"], "open not gated on 1-3:");
  eq(ready.facts.items, OK_OPENING.items, "the opening items are the step's facts:");
});

await t("a store still on the old editor (cmsMode legacy, which nothing sets since migration 0026): supported false with reason legacy and the plain 'old editor, contact support' words; no steps, never 'being updated'", async () => {
  for (const f of [base({ cmsMode: "legacy" }), base({ cmsMode: "legacy", open: true, linked: true, sync: synced() })]) {
    const m = S.deriveSteps(f, "owner");
    eq([m.supported, m.reason, m.words, m.steps, m.current, m.doneCount], [false, "legacy", S.LEGACY_WORDS, [], null, 0], "legacy:");
  }
  ok(/old editor/.test(S.LEGACY_WORDS) && /support/i.test(S.LEGACY_WORDS) && !/being updated/.test(S.LEGACY_WORDS), S.LEGACY_WORDS);
  const { scanText } = await import("./support/banned-copy.js");
  eq(scanText(S.LEGACY_WORDS), [], "banned copy:");
});

await t("openKnown: true when the live release was read (open or closed), false when it could not be (open null), for supported and _default stores alike", async () => {
  eq([S.deriveSteps(base(), "owner").openKnown, S.deriveSteps(base({ open: true }), "owner").openKnown, S.deriveSteps(base({ open: null }), "owner").openKnown], [true, true, false], "supported:");
  eq([S.deriveSteps({ supported: false, open: false }).openKnown, S.deriveSteps({ supported: false, open: null }).openKnown], [true, false], "_default:");
});

await t("pollsWhile: only while Import is in progress with its sync running or retrying; never for a connect or brand step in progress, a done or failed import, or an open store", async () => {
  const poll = (f) => S.pollsWhile(S.deriveSteps(f, "owner"));
  eq(poll(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 4, view: view("running") } })), true, "running:");
  eq(poll(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 4, view: view("retrying") } })), true, "retrying:");
  eq(poll(base({ shopDomain: "acme.myshopify.com" })), false, "connect in progress:");
  eq(step(base({ shopDomain: "acme.myshopify.com" }), "connect").state, "in_progress", "(connect is in progress there)");
  eq(poll(base({ linked: true, sync: synced(), brandRecorded: true })), false, "brand in progress:");
  eq(step(base({ linked: true, sync: synced(), brandRecorded: true }), "brand").state, "in_progress", "(brand is in progress there)");
  eq(poll(base({ linked: true, sync: synced() })), false, "import done:");
  eq(poll(base({ linked: true, sync: { hasComplete: false, anyRun: true, products: 0, view: view("failed") } })), false, "failed:");
  eq(poll(base({ open: true, sync: { hasComplete: false, anyRun: true, products: 4, view: view("running") } })), false, "open store:");
  eq([S.pollsWhile(null), S.pollsWhile({ steps: [] })], [false, false], "no model:");
});

await t("an open store: every step done, current 'open', doneCount 4, no blockedBy or problem anywhere (even with unreadable or unfinished facts)", async () => {
  for (const f of [base({ open: true, opening: null }), base({ open: true, sync: null, cmsMode: "migrating", linked: null, hasHome: null })]) {
    const m = S.deriveSteps(f, "owner");
    eq([m.open, m.current, m.doneCount], [true, "open", 4], "summary:");
    eq(m.steps.map((s) => s.state), ["done", "done", "done", "done"], "states:");
    ok(m.steps.every((s) => !("blockedBy" in s) && !("problem" in s)), JSON.stringify(m.steps));
    eq(m.steps.find((s) => s.id === "open").words, "Your store is open.", "open words:");
  }
});

await t("the _default store: supported false, no steps, the same keys", async () => {
  eq(S.deriveSteps({ supported: false, open: false }, "owner"), { supported: false, open: false, openKnown: true, current: null, doneCount: 0, total: 4, steps: [] }, "_default:");
});

await t("current is the first step not done; doneCount counts done steps", async () => {
  const f = base({ linked: true, sync: synced() });
  const m = S.deriveSteps(f, "owner");
  eq([m.current, m.doneCount], ["brand", 2], "connect and import done:");
  const m2 = S.deriveSteps(base({ linked: true, sync: synced(), brandRecorded: true, hasHome: true, opening: OK_OPENING }), "owner");
  eq([m2.current, m2.doneCount], ["open", 3], "three done:");
  const m3 = S.deriveSteps(base({ brandRecorded: true, hasHome: true }), "owner");
  eq([m3.current, m3.doneCount], ["connect", 1], "a later step done first:");
});

await t("resume: ?step=<connect|import|brand|open> opens that step; anything else is ignored and the first step not done opens", async () => {
  const m = S.deriveSteps(base({ linked: true, sync: synced() }), "owner");
  for (const id of S.STEP_IDS) eq(S.resumeStep(id, m), id, `${id}:`);
  for (const q of [undefined, null, "", "Brand", "setup", "launch", "../x", ["brand"], 3]) eq(S.resumeStep(q, m), "brand", `${JSON.stringify(q)}:`);
  eq(S.resumeStep(null, S.deriveSteps(base({ open: true }), "owner")), "open", "an open store opens on open:");
  eq(S.parseStep("import"), "import", "parseStep:");
  eq(S.parseStep("nope"), null, "parseStep unknown:");
});

await t("a failed read is never done: each step stays not done with 'We couldn't check this just now'", async () => {
  const c = step(base({ linked: null, sync: null }), "connect");
  eq([c.state, c.problem], ["ready", S.UNREADABLE], "connect:");
  const i = step(base({ linked: true, sync: null }), "import");
  eq([i.state, i.problem], ["ready", S.UNREADABLE], "import:");
  const b1 = step(base({ brandRecorded: true, hasHome: null }), "brand");
  eq([b1.state, b1.problem], ["in_progress", S.UNREADABLE], "brand, home unreadable:");
  const b2 = step(base({ cmsMode: null, brandRecorded: true }), "brand");
  eq([b2.state, b2.problem], ["ready", S.UNREADABLE], "brand, mode unreadable:");
  const b3 = step(base({ designBranded: null, hasHome: true }), "brand");
  eq([b3.state, b3.problem], ["in_progress", S.UNREADABLE], "brand, design unreadable:");
  const o1 = step(base({ opening: null }), "open");
  eq([o1.state, o1.problem], ["ready", S.UNREADABLE], "open, report unreadable:");
  ok(!o1.actions.some((a) => a.id === "open_store"), "no Open button on a guess");
  const o2 = step(base({ open: null }), "open");
  eq([o2.state, o2.problem], ["ready", S.UNREADABLE], "open, live state unreadable:");
  eq(S.deriveSteps(base({ open: null }), "owner").open, false, "open is false on a failed read:");
});

await t("actions per role come from lib/platform/authz.js: sync start/retry sync.run; starter store, brand save/skip, policy start/read storefront.write; description and test order settings.write; Open storefront.publish", async () => {
  eq(S.ACTION_PERMS, {
    start_sync: "sync.run", retry_sync: "sync.run", starter_store: "storefront.write", brand_save: "storefront.write", brand_skip: "storefront.write",
    brand_description: "settings.write", policy_start: "storefront.write", policy_read: "storefront.write", test_order: "settings.write", open_store: "storefront.publish",
  }, "the map:");
  const f = base({ linked: true, sync: { hasComplete: false, anyRun: false, products: 0, view: view("none") }, opening: OK_OPENING });
  for (const role of ROLES) {
    const all = S.deriveSteps(f, role).steps.flatMap((s) => s.actions);
    eq(all.map((a) => a.id).sort(), ["brand_description", "brand_save", "brand_skip", "open_store", "policy_read", "policy_start", "start_sync", "starter_store", "test_order"], `${role} ids:`);
    for (const a of all) {
      eq(a.allowed, roleAllows(role, S.ACTION_PERMS[a.id]), `${role} ${a.id}:`);
      if (a.allowed) ok(!("reason" in a), `${role} ${a.id} has no reason`);
      else ok(typeof a.reason === "string" && a.reason, `${role} ${a.id} says why`);
    }
  }
  const staffOpen = step(f, "open", "staff").actions.find((a) => a.id === "open_store");
  eq([staffOpen.allowed, staffOpen.reason], [false, "Only the owner or an admin can open the store"], "staff Open:");
  const staffSync = step(f, "import", "staff").actions.find((a) => a.id === "start_sync");
  eq([staffSync.allowed, staffSync.reason], [false, S.ADMIN_ONLY_REASON], "staff sync:");
  const sup = S.deriveSteps(f, "support").steps.flatMap((s) => s.actions);
  ok(sup.every((a) => a.allowed === false && a.reason === S.READ_ONLY_REASON), "support: every action disabled, read-only words");
  ok(S.deriveSteps(f, "nobody").steps.flatMap((s) => s.actions).every((a) => !a.allowed), "an unknown role: nothing allowed");
});

await t("the shop domain is in the connect step's facts only for roles with settings.read (owner, admin); staff and support never get the key", async () => {
  const f = base({ shopDomain: "acme.myshopify.com" });
  for (const role of ROLES) {
    const c = step(f, "connect", role);
    if (roleAllows(role, "settings.read")) eq(c.facts.shopDomain, "acme.myshopify.com", `${role}:`);
    else ok(!("shopDomain" in c.facts) && !JSON.stringify(S.deriveSteps(f, role)).includes("acme.myshopify.com"), `${role} sees no domain`);
  }
  ok(!JSON.stringify(S.deriveSteps(base({ open: true, shopDomain: "acme.myshopify.com" }), "support")).includes("acme"), "open store, support: no domain");
});

await t("words: plain founder copy, no internal names", async () => {
  const { scanText } = await import("./support/banned-copy.js");
  const all = JSON.stringify(S.WORDS) + S.UNREADABLE + S.TEST_ORDER_CLOSED_HINT + S.READ_ONLY_REASON + S.ADMIN_ONLY_REASON + S.OPEN_REASON;
  const hits = scanText(all);
  eq(hits, [], "banned copy:");
  ok(!/sync_runs|doc_home|cms_state|release_state|tenant/i.test(all), "no internal names");
});

// =========================================================================================
console.log("— 2. readOnboardingFacts on fixture stores");

const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("onb");
const plat = await F.makePlatform({ name: "onb" });
const C = plat.control;
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const R = await import("../lib/registry/index.js");
const Svc = await import("../lib/onboarding/service.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { currentDatabase } = await import("../lib/db.js");

const stores = {};
const mk = async (key, opts) => (stores[key] = await F.makeTenant({ name: `onb-${key}`, id: `onb${key}`, ...opts }));
await mk("fresh", { mode: "documents" });
await mk("synced", { mode: "documents", sync: "complete", catalogShape: "few" });
await mk("partial", { mode: "documents", sync: "partial", catalogShape: "many" });
await mk("failed", { mode: "documents", sync: "failed", catalogShape: "many" });
await mk("legacyprod", { mode: "documents", products: 3 });
await mk("domain", { mode: "documents", config: { shopify_store_domain: "onbdomain.myshopify.com" } });
await mk("linked", { mode: "documents", config: { shopify_store_domain: "onblinked.myshopify.com" }, secrets: { shopify_admin_token: "shpat_onb_canary_token" } });
await mk("moving", { mode: "documents" });
await mk("legacy", {});
await mk("brand", { mode: "documents", sync: "complete", catalogShape: "few", config: { onboarding: { brand_step: { at: "2026-11-01T00:00:00.000Z", paletteId: "forest" } } } });
await mk("open", { mode: "documents", sync: "complete", catalogShape: "few" });
await mk("route", { mode: "documents", config: { shopify_store_domain: "onbroute.myshopify.com", shopify_client_id: "onb-client-id-canary" }, secrets: { shopify_client_secret: "onb-client-secret-canary" } });
await mk("other", { mode: "documents" });
const raw = async (key, q, args = []) => {
  const c = stores[key].client();
  try {
    return (await c.execute({ sql: q, args })).rows.map((r) => ({ ...r }));
  } finally {
    c.close();
  }
};
await raw("moving", "UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
const inS = async (key, fn) => withTenant(await C.getTenant(`onb${key}`, { fresh: true }), fn);
const OWNER_ROLE = { role: "owner" };
const modelOf = (key, actor = OWNER_ROLE) => inS(key, () => Svc.onboardingFor(actor));
const statesOf = async (key) => (await modelOf(key)).steps.map((s) => s.state);
const homeBody = () => ({ ...R.emptyBody("home"), sections: [{ ...R.newSection("text", { id: "sec_onb_home" }), settings: { ...R.newSection("text", { id: "sec_onb_home" }).settings, title: "Hello", body: ["Hi."] } }] });
const ACT = { kind: "merchant", id: "usr_onb_owner", role: "owner" };
await inS("brand", () => Docs.createDocument({ type: "home", body: homeBody(), actor: ACT }));
await inS("open", async () => {
  const home = await Docs.createDocument({ type: "home", body: homeBody(), actor: ACT });
  return Pub.publish({ ids: [{ id: home.document.id, revision: home.document.revision, draftHash: home.document.draftHash }], actor: ACT });
});

async function withFailingSql(key, pattern, fn) {
  const client = await inS(key, () => currentDatabase().libsql);
  const real = client.execute;
  client.execute = (stmt, ...rest) => {
    const sql = typeof stmt === "string" ? stmt : stmt?.sql || "";
    if (pattern.test(sql)) return Promise.reject(Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" }));
    return real(stmt, ...rest);
  };
  try {
    return await fn();
  } finally {
    delete client.execute;
  }
}

await t("a fresh closed documents store (no domain, no keys, no products): connect ready, import blocked by connect, brand ready, open blocked by the privacy and returns pages; current connect", async () => {
  const m = await modelOf("fresh");
  eq(m.steps.map((s) => s.state), ["ready", "blocked", "ready", "blocked"], "states:");
  eq([m.current, m.doneCount, m.open, m.steps[1].blockedBy], ["connect", 0, false, "connect"], "summary:");
  const blocking = m.steps[3].facts.blocking.map((b) => b.id);
  ok(blocking.includes("privacy") && blocking.includes("returns"), JSON.stringify(blocking));
});

await t("a complete sync: connect done (no keys needed: the p6 seed's shape), import done", async () => {
  eq((await statesOf("synced")).slice(0, 2), ["done", "done"], "states:");
  const m = await modelOf("synced");
  eq(m.steps[1].facts.sync.state, "complete", "the sync view is the import step's facts:");
  ok(m.steps[1].facts.products > 0, "products counted");
});

await t("a sync partway: import in progress; a failed sync: import ready with the problem and Try again; legacy products (no runs): import done", async () => {
  const p = await modelOf("partial");
  eq([p.steps[0].state, p.steps[1].state], ["done", "in_progress"], "partial:");
  const f = await modelOf("failed");
  eq(f.steps[1].state, "ready", "failed:");
  ok(typeof f.steps[1].problem === "string" && f.steps[1].problem.length > 0 && !/tenant-fixture|second page/.test(f.steps[1].problem), `plain problem words: ${f.steps[1].problem}`);
  eq(f.steps[1].actions.map((a) => [a.id, a.allowed]), [["retry_sync", true]], "Try again:");
  eq((await statesOf("legacyprod")).slice(0, 2), ["done", "done"], "legacy products:");
});

await t("a recorded domain without keys: connect in progress; with keys: connect done (import then ready, not blocked)", async () => {
  eq((await statesOf("domain")).slice(0, 2), ["in_progress", "blocked"], "domain only:");
  eq((await statesOf("linked")).slice(0, 2), ["done", "ready"], "linked:");
});

await t("a store being moved: import and brand blocked ('updating'); a store on the old editor: not supported, the 'contact support' words", async () => {
  const m = await modelOf("moving");
  eq([m.steps[1].blockedBy, m.steps[2].state, m.steps[2].blockedBy], ["updating", "blocked", "updating"], "moving (the move is named first):");
  const l = await modelOf("legacy");
  eq([l.supported, l.reason, l.words, l.steps], [false, "legacy", S.LEGACY_WORDS, []], "legacy:");
  const p = await inS("legacy", () => Svc.onboardingProgress());
  eq([p.supported, p.doneCount], [false, 0], "legacy progress (no badge, no nudge):");
});

await t("brand: recorded brand step plus doc_home is done; the recorded step alone is in progress", async () => {
  eq((await statesOf("brand"))[2], "done", "recorded + home:");
  eq((await statesOf("synced"))[2], "ready", "neither:");
  const fixtureOnly = await withTenant({ ...(await C.getTenant("onbsynced", { fresh: true })), config: { ...(await C.getTenant("onbsynced")).config, onboarding: { brand_step: { at: "2026-11-01T00:00:00.000Z" } } } }, () => Svc.onboardingFor(OWNER_ROLE));
  eq(fixtureOnly.steps[2].state, "in_progress", "recorded only:");
});

await t("an open store (published): every step done, open true, current open", async () => {
  const m = await modelOf("open");
  eq([m.open, m.current, m.doneCount, m.steps.map((s) => s.state)], [true, "open", 4, ["done", "done", "done", "done"]], "open:");
});

await t("a failed SQL read leaves its step not done with 'We couldn't check this just now' (doc_home, sync_runs, release_state, the opening report)", async () => {
  const home = await withFailingSql("brand", /FROM documents WHERE id = 'doc_home'/, () => modelOf("brand"));
  eq([home.steps[2].state, home.steps[2].problem], ["in_progress", S.UNREADABLE], "doc_home:");
  const runs = await withFailingSql("synced", /FROM sync_runs/, () => modelOf("synced"));
  eq([runs.steps[0].state, runs.steps[0].problem, runs.steps[1].state, runs.steps[1].problem], ["ready", S.UNREADABLE, "ready", S.UNREADABLE], "sync_runs:");
  const live = await withFailingSql("open", /FROM release_state/, () => modelOf("open"));
  eq([live.open, live.openKnown, live.steps[3].state, live.steps[3].problem], [false, false, "ready", S.UNREADABLE], "release_state (an open store is not called closed-and-done on a guess):");
  const lp = await withFailingSql("open", /FROM release_state/, () => inS("open", () => Svc.onboardingProgress()));
  eq([lp.supported, lp.open, lp.openKnown], [true, false, false], "progress, release_state unreadable (no badge, no nudge):");
  const report = await withFailingSql("fresh", /WHERE type = 'page'/, () => modelOf("fresh"));
  eq([report.steps[3].state, report.steps[3].problem], ["ready", S.UNREADABLE], "the opening report:");
});

await t("onboardingProgress (the nav badge and dashboard nudge): the same doneCount as the full model, never reads the opening report; the Open step counts only on a live release", async () => {
  const counting = async (key, fn) => {
    const client = await inS(key, () => currentDatabase().libsql);
    const real = client.execute;
    const seen = [];
    client.execute = (stmt, ...rest) => (seen.push(typeof stmt === "string" ? stmt : stmt?.sql || ""), real(stmt, ...rest));
    try {
      return { value: await fn(), seen };
    } finally {
      delete client.execute;
    }
  };
  const Opening = await import("../lib/documents/opening.js");
  const reportSql = await counting("fresh", () => inS("fresh", () => Opening.openingReport()));
  const marker = reportSql.seen.find((q) => /WHERE type = 'page'/.test(q));
  ok(marker, `the opening report's own read: ${reportSql.seen.join(" | ").slice(0, 300)}`);
  for (const key of ["fresh", "synced", "brand", "open"]) {
    const full = await modelOf(key, { role: "support" });
    const light = await counting(key, () => inS(key, () => Svc.onboardingProgress()));
    eq(Object.keys(light.value), ["supported", "open", "openKnown", "doneCount", "total"], `${key} keys:`);
    eq([light.value.doneCount, light.value.open, light.value.openKnown], [full.doneCount, full.open, true], `${key}:`);
    ok(!light.seen.some((q) => /WHERE type = 'page'/.test(q)), `${key}: the light read ran the opening report: ${light.seen.filter((q) => /type = 'page'/.test(q)).join(" | ")}`);
  }
  // a closed store whose opening report would pass: the Open step still counts not done
  const fresh = await inS("fresh", () => Svc.onboardingProgress());
  eq([fresh.open, fresh.doneCount < 4], [false, true], "closed:");
});

await t("the _default store is not supported (it runs on environment config)", async () => {
  const m = await withTenant({ ...(await C.getTenant("onbfresh")), id: "_default" }, () => Svc.onboardingFor(OWNER_ROLE));
  eq([m.supported, m.steps, m.current], [false, [], null], "_default:");
});

// =========================================================================================
console.log("— 3. /api/admin/onboarding with real sessions");

const route = await import("../app/api/admin/onboarding/route.js");
const mkUser = async (email, role, store = "onbroute") => {
  const u = await I.createUser({ email, name: role, password: `${role}-onb-pass-1` });
  await I.addMembership(u.id, store, role);
  return { u, tok: (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token };
};
const users = {};
for (const role of ["owner", "admin", "staff", "support"]) users[role] = await mkUser(`${role}@onb.test`, role);
users.otherOwner = await mkUser("other-owner@onb.test", "owner", "onbother");
const HOST = "onbroute.test";
const req = (method, { tok, body, origin, host = HOST } = {}) => ({
  method,
  cookies: { get: (n) => (n === "_admin" && tok ? { name: n, value: tok } : undefined) },
  headers: { get: (k) => ({ host, ...(origin ? { origin } : {}) })[k.toLowerCase()] ?? null },
  url: `https://${host}/api/admin/onboarding`,
  nextUrl: new URL(`https://${host}/api/admin/onboarding`),
  json: async () => body,
});
const call = async (method, o) => {
  const res = await route[method](req(method, o), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json(), text: "" };
};
const CANARIES = ["onb-client-secret-canary", "onb-client-id-canary", "onbroute.myshopify.com", "shpat_"];
const KEYS = ["ok", "supported", "open", "openKnown", "current", "doneCount", "total", "steps"];

await t("GET as owner and admin: 200, the model, the shop domain in connect's facts; never the client id, secret or a token", async () => {
  for (const role of ["owner", "admin"]) {
    const r = await call("GET", { tok: users[role].tok });
    eq([r.status, Object.keys(r.body)], [200, KEYS], `${role}:`);
    eq(r.body.steps[0].facts.shopDomain, "onbroute.myshopify.com", `${role} domain:`);
    const text = JSON.stringify(r.body);
    for (const c of CANARIES.filter((x) => x !== "onbroute.myshopify.com")) ok(!text.includes(c), `${role}: ${c} leaked`);
  }
});

await t("least-trusted: support GET is 200 with exactly the keys, no shop domain, no tokens or client id, and every action disabled with the reason; staff gets no shop domain", async () => {
  const r = await call("GET", { tok: users.support.tok });
  eq([r.status, Object.keys(r.body)], [200, KEYS], "support:");
  const text = JSON.stringify(r.body);
  for (const c of CANARIES) ok(!text.includes(c), `support: ${c} leaked`);
  ok(!("shopDomain" in r.body.steps[0].facts), "no shopDomain key");
  const actions = r.body.steps.flatMap((s) => s.actions);
  ok(actions.length > 0 && actions.every((a) => a.allowed === false && a.reason === S.READ_ONLY_REASON), JSON.stringify(actions));
  const staff = await call("GET", { tok: users.staff.tok });
  eq(staff.status, 200, "staff:");
  ok(!JSON.stringify(staff.body).includes("onbroute.myshopify.com"), "staff: no domain");
});

await t("least-trusted: signed out is 401; another store's session on this host is 401; nothing of the store in either answer", async () => {
  const out = await call("GET", {});
  eq([out.status, out.body], [401, { error: "Unauthorized" }], "signed out:");
  const other = await call("GET", { tok: users.otherOwner.tok });
  eq([other.status, other.body], [401, { error: "Unauthorized" }], "another store's owner:");
  eq((await call("POST", { tok: users.otherOwner.tok, body: { step: "test_order" } })).status, 401, "another store's owner POST:");
});

const auditRows = async () => (await C.platformDb().execute({ sql: "SELECT actor, tenant_id, action, resource, diff FROM audit_log WHERE resource = 'onboarding:test_order' ORDER BY at", args: [] })).rows.map((r) => ({ ...r }));
const manualOf = async () => (await C.getTenant("onbroute", { fresh: true })).config?.onboarding?.manual || {};

await t("POST { step: 'test_order' } as owner sets the check-off, writes the audit row (settings.write, onboarding:test_order) and answers the model with the test order ok; { done: false } clears it; the brand step and other onboarding keys are kept", async () => {
  await C.patchTenant("onbroute", { config: { onboarding: { brand_step: { at: "2026-11-02T00:00:00.000Z" }, source: "signup" } } });
  const before = (await auditRows()).length;
  const r = await call("POST", { tok: users.owner.tok, body: { step: "test_order" } });
  eq([r.status, Object.keys(r.body)], [200, KEYS], JSON.stringify(r.body).slice(0, 300));
  eq(r.body.steps[3].facts.testOrderMarked, true, "the answer reads the new state:");
  eq(r.body.steps[3].facts.items.find((i) => i.id === "test_order")?.level, "ok", "the opening item is ok:");
  ok(typeof (await manualOf()).test_order === "string", "stored");
  const rows = await auditRows();
  eq(rows.length, before + 1, "one audit row:");
  eq([rows.at(-1).action, rows.at(-1).tenant_id, JSON.parse(rows.at(-1).diff)], ["settings.write", "onbroute", { done: true }], "the row:");
  const ob = (await C.getTenant("onbroute", { fresh: true })).config.onboarding;
  eq([ob.brand_step?.at, ob.source], ["2026-11-02T00:00:00.000Z", "signup"], "other keys kept:");
  const off = await call("POST", { tok: users.admin.tok, body: { step: "test_order", done: false } });
  eq([off.status, off.body.steps[3].facts.testOrderMarked], [200, false], "admin clears it:");
  ok(!("test_order" in (await manualOf())), "cleared");
  eq((await auditRows()).length, before + 2, "a second audit row:");
});

await t("POST refusals change nothing: staff 403, support 403, signed out 401, cross-origin 403, any other step 422 (preview and launch are gone)", async () => {
  const before = [await manualOf(), (await auditRows()).length];
  eq((await call("POST", { tok: users.staff.tok, body: { step: "test_order" } })).status, 403, "staff:");
  eq((await call("POST", { tok: users.support.tok, body: { step: "test_order" } })).status, 403, "support:");
  eq((await call("POST", { body: { step: "test_order" } })).status, 401, "signed out:");
  eq((await call("POST", { tok: users.owner.tok, body: { step: "test_order" }, origin: "https://evil.test" })).status, 403, "cross-origin:");
  for (const body of [{}, { step: "" }, { step: "preview" }, { step: "launch" }, { step: "connect" }, null]) eq((await call("POST", { tok: users.owner.tok, body })).status, 422, `${JSON.stringify(body)}:`);
  eq([await manualOf(), (await auditRows()).length], before, "nothing changed:");
});

// =========================================================================================
console.log("— 4. the nav and the redirects");

const { NAV, navFor, navItems } = await import("../lib/admin/nav.js");

await t("nav: 'Onboarding' (/admin/onboarding, storefront.read, badge 'onboarding') in Overview for every role; no Setup and no 'Logo and colours'; owner/admin 15 items, staff/support 11", async () => {
  const item = navItems(NAV).find((i) => i.id === "onboarding");
  eq({ ...item }, { id: "onboarding", label: "Onboarding", href: "/admin/onboarding", page: "onboarding", action: "storefront.read", badgeKey: "onboarding" }, "the item:");
  eq(NAV[0].items.map((i) => i.id), ["dashboard", "analytics", "onboarding"], "Overview:");
  ok(!navItems(NAV).some((i) => ["setup", "start"].includes(i.id) || ["/admin/setup", "/admin/start"].includes(i.href)), "no setup/start");
  eq(ROLES.map((r) => [r, navItems(navFor(r)).length]), [["owner", 15], ["admin", 15], ["staff", 11], ["support", 11]], "counts:");
  for (const r of ROLES) ok(navItems(navFor(r)).some((i) => i.id === "onboarding"), `${r} sees Onboarding`);
});

const PAGES = join(ROOT, "app/(console)/admin/(authed)");
const redirectOf = async (file, key = null) => {
  const mod = await import(pathToFileURL(join(PAGES, file)).href);
  try {
    if (key) await inS(key, () => mod.default({}));
    else await mod.default({});
  } catch (e) {
    if (e.redirectTo) return e.redirectTo;
    throw e;
  }
  return null;
};

await t("redirects: /admin/setup -> /admin/onboarding; /admin/start -> /admin/onboarding?step=brand; /admin -> onboarding while closed, the dashboard when open, for _default, and when the read fails", async () => {
  eq(await redirectOf("setup/page.js"), "/admin/onboarding", "setup:");
  eq(await redirectOf("start/page.js"), "/admin/onboarding?step=brand", "start:");
  eq(await redirectOf("page.js", "fresh"), "/admin/onboarding", "closed:");
  eq(await redirectOf("page.js", "open"), "/admin/dashboard", "open:");
  const mod = await import(pathToFileURL(join(PAGES, "page.js")).href);
  const def = await withTenant({ ...(await C.getTenant("onbfresh")), id: "_default" }, () => mod.default({}).catch((e) => e.redirectTo));
  eq(def, "/admin/dashboard", "_default:");
  eq(await withFailingSql("fresh", /release_state/i, () => redirectOf("page.js", "fresh")), "/admin/dashboard", "a failed read:");
  eq(await redirectOf("page.js", "legacy"), "/admin/dashboard", "a store on the old editor (no steps; never sent to onboarding forever):");
  eq(await withFailingSql("fresh", /FROM cms_state/i, () => redirectOf("page.js", "fresh")), "/admin/onboarding", "an unreadable editor mode on a closed store still goes to onboarding:");
  const src = (await import("node:fs")).readFileSync(join(PAGES, "page.js"), "utf8");
  ok(src.includes("liveOpen") && !src.includes("getLiveReleaseState"), "/admin reads the plain live_release_id (liveOpen), not getLiveReleaseState");
});

await t("retired: lib/admin/onboarding.js, components/admin/SetupAdmin.js and app/api/admin/setup/route.js are gone", async () => {
  for (const f of ["lib/admin/onboarding.js", "components/admin/SetupAdmin.js", "app/api/admin/setup/route.js"]) {
    let there = true;
    await access(join(ROOT, f)).catch(() => (there = false));
    ok(!there, `${f} still exists`);
  }
});

// =========================================================================================
console.log("— 5. the Brand step's FirstRun, mounted (its hooks run; no DOM)");

// A small hook driver: FirstRun is called as a function with its own state,
// refs and effects, and re-run until it settles. Children are not rendered:
// what matters here is which requests the component itself sends.
async function mountFirstRun(props, answer) {
  const req = createRequire(import.meta.url);
  const React = req("react");
  const swc = req("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const file = join(ROOT, "components/admin/first-run/FirstRun.js");
  const { readFileSync } = await import("node:fs");
  const code = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const box = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  const hooks = {
    useState(init) {
      const k = cursor++;
      if (!(k in box)) box[k] = typeof init === "function" ? init() : init;
      return [box[k], (v) => { const nv = typeof v === "function" ? v(box[k]) : v; if (!Object.is(nv, box[k])) { box[k] = nv; dirty = true; } }];
    },
    useRef(init) {
      const k = cursor++;
      if (!(k in box)) box[k] = { current: init };
      return box[k];
    },
    useEffect(fn, deps) {
      const k = cursor++;
      const prev = box[k];
      if (prev && deps && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
      box[k] = { deps };
      effects.push(fn);
    },
  };
  const react = { ...React, ...hooks, default: { ...React, ...hooks } };
  const Stub = () => null;
  const stubs = {
    react,
    "next/link": { default: Stub },
    "lucide-react": { RotateCcw: Stub },
    "@/components/console/Card": { Card: Stub, CardHeader: Stub },
    "@/components/console/Banner": { Banner: Stub },
    "@/components/console/Button": { Button: Stub },
    "@/components/admin/SyncProgress": { SyncProgressBody: Stub, readSync: async () => null, requestSync: async () => null, POLL_MS: 3000 },
    "@/lib/themes/palettes": { paletteById: () => null },
    "./BrandStep": { default: Stub },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : req(id)), mod, mod.exports);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push([init.method || "GET", String(url)]);
    return Response.json(init.method === "POST" ? { ok: true, ran: true, generated: ["doc_home"] } : answer);
  };
  try {
    for (let round = 0; round < 20; round++) {
      cursor = 0;
      effects = [];
      dirty = false;
      mod.exports.default(props);
      for (const e of effects) e();
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
      if (!dirty && !effects.length) break;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return { sent, viewOf: mod.exports.viewOf };
}
const MAKEABLE = { ok: true, firstRun: { generated: false, eligible: true, kept: [], byGenerator: [] }, sync: { state: "complete" } };

await t("least-trusted: FirstRun with canEdit=false on the 'make' view (support before the starter store exists) sends no POST, only its GET; with canEdit=true the same answer sends exactly one POST", async () => {
  const ro = await mountFirstRun({ canEdit: false, canSync: false }, MAKEABLE);
  eq(ro.viewOf(MAKEABLE.firstRun, MAKEABLE.sync), "make", "the answer is the 'make' view:");
  eq(ro.sent, [["GET", "/api/admin/first-run"]], "support (canEdit false): the GET only, no POST:");
  const rw = await mountFirstRun({ canEdit: true, canSync: true }, MAKEABLE);
  eq(rw.sent.filter(([m]) => m === "POST"), [["POST", "/api/admin/first-run"]], "an editor (canEdit true): one POST:");
});

await plat.cleanup();
for (const s of Object.values(stores)) await s.cleanup();
await F.removeFixtureFiles("onb");
console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
