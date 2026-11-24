// Phase 1 line 4: a founder connects Shopify through OAuth from onboarding
// step 1 (docs/plans/phase-1.md "Line 4").
//   1. pure: normalizeShopDomain, shopifyBase, the state kinds, the words
//   2. POST /api/admin/shopify/connect: the domain save, the lock, the app not
//      set up, the authorize URL and the nonce cookie; every role
//   3. GET /api/admin/shopify/callback: every refusal (zero token calls and
//      nothing written), then the happy path through the first sync
//   4. missing scopes, uninstall and reconnect
//   5. expiring tokens: refresh, one at a time, retries, a refused refresh
//   6. the operator flow on the shared exchange, its own state kind, and the
//      redirect URLs the operator console lists
// Shopify is scripts/support/fake-shopify.js on loopback; a fetch guard throws
// on any other host and the suite fails if anything tried.
//   pnpm test:shopify-connect
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-shconn-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_URL = "";
delete process.env.NODE_ENV;
delete process.env.VERCEL;

const { loopbackFetchGuard } = await import("./support/fake-turso-api.js");
const { startFakeShopify, callbackHmac } = await import("./support/fake-shopify.js");
const guard = loopbackFetchGuard();

let pass = 0;
const failures = [];
const started = Date.now();
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

const SO = await import("../lib/shopify-origin.js");
const O = await import("../lib/platform/oauth.js");
const W = await import("../lib/onboarding/connect-words.js");
const Steps = await import("../lib/onboarding/steps.js");

// =========================================================================================
console.log("— 1. pure");

await t("normalizeShopDomain: a handle, the full domain, an admin URL (old and new) and a pasted storefront URL; a custom domain gets the Settings, Domains words; junk is invalid; empty is empty", async () => {
  const shop = (v) => SO.normalizeShopDomain(v);
  for (const v of ["my-shop", "My-Shop", " my-shop.myshopify.com ", "https://my-shop.myshopify.com/collections/all?x=1", "my-shop.myshopify.com/", "https://admin.shopify.com/store/my-shop/settings/domains", "admin.shopify.com/store/my-shop"]) eq(shop(v), { ok: true, shop: "my-shop.myshopify.com" }, `${v}:`);
  eq(shop("brand.com"), { ok: false, code: "custom_domain", words: "Use your myshopify.com address (Shopify, Settings, Domains)" }, "custom:");
  eq(shop("https://www.brand.co.in/").code, "custom_domain", "custom with www:");
  for (const v of ["-bad", "my_shop", "a b", "my-shop.myshopify.com.evil.test/"]) ok(!shop(v).ok, `${v} accepted`);
  eq(shop("").code, "empty", "empty:");
  eq(shop(null).code, "empty", "null:");
  ok(SO.SHOP_DOMAIN_RE.test("x1.myshopify.com") && !SO.SHOP_DOMAIN_RE.test("x.myshopify.com.evil"), "the pattern");
});

await t("shopifyBase: https://<shop> unless SHOPIFY_API_ORIGIN is a loopback address outside production; it throws in production, on Vercel, or on any other host", async () => {
  eq(SO.shopifyBase("a.myshopify.com", {}), "https://a.myshopify.com", "unset:");
  eq(SO.shopifyBase("a.myshopify.com", { SHOPIFY_API_ORIGIN: "http://127.0.0.1:9999" }), "http://127.0.0.1:9999/s/a.myshopify.com", "loopback:");
  eq(SO.shopifyBase("a.myshopify.com", { SHOPIFY_API_ORIGIN: "http://localhost:9" }), "http://localhost:9/s/a.myshopify.com", "localhost:");
  const throws = (env, re) => {
    try {
      SO.shopifyBase("a.myshopify.com", env);
    } catch (e) {
      ok(re.test(e.message), e.message);
      return;
    }
    throw new Error(`no throw for ${JSON.stringify(env)}`);
  };
  throws({ SHOPIFY_API_ORIGIN: "http://127.0.0.1:9", NODE_ENV: "production" }, /production/);
  throws({ SHOPIFY_API_ORIGIN: "http://127.0.0.1:9", VERCEL: "1" }, /Vercel/);
  throws({ SHOPIFY_API_ORIGIN: "https://a.myshopify.com" }, /loopback/);
  throws({ SHOPIFY_API_ORIGIN: "http://10.0.0.5:9" }, /loopback/);
  throws({ SHOPIFY_API_ORIGIN: "not a url" }, /not a URL/);
});

await t("state kinds: an operator state verifies only as op; a founder state only with its store, session cookie and nonce, within 10 minutes; each kind is refused by the other", async () => {
  const op = O.signState("store-a");
  eq(O.verifyState(op), { tenantId: "store-a" }, "op round trip:");
  const ctx = { tenantId: "store-a", adminCookie: "cookie-x", nonce: "nonce-1" };
  const fd = O.signFounderState(ctx);
  eq(O.verifyFounderState(fd, ctx), { ok: true }, "founder round trip:");
  eq(O.verifyState(fd), null, "a founder state on the operator side:");
  eq(O.verifyFounderState(op, ctx).code, "mismatch", "an operator state on the founder side:");
  eq(O.verifyFounderState(fd, { ...ctx, tenantId: "store-b" }).code, "mismatch", "another store:");
  eq(O.verifyFounderState(fd, { ...ctx, adminCookie: "cookie-y" }).code, "mismatch", "another session:");
  eq(O.verifyFounderState(fd, { ...ctx, nonce: undefined }).code, "mismatch", "no nonce cookie:");
  eq(O.verifyFounderState(fd, { ...ctx, nonce: "nonce-2" }).code, "mismatch", "another nonce:");
  eq(O.verifyFounderState(fd, { ...ctx, now: Date.now() + 11 * 60_000 }).code, "expired", "after 10 minutes:");
  const [p, sig] = fd.split(".");
  eq(O.verifyFounderState(`${p}.${sig.slice(0, -2)}xx`, ctx).code, "mismatch", "tampered:");
  const legacy = `${Buffer.from("store-a|abc|" + (Date.now() + 60_000)).toString("base64url")}.x`;
  eq(O.verifyState(legacy), null, "an unsigned old-format state:");
});

await t("Shopify's callback HMAC: a correctly signed answer is refused when its timestamp is missing, older than 10 minutes or more than a minute ahead", async () => {
  const signed = (ts) => {
    const p = new URLSearchParams({ code: "c", shop: "a.myshopify.com", state: "s", ...(ts == null ? {} : { timestamp: String(ts) }) });
    p.set("hmac", callbackHmac(p, "app-secret"));
    return p.toString();
  };
  const now = Math.floor(Date.now() / 1000);
  ok(O.verifyOAuthCallbackHmac(signed(now), "app-secret"), "now accepted");
  ok(O.verifyOAuthCallbackHmac(signed(now - 9 * 60), "app-secret"), "9 minutes old accepted");
  ok(!O.verifyOAuthCallbackHmac(signed(now - 11 * 60), "app-secret"), "11 minutes old refused");
  ok(!O.verifyOAuthCallbackHmac(signed(now + 5 * 60), "app-secret"), "5 minutes ahead refused");
  ok(!O.verifyOAuthCallbackHmac(signed(null), "app-secret"), "no timestamp refused");
  ok(!O.verifyOAuthCallbackHmac(signed("soon"), "app-secret"), "junk timestamp refused");
});

await t("words: every error code has plain words, an unknown code gets the general message, and none names an internal", async () => {
  for (const c of W.CONNECT_ERROR_CODES) ok(W.connectErrorWords(c).length > 20 && W.connectErrorWords(c) !== W.CONNECT_GENERAL_WORDS, c);
  eq(W.connectErrorWords("weird"), W.CONNECT_GENERAL_WORDS, "unknown:");
  eq(W.connectErrorWords("__proto__"), W.CONNECT_GENERAL_WORDS, "prototype key:");
  const { scanText } = await import("./support/banned-copy.js");
  const all = [...Object.values(W.CONNECT_ERROR_WORDS), W.CONNECT_GENERAL_WORDS, W.DENIED_HINT, ...Object.values(W.CONNECT_WORDS), ...Object.values(SO.SHOP_WORDS), ...Object.values(Steps.WORDS.connect)].join("\n");
  eq(scanText(all), [], "banned copy:");
  ok(!/oauth|hmac|token|nonce|tenant/i.test(all), "no internal names");
});

// =========================================================================================
console.log("— 2. POST /api/admin/shopify/connect");

const store = await H.makeRoleStore({ name: "shconn" });
const { a, b } = store;
const C = store.platform.control;
const { libsql } = await import("../lib/db.js");
const SHOP_A = "shconn-a-shop.myshopify.com";
const CB_A = `http://${a.tenant.domains[0]}/api/admin/shopify/callback`;
const APP_A = { shop: SHOP_A, clientId: "shconn-client-id-canary", clientSecret: "shconn-client-secret-canary", redirectUris: [CB_A] };
const fake = await startFakeShopify({ apps: [APP_A] });
process.env.SHOPIFY_API_ORIGIN = fake.url;
const tokenCalls = () => fake.tokenCalls().length;
const rowA = () => C.getTenant(a.id, { fresh: true });
const auditOf = async (resource) => (await C.platformDb().execute({ sql: "SELECT actor, tenant_id, action, resource, diff FROM audit_log WHERE resource = ? ORDER BY at", args: [resource] })).rows.map((r) => ({ ...r, diff: JSON.parse(r.diff || "null") }));
const connect = (caller, body, opts = {}) => store.call(caller, "shopify/connect", "POST", { body, ...opts });
const nonceOf = (r) => /_shopify_connect=([^;]*)/.exec(r.setCookie.find((c) => c.startsWith("_shopify_connect=")) || "")?.[1] || null;
const onboarding = (caller = "owner") => store.call(caller, "onboarding", "GET", {});
const connectStepOf = async (caller = "owner") => (await onboarding(caller)).body.steps[0];
const SECRET_CANARIES = ["shconn-client-secret-canary", "shconn-client-id-canary", "shpat_", "shprt_"];

await t("least-trusted: staff and support get 403, operator-support 403, signed out 401, another store's owner 401, cross-origin 403; nothing saved and no Shopify call", async () => {
  const before = [JSON.stringify((await rowA()).config), (await auditOf("shopify:domain")).length, fake.state.log.length];
  eq((await connect("staff", { shop: "x" })).status, 403, "staff:");
  eq((await connect("support", { shop: "x" })).status, 403, "support:");
  eq((await connect("operator-support", { shop: "x" })).status, 403, "operator support:");
  eq((await connect("signed-out", { shop: "x" })).status, 401, "signed out:");
  eq((await connect("owner-b", { shop: "x" })).status, 401, "another store's owner on this host:");
  eq((await connect("owner", { shop: "x" }, { origin: "https://evil.test" })).status, 403, "cross-origin:");
  eq([JSON.stringify((await rowA()).config), (await auditOf("shopify:domain")).length, fake.state.log.length], before, "nothing changed:");
});

await t("the app isn't set up: a handle is saved as <handle>.myshopify.com with an audit row; the step is in progress with 'preparing' words; no authorize URL and no cookie", async () => {
  const r = await connect("owner", { shop: "Wrong-Handle" });
  eq([r.status, r.body.ok, r.body.appReady], [200, true, false], JSON.stringify(r.body).slice(0, 200));
  ok(!r.body.authorizeUrl && !nonceOf(r), "no authorize URL or nonce");
  eq((await rowA()).config.shopify_store_domain, "wrong-handle.myshopify.com", "saved:");
  const s = r.body.steps[0];
  eq([s.state, s.words, s.facts.shopDomain, s.facts.appReady, s.facts.locked], ["in_progress", W.CONNECT_WORDS.appNotReady, "wrong-handle.myshopify.com", false, false], "the step:");
  // still editable: a corrected address replaces it
  const r2 = await connect("admin", { shop: `https://${SHOP_A}/` });
  eq([r2.status, (await rowA()).config.shopify_store_domain], [200, SHOP_A], "corrected by an admin:");
  const rows = await auditOf("shopify:domain");
  eq(rows.map((x) => [x.action, x.tenant_id, x.diff]), [["settings.write", a.id, { from: null, to: "wrong-handle.myshopify.com" }], ["settings.write", a.id, { from: "wrong-handle.myshopify.com", to: SHOP_A }]], "audit rows:");
  eq(tokenCalls(), 0, "no token call");
});

await t("a custom domain or junk is refused with its words (422) and nothing is saved", async () => {
  const r = await connect("owner", { shop: "brand.com" });
  eq([r.status, r.body.code, r.body.error], [422, "custom_domain", "Use your myshopify.com address (Shopify, Settings, Domains)"], "custom:");
  eq((await connect("owner", { shop: "" })).body.code, "empty", "empty:");
  eq((await connect("owner", { shop: "no_way" })).body.code, "invalid", "junk:");
  eq((await rowA()).config.shopify_store_domain, SHOP_A, "unchanged:");
});

await C.patchTenant(a.id, { config: { shopify_client_id: APP_A.clientId }, secrets: { shopify_client_secret: APP_A.clientSecret } });

let flow; // { authorizeUrl, nonce }
await t("the app set up: the domain is locked (a different shop is 409, nothing saved); Connect answers the authorize URL on the stand-in with the callback on this host, and sets an httpOnly SameSite=Lax nonce cookie on the callback path for 10 minutes", async () => {
  const locked = await connect("owner", { shop: "another-one" });
  eq([locked.status, locked.body.code], [409, "locked"], "locked:");
  ok(/Wrong store\? Contact Storeasy support/.test(locked.body.error), locked.body.error);
  eq((await rowA()).config.shopify_store_domain, SHOP_A, "unchanged:");
  const r = await connect("owner", {});
  eq([r.status, r.body.ok, r.body.appReady], [200, true, true], JSON.stringify(r.body));
  const u = new URL(r.body.authorizeUrl);
  eq(`${u.origin}${u.pathname}`, `${fake.url}/s/${SHOP_A}/admin/oauth/authorize`, "authorize endpoint:");
  eq([u.searchParams.get("client_id"), u.searchParams.get("redirect_uri"), u.searchParams.get("scope")], [APP_A.clientId, CB_A, O.OAUTH_SCOPES], "params:");
  const cookie = r.setCookie.find((c) => c.startsWith("_shopify_connect="));
  ok(/HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) && /Path=\/api\/admin\/shopify\/callback/.test(cookie) && /Max-Age=600/.test(cookie), cookie);
  ok(!JSON.stringify(r.body).includes(APP_A.clientSecret), "no secret in the answer");
  flow = { authorizeUrl: r.body.authorizeUrl, nonce: nonceOf(r), state: u.searchParams.get("state") };
  const step = await connectStepOf();
  eq([step.state, step.words, step.facts.locked, step.facts.appReady], ["ready", Steps.WORDS.connect.readyToConnect, true, true], "step 1 before approval:");
  eq(tokenCalls(), 0, "no token call yet");
});

const { NextRequest: RawRequest } = await import("./support/next-server-stub.js");
const HOST_A = a.tenant.domains[0];
const spoofed = (path, { method = "GET", query = "", jar = {} } = {}) =>
  new RawRequest(`http://${HOST_A}/api/admin/${path}${query ? `?${query}` : ""}`, {
    method,
    headers: { host: HOST_A, "x-forwarded-host": "evil.test", cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), ...(method === "POST" ? { origin: `http://${HOST_A}`, "content-type": "application/json" } : {}) },
    body: method === "POST" ? "{}" : undefined,
  });

await t("a spoofed x-forwarded-host is ignored: the redirect_uri Connect sends to Shopify is on the store's own host", async () => {
  const route = await import("../app/api/admin/shopify/connect/route.js");
  const res = await route.POST(spoofed("shopify/connect", { method: "POST", jar: store.cookies.owner }), { params: Promise.resolve({}) });
  const body = await res.json();
  eq(res.status, 200, JSON.stringify(body));
  eq(new URL(body.authorizeUrl).searchParams.get("redirect_uri"), CB_A, "redirect_uri:");
});

// The stand-in's approval page and its buttons → the callback's query.
async function approve(authorizeUrl, choice = "install") {
  const page = await fetch(authorizeUrl);
  ok(page.status === 200, `approval page ${page.status}`);
  const html = await page.text();
  const href = new RegExp(`id="${choice}" href="([^"]+)"`).exec(html)?.[1]?.replace(/&amp;/g, "&");
  ok(href, "button");
  const res = await fetch(new URL(href, fake.url), { redirect: "manual" });
  eq(res.status, 302, "decide:");
  return new URL(res.headers.get("location"));
}
const callback = (caller, query, jar) => store.call(caller, "shopify/callback", "GET", { query, cookies: jar });
const ownerJar = (nonce = flow.nonce) => ({ ...store.cookies.owner, ...(nonce ? { _shopify_connect: nonce } : {}) });
const codeOf = (r) => new URL(r.headers.get("location") || "http://x/").searchParams.get("connect_error");

// =========================================================================================
console.log("— 3. GET /api/admin/shopify/callback");

await t("the stand-in: an unknown client id or a redirect URL not on the app's list is a 400 and issues nothing", async () => {
  const u = new URL(flow.authorizeUrl);
  u.searchParams.set("redirect_uri", "http://evil.test/cb");
  eq((await fetch(u)).status, 400, "redirect not listed:");
  u.searchParams.set("redirect_uri", CB_A);
  u.searchParams.set("client_id", "nope");
  eq((await fetch(u)).status, 400, "unknown client:");
  eq(fake.state.codes.size, 0, "no code issued");
});

let back; // the approved callback URL
const nothingWritten = async (label, fn) => {
  const before = [tokenCalls(), JSON.stringify((await rowA()).secrets), (await auditOf("shopify:connection")).length];
  await fn();
  eq([tokenCalls(), JSON.stringify((await rowA()).secrets), (await auditOf("shopify:connection")).length], before, `${label}: a token call or a write:`);
};

await t("least-trusted: signed out → 401 page, staff → 403 page, support and operator-support → 403 page, all with a valid signed state and nonce; zero token calls, nothing written, the nonce cookie cleared", async () => {
  back = await approve(flow.authorizeUrl);
  eq(back.origin + back.pathname, CB_A, "Shopify sends the browser to this host's callback");
  const q = back.search.slice(1);
  await nothingWritten("refused callers", async () => {
    const out = await callback("signed-out", q, { _shopify_connect: flow.nonce });
    eq(out.status, 401, "signed out:");
    ok(/Sign in/.test(out.text) && /text\/html/.test(out.headers.get("content-type")), "a page");
    ok(out.setCookie.some((c) => /^_shopify_connect=;/.test(c) && /Max-Age=0/.test(c)), `cleared: ${out.setCookie}`);
    for (const caller of ["staff", "support", "operator-support"]) {
      const r = await callback(caller, q, { ...store.cookies[caller], _shopify_connect: flow.nonce });
      eq(r.status, 403, `${caller}:`);
      ok(/Only the owner or an admin/.test(r.text), `${caller} page`);
    }
  });
});

await t("refusals in order, each → ?step=connect&connect_error=<code> with zero token calls and nothing written: another session (mismatch), no nonce, a wrong nonce, store A's state on store B, an operator state, an expired state, a tampered HMAC", async () => {
  const q = new URLSearchParams(back.search);
  const swap = (k, v) => {
    const p = new URLSearchParams(q);
    p.set(k, v);
    return p.toString();
  };
  await nothingWritten("refusals", async () => {
    const admin = await callback("admin", q.toString(), { ...store.cookies.admin, _shopify_connect: flow.nonce });
    eq([admin.status, codeOf(admin)], [303, "mismatch"], "user X's state with user Y's session:");
    eq(new URL(admin.headers.get("location")).pathname, "/admin/onboarding", "back to onboarding");
    eq(new URL(admin.headers.get("location")).searchParams.get("step"), "connect", "on step 1");
    eq(codeOf(await callback("owner", q.toString(), ownerJar(null))), "mismatch", "no nonce cookie:");
    eq(codeOf(await callback("owner", q.toString(), ownerJar("other-nonce"))), "mismatch", "a wrong nonce:");
    const onB = await store.call("owner-b", "shopify/callback", "GET", { query: q.toString(), host: b.tenant.domains[0], cookies: { ...store.cookies["owner-b"], _shopify_connect: flow.nonce } });
    eq(codeOf(onB), "mismatch", "store A's state on store B's host:");
    eq(codeOf(await callback("owner", swap("state", O.signState(a.id)), ownerJar())), "mismatch", "an operator state:");
    const old = O.signFounderState({ tenantId: a.id, adminCookie: store.cookies.owner._admin, nonce: flow.nonce, now: Date.now() - 11 * 60_000 });
    eq(codeOf(await callback("owner", swap("state", old), ownerJar())), "expired", "expired:");
    eq(codeOf(await callback("owner", swap("hmac", "0".repeat(64)), ownerJar())), "hmac", "tampered HMAC:");
    eq(codeOf(await callback("owner", swap("timestamp", "1"), ownerJar())), "hmac", "a changed parameter breaks the HMAC:");
  });
});

await t("a spoofed x-forwarded-host is ignored by the callback too: its redirect stays on the store's own host", async () => {
  const route = await import("../app/api/admin/shopify/callback/route.js");
  const res = await route.GET(spoofed("shopify/callback", { query: back.search.slice(1), jar: { ...store.cookies.admin, _shopify_connect: flow.nonce } }), { params: Promise.resolve({}) });
  eq(res.status, 303, "redirect:");
  eq(new URL(res.headers.get("location")).host, HOST_A, "host:");
});

await t("a correctly signed callback with a timestamp older than 10 minutes → hmac; nothing written", async () => {
  await nothingWritten("stale timestamp", async () => {
    const p = new URLSearchParams(back.search);
    p.delete("hmac");
    p.set("timestamp", String(Math.floor(Date.now() / 1000) - 11 * 60));
    p.set("hmac", callbackHmac(p, APP_A.clientSecret));
    eq(codeOf(await callback("owner", p.toString(), ownerJar())), "hmac", "stale:");
  });
});

await t("a different shop than recorded (correctly signed by the app) → wrong_shop; Cancel in Shopify → denied; nothing written", async () => {
  await nothingWritten("wrong shop / denied", async () => {
    const p = new URLSearchParams(back.search);
    p.delete("hmac");
    p.set("shop", "someone-else.myshopify.com");
    p.set("hmac", callbackHmac(p, APP_A.clientSecret));
    eq(codeOf(await callback("owner", p.toString(), ownerJar())), "wrong_shop", "another shop:");
    await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ wrongShop: true }) });
    const viaFake = await approve(flow.authorizeUrl);
    await fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });
    eq(codeOf(await callback("owner", viaFake.search.slice(1), ownerJar())), "wrong_shop", "the stand-in's wrong-shop switch:");
    const cancel = await approve(flow.authorizeUrl, "cancel");
    eq(cancel.searchParams.get("error"), "access_denied", "the stand-in's Cancel");
    eq(codeOf(await callback("owner", cancel.search.slice(1), ownerJar())), "denied", "denied:");
  });
});

await t("another active store already connected to this shop: refused when Connect is pressed (409 other_store) and again at the callback; nothing written", async () => {
  await C.patchTenant(b.id, { config: { shopify_store_domain: SHOP_A }, secrets: { shopify_admin_token: "shpat_b_holds_it" } });
  await nothingWritten("other store", async () => {
    const r = await connect("owner", {});
    eq([r.status, r.body.code], [409, "other_store"], "at start:");
    eq(codeOf(await callback("owner", back.search.slice(1), ownerJar())), "other_store", "at the callback:");
  });
  await C.patchTenant(b.id, { config: { shopify_store_domain: null }, secrets: { shopify_admin_token: null } });
});

await t("the founder's state on the operator callback is refused there (no token call)", async () => {
  const opRoute = await import("../app/api/connect/shopify/callback/route.js");
  const { NextRequest } = await import("./support/next-server-stub.js");
  const before = tokenCalls();
  const res = await opRoute.GET(new NextRequest(`https://platform.test/api/connect/shopify/callback${back.search}`));
  eq(res.status, 400, "operator callback:");
  ok(/Invalid or expired state/.test(await res.text()), "its words");
  eq(tokenCalls(), before, "no token call");
});

await t("Shopify's token endpoint failing (503) → token_failed after one exchange attempt; nothing stored", async () => {
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ token5xx: 1 }) });
  const before = JSON.stringify((await rowA()).secrets);
  const fresh = await approve(flow.authorizeUrl);
  eq(codeOf(await callback("owner", fresh.search.slice(1), ownerJar())), "token_failed", "token_failed:");
  eq(JSON.stringify((await rowA()).secrets), before, "nothing stored");
  await fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });
});

await t("a suspended store: finishFounderConnect refuses with suspended before any exchange", async () => {
  const { finishFounderConnect } = await import("../lib/onboarding/connect.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  await C.patchTenant(a.id, { status: "suspended" });
  try {
    const before = tokenCalls();
    const r = await withTenant(await rowA(), () => finishFounderConnect({ params: new URLSearchParams(back.search), search: back.search.slice(1), actor: { kind: "merchant", id: store.users.owner.id, role: "owner" }, adminCookie: store.cookies.owner._admin, nonce: flow.nonce, origin: `http://${a.tenant.domains[0]}` }));
    eq([r.ok, r.code, tokenCalls()], [false, "suspended", before], "suspended:");
  } finally {
    await C.patchTenant(a.id, { status: "active" });
  }
});

await t("the happy path: Install → the callback exchanges the code once with expiring=1, stores both tokens encrypted with expiry times, connected_at and connected_by, writes the audit row, queues the first sync (startedBy connect) and redirects to step 2 with connected=1; the code is single-use", async () => {
  const fresh = await approve(flow.authorizeUrl);
  const before = tokenCalls();
  const r = await callback("owner", fresh.search.slice(1), ownerJar());
  eq(r.status, 303, r.text.slice(0, 200));
  const to = new URL(r.headers.get("location"));
  eq([to.pathname, to.searchParams.get("step"), to.searchParams.get("connected")], ["/admin/onboarding", "import", "1"], "redirect:");
  eq(fake.tokenCalls().slice(before).map((c) => [c.grant, c.status, c.expiring]), [["code", 200, true]], "one exchange, expiring:");
  const row = await rowA();
  ok(row.secrets.shopify_admin_token?.startsWith("shpat_fake_") && row.secrets.shopify_refresh_token?.startsWith("shprt_fake_"), "both tokens stored");
  const exp = Date.parse(row.config.shopify_token_expires_at) - Date.now();
  const rexp = Date.parse(row.config.shopify_refresh_expires_at) - Date.now();
  ok(exp > 3500_000 && exp <= 3600_000, `access expiry ~1 h: ${exp}`);
  ok(rexp > 89 * 86400_000 && rexp <= 90 * 86400_000, `refresh expiry ~90 d: ${rexp}`);
  ok(row.config.shopify_connected_at && row.config.shopify_connected_by === store.users.owner.id, "connected at / by");
  eq([row.config.shopify_app_uninstalled_at, row.config.shopify_reauth_needed_at], [null, null], "flags clear:");
  const raw = (await C.platformDb().execute({ sql: "SELECT secrets_enc FROM tenants WHERE id = ?", args: [a.id] })).rows[0].secrets_enc;
  ok(!String(raw).includes(row.secrets.shopify_admin_token) && !String(raw).includes(row.secrets.shopify_refresh_token), "encrypted at rest");
  const rows = await auditOf("shopify:connection");
  eq(rows.map((x) => [x.action, x.tenant_id, x.diff]), [["settings.write", a.id, { shop: SHOP_A, scopes: O.OAUTH_SCOPES.split(",").length, missing: [] }]], "audit:");
  const runs = (await a.run(() => libsql.execute("SELECT started_by FROM sync_runs"))).rows.map((x) => x.started_by);
  eq(runs, ["connect"], "the first sync queued:");
  const again = await callback("owner", fresh.search.slice(1), ownerJar());
  ok(["mismatch", "token_failed", "other_store"].includes(codeOf(again)) || codeOf(again) === "token_failed", `a replay: ${codeOf(again)}`);
  eq(fake.tokenCalls().at(-1).status, 400, "the stand-in refused the used code");
  await C.patchTenant(a.id, { secrets: { shopify_admin_token: row.secrets.shopify_admin_token, shopify_refresh_token: row.secrets.shopify_refresh_token } });
});

await t("after connecting: step 1 done, step 2 current; the sync runs against the stand-in and step 2 is done with its products; support's GET has no domain, client id or token and Connect is disabled", async () => {
  const s = await connectStepOf();
  eq([s.state, s.facts.connected, s.facts.reconnect], ["done", true, false], "step 1:");
  await H.drainAfter();
  const m = (await onboarding()).body;
  const products = Number((await a.run(() => libsql.execute("SELECT COUNT(*) AS n FROM products"))).rows[0].n);
  ok(products >= 6, `products: ${products}`);
  eq(m.steps[1].state, "done", `step 2: ${JSON.stringify(m.steps[1]).slice(0, 300)}`);
  ok(fake.state.log.some((e) => e.route === "admin" && e.op === "AdminProducts" && e.status === 200), "the sync read the stand-in");
  const sup = await onboarding("support");
  const text = JSON.stringify(sup.body);
  for (const c of [...SECRET_CANARIES, SHOP_A]) ok(!text.includes(c), `support: ${c} leaked`);
  ok(!("shopDomain" in sup.body.steps[0].facts) && !("locked" in sup.body.steps[0].facts), "no domain facts for support");
  // line 7: reading a policy draft (policy_view, storefront.read) is the one support action allowed
  ok(sup.body.steps.flatMap((x) => x.actions).every((x) => x.allowed === (x.id === "policy_view")), "every support action disabled but reading a policy draft");
  ok(sup.body.steps[0].actions.find((x) => x.id === "connect_shopify")?.allowed === false, "Connect disabled for support");
  const staff = await onboarding("staff");
  ok(!JSON.stringify(staff.body).includes(SHOP_A), "staff: no domain");
  eq(staff.body.steps[0].actions, [{ id: "connect_shopify", allowed: false, reason: Steps.ADMIN_ONLY_REASON }], "staff Connect:");
  const own = JSON.stringify((await onboarding()).body);
  for (const c of SECRET_CANARIES) ok(!own.includes(c), `owner: ${c} leaked`);
});

// =========================================================================================
console.log("— 4. missing scopes, uninstall, reconnect");

async function reconnect({ faults = null } = {}) {
  const r = await connect("owner", {});
  eq([r.status, r.body.appReady], [200, true], `Connect: ${JSON.stringify(r.body)}`);
  if (faults) await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify(faults) });
  const q = await approve(r.body.authorizeUrl);
  await fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });
  return callback("owner", q.search.slice(1), ownerJar(nonceOf(r)));
}

await t("a partial grant connects but warns: missing scopes in the audit row, reconnect shown; connecting again with every scope clears it", async () => {
  const r = await reconnect({ faults: { partialScopes: true } });
  eq(new URL(r.headers.get("location")).searchParams.get("connected"), "1", "connected:");
  eq((await auditOf("shopify:connection")).at(-1).diff.missing, ["write_orders"], "audit missing:");
  const s = await connectStepOf();
  eq([s.state, s.facts.reconnect], ["done", true], "reconnect:");
  ok(/permission/.test(s.problem), s.problem);
  await reconnect();
  eq((await connectStepOf()).facts.reconnect, false, "cleared:");
});

await t("after an uninstall: step 1 offers reconnect and keeps the domain; Connect is allowed with the locked domain, and connecting clears the uninstall flag", async () => {
  await C.patchTenant(a.id, { config: { shopify_app_uninstalled_at: new Date().toISOString() } });
  const s = await connectStepOf();
  eq([s.facts.reconnect, s.facts.connected, s.facts.shopDomain, s.facts.locked], [true, false, SHOP_A, true], "uninstalled:");
  ok(/removed/.test(s.problem), s.problem);
  const r = await reconnect();
  eq(new URL(r.headers.get("location")).searchParams.get("connected"), "1", "reconnected:");
  const row = await rowA();
  eq([row.config.shopify_app_uninstalled_at, row.config.shopify_store_domain], [null, SHOP_A], "flag cleared, domain kept:");
});

// =========================================================================================
console.log("— 5. expiring tokens");

const SA = await import("../lib/shopify-admin.js");
const inA = async (fn) => a.run ? (await import("../lib/tenant-context.js")).withTenant(await rowA(), fn) : null;
const expireStored = async () => {
  await fetch(`${fake.url}/_fake/expire`, { method: "POST" });
  await C.patchTenant(a.id, { config: { shopify_token_expires_at: new Date(Date.now() + 30_000).toISOString() } });
  SA.forgetAdminToken(a.id);
};
const refreshCalls = () => fake.tokenCalls().filter((c) => c.grant === "refresh");

await t("a token more than a minute from expiry is used as stored; within a minute it is refreshed once: the new pair and expiry are saved, and the next Admin call works", async () => {
  const stored = (await rowA()).secrets.shopify_admin_token;
  eq(await inA(() => SA.getAdminAccessToken()), stored, "fresh token used:");
  const n = refreshCalls().length;
  await expireStored();
  const tok = await inA(() => SA.getAdminAccessToken());
  ok(tok !== stored && tok.startsWith("shpat_fake_"), "a new token");
  eq(refreshCalls().length - n, 1, "one refresh:");
  const row = await rowA();
  eq(row.secrets.shopify_admin_token, tok, "saved:");
  ok(Date.parse(row.config.shopify_token_expires_at) - Date.now() > 3500_000, "new expiry saved");
  const d = await inA(() => SA.adminGraphql("query { shop { name myshopifyDomain } }"));
  eq(d.shop.myshopifyDomain, SHOP_A, "the Admin API answers with it:");
});

await t("one refresh at a time: five concurrent callers share one refresh; another instance's newer token in the row is used without refreshing", async () => {
  await expireStored();
  const n = refreshCalls().length;
  const toks = await inA(() => Promise.all(Array.from({ length: 5 }, () => SA.getAdminAccessToken())));
  eq(new Set(toks).size, 1, "one token for all:");
  eq(refreshCalls().length - n, 1, "one refresh:");
  // the request's copy is stale, the row was refreshed elsewhere
  const stale = { ...(await rowA()) };
  stale.config = { ...stale.config, shopify_token_expires_at: new Date(Date.now() + 10_000).toISOString() };
  stale.secrets = { ...stale.secrets, shopify_admin_token: "shpat_stale" };
  SA.forgetAdminToken(a.id);
  const { withTenant } = await import("../lib/tenant-context.js");
  const got = await withTenant(stale, () => SA.getAdminAccessToken());
  eq([got, refreshCalls().length - n], [toks[0], 1], "the row's newer token, no second refresh:");
});

await t("a refresh that meets a 503 is tried again and succeeds", async () => {
  await expireStored();
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ token5xx: 1 }) });
  const n = refreshCalls().length;
  const tok = await inA(() => SA.getAdminAccessToken());
  await fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });
  ok(tok.startsWith("shpat_fake_"), "a token");
  eq(refreshCalls().slice(n).map((c) => c.status), [503, 200], "tried again:");
});

// Runs `during` when the next refresh call leaves for Shopify, then lets it go.
async function midRefresh(during, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).endsWith("/admin/oauth/access_token") && String(init?.body || "").includes("refresh_token")) {
      globalThis.fetch = real;
      await during();
    }
    return real(u, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

await t("two workers: A refreshes and saves; B read the row before, sends the retired refresh token, is refused, and uses A's pair instead of wiping it", async () => {
  await expireStored();
  const seen = await rowA();
  const tokA = await inA(() => SA.getAdminAccessToken());
  await inA(() => SA.adminGraphql("query { shop { name } }")); // the new token is used: Shopify retires the old refresh token
  const n = refreshCalls().length;
  const tokB = await SA.refreshTenantToken(a.id, { seen });
  eq(refreshCalls().slice(n).map((c) => c.status), [401], "B's refresh refused:");
  const row = await rowA();
  eq([tokB, row.secrets.shopify_admin_token, Boolean(row.secrets.shopify_refresh_token), row.config.shopify_reauth_needed_at ?? null], [tokA, tokA, true, null], "A's pair kept, no reconnect flag:");
});

await t("a config write that lands during a refresh is kept, and the new pair is saved too (only the token keys are written)", async () => {
  await expireStored();
  const tok = await midRefresh(() => C.patchTenant(a.id, { config: { site: { name: "Written meanwhile" } } }), () => inA(() => SA.getAdminAccessToken()));
  const row = await rowA();
  eq([row.config.site?.name, row.secrets.shopify_admin_token], ["Written meanwhile", tok], "both kept:");
  ok(Date.parse(row.config.shopify_token_expires_at) - Date.now() > 3500_000, "new expiry saved");
});

await t("a revoke during a refresh wins: the refreshed pair is not saved and the call fails", async () => {
  await expireStored();
  let err;
  await midRefresh(
    () => C.patchTenant(a.id, { secrets: { shopify_admin_token: null, shopify_refresh_token: null }, config: { shopify_token_expires_at: null, shopify_refresh_expires_at: null } }),
    () => inA(() => SA.getAdminAccessToken()),
  ).catch((e) => (err = e));
  ok(err, "the call failed");
  const row = await rowA();
  eq([row.secrets.shopify_admin_token ?? null, row.secrets.shopify_refresh_token ?? null], [null, null], "still revoked:");
  await reconnect();
});

await t("Shopify asking to connect again during a refresh wins: the refreshed pair is not saved", async () => {
  await expireStored();
  const before = (await rowA()).secrets.shopify_admin_token;
  let err;
  await midRefresh(() => C.patchTenant(a.id, { config: { shopify_reauth_needed_at: new Date().toISOString() } }), () => inA(() => SA.getAdminAccessToken())).catch((e) => (err = e));
  eq(err?.message, SA.REAUTH_ERROR, "the call says connect again:");
  eq((await rowA()).secrets.shopify_admin_token, before, "the refreshed pair was not saved:");
  await reconnect();
});

await t("a refused refresh (401 invalid_request) clears both tokens, sets reauth_needed_at and step 1 says Connect again; later calls throw without trying client credentials; connecting again clears it", async () => {
  await expireStored();
  await fetch(`${fake.url}/_fake/faults`, { method: "POST", body: JSON.stringify({ invalidRefresh: true }) });
  let err;
  await inA(() => SA.getAdminAccessToken()).catch((e) => (err = e));
  await fetch(`${fake.url}/_fake/faults`, { method: "DELETE" });
  ok(err && err.message === SA.REAUTH_ERROR, String(err?.message));
  const row = await rowA();
  eq([row.secrets.shopify_admin_token ?? null, row.secrets.shopify_refresh_token ?? null, Boolean(row.config.shopify_reauth_needed_at)], [null, null, true], "cleared:");
  const s = await connectStepOf();
  eq([s.state, s.facts.reconnect, s.facts.connected], ["done", true, false], "done (products are in), reconnect:");
  ok(/Connect again/.test(s.problem), s.problem);
  const n = fake.tokenCalls().length;
  let again;
  await inA(() => SA.getAdminAccessToken()).catch((e) => (again = e));
  eq([again?.message, fake.tokenCalls().length - n], [SA.REAUTH_ERROR, 0], "no client-credentials call:");
  await reconnect();
  const after = await rowA();
  eq([after.config.shopify_reauth_needed_at, Boolean(after.secrets.shopify_refresh_token)], [null, true], "reconnected:");
});

await t("a token without a refresh token is non-expiring: used as it is, no expiry recorded (tokenFields)", async () => {
  eq(SA.tokenFields({ access_token: "shpat_x", scope: "read_products" }).config, { shopify_token_expires_at: null, shopify_refresh_expires_at: null }, "no expiry:");
  const { withTenant } = await import("../lib/tenant-context.js");
  const n = fake.tokenCalls().length;
  eq(await withTenant({ ...(await rowA()), secrets: { shopify_admin_token: "shpat_forever" }, config: { shopify_store_domain: SHOP_A } }, () => SA.getAdminAccessToken()), "shpat_forever", "used:");
  eq(fake.tokenCalls().length, n, "no call");
});

// =========================================================================================
console.log("— 6. the operator flow");

await t("the operator callback (op state) shares the exchange and storage, so it gets expiring tokens too; its page still says Store connected", async () => {
  const SHOP_B = "shconn-b-shop.myshopify.com";
  const cb = "https://platform.test/api/connect/shopify/callback";
  fake.addApp({ shop: SHOP_B, clientId: "b-client", clientSecret: "b-secret", redirectUris: [cb] });
  await C.patchTenant(b.id, { config: { shopify_store_domain: SHOP_B, shopify_client_id: "b-client" }, secrets: { shopify_client_secret: "b-secret" } });
  const url = O.buildAuthorizeUrl({ shopDomain: SHOP_B, clientId: "b-client", redirectUri: cb, state: O.signState(b.id) });
  const q = await approve(url);
  const opRoute = await import("../app/api/connect/shopify/callback/route.js");
  const { NextRequest } = await import("./support/next-server-stub.js");
  const res = await opRoute.GET(new NextRequest(`${cb}${q.search}`));
  eq(res.status, 200, "page:");
  ok((await res.text()).includes("Store connected"), "connected page");
  const row = await C.getTenant(b.id, { fresh: true });
  ok(row.secrets.shopify_refresh_token && row.config.shopify_token_expires_at, "expiring pair stored");
  eq(row.config.shopify_connected_by, null, "no founder recorded");
  eq(fake.tokenCalls().at(-1).expiring, true, "asked for an expiring token");
});

await t("the operator console's tenant GET lists the redirect URLs to add to the store's Shopify app, one per store domain, and whether the app is set up", async () => {
  const route = await import("../app/api/platform/tenants/[id]/route.js");
  const tok = store.cookies["operator-support"]._platform;
  const { NextRequest } = await import("./support/next-server-stub.js");
  await C.patchTenant(a.id, { domains: [a.tenant.domains[0], "shop.brand.test"] });
  const res = await route.GET(new NextRequest(`https://platform.test/api/platform/tenants/${a.id}`, { headers: { cookie: `_platform=${tok}`, host: "platform.test" } }), { params: Promise.resolve({ id: a.id }) });
  const body = await res.json();
  eq(res.status, 200, JSON.stringify(body).slice(0, 200));
  eq(body.connect?.redirectUrls, [`https://${a.tenant.domains[0]}/api/admin/shopify/callback`, "https://shop.brand.test/api/admin/shopify/callback"], "redirect URLs:");
  eq(body.connect?.appReady, true, "app ready:");
});

await t("no fetch left this machine", async () => {
  eq(guard.blocked, [], "blocked:");
});

await fake.close();
await store.cleanup();
console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
