// Pure order view helpers (S31 / BE10+MC16) — NO imports, safe for client
// components and plain-node tests alike.


// Role-limited customer fields: the SUPPORT role can look at orders (status,
// money, sync state) but never sees contact PII or the address snapshot.
// Every admin order read goes through redactOrderForRole, for every role.
// customer_id (Phase 0 line 2) links the order to the shopper's account. The
// payment ids and coupon code stay: support needs them to answer a shopper.
const PII_FIELDS = ["email", "phone", "name", "address_line1", "address_line2", "city", "state", "pincode", "country", "customer_id"];

// The roles that never see a shopper's details (today: support, which an
// operator under a support grant also is).
export const redactsPii = (role) => role === "support";

// Phase 0 line 2 (S5): cart_id is the shopper's cart_session cookie and
// idempotency_key the checkout's retry key, so no admin read hands them to any
// role; nothing in the console shows them.
const SERVER_ONLY_FIELDS = ["cart_id", "idempotency_key"];

export function redactOrderForRole(order, role) {
  if (!order) return order;
  const out = { ...order };
  for (const f of SERVER_ONLY_FIELDS) delete out[f];
  if (!redactsPii(role)) return out;
  for (const f of PII_FIELDS) if (f in out) out[f] = null;
  if (out.snapshot) out.snapshot = null; // snapshot carries contact + address
  out.pii_redacted = true;
  return out;
}

// OVL-06: what a founder needs to find this line in Shopify admin, when the title
// the shopper saw is not Shopify's own: "Shopify title: X, SKU: Y". Both are
// frozen at order time, on the line (migration 0018) and in the snapshot's items.
// The snapshot covers an order placed before its tenant was migrated. Old orders
// (no Shopify title) and lines whose titles match get null, so they show as
// they always have.
// P4-SEARCH (OVL-06): the line's text colour is the console's muted text
// (--c-fg-muted #52525b, 7.7:1 on the white card), not the subtle one
// (#a1a1aa, 2.56:1): the founder reads it to find the line in Shopify.
export const SHOPIFY_LINE_CLASS = "text-xs text-fg-muted";

export function shopifyMatchLine(item, snapshotItems) {
  if (!item) return null;
  const snap =
    !item.is_gift && Array.isArray(snapshotItems)
      ? snapshotItems.find((s) => s && s.variantId && s.variantId === item.variant_id)
      : null;
  const catalogTitle = item.catalog_title ?? snap?.catalog_title ?? null;
  const sku = item.sku ?? snap?.sku ?? null;
  if (!catalogTitle || catalogTitle === item.title) return null;
  return sku ? `Shopify title: ${catalogTitle}, SKU: ${sku}` : `Shopify title: ${catalogTitle}`;
}

// Honest copy for the console's push button (fixes the "Push failed: 200"
// quirk): push REFUSALS come back HTTP 200 with their reason keys — say what
// actually happened instead of parroting the status code.
export function pushResultMessage(data = {}, httpStatus = 200) {
  if (httpStatus >= 400) return `Push failed: ${data.error || `HTTP ${httpStatus}`}`;
  if (data.ok) return data.already ? "Already synced to Shopify" : "Pushed to Shopify ✓";
  if (data.inFlight) return "A push is already in flight — refresh in a moment";
  if (data.skipped) return `Not pushable from status "${data.skipped}"`;
  if (data.mismatch) return "Refused: Shopify's total didn't match the captured amount (needs review)";
  if (data.failed) return `${data.dead ? "Dead-lettered: " : "Attempt failed: "}${String(data.failed).slice(0, 120)}`;
  if (data.dead) return `Dead-lettered after ${data.attempts ?? "max"} attempts — review before retrying`;
  return "Push did not complete — check the order timeline";
}
