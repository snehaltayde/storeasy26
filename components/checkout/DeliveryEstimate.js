import { deliveryLine, expectedLine } from "@/lib/delivery-estimate";

// Phase 8 line 1: "Delivery by Tue 1 Dec – Thu 3 Dec" (kind "delivery", from
// today) or "Expected by Thu 3 Dec" (kind "expected", from the order's time),
// in the store's time zone. Nothing when the store set no delivery days.
//   estimate: { minDays, maxDays } | null   (computeShipping / /api/pincode)
export default function DeliveryEstimate({ estimate, timeZone, from, kind = "delivery", className = "" }) {
  const opts = { timeZone, ...(from ? { from } : {}) };
  const line = kind === "expected" ? expectedLine(estimate, opts) : deliveryLine(estimate, opts);
  if (!line) return null;
  return (
    <p data-delivery-estimate={kind} className={`text-sm text-sf-text-muted ${className}`}>
      {line}
    </p>
  );
}
