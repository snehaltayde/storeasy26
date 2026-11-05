// P5-BUNDLEREAD (COM-01): the ONE place bundle-state wording comes from.
// Blocks, publish checks, the bundle panel and the editor all take their
// sentences from here (plan section 1.9), built from the structured
// `reasons` of lib/commerce/bundle-compat.js and lib/commerce/bundle-read.js,
// never from the legacy `problems` strings.
//
// Money goes through formatMoney(amount, currency ?? undefined): the
// bundle's own currency for blocks, the store's for the console. A null
// currency falls to formatMoney's own default, so a sentence never reads
// "null 1500.00". No currency symbol or code is written here.
//
// Pure: imports only lib/format.js. Edge- and browser-safe.
import { formatMoney as defaultFormatMoney } from "../format.js";

// Where a founder fixes a bundle. The editor links "Catalog > Bundles" here.
export const BUNDLES_HREF = "/admin/catalog#bundles";
export const BUNDLES_PLACE = "Catalog > Bundles";

function moneyOf(opts) {
  const fmt = typeof opts?.formatMoney === "function" ? opts.formatMoney : defaultFormatMoney;
  const currency = opts?.currency ?? undefined;
  return (amount) => fmt(amount, currency);
}

const hasMissing = (reasons) => (reasons || []).some((r) => r?.kind === "missing");
const sumOf = (reasons) => (reasons || []).find((r) => r?.kind === "no_saving" && r.sum != null)?.sum;

// The status line for a bundle in this state.
//   stateLine(state, reasons, { currency, formatMoney })
export function stateLine(state, reasons = [], opts = {}) {
  const money = moneyOf(opts);
  switch (state) {
    case "available":
      return "Showing to shoppers.";
    case "sold_out":
      // P5-FIX1: a product deleted from the catalog is not "sold out"; the
      // founder has to replace it (it never comes back in stock)
      if (hasMissing(reasons)) return `A product in this bundle is no longer in your catalog: shoppers see Currently unavailable and can't add it. Replace it with another product in ${BUNDLES_PLACE}.`;
      return "A product in this bundle is sold out: shoppers see Currently unavailable and can't add it.";
    case "no_saving": {
      const sum = sumOf(reasons);
      const added = sum != null && money(sum) ? ` (the products add up to ${money(sum)})` : "";
      // OQ-B (owner, 2026-11-05): a bundle that saves nothing is hidden from shoppers
      return `The price no longer saves anything${added}, so shoppers don't see it. Lower the price in ${BUNDLES_PLACE}.`;
    }
    case "not_ready":
      return `This bundle isn't ready for the cart yet: shoppers can't add it. Open it in ${BUNDLES_PLACE} and save it again.`;
    case "disabled":
      return `This bundle is turned off, so shoppers don't see it. Turn it on in ${BUNDLES_PLACE}, or remove it.`;
    case "missing":
      return "This bundle was deleted, so shoppers don't see it. Pick another or remove it.";
    default:
      return "";
  }
}

// One reason, as a short sentence for the product row or form field it is
// about.
//   reasonSentence(reason, { currency, formatMoney })
export function reasonSentence(reason, opts = {}) {
  const money = moneyOf(opts);
  switch (reason?.kind) {
    case "sold_out":
      return "Sold out";
    case "missing":
      return "No longer available";
    case "no_saving":
      return reason.sum != null && money(reason.sum) ? `Price must be lower than ${money(reason.sum)}` : "Price must be lower than the products add up to";
    case "too_few":
      return "Pick at least two products";
    case "duplicate":
      return "This product is already in the bundle";
    case "bad_price":
      return "Enter a price above zero";
    case "mixed_currency":
      return "These products are priced in different currencies";
    case "not_synced":
      return `Open it in ${BUNDLES_PLACE} and save it again`;
    case "bad_quantity":
      return "The quantity must be a whole number, 1 or more";
    default:
      return "";
  }
}

// P5-FIX1: the shopper sentence under the bundle page's add button
// (app/(storefront)/bundles/[slug]/page.js) for a bundle getBundle says can't
// be bought for a reason other than stock: not ready (for example a quantity
// that is not whole) or no longer saving anything. A sold-out (or deleted)
// product keeps the page's own out-of-stock sentence; these never say "out
// of stock". bundlePageSaysOutOfStock(b) is the page's rule.
export const BUNDLE_PAGE_UNAVAILABLE = "This bundle isn't available right now.";
export const bundlePageSaysOutOfStock = (bundle) => Boolean(bundle && !bundle.available && bundle.state === "sold_out");

// A grid whose bundles all failed.
export const gridEmptyLine = () => "None of the bundles in this grid can be shown, so shoppers don't see it.";

// A bundle that shares a product with another turned-on bundle.
export const overlapLine = () => "Another bundle uses the same products, so the cart may give a different saving than this block shows.";
