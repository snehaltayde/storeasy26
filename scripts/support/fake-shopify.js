// A local stand-in for Shopify (Phase 1 line 4, docs/plans/phase-1.md "Line 4"
// §5 item 9): OAuth authorize and token endpoints, and the Admin and
// Storefront GraphQL reads the catalog sync sends. Tests and the connect drill
// talk to this through SHOPIFY_API_ORIGIN (lib/shopify-origin.js: every shop is
// served under <origin>/s/<shop>). Loopback only: it refuses to listen
// anywhere else, and nothing here ever reaches Shopify.
//
//   startFakeShopify({ host, port, apps, products, collections, accessTtlSec })
//     apps: [{ shop, clientId, clientSecret, redirectUris: [exact URLs] }]
//     -> { url, state, addApp(app), tokenCalls(), close() }
//
//   GET  /s/<shop>/admin/oauth/authorize?client_id&scope&redirect_uri&state
//        the approval page (Install, Cancel); an unknown client id or a
//        redirect URL not on the app's list → 400, nothing issued
//   GET  /s/<shop>/_decide?choice=install|cancel&…   what the buttons send:
//        install → 302 redirect_uri?code&hmac&host&shop&state&timestamp (hmac
//        signed with the app's secret, as Shopify does); cancel → 302
//        redirect_uri?error=access_denied&state
//   POST /s/<shop>/admin/oauth/access_token   (JSON or form)
//        { client_id, client_secret, code, expiring } → a token (single-use
//        codes; expiring=1 adds expires_in, refresh_token, refresh_token_expires_in)
//        { client_id, client_secret, grant_type: "refresh_token", refresh_token }
//        → a new pair; the old refresh token is retired once the new access
//        token is used; an unknown or retired one → 401 invalid_request
//   POST /s/<shop>/admin/api/VERSION/graphql.json   the Admin token header; answers
//        by operation name (AdminProducts, ProductVariants, AdminProductsCount,
//        AdminCollections, CollectionProducts, and an anonymous shop query);
//        anything else is a GraphQL error. An expired or unknown token → 401.
//   POST /s/<shop>/api/VERSION/graphql.json        Storefront Products, Collections
//
// Faults: POST /_fake/faults { deny, partialScopes, token5xx, invalidRefresh, wrongShop }
//   deny: Install answers like Cancel · partialScopes: grant without write_orders
//   token5xx: the next N token calls answer 503 · invalidRefresh: refreshes answer 401
//   wrongShop: the callback names another shop
// DELETE /_fake/faults clears them; GET /_fake/log the request log (no secrets);
// POST /_fake/apps adds an app; POST /_fake/expire makes every access token expired.
import { createServer } from "node:http";
import crypto from "node:crypto";
import { OAUTH_SCOPES } from "../../lib/platform/oauth.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rand = (n = 18) => crypto.randomBytes(n).toString("base64url");

export function fakeCatalog(n = 6) {
  const products = Array.from({ length: n }, (_, i) => ({
    id: `gid://shopify/Product/${700000 + i}`,
    handle: `connect-item-${i + 1}`,
    title: `Connect Item ${i + 1}`,
    variants: [{ id: `gid://shopify/ProductVariant/${(700000 + i) * 10}`, title: "Default" }],
    images: [],
  }));
  const collections = [{ id: "gid://shopify/Collection/7100", handle: "all-connect", title: "All connect items", members: products.map((p) => p.id) }];
  return { products, collections };
}

const enc = (i) => Buffer.from(`at:${i}`).toString("base64");
const dec = (c) => (c ? Number(Buffer.from(c, "base64").toString().slice(3)) : 0);
function pageOf(list, cursor, size) {
  const start = dec(cursor);
  const nodes = list.slice(start, start + size);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < list.length, endCursor: nodes.length ? enc(end) : null } };
}
const money = { amount: "499.00", currencyCode: "INR" };
const adminVariants = (p, cursor, size) => {
  const pg = pageOf(p.variants, cursor, size);
  return { pageInfo: pg.pageInfo, nodes: pg.nodes.map((v) => ({ id: v.id, title: v.title, sku: `${v.id}-sku`, price: "499.00", compareAtPrice: null, availableForSale: true, inventoryQuantity: 4, selectedOptions: [{ name: "Title", value: v.title }], image: null })) };
};
const adminProduct = (p) => ({
  id: p.id,
  handle: p.handle,
  title: p.title,
  description: `About ${p.title}`,
  descriptionHtml: `<p>About ${p.title}</p>`,
  productType: "Goods",
  vendor: "Fake Shopify",
  tags: ["fake"],
  totalInventory: 4,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  priceRangeV2: { minVariantPrice: money, maxVariantPrice: money },
  featuredImage: null,
  images: { nodes: [] },
  options: [{ name: "Title", optionValues: p.variants.map((v) => ({ name: v.title })) }],
  variants: adminVariants(p, null, 50),
});
const storefrontProduct = (p) => ({
  ...adminProduct(p),
  priceRangeV2: undefined,
  availableForSale: true,
  priceRange: { minVariantPrice: money, maxVariantPrice: money },
  compareAtPriceRange: { minVariantPrice: { amount: "0.0", currencyCode: "INR" } },
  options: [{ name: "Title", values: p.variants.map((v) => v.title) }],
  variants: { nodes: p.variants.map((v) => ({ id: v.id, title: v.title, sku: `${v.id}-sku`, availableForSale: true, price: money, compareAtPrice: null, selectedOptions: [{ name: "Title", value: v.title }], image: null })) },
});

function answer(op, v, cat, shop) {
  switch (op) {
    case "AdminProducts": {
      const pg = pageOf(cat.products, v.cursor, 30);
      return { products: { pageInfo: pg.pageInfo, nodes: pg.nodes.map(adminProduct) } };
    }
    case "ProductVariants": {
      const p = cat.products.find((x) => x.id === v.id);
      return { product: p ? { variants: adminVariants(p, v.cursor, 100) } : null };
    }
    case "AdminProductsCount":
      return { productsCount: { count: cat.products.length, precision: "EXACT" } };
    case "AdminCollections": {
      const pg = pageOf(cat.collections, v.cursor, 50);
      return { collections: { pageInfo: pg.pageInfo, nodes: pg.nodes.map((c) => ({ id: c.id, handle: c.handle, title: c.title, description: "", updatedAt: "2026-10-01T00:00:00Z", image: null, products: pageOf(c.members.map((id) => ({ id })), null, 250) })) } };
    }
    case "CollectionProducts": {
      const c = cat.collections.find((x) => x.id === v.id);
      return { collection: c ? { products: pageOf(c.members.map((id) => ({ id })), v.cursor, 250) } : null };
    }
    case "Products": {
      const pg = pageOf(cat.products, v.cursor, v.first);
      return { products: { pageInfo: pg.pageInfo, nodes: pg.nodes.map(storefrontProduct) } };
    }
    case "Collections": {
      const pg = pageOf(cat.collections, v.cursor, v.first);
      return { collections: { pageInfo: pg.pageInfo, nodes: pg.nodes.map((c) => ({ id: c.id, handle: c.handle, title: c.title, description: "", updatedAt: "2026-10-01T00:00:00Z", image: null, products: { pageInfo: { hasNextPage: c.members.length > v.productsFirst }, nodes: c.members.slice(0, v.productsFirst).map((id) => ({ id })) } })) } };
    }
    case "anonymous":
      return { shop: { name: `Fake ${shop}`, myshopifyDomain: shop } };
    default:
      return null;
  }
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
const parseBody = (raw, type) => {
  if (String(type).includes("json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
};

export function callbackHmac(params, secret) {
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export async function startFakeShopify({ host = "127.0.0.1", port = 0, apps = [], products, collections, accessTtlSec = 3600 } = {}) {
  if (!LOOPBACK.has(String(host).toLowerCase())) throw new Error(`fake-shopify listens on loopback only, not ${host}`);
  const cat = products ? { products, collections: collections || [] } : fakeCatalog();
  const state = { apps: new Map(), codes: new Map(), access: new Map(), refresh: new Map(), faults: {}, log: [] };
  const addApp = (a) => state.apps.set(a.shop, { redirectUris: [], ...a });
  for (const a of apps) addApp(a);
  const record = (e) => state.log.push({ at: new Date().toISOString(), ...e });

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== "string";
    res.writeHead(status, { "content-type": isJson ? "application/json" : "text/html; charset=utf-8", ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  function issue(shop, app, scope, expiring) {
    const token = `shpat_fake_${rand()}`;
    const out = { access_token: token, scope };
    const rec = { shop, scope, expiresAt: expiring ? Date.now() + accessTtlSec * 1000 : null, retires: null };
    if (expiring) {
      const rt = `shprt_fake_${rand()}`;
      state.refresh.set(rt, { shop, clientId: app.clientId, scope, live: true });
      Object.assign(out, { expires_in: accessTtlSec, refresh_token: rt, refresh_token_expires_in: 90 * 86400 });
    }
    state.access.set(token, rec);
    return out;
  }

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://fake.local");
      if (u.pathname.startsWith("/_fake/")) {
        const what = u.pathname.slice(7);
        if (what === "faults" && req.method === "POST") {
          state.faults = { ...state.faults, ...parseBody(await readBody(req), "json") };
          return send(res, 200, { faults: state.faults });
        }
        if (what === "faults" && req.method === "DELETE") return send(res, 200, { faults: (state.faults = {}) });
        if (what === "log") return send(res, 200, { log: state.log });
        if (what === "apps" && req.method === "POST") {
          addApp(parseBody(await readBody(req), "json"));
          return send(res, 200, { ok: true });
        }
        if (what === "expire" && req.method === "POST") {
          for (const r of state.access.values()) if (r.expiresAt) r.expiresAt = Date.now() - 1000;
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: "unknown fake route" });
      }
      const m = /^\/s\/([^/]+)(\/.*)$/.exec(u.pathname);
      if (!m) return send(res, 404, { errors: "Not Found" });
      const [, shop, path] = m;
      const app = state.apps.get(shop);

      if (path === "/admin/oauth/authorize" && req.method === "GET") {
        const q = u.searchParams;
        record({ route: "authorize", shop });
        if (!app || q.get("client_id") !== app.clientId) return send(res, 400, "<h1>Oauth error invalid_request: The client id is not known for this shop</h1>");
        if (!app.redirectUris.includes(q.get("redirect_uri"))) return send(res, 400, "<h1>Oauth error invalid_request: The redirect_uri is not whitelisted</h1>");
        const keep = (choice) => `/s/${encodeURIComponent(shop)}/_decide?${new URLSearchParams({ choice, redirect_uri: q.get("redirect_uri"), state: q.get("state") || "", scope: q.get("scope") || "" })}`;
        return send(
          res,
          200,
          `<!doctype html><html><head><meta charset="utf-8"><title>Install app · Fake Shopify</title></head><body style="font-family:system-ui;padding:40px">` +
            `<h1>Install Storeasy on ${esc(shop)}?</h1><p data-fake="scopes">Access requested: ${esc(q.get("scope") || "")}</p>` +
            `<p><a id="install" href="${esc(keep("install"))}" style="padding:8px 16px;background:#008060;color:#fff;border-radius:6px;text-decoration:none">Install</a> ` +
            `<a id="cancel" href="${esc(keep("cancel"))}" style="padding:8px 16px;border:1px solid #888;border-radius:6px;text-decoration:none;color:#222">Cancel</a></p></body></html>`,
        );
      }

      if (path === "/_decide" && req.method === "GET") {
        const q = u.searchParams;
        const redirect = q.get("redirect_uri");
        if (!app || !app.redirectUris.includes(redirect)) return send(res, 400, "<h1>Oauth error invalid_request</h1>");
        const back = new URL(redirect);
        if (q.get("choice") !== "install" || state.faults.deny) {
          record({ route: "decide", shop, choice: "cancel" });
          back.search = new URLSearchParams({ error: "access_denied", state: q.get("state") || "" }).toString();
          res.writeHead(302, { location: back.href });
          return res.end();
        }
        const scope = state.faults.partialScopes ? (q.get("scope") || OAUTH_SCOPES).split(",").filter((s) => s !== "write_orders").join(",") : q.get("scope") || OAUTH_SCOPES;
        const code = rand(12);
        state.codes.set(code, { shop, clientId: app.clientId, scope });
        const named = state.faults.wrongShop ? `someone-else-${shop}` : shop;
        const p = new URLSearchParams({ code, host: Buffer.from(`admin.shopify.com/store/${named.split(".")[0]}`).toString("base64url"), shop: named, state: q.get("state") || "", timestamp: String(Math.floor(Date.now() / 1000)) });
        p.set("hmac", callbackHmac(p, app.clientSecret));
        back.search = p.toString();
        record({ route: "decide", shop, choice: "install" });
        res.writeHead(302, { location: back.href });
        return res.end();
      }

      if (path === "/admin/oauth/access_token" && req.method === "POST") {
        const body = parseBody(await readBody(req), req.headers["content-type"]);
        const grant = body.grant_type === "refresh_token" ? "refresh" : body.grant_type === "client_credentials" ? "client_credentials" : "code";
        const entry = { route: "token", shop, grant };
        if (state.faults.token5xx > 0) {
          state.faults.token5xx -= 1;
          record({ ...entry, status: 503 });
          return send(res, 503, { errors: "Service Unavailable" });
        }
        if (!app || body.client_id !== app.clientId || body.client_secret !== app.clientSecret) {
          record({ ...entry, status: 401 });
          return send(res, 401, { error: "invalid_client" });
        }
        if (grant === "refresh") {
          const r = state.refresh.get(body.refresh_token);
          if (state.faults.invalidRefresh || !r || !r.live || r.shop !== shop) {
            record({ ...entry, status: 401 });
            return send(res, 401, { error: "invalid_request", error_description: "The refresh token is invalid or was already used" });
          }
          const out = issue(shop, app, r.scope, true);
          state.access.get(out.access_token).retires = body.refresh_token; // retired once the new token is used
          record({ ...entry, status: 200 });
          return send(res, 200, out);
        }
        if (grant === "code") {
          const c = state.codes.get(body.code);
          state.codes.delete(body.code); // single use
          if (!c || c.shop !== shop || c.clientId !== body.client_id) {
            record({ ...entry, status: 400 });
            return send(res, 400, { error: "invalid_request", error_description: "The authorization code was not found or was already used" });
          }
          const expiring = String(body.expiring) === "1";
          record({ ...entry, status: 200, expiring });
          return send(res, 200, issue(shop, app, c.scope, expiring));
        }
        record({ ...entry, status: 400 });
        return send(res, 400, { error: "unsupported_grant_type" });
      }

      const admin = /^\/admin\/api\/[^/]+\/graphql\.json$/.test(path);
      const storefront = /^\/api\/[^/]+\/graphql\.json$/.test(path);
      if ((admin || storefront) && req.method === "POST") {
        const { query = "", variables = {} } = parseBody(await readBody(req), "json");
        const op = /^\s*query\s+(\w+)/.exec(query)?.[1] || (/^\s*(query\s*)?\{/.test(query) ? "anonymous" : "other");
        if (admin) {
          const rec = state.access.get(req.headers["x-shopify-access-token"]);
          if (!rec || rec.shop !== shop || (rec.expiresAt && rec.expiresAt < Date.now())) {
            record({ route: "admin", shop, op, status: 401 });
            return send(res, 401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" });
          }
          if (rec.retires) {
            const old = state.refresh.get(rec.retires);
            if (old) old.live = false;
            rec.retires = null;
          }
        }
        const data = answer(op, variables, cat, shop);
        record({ route: admin ? "admin" : "storefront", shop, op, status: 200 });
        if (!data) return send(res, 200, { errors: [{ message: `the fake Shopify answers reads only; it has no answer for "${op}"` }] });
        return send(res, 200, { data });
      }
      return send(res, 404, { errors: "Not Found" });
    } catch (e) {
      send(res, 500, { errors: String(e?.message || e) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}`;
  return {
    url,
    state,
    addApp,
    tokenCalls: () => state.log.filter((e) => e.route === "token"),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
