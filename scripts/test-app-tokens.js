// App API tokens and API v1 (Phase 4 line 4, docs/plans/phase-4.md "Line 4").
//   pnpm test:app-tokens
// Minting (shown once, stored as a SHA-256 hash, at most 5 active, scopes
// within the app's approval, 30/90/365 days), revoking, the approval editor
// (narrowing at once, widening only when confirmed), the routes as every
// caller, API v1 as anonymous, with cookies only, with store B's host, with a
// revoked, expired, switched-off and uninstalled app's token, out of scope,
// and in scope; no customer field in any order answer; one strict audit row
// per call (and a 503 with no data when it can't be written), the call list,
// rate limits per token and per IP for unknown tokens, GET only, no CORS
// headers, and that admin routes ignore Bearer while v1 ignores cookies.
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-apptok-default.db";
process.env.PLATFORM_SECRET = "test-apptok-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.STOREASY_PLUGIN_EGRESS_LOCAL = "1";
const network = H.blockNetwork();

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

const F = await import("./support/tenant-fixture.js");
const TK = await import("../lib/plugins/tokens.js");
const AA = await import("../lib/plugins/api-auth.js");
const { audit, listAudit } = await import("../lib/platform/audit.js");
const { platformDb } = await import("../lib/platform/control.js");

// --- pure parts ------------------------------------------------------------------------
await t("sameSecret: equal only for identical non-empty strings; tokenStatus: active, expiring (7 days), expired, revoked", () => {
  ok(TK.sameSecret("ab", "ab") && !TK.sameSecret("ab", "ac") && !TK.sameSecret("ab", "abc") && !TK.sameSecret("", ""), "sameSecret");
  const day = 24 * 60 * 60_000;
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  eq(TK.tokenStatus({ expires_at: at(30 * day) }), "active");
  eq(TK.tokenStatus({ expires_at: at(3 * day) }), "expiring");
  eq(TK.tokenStatus({ expires_at: at(-1000) }), "expired");
  eq(TK.tokenStatus({ expires_at: at(30 * day), revoked_at: at(0) }), "revoked");
  eq(TK.EXPIRY_DAYS.join(","), "30,90,365");
  eq(TK.MAX_ACTIVE_TOKENS, 5);
});

await t("forbiddenWords and the plain-words errors", () => {
  eq(AA.forbiddenWords("orders.read"), "This app wasn't given permission to see your orders, without customer details.");
  eq(AA.INVALID_TOKEN, "This token isn't valid for this store.");
});

// --- the stores ----------------------------------------------------------------------
const store = await H.makeRoleStore({ name: "apptok", a: { products: [1, 2, 3].map((i) => F.fixtureProduct(i)) } });
const { a, b, call, v1, users } = store;
const hostB = b.tenant.domains[0];
const { db } = await import("../lib/db.js");
const inA = (fn) => a.run(fn);
const callsOf = async (installId) => (await listAudit({ tenantId: a.id, limit: 200 })).filter((r) => r.action === "apps.api_call" && r.actor === installId);

await t("audit: the default stays best-effort; strict throws when the row can't be written", async () => {
  const pdb = platformDb();
  await pdb.execute("ALTER TABLE audit_log RENAME TO audit_log_off");
  try {
    await audit({ actor: { kind: "system", id: "t" }, action: "test.best_effort" }); // no throw
    let threw = false;
    try {
      await audit({ actor: { kind: "system", id: "t" }, action: "test.strict", strict: true });
    } catch {
      threw = true;
    }
    ok(threw, "strict threw");
  } finally {
    await pdb.execute("ALTER TABLE audit_log_off RENAME TO audit_log");
  }
});

// customer details that must never reach an app
const PII = { email: "apptokbuyer@example.test", phone: "9876512399", name: "Apptokname Buyer", address_line1: "12 Apptokaddr Road", city: "Apptokcity", pincode: "560777" };
const ORDER_ID = "BL-APPTOK0001";
await inA(async () => {
  const now = new Date().toISOString();
  await db.insertInto("orders").values({ id: ORDER_ID, ...PII, state: "KA", country: "IN", cart_id: "cart_apptoksecret", idempotency_key: "idem_apptoksecret", subtotal: 500, discount_total: 0, shipping_total: 0, total: 500, currency: "INR", payment_method: "cod", payment_status: "cod", status: "cod_pending", snapshot: JSON.stringify({ contact: { email: PII.email } }), created_at: now, updated_at: now }).execute();
  await db.insertInto("order_items").values({ order_id: ORDER_ID, variant_id: "v1", product_id: "p1", title: "Item", variant_title: "M", unit_price: 500, quantity: 1, line_total: 500, line_discount: 0, position: 0 }).execute();
});
const noCustomer = (text, label) => {
  for (const v of [...Object.values(PII), "cart_apptoksecret", "idem_apptoksecret"]) ok(!String(text).toLowerCase().includes(String(v).toLowerCase()), `${label}: no ${v}`);
  for (const k of ["email", "phone", "address_line1", "customer_id", "snapshot", "cart_id", "idempotency_key"]) ok(!String(text).includes(`"${k}"`), `${label}: no ${k} key`);
};

// a custom app (orders.read and storefront.read approved), through the route
const made = await call("owner", "apps", "POST", { body: { create_custom: { name: "Token app", url: "http://127.0.0.1:9/hooks", topics: ["order.created"], scopes: ["orders.read", "storefront.read"] } } });
const APP = made.body?.install?.id;
const tokensOf = (caller = "owner", id = APP, opts = {}) => call(caller, "apps/[id]/tokens", "GET", { params: { id }, ...opts });
const post = (caller, body, id = APP, opts = {}) => call(caller, "apps/[id]/tokens", "POST", { params: { id }, body, ...opts });

await t("setup: a custom app exists; nothing reached the network", () => {
  ok(APP, `custom app ${made.status} ${made.text.slice(0, 160)}`);
});

let first;
await t("create: owner mints sea_tok_….<64 hex>, answered once (no-store); the store keeps only sha256(secret); the audit row has no secret", async () => {
  const r = await post("owner", { create: { name: "Orders sync", scopes: ["orders.read"], days: 30 } });
  eq(r.status, 200, r.text.slice(0, 200));
  first = r.body;
  ok(/^sea_tok_[0-9a-f]{16}\.[0-9a-f]{64}$/.test(first.secret), "token shape");
  eq(r.headers.get("cache-control"), "no-store");
  eq(first.token.status, "active");
  eq(first.token.scopes.join(","), "orders.read");
  const secretPart = first.secret.split(".")[1];
  const row = await inA(() => db.selectFrom("plugin_tokens").selectAll().where("id", "=", first.token.id).executeTakeFirst());
  ok(row && row.secret_hash !== secretPart && /^[0-9a-f]{64}$/.test(row.secret_hash), "a hash is stored");
  const { sha256Hex } = await import("../lib/platform/sessions.js");
  eq(row.secret_hash, await sha256Hex(secretPart), "sha256 of the secret part");
  const days = Math.round((Date.parse(row.expires_at) - Date.now()) / 86400000);
  eq(days, 30, "expires in 30 days");
  const rows = (await listAudit({ tenantId: a.id, limit: 200 })).filter((x) => x.action === "apps.token_create" && x.resource === `app:${APP}`);
  ok(rows.length === 1 && rows[0].resource === `app:${APP}`, "one token_create row");
  ok(!JSON.stringify(rows).includes(secretPart) && !JSON.stringify(rows).includes(row.secret_hash), "no secret or hash in audit");
});

await t("GET tokens: every role reads the list (apps.read), never a secret or hash; signed out, store B's owner and app-token get 401", async () => {
  const secretPart = first.secret.split(".")[1];
  const row = await inA(() => db.selectFrom("plugin_tokens").select("secret_hash").where("id", "=", first.token.id).executeTakeFirst());
  for (const c of ["owner", "admin", "staff", "support", "operator-support", "operator-support-entry"]) {
    const r = await tokensOf(c);
    eq(r.status, 200, `${c} ${r.text.slice(0, 120)}`);
    ok(!r.text.includes(secretPart) && !r.text.includes(row.secret_hash) && !r.text.includes("secret_hash"), `${c}: no secret`);
    eq(r.body.tokens[0].id, first.token.id, `${c} sees the token`);
    eq(r.body.scopes.map((s) => s.scope).join(","), "orders.read,storefront.read", `${c} scopes`);
  }
  for (const c of ["signed-out", "app-token"]) eq((await tokensOf(c)).status, 401, c);
  eq((await tokensOf("owner-b", APP, { host: hostB })).status, 404, "store B's owner on B: no such app there");
  eq((await tokensOf("owner-b")).status, 401, "store B's owner on A");
});

await t("POST tokens: staff, support and operator support get 403 and nothing is made", async () => {
  for (const c of ["staff", "support", "operator-support", "operator-support-entry"]) eq((await post(c, { create: { name: "x", scopes: ["orders.read"] } })).status, 403, c);
  for (const c of ["signed-out", "app-token"]) eq((await post(c, { create: { name: "x", scopes: ["orders.read"] } })).status, 401, c);
  eq((await tokensOf()).body.tokens.length, 1);
});

await t("create refusals: no name, a scope the app wasn't given, offers.read, customers.read, no scope, 45 days; a first-party app has no tokens", async () => {
  const bad = async (create, code) => {
    const r = await post("owner", { create });
    eq(r.body?.code, code, `${JSON.stringify(create)} → ${r.status} ${r.text.slice(0, 120)}`);
  };
  await bad({ name: "", scopes: ["orders.read"] }, "NAME_INVALID");
  await bad({ name: "x", scopes: ["offers.read"] }, "SCOPES_INVALID");
  await bad({ name: "x", scopes: ["customers.read"] }, "SCOPES_INVALID");
  await bad({ name: "x", scopes: [] }, "SCOPES_INVALID");
  await bad({ name: "x", scopes: ["orders.read"], days: 45 }, "EXPIRY_INVALID");
  const fp = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
  eq((await post("owner", { create: { name: "x", scopes: [] } }, fp.body?.install?.id)).body?.code, "NOT_CUSTOM");
  eq((await tokensOf("owner", "pin_0000000000000000")).status, 404);
});

await t("at most 5 active tokens; a revoked one frees a place", async () => {
  const made = [];
  for (let i = 0; i < 4; i++) made.push((await post("owner", { create: { name: `extra ${i}`, scopes: ["storefront.read"] } })).body.token.id);
  const sixth = await post("owner", { create: { name: "sixth", scopes: ["storefront.read"] } });
  eq(sixth.status, 409, sixth.text.slice(0, 120));
  eq(sixth.body.code, "TOO_MANY");
  for (const id of made) eq((await post("owner", { revoke: id })).status, 200, `revoke ${id}`);
  const again = await post("owner", { revoke: made[0] });
  eq(again.body?.code, "ALREADY_REVOKED");
  const list = (await tokensOf()).body.tokens;
  eq(list.filter((x) => x.status === "revoked").length, 4, "revoked rows stay listed");
  eq((await post("admin", { revoke: "tok_0000000000000000" })).status, 404);
});

const tok = () => first.secret;
await t("v1 me: the app, its effective scopes and the store host; anonymous, malformed, cookies-only and Basic get 401", async () => {
  const r = await v1("me", { token: tok() });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.app.id, APP);
  eq(r.body.scopes.join(","), "orders.read");
  eq(r.body.store, a.tenant.domains[0]);
  eq((await v1("me")).status, 401, "anonymous");
  eq((await v1("me", { token: "sea_tok_nope.x" })).body?.error, "This token isn't valid for this store.", "malformed");
  eq((await v1("me", { cookies: store.cookies.owner })).status, 401, "owner's console cookie");
  eq((await v1("me", { headers: { authorization: `Basic ${tok()}` } })).status, 401, "Basic");
  eq((await v1("me", { token: `${tok().slice(0, -1)}0` === tok() ? `${tok().slice(0, -1)}1` : `${tok().slice(0, -1)}0` })).status, 401, "wrong secret");
});

await t("v1 on store B's host with store A's token: 401", async () => {
  eq((await v1("me", { token: tok(), host: hostB })).status, 401);
  eq((await v1("orders", { token: tok(), host: hostB })).status, 401);
});

await t("v1 orders and orders/[id]: in scope 200, never a customer field, cart_id or idempotency_key", async () => {
  const list = await v1("orders", { token: tok() });
  eq(list.status, 200, list.text.slice(0, 200));
  ok(list.body.items.some((o) => o.id === ORDER_ID), "the order is listed");
  noCustomer(list.text, "orders");
  const one = await v1("orders/[id]", { token: tok(), params: { id: ORDER_ID } });
  eq(one.status, 200, one.text.slice(0, 200));
  eq(one.body.order.total, 500);
  eq(one.body.order.items.length, 1);
  noCustomer(one.text, "orders/[id]");
  eq((await v1("orders/[id]", { token: tok(), params: { id: "BL-NOPE" } })).status, 404);
});

await t("v1 out of scope: products, collections and offers answer 403 in plain words", async () => {
  const r = await v1("products", { token: tok() });
  eq(r.status, 403);
  eq(r.body.error, "This app wasn't given permission to see your live store content, products and collections.");
  eq((await v1("collections", { token: tok() })).status, 403);
  eq((await v1("offers", { token: tok() })).status, 403);
});

let wide;
await t("v1 products, products/[handle] and collections with a storefront.read token; limit and cursor paging; a bad limit or cursor is 400", async () => {
  // revoke one of the old tokens' places first: 1 active + this one
  wide = (await post("owner", { create: { name: "Catalog", scopes: ["orders.read", "storefront.read"], days: 365 } })).body;
  ok(wide?.secret, "minted");
  const p1 = await v1("products", { token: wide.secret, query: "limit=2" });
  eq(p1.status, 200, p1.text.slice(0, 200));
  eq(p1.body.items.length, 2);
  ok(p1.body.nextCursor, "a next page");
  const p2 = await v1("products", { token: wide.secret, query: `limit=2&cursor=${p1.body.nextCursor}` });
  eq(p2.body.items.length, 1);
  eq(p2.body.nextCursor, null);
  const handle = p1.body.items[0].handle;
  const one = await v1("products/[handle]", { token: wide.secret, params: { handle } });
  eq(one.status, 200, one.text.slice(0, 200));
  eq(one.body.product.handle, handle);
  ok(Array.isArray(one.body.product.variants) && one.body.product.variants.length === 1, "variants");
  eq((await v1("products/[handle]", { token: wide.secret, params: { handle: "no-such" } })).status, 404);
  eq((await v1("collections", { token: wide.secret })).status, 200);
  eq((await v1("products", { token: wide.secret, query: "limit=101" })).status, 400);
  eq((await v1("products", { token: wide.secret, query: "cursor=zzz" })).status, 400);
});

await t("narrowing the app's approval narrows every token at once; widening needs confirm; a permission its webhook events need stays", async () => {
  const narrow = await post("owner", { scopes: { scopes: ["orders.read"] } });
  eq(narrow.status, 200, narrow.text.slice(0, 160));
  eq((await v1("products", { token: wide.secret })).status, 403, "storefront.read gone at once");
  eq((await v1("me", { token: wide.secret })).body.scopes.join(","), "orders.read");
  const widen = await post("owner", { scopes: { scopes: ["orders.read", "storefront.read"] } });
  eq(widen.status, 409);
  eq(widen.body.code, "CONFIRM_WIDEN");
  eq(widen.body.added[0].scope, "storefront.read");
  eq((await post("owner", { scopes: { scopes: ["orders.read", "storefront.read"], confirm: true } })).status, 200);
  eq((await v1("products", { token: wide.secret })).status, 200, "back");
  eq((await post("owner", { scopes: { scopes: ["storefront.read"] } })).body?.code, "SCOPES_NEEDED", "order.created needs orders.read");
  eq((await post("owner", { scopes: { scopes: ["customers.read"], confirm: true } })).body?.code, "SCOPES_INVALID");
  const rows = (await listAudit({ tenantId: a.id, limit: 200 })).filter((x) => x.action === "apps.scopes");
  eq(rows.length, 2, "two scope changes audited");
});

await t("every call writes one apps.api_call row (actor the install, via the tok_ id, scope, status), never the secret; the call list shows them (audit.read only)", async () => {
  const rows = await callsOf(APP);
  ok(rows.length >= 15, `rows ${rows.length}`);
  ok(rows.every((r) => r.actor_kind === "app" && /^GET \/api\/apps\/v1\//.test(r.resource)), "shape");
  const d = JSON.parse(rows.find((r) => r.resource === "GET /api/apps/v1/products" && JSON.parse(r.diff).status === 403).diff);
  eq(d.scope, "storefront.read");
  ok(/^tok_/.test(d.via), "via");
  for (const s of [first.secret, wide.secret]) ok(!JSON.stringify(rows).includes(s.split(".")[1]), "no secret in rows");
  const list = await call("owner", "apps/[id]/calls", "GET", { params: { id: APP } });
  eq(list.status, 200, list.text.slice(0, 160));
  ok(list.body.calls.length === Math.min(rows.length, 100), "same rows");
  const c = list.body.calls.find((x) => x.tokenId === first.token.id);
  eq(c.tokenName, "Orders sync");
  eq(c.method, "GET");
  for (const caller of ["staff", "support", "operator-support", "operator-support-entry"]) eq((await call(caller, "apps/[id]/calls", "GET", { params: { id: APP } })).status, 403, caller);
  for (const caller of ["signed-out", "app-token"]) eq((await call(caller, "apps/[id]/calls", "GET", { params: { id: APP } })).status, 401, caller);
  const audit = await call("owner", "audit", "GET");
  ok(audit.text.includes("apps.api_call"), "the store's Audit log tab shows them");
});

await t("an unwritable audit row: 503 and no data", async () => {
  const pdb = platformDb();
  await pdb.execute("ALTER TABLE audit_log RENAME TO audit_log_off");
  let r;
  try {
    r = await v1("orders", { token: tok() });
  } finally {
    await pdb.execute("ALTER TABLE audit_log_off RENAME TO audit_log");
  }
  eq(r.status, 503);
  eq(r.body.code, "AUDIT_UNAVAILABLE");
  ok(!r.text.includes(ORDER_ID), "no data");
});

await t("last_used_at is set on a call", async () => {
  const row = await inA(() => db.selectFrom("plugin_tokens").select("last_used_at").where("id", "=", first.token.id).executeTakeFirst());
  ok(row.last_used_at, "set");
});

await t("rate limits: 429 with Retry-After per token (audited); unknown tokens are limited by IP", async () => {
  process.env.RATE_LIMIT_DISABLED = "0";
  const envKey = `RATE_LIMIT_APPS_API_${first.token.id.toUpperCase()}`;
  process.env[envKey] = "2";
  process.env.RATE_LIMIT_APPS_API_UNKNOWN = "2";
  try {
    const xff = { "x-forwarded-for": "203.0.113.9" };
    const got = [];
    for (let i = 0; i < 3; i++) got.push(await v1("me", { token: tok(), headers: xff }));
    eq(got.map((r) => r.status).join(","), "200,200,429");
    ok(Number(got[2].headers.get("retry-after")) > 0, "Retry-After");
    ok((await callsOf(APP)).some((r) => JSON.parse(r.diff).status === 429), "the 429 is audited");
    const ip = { "x-forwarded-for": "203.0.113.10" };
    const unk = [];
    for (let i = 0; i < 3; i++) unk.push((await v1("me", { token: `sea_tok_${"0".repeat(16)}.${"0".repeat(64)}`, headers: ip })).status);
    eq(unk.join(","), "401,401,429");
  } finally {
    process.env.RATE_LIMIT_DISABLED = "1";
    delete process.env[envKey];
    delete process.env.RATE_LIMIT_APPS_API_UNKNOWN;
  }
});

await t("revoked, expired, switched-off and uninstalled apps' tokens: 401 (attributable ones audited)", async () => {
  eq((await post("owner", { revoke: first.token.id })).status, 200);
  eq((await v1("me", { token: first.secret })).status, 401, "revoked");
  ok((await callsOf(APP)).some((r) => JSON.parse(r.diff).via === first.token.id && JSON.parse(r.diff).status === 401), "the refused call is in the list");
  await inA(() => db.updateTable("plugin_tokens").set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where("id", "=", wide.token.id).execute());
  eq((await v1("me", { token: wide.secret })).status, 401, "expired");
  await inA(() => db.updateTable("plugin_tokens").set({ expires_at: new Date(Date.now() + 86400000).toISOString() }).where("id", "=", wide.token.id).execute());
  eq((await v1("me", { token: wide.secret })).status, 200, "live again");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: APP }, body: { disable: true } })).status, 200);
  eq((await v1("me", { token: wide.secret })).status, 401, "app off: suspended");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: APP }, body: { enable: true } })).status, 200);
  eq((await v1("me", { token: wide.secret })).status, 200, "on again: works");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: APP }, body: { uninstall: true } })).status, 200);
  eq((await v1("me", { token: wide.secret })).status, 401, "uninstalled");
  const left = await inA(() => db.selectFrom("plugin_tokens").select(["id"]).where("install_id", "=", APP).where("revoked_at", "is", null).execute());
  eq(left.length, 0, "every token revoked by the uninstall");
});

await t("the harness app-token caller: v1 answers it; every admin route ignores Bearer (test:permissions expects 401 on every row)", async () => {
  eq((await v1("me", { token: (await store.appToken()).secret })).status, 200);
  eq((await call("app-token", "orders", "GET")).status, 401);
});

// --- static guards -------------------------------------------------------------------
const src = (p) => readFile(join(ROOT, p), "utf8");
const V1 = ["me", "products", "products/[handle]", "collections", "offers", "orders", "orders/[id]"];
await t("v1 routes: GET only, through appApiRoute (tenantHandler, runtime nodejs), no CORS headers; api-auth never reads cookies; requireAdmin never reads Authorization", async () => {
  for (const p of V1) {
    const s = await src(`app/api/apps/v1/${p}/route.js`);
    eq([...s.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)].map((m) => m[1]).join(","), "GET", `${p} methods`);
    ok(s.includes("appApiRoute(") && s.includes('runtime = "nodejs"'), `${p} gate`);
    ok(!/access-control/i.test(s), `${p} CORS`);
  }
  const gate = await src("lib/plugins/api-auth.js");
  ok(gate.includes("tenantHandler(") && !/\.cookies\b/.test(gate) && !/access-control/i.test(gate), "api-auth");
  ok(!/headers\.get\(\s*["']authorization/i.test(await src("lib/admin-auth.js")), "admin-auth reads no Authorization header");
  const r = await v1("me", { token: (await store.appToken()).secret });
  ok(![...r.headers.keys()].some((k) => k.startsWith("access-control")), "no CORS header on an answer");
  eq((await v1("me", { token: (await store.appToken()).secret, method: "POST" })).status, 405);
});

await t("no diff key named like a secret in the token and call rows; the token secret is never logged in lib", async () => {
  const s = await src("lib/plugins/tokens.js");
  const badKey = /diff: \{[^}]*\b(token|secret\w*|key|password)\s*:/;
  ok(!badKey.test(s), "tokens.js diffs");
  ok(!badKey.test(await src("lib/plugins/api-auth.js")), "api-auth diffs");
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, network.join(","));
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
