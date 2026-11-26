// Phase 9 line 3 suite: WhatsApp order updates and an abandoned-cart
// reminder, consent-gated.
//   the internal topic: only the WhatsApp manifest receives order.delivery_updated
//   templates: defaults pass the shopper banned-copy scan; only approved sends;
//     an edit returns a template to draft
//   providers: the stub refuses in production; Meta's template-send body
//   "nobody else": 60 carts and orders across every combination; after every
//     handler and sweep the whatsapp-stub rows equal the expected set exactly,
//     and no row exists without a matching live consent
//   caps and quiet hours on a pinned clock; a replayed event sends nothing new
//   routes: consent (cart cookie only), account (own only, 401 signed out),
//     stop link, cart-restore link, the signed webhook (constant time, raw body)
//   privacy erase deletes consents; support sees phones masked, no secrets
//   pnpm test:whatsapp
import { createHmac, createHash } from "node:crypto";
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.PLATFORM_SECRET = "test-wa-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.NODE_ENV = "test";
delete process.env.WHATSAPP_PROVIDER;
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
const same = (got, want, label = "") => eq(JSON.stringify(got), JSON.stringify(want), label);
const started = Date.now();

const LINK_A = "wa-a-link-secret";
const store = await H.makeRoleStore({ name: "wa", a: { products: 2, secrets: { order_link_secret: LINK_A } }, b: { products: 1, secrets: { order_link_secret: "wa-b-link-secret" } } });
const { a, b, call } = store;
const HOST_A = a.tenant.domains[0];
const HOST_B = b.tenant.domains[0];

const { db } = await import("../lib/db.js");
const C = await import("../lib/messaging/consent.js");
const W = await import("../lib/messaging/whatsapp.js");
const CAPS = await import("../lib/messaging/caps.js");
const TOP = await import("../lib/plugins/topics.js");
const M = await import("../lib/plugins/manifest.js");
const CAT = await import("../lib/plugins/catalog.js");
const SW = await import("../lib/plugins/sweeps.js");
const EV = await import("../lib/plugins/events.js");
const DL = await import("../lib/plugins/deliveries.js");
const { HANDLERS } = await import("../lib/plugins/first-party/whatsapp/handlers.js");
const { DEFAULT_TEMPLATES } = await import("../lib/plugins/first-party/whatsapp/templates.js");
const { scanText } = await import("./support/banned-copy.js");
const { redactCustomer } = await import("../lib/privacy.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const { CART_COOKIE } = await import("../lib/cart.js");
const { CUSTOMER_COOKIE } = await import("../lib/customers.js");

const ROUTES = {
  consent: await import("../app/api/messaging/consent/route.js"),
  stop: await import("../app/api/messaging/stop/route.js"),
  account: await import("../app/api/account/messaging/route.js"),
  webhook: await import("../app/api/whatsapp/webhook/route.js"),
  restore: await import("../app/(storefront)/cart/r/[token]/route.js"),
};
async function hit(route, method, { host = HOST_A, path = "/x", cookies = {}, body, raw, form, headers: extra = {}, params } = {}) {
  const headers = { host, ...extra };
  if (method !== "GET") headers.origin ??= `http://${host}`;
  const jar = Object.entries(cookies).filter(([, v]) => v != null);
  if (jar.length) headers.cookie = jar.map(([k, v]) => `${k}=${v}`).join("; ");
  let reqBody;
  if (form) {
    reqBody = new FormData();
    for (const [k, v] of Object.entries(form)) reqBody.append(k, v);
  } else if (raw !== undefined) reqBody = raw;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await ROUTES[route][method](new NextRequest(`http://${host}${path}`, { method, headers, body: reqBody }), { params: Promise.resolve(params ?? {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // text or a redirect
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

// --- the clock ----------------------------------------------------------------
const DAY = Date.parse("2026-11-26T06:30:00.000Z"); // 12:00 in Kolkata
const QUIET_AT = Date.parse("2026-11-26T17:00:00.000Z"); // 22:30 in Kolkata
const HOUR = 3_600_000;
const isoAt = (ms) => new Date(ms).toISOString();

// --- installs: WhatsApp in A and B (B is the other store), templates approved ---
const install = async (host, caller) => (await call(caller, "apps", "POST", { body: { install: { pluginId: "whatsapp", scopes: ["orders.read"] } }, host })).body?.install;
const waA = await install(HOST_A, "owner");
const waB = await install(HOST_B, "owner-b");

await t("setup: WhatsApp installs in both stores", () => {
  ok(/^pin_/.test(String(waA?.id)) && /^pin_/.test(String(waB?.id)), `installs: ${JSON.stringify([waA?.id, waB?.id])}`);
});

// --- 1. the internal topic -----------------------------------------------------
await t("manifest: WhatsApp's events include order.delivery_updated; the catalog is clean", () => {
  same(CAT.checkCatalog(), [], "catalog problems:");
  same([...CAT.pluginById("whatsapp").events], ["order.created", "order.fulfilled", "order.delivery_updated"], "events:");
  same([...CAT.pluginById("whatsapp").egress], ["graph.facebook.com"], "egress:");
  same(Object.keys(TOP.FIRST_PARTY_INTERNAL), ["order.delivery_updated"], "internal topics:");
  same([...TOP.FIRST_PARTY_INTERNAL["order.delivery_updated"]], ["whatsapp"], "only WhatsApp:");
  eq(TOP.SUBSCRIBABLE.includes("order.delivery_updated"), false, "still not subscribable:");
});

await t("guard: any other manifest naming order.delivery_updated is still refused, with or without orders.read", () => {
  const fx = (id, scopes) => ({ id, name: "Fx", version: "1.0.0", summary: "s", description: "d", icon: "Truck", author: { name: "T" }, scopes, settings: [], events: ["order.delivery_updated"], egress: [] });
  for (const [id, scopes] of [["fx-outside", ["orders.read"]], ["whatsapp-clone", ["orders.read"]], ["fx-noscope", []]]) {
    ok(M.checkManifest(fx(id, scopes)).some((p) => p.includes('unknown event "order.delivery_updated"')), `${id} refused`);
  }
  // the whatsapp id is taken in the catalog, so the test seam can't add a second one
  let threw = false;
  try {
    CAT.registerPlugin({ ...fx("whatsapp", ["orders.read"]) });
  } catch {
    threw = true;
  }
  ok(threw, "a second whatsapp manifest is refused");
});

await t("guard: an outside (custom) app can't subscribe to order.delivery_updated", async () => {
  process.env.STOREASY_PLUGIN_EGRESS_LOCAL = "1";
  const r = await call("owner", "apps", "POST", { body: { create_custom: { name: "Outside app", url: "http://127.0.0.1:9/hook", topics: ["order.delivery_updated"], scopes: ["orders.read"] } } });
  eq(r.status, 422, `create_custom: ${r.text.slice(0, 160)}`);
  eq(r.body?.code, "TOPICS_INVALID", "code:");
  delete process.env.STOREASY_PLUGIN_EGRESS_LOCAL;
});

// --- 2. templates ----------------------------------------------------------------
await t("default copy passes the banned-copy scan with shopper rules and claims, and the template rules", async () => {
  for (const [kind, body] of Object.entries(DEFAULT_TEMPLATES)) {
    same(scanText(body, { shopper: true }), [], `${kind} scan:`);
    same(W.templateProblems({ body, provider_template: kind, language: "en" }), [], `${kind} rules:`);
  }
  for (const words of Object.values((await import("../lib/messaging/wording.js")).CONSENT_WORDING)) same(scanText(words.text, { shopper: true }), [], "consent words:");
});

await t("template rules: unknown fields, no {stop}, no {link}, a bad name are refused", () => {
  ok(W.templateProblems({ body: "Hi {email} {link} {stop}" }).length, "unknown field");
  ok(W.templateProblems({ body: "Hi {link}" }).some((p) => p.includes("{stop}")), "no stop");
  ok(W.templateProblems({ body: "Hi {stop}" }).some((p) => p.includes("{link}")), "no link");
  ok(W.templateProblems({ body: "{link} {stop}", provider_template: "Bad Name" }).length, "bad name");
});

const approveAll = async (caller = "owner", host = HOST_A, id = waA.id) => {
  for (const kind of W.KINDS) {
    const r = await call(caller, "apps/[id]/whatsapp", "POST", { params: { id }, body: { approve: kind }, host });
    if (r.status !== 200) throw new Error(`approve ${kind}: ${r.status} ${r.text.slice(0, 160)}`);
  }
};

await t("templates: seeded as drafts; the card's roles: support/staff 403 on approve, admin approves; an edit returns to draft", async () => {
  const g = await call("owner", "apps/[id]/whatsapp", "GET", { params: { id: waA.id } });
  eq(g.status, 200, g.text.slice(0, 160));
  same(g.body.templates.map((x) => `${x.kind}:${x.status}`), W.KINDS.map((k) => `${k}:draft`), "seeded drafts:");
  for (const caller of ["support", "staff"]) eq((await call(caller, "apps/[id]/whatsapp", "POST", { params: { id: waA.id }, body: { approve: "order_confirmed" } })).status, 403, `${caller} approve:`);
  const ap = await call("admin", "apps/[id]/whatsapp", "POST", { params: { id: waA.id }, body: { approve: "order_confirmed" } });
  eq(ap.body?.templates?.find((x) => x.kind === "order_confirmed")?.status, "approved", "approved:");
  const ed = await call("admin", "apps/[id]/whatsapp", "POST", { params: { id: waA.id }, body: { template: { kind: "order_confirmed", body: "Order {order} at {store}: {link}\nStop: {stop}" } } });
  eq(ed.body?.templates?.find((x) => x.kind === "order_confirmed")?.status, "draft", "edited → draft:");
  const bad = await call("admin", "apps/[id]/whatsapp", "POST", { params: { id: waA.id }, body: { template: { kind: "order_confirmed", body: "no links here" } } });
  eq(bad.status, 422, "invalid body refused:");
  const other = await call("owner", "apps/[id]/whatsapp", "GET", { params: { id: store.b ? "pin_0000000000000000" : "" } });
  eq(other.status, 404, "not a WhatsApp install:");
  const crossStore = await call("owner", "apps/[id]/whatsapp", "GET", { params: { id: waB.id } });
  eq(crossStore.status, 404, "store B's install isn't on A:");
});

// --- 3. providers ----------------------------------------------------------------
await t("the stub refuses in production; with no provider set in production nothing is connected", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    eq(W.whatsappProvider(), null, "no provider in production:");
    eq(W.whatsappProvider({ NODE_ENV: "production", WHATSAPP_PROVIDER: "stub" }), null, "stub never chosen in production:");
    eq(W.connection({}).connected, false, "not connected:");
    let threw = false;
    try {
      await W.stub.send({});
    } catch {
      threw = true;
    }
    ok(threw, "stub.send throws in production");
    threw = false;
    try {
      await a.run(() => W.sendWhatsApp({ to: "+919800000000", template: { kind: "order_confirmed", status: "approved", body: "x {link} {stop}" }, vars: {}, consentClass: "transactional", consentRef: "mc_x", idempotencyKey: "wa:prodtest", provider: W.stub }));
    } catch {
      threw = true;
    }
    ok(threw, "sendWhatsApp with the stub throws in production");
    eq(await a.run(async () => (await db.selectFrom("notifications").select("id").where("idempotency_key", "=", "wa:prodtest").executeTakeFirst()) ?? null), null, "no row written:");
  } finally {
    process.env.NODE_ENV = prev;
  }
  eq(W.whatsappProvider()?.name, "stub", "outside production the stub is the default:");
  eq(W.whatsappProvider({ NODE_ENV: "production", WHATSAPP_PROVIDER: "meta" })?.name, "meta", "meta when chosen:");
});

await t("meta: the Cloud API template body (v27.0, Bearer token, positional body parameters); a refusal is a failed row", async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1 ? { ok: true, status: 200 } : { ok: false, status: 400 };
  };
  const tpl = { kind: "order_confirmed", status: "approved", provider_template: "order_confirmed", language: "en", body: "Hi {first_name}, {order} at {store}: {link} {stop}" };
  await a.run(async () => {
    const r = await W.sendWhatsApp({ to: "+919811111111", template: tpl, vars: { first_name: "Asha", order: "BL-1", store: "Shop", link: "https://x/o", stop: "https://x/s" }, consentClass: "transactional", consentRef: "mc_meta", idempotencyKey: "wa:meta:1", provider: W.meta, settings: { phone_number_id: "106540352242922" }, secrets: { access_token: "tok_meta" }, fetch });
    ok(r.id && !r.failed, "sent");
    const body = JSON.parse(calls[0].opts.body);
    eq(calls[0].url, "https://graph.facebook.com/v27.0/106540352242922/messages", "url:");
    eq(calls[0].opts.headers.authorization, "Bearer tok_meta", "auth:");
    same({ p: body.messaging_product, to: body.to, type: body.type, name: body.template.name, lang: body.template.language.code }, { p: "whatsapp", to: "919811111111", type: "template", name: "order_confirmed", lang: "en" }, "body:");
    same(body.template.components[0].parameters.map((p) => p.text), ["Asha", "BL-1", "Shop", "https://x/o", "https://x/s"], "params in order:");
    const f = await W.sendWhatsApp({ to: "+919811111111", template: tpl, vars: {}, consentClass: "transactional", consentRef: "mc_meta", idempotencyKey: "wa:meta:2", provider: W.meta, settings: { phone_number_id: "106540352242922" }, secrets: { access_token: "tok_meta" }, fetch });
    ok(f.failed, "refused → failed");
    eq((await db.selectFrom("notifications").select("status").where("idempotency_key", "=", "wa:meta:2").executeTakeFirst())?.status, "failed", "row failed:");
    const nc = await W.meta.send({ to: "+91", template: tpl, settings: {}, secrets: {}, fetch });
    eq(nc.error, "not_connected", "no secrets, not sent:");
    eq(calls.length, 2, "no call without secrets:");
    await db.deleteFrom("notifications").where("idempotency_key", "in", ["wa:meta:1", "wa:meta:2"]).execute();
  });
});

await t("sendWhatsApp: an unapproved template and a marketing send without consent are refused before any row", async () => {
  await a.run(async () => {
    for (const [tpl, cls, ref] of [
      [{ kind: "order_confirmed", status: "draft", body: "{link}{stop}" }, "transactional", "mc_x"],
      [{ kind: "cart_reminder", status: "approved", body: "{link}{stop}" }, "marketing", null],
    ]) {
      let threw = false;
      try {
        await W.sendWhatsApp({ to: "+919822222222", template: tpl, vars: {}, consentClass: cls, consentRef: ref, idempotencyKey: `wa:refuse:${tpl.kind}`, provider: W.stub });
      } catch {
        threw = true;
      }
      ok(threw, `${tpl.kind} refused`);
    }
    eq(Number((await db.selectFrom("notifications").select(db.fn.countAll().as("n")).where("idempotency_key", "like", "wa:refuse:%").executeTakeFirst()).n), 0, "no rows:");
  });
});

// --- 4. consent routes -------------------------------------------------------------
await t("consent route: no cart cookie → 400; a tick records the exact words, version and source, bound to the cart cookie (a body cart id is ignored)", async () => {
  eq((await hit("consent", "POST", { body: { purpose: "updates", granted: true, phone: "9876500001" } })).status, 400, "no cart:");
  const r = await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_route_1" }, body: { purpose: "updates", granted: true, phone: "98765 00001", cart_id: "cart_other", cartId: "cart_other" } });
  eq(r.status, 200, r.text);
  const rows = await a.run(() => db.selectFrom("messaging_consents").selectAll().where("cart_id", "in", ["cart_route_1", "cart_other"]).execute());
  eq(rows.length, 1, "one row:");
  same({ cart: rows[0].cart_id, phone: rows[0].phone_e164, words: rows[0].wording, v: rows[0].wording_version, src: rows[0].source, purpose: rows[0].purpose }, { cart: "cart_route_1", phone: "+919876500001", words: "Send my order updates on WhatsApp", v: 1, src: "checkout", purpose: "updates" }, "row:");
  eq((await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_route_1" }, body: { purpose: "updates", granted: true, phone: "12" } })).status, 422, "bad phone:");
  eq((await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_route_1" }, body: { purpose: "everything", granted: true, phone: "9876500001" } })).status, 400, "bad purpose:");
  eq((await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_route_1" }, body: { purpose: "updates", granted: true, phone: "9876500001" }, headers: { origin: "https://evil.example" } })).status, 403, "cross-origin:");
  // a new phone replaces the old one on the same cart
  await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_route_1" }, body: { purpose: "updates", granted: true, phone: "9876500002" } });
  const live = await a.run(() => db.selectFrom("messaging_consents").select(["phone_e164"]).where("cart_id", "=", "cart_route_1").where("revoked_at", "is", null).execute());
  same(live.map((x) => x.phone_e164), ["+919876500002"], "one live row, the new phone:");
  const un = await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_route_1" }, body: { purpose: "updates", granted: false } });
  eq(un.status, 200, "untick:");
  eq((await a.run(() => db.selectFrom("messaging_consents").select("id").where("cart_id", "=", "cart_route_1").where("revoked_at", "is", null).execute())).length, 0, "nothing live:");
});

await t("consent route: GET shows this cart's live boxes (phone masked; nothing without a cart); sync withdraws another number's consent", async () => {
  const jar = { [CART_COOKIE]: "cart_route_2" };
  same((await hit("consent", "GET")).body, { ok: true, updates: false, marketing: false, phone: null }, "no cart:");
  await hit("consent", "POST", { cookies: jar, body: { purpose: "updates", granted: true, phone: "9876500701" } });
  await hit("consent", "POST", { cookies: jar, body: { purpose: "marketing", granted: true, phone: "9876500701" } });
  const g = await hit("consent", "GET", { cookies: jar });
  same({ u: g.body.updates, m: g.body.marketing }, { u: true, m: true }, "after a reload:");
  ok(g.body.phone.endsWith("0701") && !g.text.includes("9876500701"), `masked: ${g.text}`);
  eq((await hit("consent", "GET", { cookies: { [CART_COOKIE]: "cart_route_other" } })).body.updates, false, "another cart sees nothing:");
  const same1 = await hit("consent", "POST", { cookies: jar, body: { sync: true, phone: "98765 00701" } });
  same({ u: same1.body.updates, m: same1.body.marketing }, { u: true, m: true }, "same number keeps both:");
  const moved = await hit("consent", "POST", { cookies: jar, body: { sync: true, phone: "9876500702" } });
  same({ u: moved.body.updates, m: moved.body.marketing }, { u: false, m: false }, "a new number withdraws both:");
  const vias = await a.run(() => db.selectFrom("messaging_consents").select("revoked_via").where("cart_id", "=", "cart_route_2").execute());
  ok(vias.length === 2 && vias.every((v) => v.revoked_via === "phone_changed"), JSON.stringify(vias));
});

await t("consent route: syncs have their own allowance (60 per 10 minutes), apart from ticks", async () => {
  process.env.RATE_LIMIT_DISABLED = "0";
  try {
    const h = { "x-forwarded-for": "203.0.113.88" };
    for (let i = 0; i < 12; i++) await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_rl2" }, headers: h, body: { sync: true, phone: "9876500801" } });
    const tick = await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_rl2" }, headers: h, body: { purpose: "updates", granted: true, phone: "9876500801" } });
    eq(tick.status, 200, "a tick after 12 syncs:");
  } finally {
    process.env.RATE_LIMIT_DISABLED = "1";
  }
});

await t("consent route: 10 per 10 minutes", async () => {
  process.env.RATE_LIMIT_DISABLED = "0"; // the harness turns limits off
  let last;
  for (let i = 0; i < 12; i++) last = await hit("consent", "POST", { cookies: { [CART_COOKIE]: "cart_rl" }, headers: { "x-forwarded-for": "203.0.113.77" }, body: { purpose: "marketing", granted: false } });
  process.env.RATE_LIMIT_DISABLED = "1";
  eq(last.status, 429, "the 12th:");
});

// a shopper account in A (session written as lib/customers.js does)
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function shopper(t, email, phone) {
  const id = `cus_${sha(email).slice(0, 12)}`;
  const token = `ct_${sha(`tok${email}`).slice(0, 32)}`;
  const link = t === a ? LINK_A : "wa-b-link-secret";
  await t.run(async () => {
    await db.insertInto("customers").values({ id, email, name: "Wa Shopper", phone, default_address: null, created_at: isoAt(DAY), last_login_at: null }).execute();
    await db.insertInto("customer_sessions").values({ token_hash: sha(`${token}|${link}|customer`), customer_id: id, created_at: isoAt(Date.now()), expires_at: isoAt(Date.now() + 3_600_000) }).execute();
  });
  return { id, token };
}
const asha = await shopper(a, "asha@wa.test", "9876500100");
const ravi = await shopper(a, "ravi@wa.test", "9876500200");

await t("account route: signed out → 401 (GET and POST); the shopper's own toggles only", async () => {
  eq((await hit("account", "GET")).status, 401, "GET signed out:");
  eq((await hit("account", "POST", { body: { purpose: "updates", granted: true } })).status, 401, "POST signed out:");
  const on = await hit("account", "POST", { cookies: { [CUSTOMER_COOKIE]: asha.token }, body: { purpose: "updates", granted: true } });
  same({ s: on.status, u: on.body?.updates, m: on.body?.marketing }, { s: 200, u: true, m: false }, "on:");
  ok(!on.text.includes("9876500100") && on.body.phone.endsWith("0100"), `masked: ${on.text}`);
  const rv = await hit("account", "GET", { cookies: { [CUSTOMER_COOKIE]: ravi.token } });
  same({ u: rv.body?.updates, m: rv.body?.marketing }, { u: false, m: false }, "ravi sees only his own:");
  const row = await a.run(() => db.selectFrom("messaging_consents").selectAll().where("customer_id", "=", asha.id).where("revoked_at", "is", null).executeTakeFirst());
  same({ src: row?.source, cart: row?.cart_id ?? null }, { src: "account", cart: null }, "bound to the account:");
  const off = await hit("account", "POST", { cookies: { [CUSTOMER_COOKIE]: asha.token }, body: { purpose: "updates", granted: false } });
  eq(off.body?.updates, false, "off:");
});

// --- 5. tokens, stop, cart restore ---------------------------------------------------
await t("signed tokens carry no PII; stop revokes every consent for that phone; a bad token changes nothing", async () => {
  const { stopT, cartT, ids } = await a.run(async () => {
    const u = await C.grantConsent({ purpose: "updates", phone: "9876500300", cartId: "cart_stop", source: "checkout" });
    const m = await C.grantConsent({ purpose: "marketing", phone: "9876500300", cartId: "cart_stop", source: "checkout" });
    return { stopT: await C.stopToken(u.id), cartT: await C.cartToken(m.id), ids: [u.id, m.id] };
  });
  for (const tok of [stopT, cartT]) {
    ok(!/9876500300|cart_stop|@/.test(tok), `no PII in ${tok}`);
    ok(/^mc_[0-9a-f]{24}\.\d+\.[0-9a-f]{32}$/.test(tok), `shape ${tok}`);
  }
  eq(await a.run(() => C.verifyStopToken(cartT)), null, "a cart token isn't a stop token:");
  eq(await b.run(() => C.verifyStopToken(stopT)), null, "store B's secret refuses A's token:");
  const tampered = stopT.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  const bad = await hit("stop", "POST", { form: { t: tampered } });
  eq(bad.status, 303, "bad token: back to the page:");
  ok(String(bad.headers.get("location")).includes("bad=1"), "bad:");
  eq((await a.run(() => db.selectFrom("messaging_consents").select("id").where("id", "in", ids).where("revoked_at", "is", null).execute())).length, 2, "nothing revoked:");
  const done = await hit("stop", "POST", { form: { t: stopT } });
  ok(String(done.headers.get("location")).includes("done=1"), "done:");
  const left = await a.run(() => db.selectFrom("messaging_consents").select(["revoked_via"]).where("id", "in", ids).execute());
  same(left.map((x) => x.revoked_via), ["stop_link", "stop_link"], "both purposes revoked:");
  ok((await a.run(() => C.verifyStopToken(stopT, { now: Date.now() + C.STOP_TTL_MS + 1000 }))) === null, "expires");
});

await t("cart restore: a valid token puts that cart in the cookie and opens checkout; a bad one opens the store", async () => {
  const tok = await a.run(async () => C.cartToken((await C.grantConsent({ purpose: "marketing", phone: "9876500400", cartId: "cart_restore", source: "checkout" })).id));
  const r = await hit("restore", "GET", { path: `/cart/r/${tok}`, params: { token: tok } });
  eq(r.status, 303, "redirect:");
  ok(String(r.headers.get("location")).endsWith("/checkout"), `to checkout: ${r.headers.get("location")}`);
  ok(String(r.headers.get("set-cookie")).includes(`${CART_COOKIE}=cart_restore`), `cookie: ${r.headers.get("set-cookie")}`);
  const x = await hit("restore", "GET", { path: "/cart/r/mc_x", params: { token: "mc_x" } });
  ok(String(x.headers.get("location")).endsWith("/") && !x.headers.get("set-cookie"), "bad token: home, no cookie");
  const onB = await hit("restore", "GET", { host: HOST_B, path: `/cart/r/${tok}`, params: { token: tok } });
  ok(!onB.headers.get("set-cookie"), "A's token does nothing on B");
  // a revoked consent, or a cart that became an order: the link just opens the store
  const tok2 = await a.run(async () => C.cartToken((await C.grantConsent({ purpose: "marketing", phone: "9876500401", cartId: "cart_restore_rev", source: "checkout" })).id));
  await a.run(() => C.revokeConsent({ purpose: "marketing", cartId: "cart_restore_rev", via: "checkout" }));
  ok(!(await hit("restore", "GET", { path: `/cart/r/${tok2}`, params: { token: tok2 } })).headers.get("set-cookie"), "revoked: no cookie");
  await a.run(() => db.insertInto("orders").values({ id: "BL-WRESTORE", idempotency_key: "idem_wrestore", cart_id: "cart_restore", phone: "9876500400", total: 1, currency: "INR", status: "paid", created_at: isoAt(DAY), updated_at: isoAt(DAY) }).execute());
  ok(!(await hit("restore", "GET", { path: `/cart/r/${tok}`, params: { token: tok } })).headers.get("set-cookie"), "ordered: no cookie");
});

// --- 6. the webhook -------------------------------------------------------------------
const APP_SECRET = "wa-app-secret-0";
await call("owner", "apps/[id]", "POST", { params: { id: waA.id }, body: { settings: { phone_number_id: "106540352242922", app_secret: APP_SECRET, verify_token: "wa-verify-0", access_token: "wa-access-0" } } });

await t("webhook signature: known answer (sha256= hex HMAC-SHA256 of the raw body)", async () => {
  const raw = '{"object":"whatsapp_business_account"}';
  eq(await W.hubSignature("key", raw), `sha256=${createHmac("sha256", "key").update(raw).digest("hex")}`, "matches node's HMAC:");
  eq(await W.hubSignature("key", "The quick brown fox jumps over the lazy dog"), "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8", "RFC-style known answer:");
});

await t("webhook: GET verify challenge (token match only); POST unsigned or tampered → 401 and nothing changes; a signed STOP revokes", async () => {
  const v = await hit("webhook", "GET", { path: "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wa-verify-0&hub.challenge=12345" });
  same([v.status, v.text], [200, "12345"], "verified:");
  eq((await hit("webhook", "GET", { path: "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" })).status, 403, "wrong token:");
  const id = (await a.run(() => C.grantConsent({ purpose: "updates", phone: "9876500500", cartId: "cart_hook", source: "checkout" }))).id;
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [{ from: "919876500500", type: "text", text: { body: " stop " } }] } }] }] });
  const sig = await W.hubSignature(APP_SECRET, raw);
  eq((await hit("webhook", "POST", { raw })).status, 401, "no signature:");
  eq((await hit("webhook", "POST", { raw: raw.replace("stop", "stOp").replace("9876500500", "9876500501"), headers: { "x-hub-signature-256": sig } })).status, 401, "tampered body:");
  eq((await hit("webhook", "POST", { raw, headers: { "x-hub-signature-256": sig.replace(/.$/, "0") } })).status, 401, "wrong signature:");
  eq((await hit("webhook", "POST", { raw, headers: { "x-hub-signature-256": sig }, host: HOST_B })).status, 401, "A's signature on B (no app secret there):");
  eq((await a.run(() => C.consentById(id)))?.revoked_at ?? null, null, "still live:");
  const big = JSON.stringify({ pad: "x".repeat(260 * 1024) });
  eq((await hit("webhook", "POST", { raw: big, headers: { "x-hub-signature-256": await W.hubSignature(APP_SECRET, big) } })).status, 413, "a body over 256 KB, even signed:");
  // chunked, no content-length: the running limit still refuses it
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sentChunks = 0;
  const stream = new ReadableStream({ pull(c) { if (sentChunks++ < 6) c.enqueue(chunk); else c.close(); } });
  const chunked = await ROUTES.webhook.POST(new NextRequest(`http://${HOST_A}/api/whatsapp/webhook`, { method: "POST", headers: { host: HOST_A, "x-hub-signature-256": sig }, body: stream, duplex: "half" }), { params: Promise.resolve({}) });
  eq(chunked.status, 413, "chunked over 256 KB:");
  ok(sentChunks <= 6, "stopped reading at the limit");
  const okd = await hit("webhook", "POST", { raw, headers: { "x-hub-signature-256": sig } });
  eq(okd.status, 200, okd.text);
  eq((await a.run(() => C.consentById(id)))?.revoked_via, "whatsapp_stop", "revoked by STOP:");
});

// --- 7. "nobody else" ------------------------------------------------------------------
// Store A: 32 orders (8 cases × 4) and 28 carts (7 cases × 4); store B gets a
// consent that copies an A case. Every case's phone is its own (except the
// shared-phone and the cap cases), so the expected set is exact.
const phoneOf = (n) => `98765${String(10000 + n).slice(-5)}`;
const e164 = (p) => `+91${p}`;
let seq = 0;
const expected = new Set();
const prodGid = a.products?.[0]?.id ?? "gid://shopify/Product/1";
const varGid = a.products?.[0]?.variants?.[0]?.id ?? a.products?.[0]?.variants?.nodes?.[0]?.id ?? "gid://shopify/ProductVariant/1";

async function seedOrder(kind) {
  const n = ++seq;
  const phone = phoneOf(n);
  const cart = `cart_o${n}`;
  const orderId = `BL-WA${String(n).padStart(6, "0")}`;
  const customer = kind === "customer_bound" ? `cus_wa${n}` : null;
  await a.run(async () => {
    await db.insertInto("orders").values({ id: orderId, idempotency_key: `idem_wa_${n}`, cart_id: cart, email: `o${n}@wa.test`, phone, name: `Buyer${n} Test`, subtotal: 500, discount_total: 0, shipping_total: 0, total: 500, currency: "INR", payment_method: "cod", payment_status: "cod", status: "cod_pending", snapshot: JSON.stringify({ address: { country_code: "IN" } }), customer_id: customer, created_at: isoAt(DAY), updated_at: isoAt(DAY) }).execute();
    const grant = (purpose, over = {}) => C.grantConsent({ purpose, phone, cartId: cart, source: "checkout", now: DAY - HOUR, ...over });
    if (kind === "updates") await grant("updates");
    if (kind === "both") {
      await grant("updates");
      await grant("marketing");
    }
    if (kind === "marketing_only") await grant("marketing");
    if (kind === "revoked") {
      await grant("updates");
      await C.revokeConsent({ purpose: "updates", cartId: cart, via: "checkout" });
    }
    if (kind === "other_cart") await grant("updates", { cartId: `cart_elsewhere${n}` });
    if (kind === "other_phone") await grant("updates", { phone: phoneOf(900 + n) });
    if (kind === "customer_bound") await grant("updates", { cartId: null, customerId: customer });
    // an account's consent for this phone, but the order is a guest's (no customer, another cart)
    if (kind === "customer_vs_guest") await grant("updates", { cartId: null, customerId: `cus_other${n}` });
  });
  if (kind === "store_b") await b.run(() => C.grantConsent({ purpose: "updates", phone, cartId: cart, source: "checkout", now: DAY - HOUR }));
  if (["updates", "both", "customer_bound"].includes(kind)) expected.add(`whatsapp_order_confirmed|${e164(phone)}|wa:order_confirmed:${orderId}`);
  return orderId;
}

async function seedCart(kind) {
  const n = ++seq;
  const phone = kind === "cap" ? phoneOf(7777) : phoneOf(n);
  const cart = `cart_c${n}`;
  const idle = kind === "fresh" ? DAY - 30 * 60_000 : DAY - 3 * HOUR;
  await a.run(async () => {
    await db.insertInto("carts").values({ id: cart, coupon_code: null, created_at: isoAt(idle), updated_at: isoAt(idle) }).execute();
    if (kind !== "empty") await db.insertInto("cart_items").values({ cart_id: cart, variant_id: varGid, product_id: prodGid, quantity: 1, added_at: isoAt(idle) }).execute();
    const grant = (purpose, over = {}) => C.grantConsent({ purpose, phone, cartId: cart, source: "checkout", now: idle - 60_000, ...over });
    if (["marketing", "fresh", "empty", "ordered", "cap", "shared_phone", "first_time"].includes(kind)) await grant("marketing");
    // a past order with this number on another cart (the first-time case has none, and still gets its reminder)
    if (kind !== "first_time") await db.insertInto("orders").values({ id: `BL-WP${String(n).padStart(6, "0")}`, idempotency_key: `idem_wp_${n}`, cart_id: `cart_proof${n}`, email: `p${n}@wa.test`, phone, name: "Proof", total: 1, currency: "INR", status: "paid", created_at: isoAt(DAY - 30 * 86_400_000), updated_at: isoAt(DAY - 30 * 86_400_000) }).onConflict((oc) => oc.doNothing()).execute();
    if (kind === "updates_only") await grant("updates");
    if (kind === "revoked") {
      await grant("marketing");
      await C.revokeConsent({ purpose: "marketing", cartId: cart, via: "checkout" });
    }
    if (kind === "ordered") await db.insertInto("orders").values({ id: `BL-WC${String(n).padStart(6, "0")}`, idempotency_key: `idem_wc_${n}`, cart_id: cart, email: null, phone, name: "X", total: 1, currency: "INR", status: "paid", created_at: isoAt(DAY), updated_at: isoAt(DAY) }).execute();
    // the cart next door: the same phone, no consent of its own
    if (kind === "shared_phone") {
      await db.insertInto("carts").values({ id: `${cart}_twin`, coupon_code: null, created_at: isoAt(idle), updated_at: isoAt(idle) }).execute();
      await db.insertInto("cart_items").values({ cart_id: `${cart}_twin`, variant_id: varGid, product_id: prodGid, quantity: 1, added_at: isoAt(idle) }).execute();
    }
  });
  if (["marketing", "shared_phone", "first_time"].includes(kind)) expected.add(`whatsapp_cart_reminder|${e164(phone)}|wa:cart_reminder:${cart}`);
  return { cart, kind };
}

const ORDER_CASES = ["none", "updates", "both", "marketing_only", "revoked", "other_cart", "other_phone", "customer_bound", "customer_vs_guest", "store_b"];
const CART_CASES = ["none", "updates_only", "marketing", "revoked", "ordered", "fresh", "empty", "shared_phone", "first_time"];
const orders = [];
for (let i = 0; i < 4; i++) for (const k of ORDER_CASES) orders.push(await seedOrder(k));
const carts = [];
for (let i = 0; i < 3; i++) for (const k of CART_CASES) carts.push(await seedCart(k));
// the cap case: two carts, one phone → the first reminder only (1 a day per phone)
const capCarts = [await seedCart("cap"), await seedCart("cap")];
expected.add(`whatsapp_cart_reminder|${e164(phoneOf(7777))}|wa:cart_reminder:${capCarts[0].cart}`);

// the email-only erase: a guest's marketing consent on cart X; their order came
// from cart Y under email E with the same phone; the erase names only E
const ERASE_PHONE = phoneOf(8888);
const ERASE_EMAIL = "guest-erase@wa.test";
await a.run(async () => {
  const idle = DAY - 3 * HOUR;
  await db.insertInto("carts").values({ id: "cart_erase_x", coupon_code: null, created_at: isoAt(idle), updated_at: isoAt(idle) }).execute();
  await db.insertInto("cart_items").values({ cart_id: "cart_erase_x", variant_id: varGid, product_id: prodGid, quantity: 1, added_at: isoAt(idle) }).execute();
  await C.grantConsent({ purpose: "marketing", phone: ERASE_PHONE, cartId: "cart_erase_x", source: "checkout", now: idle - 60_000 });
  await C.grantConsent({ purpose: "updates", phone: ERASE_PHONE, cartId: "cart_erase_y", source: "checkout", now: idle - 60_000 });
  await db.insertInto("orders").values({ id: "BL-WERASE01", idempotency_key: "idem_werase", cart_id: "cart_erase_y", email: ERASE_EMAIL, phone: ERASE_PHONE, name: "Guest", total: 1, currency: "INR", status: "paid", created_at: isoAt(DAY - 86_400_000), updated_at: isoAt(DAY - 86_400_000) }).execute();
});
await t("nobody else: an email-only erase deletes a guest's consents bound to their carts and phone", async () => {
  await a.run(() => redactCustomer({ email: ERASE_EMAIL }));
  const left = await a.run(() => db.selectFrom("messaging_consents").select("id").where((eb) => eb.or([eb("phone_e164", "=", e164(ERASE_PHONE)), eb("cart_id", "in", ["cart_erase_x", "cart_erase_y"])])).execute());
  eq(left.length, 0, "no consent left for that phone or those carts:");
});

const stubRows = (t) => t.run(() => db.selectFrom("notifications").select(["type", "recipient", "idempotency_key", "consent_ref", "consent_class", "status"]).where("provider_id", "=", "whatsapp-stub").where("idempotency_key", "like", "wa:%").where("idempotency_key", "not like", "wa:order_confirmed:sup%").execute());
const asSet = (rows) => new Set(rows.map((r) => `${r.type}|${r.recipient}|${r.idempotency_key}`));
const sameSet = (got, want, label) => same([...got].sort(), [...want].sort(), label);

// every row must have a live (at send time) consent of the right purpose for that phone
async function everyRowConsented(rows) {
  for (const r of rows) {
    const c = await a.run(() => C.consentById(r.consent_ref));
    ok(c && c.phone_e164 === r.recipient, `row ${r.idempotency_key} has its consent`);
    eq(c.purpose, r.consent_class === "marketing" ? "marketing" : "updates", `${r.idempotency_key} purpose:`);
  }
}

async function deliverAll(t, topic, ids) {
  await t.run(async () => {
    for (const id of ids) {
      const ev = await EV.emitOrderEvent(topic, id);
      if (!ev) continue;
      await EV.fanOut(ev.id);
    }
    const pending = await db.selectFrom("plugin_deliveries").select("id").where("status", "=", "pending").execute();
    for (const d of pending) await DL.deliver(d.id);
  });
}

await t("nobody else: before templates are approved, no handler or sweep sends anything", async () => {
  ok(orders.length + carts.length + capCarts.length >= 60, `cases: ${orders.length + carts.length + capCarts.length}`);
  await deliverAll(a, "order.created", orders);
  await SW.sweepPlugins({ now: () => DAY });
  eq((await stubRows(a)).length, 0, "no rows while drafts:");
  // the deliveries were handled (a skip is not a failure)
  const failed = await a.run(() => db.selectFrom("plugin_deliveries").select("status").where("status", "=", "failed").execute());
  eq(failed.length, 0, "no failed deliveries:");
});

await t("nobody else: after approval, order.created sends exactly the expected set (and a replay sends nothing new)", async () => {
  await approveAll();
  await approveAll("owner-b", HOST_B, waB.id);
  // the earlier deliveries were consumed: new events for the same orders are deduped by key, so call the handler directly
  const ctx = (id) => ({ event: { data: { order: { id } } }, install: { id: waA.id, settings: { daily_cap: 200 } }, secrets: async () => ({}), fetch: async () => ({ ok: false }), log: () => {} });
  for (const id of orders) await a.run(() => HANDLERS["order.created"](ctx(id)));
  const want = new Set([...expected].filter((k) => k.startsWith("whatsapp_order_")));
  sameSet(asSet(await stubRows(a)), want, "order rows:");
  for (const id of orders) await a.run(() => HANDLERS["order.created"](ctx(id)));
  sameSet(asSet(await stubRows(a)), want, "after a replay:");
  eq((await stubRows(b)).length, 0, "store B sent nothing:");
  await everyRowConsented(await stubRows(a));
});

await t("nobody else: the sweep in quiet hours sends nothing; at noon it sends exactly the expected reminders, once per cart ever", async () => {
  await SW.sweepPlugins({ now: () => QUIET_AT });
  eq((await stubRows(a)).filter((r) => r.type === "whatsapp_cart_reminder").length, 0, "quiet hours:");
  await SW.sweepPlugins({ now: () => DAY });
  sameSet(asSet(await stubRows(a)), expected, "every row, exactly:");
  await SW.sweepPlugins({ now: () => DAY + HOUR });
  sameSet(asSet(await stubRows(a)), expected, "an hour later nothing new (one reminder per cart; the fresh carts still under the delay; the cap holds):");
  eq((await stubRows(b)).length, 0, "store B: nothing:");
  await everyRowConsented(await stubRows(a));
  const reminders = await a.run(() => db.selectFrom("whatsapp_reminders").select("cart_id").execute());
  same(reminders.map((r) => r.cart_id).sort(), [...expected].filter((k) => k.includes("cart_reminder")).map((k) => k.split(":").pop()).sort(), "reminder rows:");
  const row = (await stubRows(a)).find((r) => r.type === "whatsapp_cart_reminder");
  eq(row.consent_class, "marketing", "marketing class:");
});

await t("nobody else, two days on: the fresh carts are now idle and get theirs; the capped phone's second cart gets its one (2 a week)", async () => {
  for (const c of carts.filter((x) => x.kind === "fresh")) expected.add(`whatsapp_cart_reminder|${e164(phoneOf(Number(c.cart.slice(6))))}|wa:cart_reminder:${c.cart}`);
  expected.add(`whatsapp_cart_reminder|${e164(phoneOf(7777))}|wa:cart_reminder:${capCarts[1].cart}`);
  await SW.sweepPlugins({ now: () => DAY + 2 * 86_400_000 });
  sameSet(asSet(await stubRows(a)), expected, "rows:");
  await SW.sweepPlugins({ now: () => DAY + 3 * 86_400_000 });
  sameSet(asSet(await stubRows(a)), expected, "and then nothing more:");
  ok((await stubRows(a)).every((r) => r.status === "sent"), "every row sent");
  await everyRowConsented(await stubRows(a));
});

await t("the reminder's links: the cart link restores that cart; the stop link opens the stop page; no phone in either", async () => {
  const text = await a.run(async () => (await db.selectFrom("notifications").select("body").where("type", "=", "whatsapp_cart_reminder").executeTakeFirst()).body);
  const cartLink = /\/cart\/r\/([^\s]+)/.exec(text)?.[1];
  const stopLink = /\/m\/stop\?t=([^\s]+)/.exec(text)?.[1];
  ok(cartLink && stopLink, `links in ${text}`);
  ok(!/98765/.test(cartLink + stopLink), "no phone in the links");
  const r = await hit("restore", "GET", { path: `/cart/r/${cartLink}`, params: { token: cartLink } });
  ok(/cart_session=cart_c\d+/.test(String(r.headers.get("set-cookie"))), `restores: ${r.headers.get("set-cookie")}`);
});

await t("delivered and shipped: order.delivery_updated sends only for delivered, order.fulfilled sends shipped, both only with consent", async () => {
  const ctx = (id, data) => ({ event: { data: { order: { id }, ...data } }, install: { id: waA.id, settings: {} }, secrets: async () => ({}), fetch: async () => ({ ok: false }), log: () => {} });
  const before = await stubRows(a);
  for (const id of orders) {
    await a.run(() => HANDLERS["order.delivery_updated"](ctx(id, { delivery: { status: "out_for_delivery" } })));
    await a.run(() => HANDLERS["order.delivery_updated"](ctx(id, { delivery: { status: "delivered" } })));
    await a.run(() => HANDLERS["order.fulfilled"](ctx(id)));
  }
  const confirmed = [...expected].filter((k) => k.startsWith("whatsapp_order_confirmed"));
  const want = new Set([...asSet(before), ...confirmed.map((k) => k.replace(/order_confirmed/g, "order_delivered")), ...confirmed.map((k) => k.replace(/order_confirmed/g, "order_shipped"))]);
  sameSet(asSet(await stubRows(a)), want, "rows:");
  await everyRowConsented(await stubRows(a));
});

await t("revocation is re-checked at send time: a consent revoked after the event sends nothing", async () => {
  const id = await seedOrder("updates");
  const order = await a.run(() => db.selectFrom("orders").select(["phone", "cart_id"]).where("id", "=", id).executeTakeFirst());
  await a.run(() => C.revokePhone(`+91${order.phone}`, "whatsapp_stop"));
  await a.run(() => HANDLERS["order.created"]({ event: { data: { order: { id } } }, install: { id: waA.id, settings: {} }, secrets: async () => ({}), fetch: async () => ({ ok: false }), log: () => {} }));
  eq((await stubRows(a)).filter((r) => r.idempotency_key === `wa:order_confirmed:${id}`).length, 0, "nothing sent:");
});

await t("an edited template stops sending until approved again", async () => {
  await call("owner", "apps/[id]/whatsapp", "POST", { params: { id: waA.id }, body: { template: { kind: "order_confirmed", body: "Order {order}: {link}\nStop: {stop}" } } });
  const id = await seedOrder("updates");
  const run = () => a.run(() => HANDLERS["order.created"]({ event: { data: { order: { id } } }, install: { id: waA.id, settings: {} }, secrets: async () => ({}), fetch: async () => ({ ok: false }), log: () => {} }));
  await run();
  eq((await stubRows(a)).filter((r) => r.idempotency_key === `wa:order_confirmed:${id}`).length, 0, "draft: nothing:");
  await approveAll();
  await run();
  eq((await stubRows(a)).filter((r) => r.idempotency_key === `wa:order_confirmed:${id}`).length, 1, "approved: one:");
});

await t("nobody else: a consent revoked between the sweep's query and its send sends nothing", async () => {
  const idle = DAY + 10 * 86_400_000 - 3 * HOUR;
  const T = DAY + 10 * 86_400_000;
  const mk = async (id, phone, at) => {
    await db.insertInto("carts").values({ id, coupon_code: null, created_at: isoAt(at), updated_at: isoAt(at) }).execute();
    await db.insertInto("cart_items").values({ cart_id: id, variant_id: varGid, product_id: prodGid, quantity: 1, added_at: isoAt(at) }).execute();
    await db.insertInto("orders").values({ id: `BL-WR${id.slice(-2)}`, idempotency_key: `idem_wr_${id}`, cart_id: `${id}_proof`, email: null, phone, name: "R", total: 1, currency: "INR", status: "paid", created_at: isoAt(at), updated_at: isoAt(at) }).execute();
    return C.grantConsent({ purpose: "marketing", phone, cartId: id, source: "checkout", now: at - 60_000 });
  };
  const { sweepCarts } = await import("../lib/plugins/first-party/whatsapp/sweep.js");
  const out = await a.run(async () => {
    await mk("cart_race_01", "9811100001", idle - HOUR); // older: sent first
    const second = await mk("cart_race_02", "9811100002", idle);
    let revoked = false;
    const log = (evt) => {
      // right after the first send, the second shopper says STOP
      if (evt === "wa_sent" && !revoked) {
        revoked = true;
        return C.revokeById(second.id, "whatsapp_stop");
      }
    };
    const logged = [];
    const r = await sweepCarts({ install: { id: waA.id, settings: {} }, now: T, secrets: async () => ({}), fetch: async () => ({ ok: false }), log: async (e, f) => (logged.push([e, f?.reason]), await log(e)) });
    return { r, logged };
  });
  eq(out.r.due >= 2, true, `both were due: ${JSON.stringify(out.r)}`);
  const sent = await a.run(() => db.selectFrom("notifications").select("idempotency_key").where("idempotency_key", "in", ["wa:cart_reminder:cart_race_01", "wa:cart_reminder:cart_race_02"]).execute());
  same(sent.map((x) => x.idempotency_key), ["wa:cart_reminder:cart_race_01"], "only the first:");
  ok(out.logged.some(([e, why]) => e === "wa_skipped" && why === "no_consent"), "the second skipped: no consent");
});

await t("fairness: 60 older carts whose phone is at its weekly cap don't take the batch; a newer first-time cart still gets its reminder", async () => {
  const T = DAY + 20 * 86_400_000;
  const { sweepCarts, BATCH } = await import("../lib/plugins/first-party/whatsapp/sweep.js");
  const r = await a.run(async () => {
    const capped = "+919811122222";
    for (const i of [1, 2]) await db.insertInto("notifications").values({ id: `ntf_fair${i}`, type: "whatsapp_cart_reminder", recipient: capped, subject: "WhatsApp", body: "x", status: "sent", error: null, provider_id: "whatsapp-stub", consent_class: "marketing", consent_ref: "mc_fair", idempotency_key: `fair:${i}`, created_at: isoAt(T - i * 86_400_000 - HOUR), sent_at: isoAt(T - i * 86_400_000 - HOUR) }).execute();
    for (let i = 0; i < BATCH + 10; i++) {
      const id = `cart_fair_${String(i).padStart(3, "0")}`;
      const at = T - 6 * HOUR - i * 60_000;
      await db.insertInto("carts").values({ id, coupon_code: null, created_at: isoAt(at), updated_at: isoAt(at) }).execute();
      await db.insertInto("cart_items").values({ cart_id: id, variant_id: varGid, product_id: prodGid, quantity: 1, added_at: isoAt(at) }).execute();
      await C.grantConsent({ purpose: "marketing", phone: capped, cartId: id, source: "checkout", now: at - 60_000 });
    }
    const at = T - 3 * HOUR;
    await db.insertInto("carts").values({ id: "cart_fair_new", coupon_code: null, created_at: isoAt(at), updated_at: isoAt(at) }).execute();
    await db.insertInto("cart_items").values({ cart_id: "cart_fair_new", variant_id: varGid, product_id: prodGid, quantity: 1, added_at: isoAt(at) }).execute();
    await C.grantConsent({ purpose: "marketing", phone: "9811133333", cartId: "cart_fair_new", source: "checkout", now: at - 60_000 });
    return sweepCarts({ install: { id: waA.id, settings: {} }, now: T, secrets: async () => ({}), fetch: async () => ({ ok: false }) });
  });
  eq(r.due, 1, `only the sendable cart is due: ${JSON.stringify(r)}`);
  eq(r.sent, 1, "sent:");
  ok(await a.run(async () => Boolean(await db.selectFrom("notifications").select("id").where("idempotency_key", "=", "wa:cart_reminder:cart_fair_new").executeTakeFirst())), "the newer cart's reminder");
});

await t("caps race: parallel marketing sends to one phone write one row (the count is inside the insert)", async () => {
  await a.run(async () => {
    const to = "+919800077777";
    const tpl = { kind: "cart_reminder", status: "approved", body: "x {link} {stop}" };
    const T = DAY + 40 * 86_400_000;
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => W.sendWhatsApp({ to, template: tpl, vars: {}, consentClass: "marketing", consentRef: "mc_race", idempotencyKey: `race:${i}`, provider: W.stub, now: T })));
    eq(rs.filter((r) => r.id && !r.failed).length, 1, "one sent:");
    eq(rs.filter((r) => r.capped).length, 5, "five capped:");
    eq(Number((await db.selectFrom("notifications").select(db.fn.countAll().as("n")).where("idempotency_key", "like", "race:%").executeTakeFirst()).n), 1, "one row:");
    // the store's cap holds the same way
    const rs2 = await Promise.all(Array.from({ length: 4 }, (_, i) => W.sendWhatsApp({ to: `+91980007000${i}`, template: tpl, vars: {}, consentClass: "marketing", consentRef: "mc_race", idempotencyKey: `race2:${i}`, provider: W.stub, now: T + 3 * 86_400_000, dailyCap: 2 })));
    eq(rs2.filter((r) => r.id).length, 2, "the store's cap of 2:");
    await db.deleteFrom("notifications").where((eb) => eb.or([eb("idempotency_key", "like", "race:%"), eb("idempotency_key", "like", "race2:%")])).execute();
  });
});

await t("contract: order.delivery_updated is read only as { order: { id }, delivery: { awb, status, at } }", async () => {
  const id = await seedOrder("updates");
  const run = (data) => a.run(() => HANDLERS["order.delivery_updated"]({ event: { data }, install: { id: waA.id, settings: {} }, secrets: async () => ({}), fetch: async () => ({ ok: false }), log: () => {} }));
  for (const bad of [{ order: { id }, status: "delivered" }, { order_id: id, delivery: { status: "delivered" } }, { order: { id }, delivery: "delivered" }, { order: { id: 7 }, delivery: { status: "delivered" } }]) await run(bad);
  eq((await stubRows(a)).filter((r) => r.idempotency_key === `wa:order_delivered:${id}`).length, 0, "other shapes dropped:");
  await run({ order: { id }, delivery: { awb: "AWB1", status: "delivered", at: isoAt(DAY) } });
  eq((await stubRows(a)).filter((r) => r.idempotency_key === `wa:order_delivered:${id}`).length, 1, "the contract shape sends:");
});

// --- 8. caps and quiet hours on a pinned clock ------------------------------------------
await t("quiet hours: 21:00 to 09:00 in the store's zone", () => {
  for (const [isoT, want] of [["2026-11-26T15:29:00Z", false], ["2026-11-26T15:30:00Z", true], ["2026-11-26T03:29:00Z", true], ["2026-11-26T03:30:00Z", false]]) eq(CAPS.inQuietHours(Date.parse(isoT), "Asia/Kolkata"), want, isoT);
  eq(CAPS.inQuietHours(Date.parse("2026-11-26T22:00:00Z"), "UTC"), true, "UTC 22:00:");
});

await t("caps: 1 a day and 2 a week per phone, and the store's daily cap", async () => {
  await a.run(async () => {
    const to = "+919800099999";
    const put = (n, at) => db.insertInto("notifications").values({ id: `ntf_cap${n}`, type: "whatsapp_cart_reminder", recipient: to, subject: "WhatsApp", body: "x", status: "sent", error: null, provider_id: "whatsapp-stub", consent_class: "marketing", consent_ref: "mc_cap", idempotency_key: `cap:${n}`, created_at: isoAt(at), sent_at: isoAt(at) }).execute();
    const T0 = DAY + 30 * 86_400_000;
    eq(await CAPS.marketingRoom({ phone: to, now: T0 }), null, "room:");
    await put(1, T0 - 2 * HOUR);
    eq(await CAPS.marketingRoom({ phone: to, now: T0 }), "phone_day", "1 a day:");
    eq(await CAPS.marketingRoom({ phone: to, now: T0 + 23 * HOUR }), null, "after 24 h:");
    await put(2, T0 - 3 * 86_400_000);
    eq(await CAPS.marketingRoom({ phone: to, now: T0 + 23 * HOUR }), "phone_week", "2 a week:");
    eq(await CAPS.marketingRoom({ phone: to, now: T0 + 5 * 86_400_000 }), null, "after the week:");
    eq(await CAPS.marketingRoom({ phone: "+919800088888", now: T0, dailyCap: 1 }), "store_day", "the store's cap:");
    await db.deleteFrom("notifications").where("idempotency_key", "like", "cap:%").execute();
  });
});

// --- 9. privacy erase ---------------------------------------------------------------------
await t("privacy erase: the person's consents (by phone and by account) are deleted, and nothing can send to them", async () => {
  await a.run(async () => {
    await C.grantConsent({ purpose: "updates", phone: "9876500100", customerId: asha.id, source: "account" });
    await C.grantConsent({ purpose: "marketing", phone: "9876500600", cartId: "cart_erase", source: "checkout" });
  });
  await a.run(() => redactCustomer({ email: "asha@wa.test", phone: null }));
  await a.run(() => redactCustomer({ email: null, phone: "9876500600" }));
  const left = await a.run(() => db.selectFrom("messaging_consents").select("id").where((eb) => eb.or([eb("customer_id", "=", asha.id), eb("phone_e164", "in", ["+919876500100", "+919876500600"])])).execute());
  eq(left.length, 0, "deleted:");
  eq(await a.run(() => C.liveConsent({ purpose: "updates", phone: "+919876500100", customerId: asha.id })), null, "no live consent:");
});

// --- 10. the card as support: phones masked, no secrets --------------------------------------
await t("the card: support sees phones masked and no secret; the owner sees the phone; neither sees the access token", async () => {
  const sup = await call("support", "apps/[id]/whatsapp", "GET", { params: { id: waA.id } });
  const own = await call("owner", "apps/[id]/whatsapp", "GET", { params: { id: waA.id } });
  eq(sup.status, 200, sup.text.slice(0, 120));
  ok(sup.body.log.length > 0 && sup.body.log.every((m) => /•/.test(m.to)), "masked for support");
  ok(!/\+9198765\d{5}/.test(sup.text), "no full phone for support");
  ok(/\+9198765\d{5}/.test(own.text), "the owner sees phones");
  for (const r of [sup, own]) ok(!r.text.includes("wa-access-0") && !r.text.includes(APP_SECRET) && !r.text.includes("wa-verify-0"), "no secret");
  ok(sup.body.log.length <= 50, "the last 50");
  same(Object.keys(sup.body).sort(), ["caps", "connection", "log", "ok", "templates", "vars"], "keys:");
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
