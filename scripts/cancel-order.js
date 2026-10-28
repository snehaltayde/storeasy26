// Cancel ONE order on both sides (test-order hygiene / manual cancel flow):
//   pnpm order:cancel BL-XXXXXXXX [reason] [--tenant slug]
//   pnpm order:cancel BL-XXXXXXXX [reason] --refunded rfnd_XXXX
// S51: thin wrapper over lib/order-cancel.js — the same engine the admin
// console's Cancel action uses. Policy lives there: Shopify orderCancel first
// (restock, no refund, no email), captured payments need --refunded.
// Session 24: --tenant cancels in THAT tenant's database (and with its
// Shopify credentials).
import { cancelOrder } from "../lib/order-cancel.js";
import { parseTenantFlag, runAsTenant } from "../lib/platform/ops.js";

const { tenantSlug, rest } = parseTenantFlag(process.argv.slice(2));
const refundedIdx = rest.indexOf("--refunded");
const refundId = refundedIdx >= 0 ? rest[refundedIdx + 1] : null;
const positional = rest.filter(
  (a, i) => a !== "--refunded" && (refundedIdx < 0 || i !== refundedIdx + 1),
);
const orderId = positional[0];
const reason = positional[1] || "test order cleanup";
if (!orderId || (refundedIdx >= 0 && !refundId)) {
  console.error("usage: pnpm order:cancel BL-XXXXXXXX [reason] [--refunded rfnd_XXXX] [--tenant slug]");
  process.exit(1);
}

// allowSuspended: cancelling/refunding a suspended tenant's orders is a
// legitimate operator task (runAsTenant prints a warning when it happens).
await runAsTenant(tenantSlug, main, { allowSuspended: true }).catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});

async function main() {
  const r = await cancelOrder(orderId, { reason, refundId, via: "cancel-order-cli" });
  if (!r.ok) {
    console.error(`✗ ${orderId}: ${r.error}`);
    process.exit(1);
  }
  if (r.shopifyCancelled) console.log(`• Shopify order cancelled (restocked, no refund, no email)`);
  console.log(`✓ ${orderId}: ${r.already ? "already cancelled" : `${r.from} → cancelled`}`);
  process.exit(0);
}
