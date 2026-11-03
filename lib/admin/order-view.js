// Pure order view helpers (S31 / BE10+MC16) — NO imports, safe for client
// components and plain-node tests alike.


// Role-limited customer fields: the SUPPORT role can look at orders (status,
// money, sync state) but never sees contact PII or the address snapshot.
const PII_FIELDS = ["email", "phone", "name", "address_line1", "address_line2", "city", "state", "pincode", "country"];

export function redactOrderForRole(order, role) {
  if (!order || role !== "support") return order;
  const out = { ...order };
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
