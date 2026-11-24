// Phase 1 line 4: where a shop's Shopify endpoints live, and the one reading of
// a founder's "which Shopify store" answer. Edge-safe (no node:* imports).
//
//   shopifyBase(shop)        "https://<shop>" for every OAuth, Admin and
//                            Storefront URL. SHOPIFY_API_ORIGIN (the local
//                            stand-in, scripts/support/fake-shopify.js) is used
//                            only when it is a loopback address outside
//                            production: "<origin>/s/<shop>". It throws in
//                            production or on Vercel, and on any other host.
//   normalizeShopDomain(v)   "my-shop", "my-shop.myshopify.com" or a pasted admin
//                            URL → { ok: true, shop } | { ok: false, code, words }
//                            code: "empty" | "custom_domain" | "invalid"
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const SHOP_WORDS = Object.freeze({
  empty: "Enter your Shopify store's address.",
  custom_domain: "Use your myshopify.com address (Shopify, Settings, Domains)",
  invalid: "That doesn't look like a Shopify store address. It ends in .myshopify.com.",
});

const isProduction = (env) => env.NODE_ENV === "production" || Boolean(env.VERCEL);

export function shopifyBase(shop, env = process.env) {
  const raw = env.SHOPIFY_API_ORIGIN;
  if (!raw) return `https://${shop}`;
  if (isProduction(env)) throw new Error("SHOPIFY_API_ORIGIN must be unset in production (or on Vercel)");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("SHOPIFY_API_ORIGIN is not a URL");
  }
  if (!LOOPBACK.has(u.hostname)) throw new Error("SHOPIFY_API_ORIGIN may only point at a loopback address (the local stand-in)");
  return `${u.origin}/s/${shop}`;
}

export function normalizeShopDomain(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return { ok: false, code: "empty", words: SHOP_WORDS.empty };
  // admin.shopify.com/store/<handle>/… is the new admin's address
  const admin = /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(s);
  if (admin) s = `${admin[1]}.myshopify.com`;
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  if (SHOP_DOMAIN_RE.test(s)) return { ok: true, shop: s };
  if (!s.endsWith(".myshopify.com") && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return { ok: false, code: "custom_domain", words: SHOP_WORDS.custom_domain };
  return { ok: false, code: "invalid", words: SHOP_WORDS.invalid };
}
