// P4-LIVEROW (OVL-04, R4): where an entity lives in the store's Shopify admin,
// for "Shopify owns these" links. Edge-safe: no node: imports.
//
//   shopifyAdminBase()                       https://admin.shopify.com/store/<store>,
//                                            or null without a store domain
//   shopifyAdminUrl({ product } | { collection })
//                                            that product's or collection's page
//                                            there, or null
//
// shopifyAdminBase is moved verbatim from app/api/admin/catalog/route.js
// (tenantOwnCfg shopify_store_domain). The route still has its own copy until
// P4-ED05 switches it to this import (batch 4).
import { tenantOwnCfg } from "../tenant-context.js";
import { numericId } from "../ids.js";

export const shopifyAdminBase = () => {
  const d = tenantOwnCfg("shopify_store_domain", "SHOPIFY_STORE_DOMAIN", "") || "";
  const store = d.replace(/\.myshopify\.com$/, "");
  return store ? `https://admin.shopify.com/store/${store}` : null;
};

export function shopifyAdminUrl({ product = null, collection = null } = {}) {
  const base = shopifyAdminBase();
  if (!base) return null;
  if (typeof product === "string" && product && !collection) return `${base}/products/${encodeURIComponent(numericId(product))}`;
  if (typeof collection === "string" && collection && !product) return `${base}/collections/${encodeURIComponent(numericId(collection))}`;
  return null;
}
