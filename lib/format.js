// Money + image helpers shared across server and client components.

export function formatMoney(amount, currency = "INR") {
  if (amount == null || amount === "" || Number.isNaN(Number(amount))) return "";
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      // Whole rupees read cleaner than ₹1,499.00
      maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// Ask the Shopify CDN for a right-sized image (keeps payloads small + fast).
export function shopifyImage(url, width) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return url;
  }
}

export function discountPercent(price, compareAt) {
  const p = Number(price);
  const c = Number(compareAt);
  if (!p || !c || c <= p) return 0;
  return Math.round(((c - p) / c) * 100);
}
