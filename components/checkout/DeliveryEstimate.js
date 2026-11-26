import { deliveryLine, expectedLine } from "@/lib/delivery-estimate";

// Phase 8 line 1: "Delivery by Tue 1 Dec – Thu 3 Dec" (kind "delivery", from
// today) or "Expected by Thu 3 Dec" (kind "expected", from the order's time),
// in the store's time zone. Nothing when the store set no delivery days.
//   estimate: { minDays, maxDays } | null   (computeShipping / /api/pincode)
// Phase 9 line 4: an estimate with serviceable: false (the store chose
// Shiprocket's courier estimate and no courier reaches the PIN) says so
// instead of a date, on the product page and in the checkout. Ordering is
// not blocked; an order's "expected" line keeps the store's own dates.
export const UNSERVICEABLE = "Couriers don't reach this PIN code yet";

export default function DeliveryEstimate({ estimate, timeZone, from, kind = "delivery", className = "" }) {
  if (kind !== "expected" && estimate?.serviceable === false) {
    return (
      <p data-delivery-estimate="unserviceable" className={`text-sm text-sf-text-muted ${className}`}>
        {UNSERVICEABLE}
      </p>
    );
  }
  const opts = { timeZone, ...(from ? { from } : {}) };
  const line = kind === "expected" ? expectedLine(estimate, opts) : deliveryLine(estimate, opts);
  if (!line) return null;
  return (
    <p data-delivery-estimate={kind} className={`text-sm text-sf-text-muted ${className}`}>
      {line}
    </p>
  );
}
