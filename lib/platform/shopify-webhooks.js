// Shopify webhook plumbing (Session 21): HMAC verification, topic → sync-action
// routing, and subscription registration. Webhook deliveries carry only a hint —
// freshness comes from a targeted REFETCH via the Admin API (lib/sync.js), so
// the payload shape never becomes a third format to maintain.
import crypto from "node:crypto";
import { adminGraphql } from "../shopify-admin.js";
import { withTenant } from "../tenant-context.js";
import {
  syncProductByGid,
  deleteProductByGid,
  syncCollectionByGid,
  deleteCollectionByGid,
} from "../sync.js";

// Shopify signs the RAW body with the app's client secret → base64 digest in
// X-Shopify-Hmac-Sha256. Per-tenant apps → per-tenant secrets: verification
// doubles as tenant-match proof.
export function verifyWebhookHmac(rawBody, hmacHeader, clientSecret) {
  if (!hmacHeader || !clientSecret) return false;
  const digest = crypto.createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// Delete payloads carry only a numeric id; create/update include the gid.
export const productGid = (payload) => payload?.admin_graphql_api_id || `gid://shopify/Product/${payload?.id}`;
export const collectionGid = (payload) => payload?.admin_graphql_api_id || `gid://shopify/Collection/${payload?.id}`;

// Apply one catalog webhook INSIDE an established tenant context. Returns a
// result object, or { unhandled: topic } for topics this router doesn't own.
export async function applyWebhook(topic, payload, { gql } = {}) {
  switch (topic) {
    case "products/create":
    case "products/update":
      return syncProductByGid(productGid(payload), { gql });
    case "products/delete":
      return deleteProductByGid(productGid(payload));
    case "collections/create":
    case "collections/update":
      return syncCollectionByGid(collectionGid(payload), { gql });
    case "collections/delete":
      return deleteCollectionByGid(collectionGid(payload));
    // S31 (BE10): order-money/fulfillment deliveries are HINTS — the handler
    // does an authoritative order refetch and rebuilds the whole projection,
    // so duplicates and out-of-order arrivals cannot double revenue or
    // regress status (same philosophy as the catalog refetches above).
    case "refunds/create":
    case "fulfillments/create":
    case "fulfillments/update":
    case "orders/cancelled": {
      const { reconcileByShopifyOrderGid } = await import("../order-projection.js");
      return reconcileByShopifyOrderGid(orderGid(payload), { gql });
    }
    default:
      return { unhandled: topic };
  }
}

// refunds/fulfillments payloads carry the numeric order id in `order_id`;
// orders/* payloads carry it in `id` (or the admin gid directly).
export function orderGid(payload) {
  if (payload?.admin_graphql_api_order_id) return payload.admin_graphql_api_order_id;
  const num = payload?.order_id ?? payload?.id;
  return num ? `gid://shopify/Order/${num}` : null;
}

// ---- registration ------------------------------------------------------------

export const WEBHOOK_TOPICS = [
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "COLLECTIONS_CREATE",
  "COLLECTIONS_UPDATE",
  "COLLECTIONS_DELETE",
  "APP_UNINSTALLED",
  // S31 (BE10): order projection hints — re-run `pnpm webhooks:register <slug>`
  // per tenant to subscribe (deploy-checkpoint item; needs read_orders scope).
  "REFUNDS_CREATE",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "ORDERS_CANCELLED",
];

const LIST_SUBS = /* GraphQL */ `
  query {
    webhookSubscriptions(first: 50) {
      nodes {
        id
        topic
        endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
`;

const CREATE_SUB = /* GraphQL */ `
  mutation Create($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_SUB = /* GraphQL */ `
  mutation Update($id: ID!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

// Idempotent: creates missing topics, repoints stale callback URLs, leaves
// matching subscriptions untouched. Runs AS the tenant (its admin token).
export async function registerWebhooks(tenant, { callbackUrl, gql = adminGraphql } = {}) {
  if (!callbackUrl) throw new Error("callbackUrl required");
  return withTenant(tenant, async () => {
    const data = await gql(LIST_SUBS);
    const existing = new Map(
      (data.webhookSubscriptions?.nodes || []).map((n) => [n.topic, n]),
    );
    const results = [];
    for (const topic of WEBHOOK_TOPICS) {
      const sub = existing.get(topic);
      if (sub && sub.endpoint?.callbackUrl === callbackUrl) {
        results.push({ topic, status: "ok" });
        continue;
      }
      const mutation = sub ? UPDATE_SUB : CREATE_SUB;
      const vars = sub
        ? { id: sub.id, sub: { callbackUrl } }
        : { topic, sub: { callbackUrl } };
      const res = await gql(mutation, vars);
      const payload = res.webhookSubscriptionCreate || res.webhookSubscriptionUpdate;
      if (payload?.userErrors?.length) {
        results.push({ topic, status: "error", errors: payload.userErrors });
      } else {
        results.push({ topic, status: sub ? "updated" : "created" });
      }
    }
    return results;
  });
}
