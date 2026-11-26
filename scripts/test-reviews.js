// Reviews (Phase 9 line 1, docs/plans/phase-9.md "Line 1"): a buyer reviews a
// product from a signed invite link, the store moderates it, and the product
// page shows stars, the list and AggregateRating from approved reviews only.
//   pnpm test:reviews
// 1. Contracts: the plugin, its blocks (each Off), settings, handler and sweep.
// 2. Tokens: tampered, expired, other-store, moved and replayed links refused;
//    no link secret in production fails closed.
// 3. Invites from order.fulfilled; the write route (form and JSON, origin,
//    rate limit); two concurrent submits make one review.
// 4. Moderation as every role (support reads redacted, 403 on writes), audit
//    rows, cache invalidation, bulk ≤ 50, replies.
// 5. The anonymous shopper (least-trusted): only approved reviews render or
//    count, no email, plain text, store B's never on A; JSON-LD equals the
//    approved set over 200 random sets and is absent when Stars is Off, the
//    plugin is off or killed, or there are no reviews; "</script>" can't break out.
// 6. The sweep: one email per order, opt-out, emails off; privacy erase; export.
// 7. Banned-copy scan on the default copy.
// The clock is pinned (NOW) for every comparison against "now" in lib calls.
import "./support/request-cache.js"; // before any app module that imports react
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
const { runRequest } = await import("./support/request-cache.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-reviews-default.db";
process.env.PLATFORM_SECRET = "test-reviews-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
delete process.env.ORDER_LINK_SECRET;
delete process.env.RAZORPAY_KEY_SECRET;
await rm(join(ROOT, ".test-reviews-default.db"), { force: true });
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
    console.error(`✗ ${name}\n   ${String(e?.stack && !e.message ? e.stack : e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-20T10:00:00.000Z"); // the pinned clock

const CAT = await import("../lib/plugins/catalog.js");
const HND = await import("../lib/plugins/handlers.js");
const SW = await import("../lib/plugins/sweeps.js");
const PL = await import("../lib/plugins/placement.js");
const TOK = await import("../lib/reviews/tokens.js");
const ST = await import("../lib/reviews/store.js");
const STATS = await import("../lib/reviews/stats.js");
const MOD = await import("../lib/reviews/moderate.js");
const LD = await import("../lib/reviews/jsonld.js");
const WORDS = await import("../lib/reviews/words.js");
const SWEEP = await import("../lib/plugins/first-party/reviews/sweep.js");
const Cache = await import("../lib/cache.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { redactCustomer } = await import("../lib/privacy.js");
const { scanText } = await import("./support/banned-copy.js");
const { db } = await import("../lib/db.js");

// --- the stores: A (Reviews installed) and B (its own reviews), different link secrets
const store = await H.makeRoleStore({ name: "reviews", a: { products: 3, secrets: { order_link_secret: "reviews-a-link-secret" } }, b: { products: 2, secrets: { order_link_secret: "reviews-b-link-secret" } } });
const { a, b, call } = store;
const callJ = async (...args) => {
  const r = await call(...args);
  return { ...r, json: r.body };
};
const F = await import("./support/tenant-fixture.js");
const c = await F.makeTenant({ name: "reviews-c", products: 1, secrets: { order_link_secret: "" } }); // no link secret of its own
const P = (tn) => tn.run(async () => (await db.selectFrom("products").select(["id", "handle", "title"]).orderBy("handle").execute()).map((r) => ({ ...r })));
const [pa1, pa2, pa3] = await P(a);
const [pb1] = await P(b);
const EMAIL = "reviewer.canary@shopper.test";

async function placeOrder(tn, { id, email = EMAIL, name = "Priya Sharma", products, customerId = null }) {
  await tn.run(async () => {
    const at = new Date(NOW - 10 * DAY).toISOString();
    await db.insertInto("orders").values({ id, email, phone: "9999999999", name, subtotal: 100, total: 100, currency: "INR", payment_method: "cod", status: "synced", customer_id: customerId, created_at: at, updated_at: at }).execute();
    let pos = 0;
    for (const p of products) await db.insertInto("order_items").values({ order_id: id, product_id: p.id, variant_id: `${p.id}-v`, title: p.title, quantity: 1, unit_price: 100, line_total: 100, position: pos++ }).execute();
  });
}
const fulfil = (tn, orderId, fulfilledAt = new Date(NOW).toISOString(), settings = {}) =>
  tn.run(() => HND.handlerFor("reviews", "order.fulfilled")({ event: { id: "evt_x", type: "order.fulfilled", created_at: fulfilledAt, data: { order: { id: orderId } } }, install: { id: "pin_x", settings: { send_after_days: 7, ...settings } }, log: () => {} }));
const invitesOf = (tn, orderId) => tn.run(() => db.selectFrom("review_invites").selectAll().where("order_id", "=", orderId).orderBy("product_id").execute());
const tokenFor = (tn, inv) => tn.run(() => TOK.inviteToken(inv));
const GOOD = { rating: 5, title: "Lovely", body: "Soft, warm and exactly as shown in the pictures.", display_name: "Priya S." };

// --- 1. contracts -----------------------------------------------------------------
await t("contracts: Reviews is in the catalog (checkCatalog is []), asks for orders.read, receives order.fulfilled; three blocks in their slots; settings default off / 7 / on; handler and sweep registered", () => {
  eq(CAT.checkCatalog().join("\n"), "", "catalog problems:");
  const m = CAT.pluginById("reviews");
  ok(m, "in the catalog");
  eq(JSON.stringify(m.scopes), '["orders.read"]', "scopes:");
  eq(JSON.stringify(m.events), '["order.fulfilled"]', "events:");
  eq(m.blocks.map((x) => `${x.id}:${x.primitive}:${x.slots.join("+")}`).join(","), "stars:rating_summary:storefront.pdp.under_price,list:review_list:storefront.pdp.below_fold,links:link_list:storefront.order.status", "blocks:");
  eq(m.settings.map((s) => `${s.key}=${JSON.stringify(s.default)}`).join(","), "invite_emails=false,send_after_days=7,show_replies=true", "settings:");
  eq(m.settings.find((s) => s.key === "send_after_days").min + "-" + m.settings.find((s) => s.key === "send_after_days").max, "1-30", "days range:");
  ok(typeof HND.handlerFor("reviews", "order.fulfilled") === "function", "handler");
  ok(typeof SW.sweepFor("reviews") === "function", "sweep");
  eq(CAT.killFlag("reviews"), "ff_plugin-reviews", "kill flag:");
});

// install on A as the owner; every block starts Off
const inst = await callJ("owner", "apps", "POST", { body: { install: { pluginId: "reviews", scopes: ["orders.read"] } } });
const installId = inst.json?.install?.id;
const blocksA = async () => (await callJ("owner", "apps/[id]/blocks", "GET", { params: { id: installId } })).json?.blocks ?? [];
const setBlock = (block, state) => callJ("owner", "apps/[id]/blocks", "POST", { params: { id: installId }, body: { block, state } });

await t("install: the owner installs Reviews (200); its three blocks start Off; each can go Live with no reviews yet (nothing to show is not an error)", async () => {
  eq(inst.status, 200, `install ${JSON.stringify(inst.json)}:`);
  const bl = await blocksA();
  eq(bl.map((x) => `${x.blockId}:${x.state}`).sort().join(","), "links:off,list:off,stars:off", "blocks Off:");
  for (const id of ["stars", "list", "links"]) eq((await setBlock(id, "live")).status, 200, `${id} live:`);
});

// --- 2. tokens --------------------------------------------------------------------
await placeOrder(a, { id: "ord_ra1", products: [pa1, pa2, pa1] });
await placeOrder(a, { id: "ord_ra2", products: [pa3], email: "other.buyer@shopper.test", name: "Ravi" });
await placeOrder(b, { id: "ord_rb1", products: [pb1], email: "b.buyer@shopper.test", name: "Bina K" });

await t("invites: order.fulfilled makes one invite per distinct product (UNIQUE order+product; a replay adds none), send_after = fulfilled + N days, 60-day expiry, customer kept", async () => {
  await fulfil(a, "ord_ra1");
  await fulfil(a, "ord_ra1");
  await fulfil(a, "ord_ra2", new Date(NOW).toISOString(), { send_after_days: 3 });
  await fulfil(b, "ord_rb1");
  const inv = await invitesOf(a, "ord_ra1");
  eq(inv.length, 2, "two products, two invites:");
  eq(inv[0].send_after, new Date(NOW + 7 * DAY).toISOString(), "send_after:");
  eq(inv[0].expires_at, new Date(NOW + 60 * DAY).toISOString(), "expires:");
  eq((await invitesOf(a, "ord_ra2"))[0].send_after, new Date(NOW + 3 * DAY).toISOString(), "3 days:");
  eq((await invitesOf(b, "ord_rb1")).length, 1, "store B's own:");
});

await t("tokens: the invite's own token opens it; a changed signature, exp or id, an expired link, a link moved to another order's product, and store B's link on A are all refused with one answer", async () => {
  const [i1, i2] = await invitesOf(a, "ord_ra1");
  const [j] = await invitesOf(a, "ord_ra2");
  const [k] = await invitesOf(b, "ord_rb1");
  const tok = await tokenFor(a, i1);
  ok(/^rvi_[0-9a-f]{16}\.\d+\.[A-Za-z0-9_-]{43}$/.test(tok), `shape ${tok}`);
  ok(await a.run(() => ST.openInvite(tok, NOW)), "opens");
  const [id, exp, sig] = tok.split(".");
  const flip = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  for (const bad of [`${id}.${exp}.${flip}`, `${id}.${Number(exp) + 86400}.${sig}`, `${i2.id}.${exp}.${sig}`, `${j.id}.${exp}.${sig}`, "", "rvi_x.1.2", `${id}.${exp}`]) eq(await a.run(() => ST.openInvite(bad, NOW)), null, `refused ${bad}:`);
  eq(await a.run(() => ST.openInvite(tok, NOW + 61 * DAY)), null, "expired:");
  const bTok = await tokenFor(b, k);
  eq(await a.run(() => ST.openInvite(bTok, NOW)), null, "store B's link on A:");
  // the same row in A signed with B's secret still fails on A
  await a.run(() => db.insertInto("review_invites").values({ ...k }).execute());
  eq(await a.run(() => ST.openInvite(bTok, NOW)), null, "B's signature on a copied row:");
  await a.run(() => db.deleteFrom("review_invites").where("id", "=", k.id).execute());
  ok(TOK.timingEq("abc", "abc") && !TOK.timingEq("abc", "abd") && !TOK.timingEq("", "") && !TOK.timingEq("ab", "abc"), "constant-time compare");
});

await t("no link secret in production: a store with none mints no token and opens none (fails closed)", async () => {
  const prev = process.env.NODE_ENV;
  const [inv] = await invitesOf(a, "ord_ra1");
  const devTok = await c.run(() => TOK.inviteToken(inv));
  ok(devTok, "dev mints with the dev secret");
  process.env.NODE_ENV = "production";
  try {
    eq(await c.run(() => TOK.inviteToken(inv)), null, "no token:");
    eq(await c.run(() => TOK.verifyInviteToken(inv, devTok, NOW)), false, "no verify:");
    eq(await c.run(() => TOK.optOutToken("a".repeat(64))), null, "no opt-out token:");
  } finally {
    process.env.NODE_ENV = prev;
  }
});

await t("validation: rating 1–5, title ≤ 80, review 20–2,000, name 1–40; control characters stripped", () => {
  ok(ST.validateReview(GOOD).ok, "good");
  for (const [k, v] of [["rating", 0], ["rating", 6], ["rating", 4.5], ["title", "x".repeat(81)], ["body", "too short"], ["body", "x".repeat(2001)], ["display_name", ""], ["display_name", "x".repeat(41)]]) {
    const r = ST.validateReview({ ...GOOD, [k]: v });
    ok(!r.ok && r.errors[k], `${k}=${String(v).slice(0, 12)} refused`);
  }
  eq(ST.validateReview({ ...GOOD, display_name: "Pri\u0000ya\u202e S." }).value.display_name, "Pri ya S.", "cleaned:");
  eq(ST.displayNameFrom("priya sharma"), "priya S.", "display name:");
  eq(ST.displayNameFrom(""), "", "none:");
});

// --- 3. the write route --------------------------------------------------------------
const { NextRequest } = await import("./support/next-server-stub.js");
const ReviewsRoute = await import("../app/api/reviews/route.js");
let ipN = 0;
async function postReview(tn, payload, { form = false, origin = "same", ip = `10.0.0.${++ipN}` } = {}) {
  const host = tn.tenant.domains[0];
  const headers = { host, "x-forwarded-for": ip };
  if (origin) headers.origin = origin === "same" ? `http://${host}` : origin;
  let body;
  if (form) {
    body = new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else {
    body = JSON.stringify(payload);
    headers["content-type"] = "application/json";
  }
  const res = await ReviewsRoute.POST(new NextRequest(`http://${host}/api/reviews`, { method: "POST", headers, body }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, location: res.headers.get("location") };
}
// invites made relative to the real clock, for the route (which reads Date.now())
await placeOrder(a, { id: "ord_live1", products: [pa1, pa2] });
await placeOrder(a, { id: "ord_live2", products: [pa1] });
await fulfil(a, "ord_live1", new Date().toISOString());
await fulfil(a, "ord_live2", new Date().toISOString());

await t("POST /api/reviews: a plain form post saves a pending review and 303s to the thanks page; replaying the link refuses with the same words; a cross-site origin is 403", async () => {
  const [inv] = await invitesOf(a, "ord_live1");
  const tok = await tokenFor(a, inv);
  const r = await postReview(a, { t: tok, ...GOOD }, { form: true });
  eq(r.status, 303, "303:");
  ok(r.location.endsWith("/reviews/write?done=1"), `location ${r.location}`);
  const row = await a.run(() => db.selectFrom("reviews").selectAll().where("invite_id", "=", inv.id).executeTakeFirst());
  eq(row?.status, "pending", "pending:");
  eq(row.order_id, "ord_live1", "bound to the order:");
  eq(row.product_id, inv.product_id, "bound to the product:");
  ok((await a.run(() => db.selectFrom("review_invites").select("used_at").where("id", "=", inv.id).executeTakeFirst())).used_at, "used");
  const again = await postReview(a, { t: tok, ...GOOD });
  eq(again.status, 410, "replay:");
  eq(again.json?.error, ST.REFUSED, "same words:");
  const formAgain = await postReview(a, { t: tok, ...GOOD }, { form: true });
  ok(formAgain.location.endsWith("/reviews/write?refused=1"), "form replay refused");
  const [, inv2] = await invitesOf(a, "ord_live1");
  eq((await postReview(a, { t: await tokenFor(a, inv2), ...GOOD }, { origin: "https://evil.test" })).status, 403, "cross-site:");
  const bad = await postReview(a, { t: await tokenFor(a, inv2), ...GOOD, body: "short" }, { form: true });
  ok(/\/reviews\/write\?t=.+&err=body$/.test(bad.location), `invalid → back with the field: ${bad.location}`);
  eq((await postReview(a, { t: await tokenFor(a, inv2), ...GOOD, body: "short" })).status, 422, "json invalid:");
  eq((await postReview(b, { t: await tokenFor(a, inv2), ...GOOD })).status, 410, "A's link on B's host:");
});

await t("two concurrent submits of one link make one review", async () => {
  const [inv] = await invitesOf(a, "ord_live2");
  const tok = await tokenFor(a, inv);
  const rs = await Promise.allSettled([a.run(() => ST.submitReview(tok, GOOD)), a.run(() => ST.submitReview(tok, GOOD)), a.run(() => ST.submitReview(tok, GOOD))]);
  eq(rs.filter((x) => x.status === "fulfilled").length, 1, "one accepted:");
  ok(rs.filter((x) => x.status === "rejected").every((x) => x.reason?.code === "REFUSED"), "the others refused");
  eq(Number((await a.run(() => db.selectFrom("reviews").select((eb) => eb.fn.countAll().as("n")).where("invite_id", "=", inv.id).executeTakeFirst())).n), 1, "one row:");
});

await t("rate limit: the 11th post in an hour from one address is 429", async () => {
  const codes = [];
  process.env.RATE_LIMIT_DISABLED = "0"; // the harness turns limits off; this test turns them on
  for (let i = 0; i < 11; i++) codes.push((await postReview(a, { t: "rvi_0000000000000000.1.x", ...GOOD }, { ip: "10.9.9.9" })).status);
  eq(codes.slice(0, 10).every((s) => s === 410), true, `first ten refused as bad links ${codes}:`);
  process.env.RATE_LIMIT_DISABLED = "1";
  eq(codes[10], 429, "eleventh:");
});

// --- 4. moderation ------------------------------------------------------------------
const pendingIds = async (tn = a) => (await tn.run(() => db.selectFrom("reviews").select("id").where("status", "=", "pending").orderBy("id").execute())).map((r) => r.id);
let invalidated = [];
Cache.__setCacheTestHooks({ onInvalidate: (scopes) => invalidated.push(...[].concat(scopes)) });

await t("queue reads: every merchant role reads it (200); support and operator support get no email, order id or reject reason (canaries absent from the raw answer); signed out 401; store B's owner sees nothing of A", async () => {
  for (const caller of ["owner", "admin", "staff", "support", "operator-support", "operator-support-entry"]) {
    const r = await callJ(caller, "reviews", "GET", {});
    eq(r.status, 200, `${caller} ${JSON.stringify(r).slice(0, 300)}:`);
    const raw = JSON.stringify(r.json);
    const redacted = ["support", "operator-support", "operator-support-entry"].includes(caller);
    eq(raw.includes(EMAIL), !redacted, `${caller} email canary:`);
    eq(raw.includes("ord_live1"), !redacted, `${caller} order canary:`);
    ok(r.json.counts.pending >= 2, `${caller} counts`);
  }
  eq((await callJ("signed-out", "reviews", "GET", {})).status, 401, "signed out:");
  const bOwner = await callJ("owner-b", "reviews", "GET", {});
  ok(bOwner.status === 401 || (bOwner.status === 200 && !JSON.stringify(bOwner.json).includes("ord_live1")), `B's owner: ${bOwner.status}`);
});

await t("moderation writes: support and operator support 403 (nothing changes); staff approves (audit reviews.approve, the plugins tag invalidated); wrong state 409; hide → restore; reject keeps an internal reason", async () => {
  const [id1, id2] = await pendingIds();
  for (const caller of ["support", "operator-support", "operator-support-entry"]) eq((await callJ(caller, "reviews", "POST", { body: { action: "approve", ids: [id1] } })).status, 403, `${caller}:`);
  eq((await pendingIds()).includes(id1), true, "still pending:");
  invalidated = [];
  const ap = await callJ("staff", "reviews", "POST", { body: { action: "approve", ids: [id1] } });
  eq(ap.status, 200, `approve ${JSON.stringify(ap.json)}:`);
  eq(ap.json.changed, 1, "changed:");
  ok(invalidated.some((x) => String(x).endsWith(":plugins") || x === "plugins"), `invalidated ${invalidated}`);
  const audits = (await listAudit({ tenantId: a.id, limit: 100 })).map((x) => x.action);
  ok(audits.includes("reviews.approve"), "audited");
  eq((await callJ("staff", "reviews", "POST", { body: { action: "restore", ids: [id1] } })).status, 409, "restore an approved review:");
  eq((await callJ("staff", "reviews", "POST", { body: { action: "hide", ids: [id1] } })).json?.changed, 1, "hide:");
  eq((await callJ("staff", "reviews", "POST", { body: { action: "restore", ids: [id1] } })).json?.changed, 1, "restore:");
  eq((await callJ("admin", "reviews", "POST", { body: { action: "reject", ids: [id2], reason: "Mentions a competitor" } })).status, 200, "reject:");
  const rej = (await callJ("owner", "reviews", "GET", { query: "status=rejected" })).json.reviews.find((r) => r.id === id2);
  eq(rej?.rejectReason, "Mentions a competitor", "reason kept for staff:");
  const sup = (await callJ("support", "reviews", "GET", { query: "status=rejected" })).json.reviews.find((r) => r.id === id2);
  eq(sup?.rejectReason, null, "support doesn't see it:");
  const actions = (await listAudit({ tenantId: a.id, limit: 100 })).map((x) => x.action);
  for (const x of ["reviews.hide", "reviews.restore", "reviews.reject"]) ok(actions.includes(x), `audit ${x}`);
  eq((await callJ("staff", "reviews", "POST", { body: { action: "approve", ids: [id2] } })).json?.changed, 1, "rejected → approved:");
  eq((await callJ("staff", "reviews", "POST", { body: { action: "delete", ids: [id2] } })).status, 400, "unknown action:");
});

await t("bulk: approve or reject up to 50 at once (51 is 400); hide and restore one at a time; reply ≤ 1,000 (audited reviews.reply), empty removes it", async () => {
  eq((await callJ("staff", "reviews", "POST", { body: { action: "approve", ids: Array.from({ length: 51 }, (_, i) => `rev_${i}`) } })).status, 400, "51:");
  eq((await callJ("staff", "reviews", "POST", { body: { action: "hide", ids: ["rev_a", "rev_b"] } })).status, 400, "bulk hide:");
  const [id] = (await a.run(() => db.selectFrom("reviews").select("id").where("status", "=", "approved").execute())).map((r) => r.id);
  eq((await callJ("staff", "reviews", "POST", { body: { reply: { id, text: "x".repeat(1001) } } })).status, 422, "too long:");
  eq((await callJ("support", "reviews", "POST", { body: { reply: { id, text: "Thanks" } } })).status, 403, "support reply:");
  eq((await callJ("staff", "reviews", "POST", { body: { reply: { id, text: "Thank you for the kind words." } } })).json?.reply, "Thank you for the kind words.", "reply:");
  ok((await listAudit({ tenantId: a.id, limit: 100 })).some((x) => x.action === "reviews.reply"), "audited");
});

// --- 5. the anonymous shopper ---------------------------------------------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { prerenderToNodeStream } = require("react-dom/static");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) => (await swc.transform(await readFile(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
let renderStore = a;
class NotFound extends Error {}
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "next/navigation": { __esModule: true, notFound: () => { throw new NotFound("not found"); }, redirect: () => { throw new Error("redirect"); } },
  "@/lib/storefront-request": { __esModule: true, tfetch: (fn) => renderStore.run(fn) },
  "@/lib/content/resolve": { __esModule: true, contentSource: async () => ({ preview: false, v: 4 }) },
  "@/components/StoreImage": { __esModule: true, default: ({ src, alt }) => React.createElement("img", { src, alt }) },
};
const seen = new Map();
async function loadJsx(file) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in STUBS || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
      if (!target.endsWith(".js")) target = existsSync(`${target}.js`) ? `${target}.js` : join(target, "index.js");
      deps.set(id, isJsx(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
    } else deps.set(id, require(id));
  }
  const req = (id) => (id in STUBS ? STUBS[id] : id === "react" ? React : id === "react/jsx-runtime" ? require("react/jsx-runtime") : deps.has(id) ? deps.get(id) : (() => { throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`); })());
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
async function html(el, tn = a) {
  renderStore = tn;
  return runRequest(async () => {
    const { prelude } = await prerenderToNodeStream(React.createElement(ImageConfigContext.Provider, { value: imageConfigDefault }, el));
    let out = "";
    for await (const chunk of prelude) out += chunk;
    return out;
  });
}
const PluginSlot = (await loadJsx(join(ROOT, "components/plugins/PluginSlot.js"))).default;
const WritePage = (await loadJsx(join(ROOT, "app/(storefront)/reviews/write/page.js"))).default;
const AllPage = (await loadJsx(join(ROOT, "app/(storefront)/products/[handle]/reviews/page.js"))).default;
const OptOutPage = (await loadJsx(join(ROOT, "app/(storefront)/reviews/optout/page.js"))).default;
const pdpHtml = async (product, tn = a) => (await html(React.createElement(PluginSlot, { name: "storefront.pdp.under_price", ctx: product }), tn)) + (await html(React.createElement(PluginSlot, { name: "storefront.pdp.below_fold", ctx: product }), tn));
const statusRows = (tn, productId) => tn.run(() => db.selectFrom("reviews").select(["status", "rating"]).where("product_id", "=", productId).execute());

// a review in every state on pa1, written straight to the store (the moderation path is tested above)
async function seedReview(tn, { product, status, rating, title = "T", body = "A plain review body over twenty.", name = "Asha R." }) {
  const id = `rev_${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`;
  const at = new Date(NOW - Math.floor(Math.random() * 30) * DAY).toISOString();
  await tn.run(() => db.insertInto("reviews").values({ id, product_id: product.id, order_id: "ord_seed", invite_id: `rvi_${id.slice(4)}`, customer_id: null, rating, title, body, display_name: name, status, created_at: at, updated_at: at }).execute());
  return id;
}

await t("only approved reviews render or count: pending, rejected and hidden never show in the stars, the list, the all-reviews page or the stats; store B's reviews never on A", async () => {
  await a.run(() => db.deleteFrom("reviews").where("product_id", "=", pa3.id).execute());
  await seedReview(a, { product: pa3, status: "approved", rating: 4, title: "Approved one" });
  await seedReview(a, { product: pa3, status: "pending", rating: 1, title: "Pending canary" });
  await seedReview(a, { product: pa3, status: "rejected", rating: 1, title: "Rejected canary" });
  await seedReview(a, { product: pa3, status: "hidden", rating: 1, title: "Hidden canary" });
  await seedReview(b, { product: { id: pa3.id }, status: "approved", rating: 1, title: "Store B canary" });
  const s = await a.run(() => STATS.readProductStats(pa3.id));
  eq(`${s.count}/${s.average}`, "1/4", "stats:");
  const h = await pdpHtml(pa3);
  ok(h.includes("Approved one") && h.includes('data-rating-summary'), "approved shows");
  for (const canary of ["Pending canary", "Rejected canary", "Hidden canary", "Store B canary"]) ok(!h.includes(canary), `${canary} absent`);
  ok(h.includes("(1 review)") || h.includes("1 review"), "count 1");
  const all = await html(React.createElement(AllPage, { params: Promise.resolve({ handle: pa3.handle }), searchParams: Promise.resolve({}) }));
  ok(all.includes("Approved one") && !/Pending canary|Rejected canary|Hidden canary|Store B canary/.test(all), "all-reviews page");
  eq((await b.run(() => ST.approvedReviews(pa3.id))).length, 1, "B reads only its own:");
});

await t("anonymous HTML: no email (no '@' from the seeded address), text rendered as plain text (a <script> title is escaped), replies follow Show store replies", async () => {
  await seedReview(a, { product: pa3, status: "approved", rating: 5, title: "<script>alert(1)</script>", body: "Bold <b>claims</b> & more words here.", name: "Neha" });
  const h = await pdpHtml(pa3);
  ok(!h.includes(EMAIL) && !h.includes("shopper.test"), "no email");
  ok(!h.includes("<script>alert(1)") && h.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "escaped title");
  ok(!h.includes("<b>claims</b>"), "escaped body");
  await a.run(() => db.updateTable("reviews").set({ reply: "Reply canary" }).where("product_id", "=", pa3.id).where("status", "=", "approved").execute());
  ok((await pdpHtml(pa3)).includes("Reply canary"), "reply shows");
  eq((await callJ("owner", "apps/[id]", "POST", { params: { id: installId }, body: { settings: { invite_emails: false, send_after_days: 7, show_replies: false } } })).status, 200, "replies off:");
  ok(!(await pdpHtml(pa3)).includes("Reply canary"), "reply hidden");
  await callJ("owner", "apps/[id]", "POST", { params: { id: installId }, body: { settings: { invite_emails: false, send_after_days: 7, show_replies: true } } });
});

await t("order page: Review links list one link per product with an unused invite (a used one drops out); a link opens the write page; the write page refuses a bad link with the one sentence", async () => {
  const links = await html(React.createElement(PluginSlot, { name: "storefront.order.status", ctx: { id: "ord_live1", status: "synced" } }));
  const hrefs = [...links.matchAll(/href="(\/reviews\/write\?t=[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  eq(hrefs.length, 1, "one unused invite left (the other was used):");
  const t2 = decodeURIComponent(hrefs[0].split("t=")[1]);
  const page = await html(React.createElement(WritePage, { searchParams: Promise.resolve({ t: t2 }) }));
  ok(page.includes('data-review-form') && page.includes("We never show your email.") && page.includes('value="Priya S."'), "the form, prefilled");
  ok(page.includes('method="post"') && page.includes('action="/api/reviews"'), "a plain form");
  for (const bad of ["", "nope", `${t2}x`]) {
    const r = await html(React.createElement(WritePage, { searchParams: Promise.resolve({ t: bad }) }));
    ok(r.includes(ST.REFUSED) && !r.includes("data-review-form"), `refused ${bad.slice(0, 10)}`);
  }
  ok((await html(React.createElement(WritePage, { searchParams: Promise.resolve({ done: "1" }) }))).includes(WORDS.WRITE_WORDS.thanks), "thanks");
});

await t("all-reviews page: 20 a page, newest first, Newer / Older links, and a page past the end is a 404", async () => {
  await a.run(() => db.deleteFrom("reviews").where("product_id", "=", pa2.id).execute());
  for (let i = 0; i < 45; i++) {
    const at = new Date(NOW - i * 60_000).toISOString();
    await a.run(() => db.insertInto("reviews").values({ id: `rev_pg${String(i).padStart(2, "0")}`, product_id: pa2.id, order_id: "o", invite_id: `rvi_pg${i}`, rating: 4, title: `Paged ${String(i).padStart(2, "0")}`, body: "x".repeat(20), display_name: "N", status: "approved", created_at: at, updated_at: at }).execute());
  }
  const page = async (n) => (await html(React.createElement(AllPage, { params: Promise.resolve({ handle: pa2.handle }), searchParams: Promise.resolve(n ? { page: String(n) } : {}) }))).replace(/<!-- -->/g, "");
  const items = (h) => [...h.matchAll(/data-review=""/g)].length;
  const titles = (h) => [...h.matchAll(/Paged (\d\d)/g)].map((m) => m[1]);
  const p1 = await page(null);
  eq(items(p1), 20, "page 1:");
  eq(titles(p1)[0], "00", "newest first:");
  ok(p1.includes(`/products/${pa2.handle}/reviews?page=2`) && !p1.includes("Newer") && p1.includes("Older") && p1.includes("Page 1 of 3"), "page 1 links");
  const p2 = await page(2);
  eq(items(p2), 20, "page 2:");
  eq(titles(p2)[0], "20", "page 2 starts at the 21st:");
  ok(p2.includes("Newer") && p2.includes("Older") && p2.includes(`reviews?page=1`) && p2.includes(`reviews?page=3`), "page 2 links");
  const p3 = await page(3);
  eq(items(p3), 5, "page 3:");
  ok(p3.includes("Newer") && !p3.includes("Older"), "page 3 links");
  let missing = false;
  try {
    await page(4);
  } catch (e) {
    missing = e instanceof NotFound;
  }
  ok(missing, "page 4 is a 404");
  eq(items(await page("junk")), 20, "a junk page number reads as page 1:");
});

await t("JSON-LD: AggregateRating equals the approved set's count and mean over 200 random sets (pending, rejected, hidden ignored); numbers only", async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const states = ["approved", "pending", "rejected", "hidden"];
  for (let n = 0; n < 200; n++) {
    await a.run(() => db.deleteFrom("reviews").where("product_id", "=", pa2.id).execute());
    const rows = Array.from({ length: Math.floor(rnd() * 12) }, () => ({ status: states[Math.floor(rnd() * 4)], rating: 1 + Math.floor(rnd() * 5) }));
    if (rows.length) await a.run(() => db.insertInto("reviews").values(rows.map((r, i) => ({ id: `rev_j${n}_${i}`, product_id: pa2.id, order_id: "o", invite_id: `rvi_j${n}_${i}`, rating: r.rating, body: "x".repeat(20), display_name: "N", status: r.status, created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z" }))).execute());
    const approved = rows.filter((r) => r.status === "approved");
    const got = STATS.ratingJsonLd(await a.run(() => STATS.readProductStats(pa2.id)));
    if (!approved.length) {
      eq(got, null, `set ${n} empty:`);
      continue;
    }
    const mean = approved.reduce((s, r) => s + r.rating, 0) / approved.length;
    eq(JSON.stringify(got), JSON.stringify({ "@type": "AggregateRating", ratingValue: Math.round(mean * 100) / 100, reviewCount: approved.length, bestRating: 5, worstRating: 1 }), `set ${n}:`);
  }
});

await t("JSON-LD: present with Stars Live and ≥ 1 approved review; absent when Stars is Off, the plugin is turned off or killed, or there are no approved reviews; a '</script>' title can't break the tag", async () => {
  const product = { ...pa3 };
  const rating = () => a.run(() => runRequest(() => LD.reviewRating(product)));
  ok((await rating())?.reviewCount >= 1, "present");
  eq((await setBlock("stars", "off")).status, 200, "stars off:");
  eq(await rating(), null, "Stars Off:");
  await setBlock("stars", "live");
  ok(await rating(), "back");
  PL.__setKillReader(async (id) => id === "reviews");
  try {
    eq(await rating(), null, "killed:");
  } finally {
    PL.__setKillReader(null);
  }
  PL.__setKillReader(async () => {
    throw new Error("flags down");
  });
  try {
    eq(await rating(), null, "kill switch unreadable (fails closed):");
  } finally {
    PL.__setKillReader(null);
  }
  eq((await callJ("owner", "apps/[id]", "POST", { params: { id: installId }, body: { disable: true } })).status, 200, "plugin off:");
  eq(await rating(), null, "plugin off:");
  eq(await a.run(() => ST.reviewsActive()), false, "write side off too:");
  await callJ("owner", "apps/[id]", "POST", { params: { id: installId }, body: { enable: true } });
  eq(await a.run(() => runRequest(() => LD.reviewRating({ ...pa1, id: "gid://none" }))), null, "no reviews:");
  const ld = LD.ldJson([{ name: "</script><script>alert(1)</script>", aggregateRating: STATS.ratingJsonLd({ count: 2, average: 4.5 }) }]);
  ok(!ld.includes("<") && ld.includes("\\u003c/script>"), `escaped ${ld}`);
  eq(JSON.parse(ld)[0].name, "</script><script>alert(1)</script>", "still the same JSON:");
  const agg = JSON.parse(ld)[0].aggregateRating;
  ok(typeof agg.ratingValue === "number" && typeof agg.reviewCount === "number", "numbers only");
});

// --- 6. the sweep, opt-out, privacy, export ---------------------------------------
const sweepInstall = (settings) => ({ id: installId, pluginId: "reviews", settings: { invite_emails: true, send_after_days: 7, show_replies: true, ...settings } });
const notes = (tn, orderId) => tn.run(() => db.selectFrom("notifications").selectAll().where("idempotency_key", "=", `review_invite:${orderId}`).execute());

await t("sweep: with emails off nothing is sent; on, one email per due order (idempotency review_invite:<order>, transactional) listing a link per product that opens its invite, and an opt-out link; not before send_after; not twice", async () => {
  const run = (now, settings = {}) => a.run(() => SWEEP.sweepReviews({ install: sweepInstall(settings), now, log: () => {} }));
  eq((await run(NOW + 8 * DAY, { invite_emails: false })).orders, 0, "emails off:");
  eq((await notes(a, "ord_ra1")).length, 0, "nothing queued:");
  eq((await run(NOW + 6 * DAY)).orders, 0, "not yet due (7 days):");
  const r = await run(NOW + 7 * DAY + 1000);
  ok(r.orders >= 1, `sent ${JSON.stringify(r)}`);
  const [n] = await notes(a, "ord_ra1");
  ok(n, "queued");
  eq(n.type, "review_invite", "type:");
  eq(n.consent_class, "transactional", "class:");
  eq(n.recipient, EMAIL, "to the buyer:");
  const urls = [...n.body.matchAll(/(https?:\/\/\S+\/reviews\/write\?t=\S+)/g)].map((m) => m[1]);
  eq(urls.length, 2, "a link per product:");
  ok(await a.run(() => ST.openInvite(decodeURIComponent(urls[0].split("t=")[1]), NOW + 8 * DAY)), "the link opens its invite");
  ok(/Don't ask me for reviews: \S+\/reviews\/optout\?t=[0-9a-f]{64}\.\S+/.test(n.body), "opt-out link");
  ok(!n.body.includes("ord_ra1"), "no order id in the email");
  eq((await run(NOW + 7 * DAY + 2000)).orders, 0, "not twice:");
  eq((await notes(a, "ord_ra1")).length, 1, "one row:");
  // catch-up: a fresh invite whose send_after passed more than 3 days ago is never mailed
  await placeOrder(a, { id: "ord_late", products: [pa2], email: "late.buyer@shopper.test" });
  await fulfil(a, "ord_late", new Date(NOW).toISOString());
  eq((await invitesOf(a, "ord_late"))[0].sent_at, null, "fresh, unsent:");
  await run(NOW + 7 * DAY + 3 * DAY + 60_000);
  eq((await notes(a, "ord_late")).length, 0, "due 3 days and a minute ago: never mailed (catch-up window):");
  eq((await invitesOf(a, "ord_late"))[0].sent_at, null, "left unsent (still usable from the order page):");
});

await t("sweep cap: at most 50 orders a run, each with every one of its invites (an order is never split across runs)", async () => {
  const ids = Array.from({ length: 52 }, (_, i) => `ord_cap${String(i).padStart(2, "0")}`);
  for (const id of ids) {
    await placeOrder(a, { id, products: [pa1, pa2, pa3], email: `${id}@shopper.test` });
    await fulfil(a, id, new Date(NOW + 100 * DAY).toISOString());
  }
  const run = () => a.run(() => SWEEP.sweepReviews({ install: sweepInstall({}), now: NOW + 107 * DAY + 1000, log: () => {} }));
  eq((await run()).orders, 50, "first run:");
  const sentOf = async (id) => (await invitesOf(a, id)).filter((i) => i.sent_at).length;
  const counts = await Promise.all(ids.map(sentOf));
  ok(counts.every((n) => n === 0 || n === 3), `no order split: ${counts}`);
  eq(counts.filter((n) => n === 3).length, 50, "fifty whole orders:");
  for (const id of ids.filter((_, i) => counts[i] === 3)) eq((await notes(a, id))[0]?.body.match(/\/reviews\/write\?t=/g)?.length, 3, `${id} lists all three:`);
  eq((await run()).orders, 2, "the rest next run:");
});

await t("opt-out: the signed link's button writes review_optouts (a tampered one refuses); the sweep then skips that address; the page shows the confirm button, never a write on GET", async () => {
  await placeOrder(a, { id: "ord_opt", products: [pa1], email: "Opt.Out@Shopper.test" });
  await fulfil(a, "ord_opt", new Date(NOW).toISOString());
  const hash = await TOK.emailHash("opt.out@shopper.test");
  eq(hash, await TOK.emailHash("  OPT.OUT@shopper.test "), "case and spaces:");
  const tok = await a.run(() => TOK.optOutToken(hash));
  const page = await html(React.createElement(OptOutPage, { searchParams: Promise.resolve({ t: tok }) }));
  ok(page.includes("data-optout-confirm") && page.includes('method="post"'), "a confirm button");
  ok(!(await a.run(() => ST.isOptedOut(hash))), "GET wrote nothing");
  eq((await postReview(a, { kind: "optout", t: `${tok.slice(0, -1)}x` })).status, 400, "tampered:");
  const r = await postReview(a, { kind: "optout", t: tok }, { form: true });
  eq(r.status, 303, "303:");
  ok(await a.run(() => ST.isOptedOut(hash)), "recorded");
  ok(!JSON.stringify(await a.run(() => db.selectFrom("review_optouts").selectAll().execute())).toLowerCase().includes("opt.out"), "no email stored");
  await a.run(() => SWEEP.sweepReviews({ install: sweepInstall({}), now: NOW + 7 * DAY + 1000, log: () => {} }));
  eq((await notes(a, "ord_opt")).length, 0, "skipped:");
  ok((await invitesOf(a, "ord_opt"))[0].sent_at, "marked handled");
});

await t("privacy erase: redactCustomer deletes that buyer's reviews, invites and opt-out (by email hash); another buyer's stay", async () => {
  const before = await a.run(() => db.selectFrom("reviews").select("id").where("order_id", "=", "ord_ra2").execute());
  const [inv] = await invitesOf(a, "ord_ra1");
  const tok = await tokenFor(a, inv);
  await a.run(() => ST.submitReview(tok, GOOD, { now: NOW + DAY }));
  const hash = await TOK.emailHash(EMAIL);
  await a.run(() => ST.recordOptOut(hash));
  const r = await a.run(() => redactCustomer({ email: EMAIL }));
  ok(r.reviews >= 1, `reviews ${JSON.stringify(r)}`);
  eq((await invitesOf(a, "ord_ra1")).length, 0, "invites gone:");
  eq((await a.run(() => db.selectFrom("reviews").select("id").where("order_id", "in", ["ord_ra1", "ord_live1", "ord_live2"]).execute())).length, 0, "reviews gone:");
  eq(await a.run(() => ST.isOptedOut(hash)), false, "opt-out gone:");
  eq((await a.run(() => db.selectFrom("reviews").select("id").where("order_id", "=", "ord_ra2").execute())).length, before.length, "others stay:");
  const otherHash = await TOK.emailHash("opt.out@shopper.test");
  ok(await a.run(() => ST.isOptedOut(otherHash)), "another buyer's opt-out stays");
});

await t("export lists review_invites, reviews and review_optouts", async () => {
  const src = await readFile(join(ROOT, "lib/platform/export.js"), "utf8");
  for (const tb of ["review_invites", "reviews", "review_optouts"]) ok(src.includes(`"${tb}"`), tb);
});

await t("a store one migration behind (no 0040 tables) reads as empty: no stars, no list, no links, a refused link", async () => {
  const old = await F.makeTenant({ name: "reviews-old", stage: "0034", products: 1 });
  try {
    const [p] = await P(old);
    eq((await old.run(() => STATS.readProductStats(p.id))).count, 0, "stats:");
    eq((await old.run(() => ST.approvedReviews(p.id))).length, 0, "list:");
    eq((await old.run(() => ST.inviteLinks("ord_x", NOW))).length, 0, "links:");
    eq(await old.run(() => ST.openInvite("rvi_0000000000000000.1." + "A".repeat(43), NOW)), null, "refused:");
  } finally {
    await old.cleanup();
  }
});

await t("no third-party pixels on /reviews/* or /m/* (the signed token never reaches gtag or Meta): Pixels gates on the path, the review pages render no script, ?t= is stripped after render, referrer policy origin", async () => {
  const { pixelsAllowed } = await import("../lib/track/no-pixels.js");
  for (const p of ["/reviews/write", "/reviews/optout", "/reviews", "/reviews/write?t=x", "/m/stop", "/m/stop?t=x", "/m"]) eq(pixelsAllowed(p), false, `${p}:`);
  for (const p of ["/", "/products/x", "/products/x/reviews", "/reviewsx", "/cart", "/men", "/products/m/stop"]) eq(pixelsAllowed(p), true, `${p}:`);
  const src = await readFile(join(ROOT, "components/analytics/Pixels.js"), "utf8");
  ok(/const allowed = pixelsAllowed\(usePathname\(\)\)/.test(src) && /if \(!allowed\) return undefined;/.test(src) && src.indexOf("if (!allowed)") < src.indexOf("loadGtag(ga4Id)"), "Pixels bails before loading any tag");
  const layout = await readFile(join(ROOT, "app/(storefront)/layout.js"), "utf8");
  eq((layout.match(/googletagmanager|fbevents/g) || []).length, 0, "the layout loads no tag itself:");
  const [inv] = await invitesOf(a, "ord_late");
  const tok = await tokenFor(a, inv);
  const optTok = await a.run(async () => TOK.optOutToken(await TOK.emailHash("late.buyer@shopper.test")));
  for (const [label, el] of [["write", React.createElement(WritePage, { searchParams: Promise.resolve({ t: tok }) })], ["optout", React.createElement(OptOutPage, { searchParams: Promise.resolve({ t: optTok }) })]]) {
    const h = await html(el);
    ok(!/<script|googletagmanager|fbevents|gtag|fbq/.test(h), `${label}: no script or pixel`);
  }
  for (const f of ["app/(storefront)/reviews/write/page.js", "app/(storefront)/reviews/optout/page.js", "app/(storefront)/m/stop/page.js"]) {
    const s = await readFile(join(ROOT, f), "utf8");
    ok(s.includes('referrer: "origin"') && s.includes("<StripToken />"), `${f}: referrer origin and StripToken`);
  }
  const strip = await readFile(join(ROOT, "components/reviews/StripToken.js"), "utf8");
  ok(strip.includes('searchParams.delete("t")') && strip.includes("history.replaceState"), "StripToken removes t");
});

// --- 7. banned copy -----------------------------------------------------------------
await t("banned copy: the plugin's words, block labels, the review pages, the email and the refusal pass the banned-copy scan (shopper rules on; 'review' as a verb is this plugin's own word, so CLAIMS stays for generated copy)", () => {
  const m = CAT.pluginById("reviews");
  const email = SWEEP.inviteEmail({ name: "Priya S.", store: "Fixture Store", links: [{ label: "Review Fixture product 1", url: "https://x.test/reviews/write?t=a" }], optOutUrl: "https://x.test/reviews/optout?t=b" });
  const texts = [m.name, m.summary, m.description, ...m.settings.map((s) => s.label), ...m.blocks.map((x) => x.label), ...Object.values(WORDS.WRITE_WORDS), ...Object.values(WORDS.FIELD_WORDS), ...Object.values(WORDS.OPTOUT_WORDS), ST.REFUSED, email.subject, email.text.replace(/https:\S+/g, "")];
  for (const s of texts) eq(JSON.stringify(scanText(s, { shopper: true, claims: false })), "[]", `"${s.slice(0, 50)}":`);
  for (const s of texts) ok(!/hurry|only today|last chance|don't miss|limited time|act now/i.test(s), `pressure words: ${s}`);
});

await store.cleanup?.();
await c.cleanup?.();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
