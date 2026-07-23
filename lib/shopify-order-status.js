import { adminGraphql } from "./shopify-admin.js";

// Live fulfillment/tracking view for the guest status page (Session 18).
// Shopify is the source of truth once an order syncs; a lookup failure must
// degrade gracefully (the page still renders our durable state machine view).
export async function getShopifyOrderStatus(shopifyGid) {
  if (!shopifyGid) return null;
  try {
    const d = await adminGraphql(
      `query($id: ID!) {
        node(id: $id) {
          ... on Order {
            name
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            fulfillments(first: 5) {
              status
              trackingInfo(first: 5) { number url company }
            }
          }
        }
      }`,
      { id: shopifyGid },
    );
    const o = d?.node;
    if (!o) return null;
    return {
      name: o.name,
      financial: o.displayFinancialStatus,
      fulfillment: o.displayFulfillmentStatus,
      cancelledAt: o.cancelledAt,
      tracking: (o.fulfillments || [])
        .flatMap((f) => f.trackingInfo || [])
        .filter((t) => t.number)
        .map((t) => ({ number: t.number, url: t.url || null, company: t.company || null })),
    };
  } catch {
    return null;
  }
}
