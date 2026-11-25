// Plan and ledger money is stored in paise (Razorpay's minor units), while
// store money elsewhere is whole currency units (Phase 3 line 3, plan risk 2).
// This is the one boundary: the operator's billing screens show rupees and
// send paise, through these two functions only. Pure; Edge- and client-safe.
import { formatMoney } from "../format.js";

// 129900 -> "₹1,299"; 129950 -> "₹1,299.50"; a signed ledger amount keeps its sign.
export function formatPaise(paise, currency = "INR") {
  if (paise == null || paise === "" || !Number.isFinite(Number(paise))) return "";
  return formatMoney(Math.round(Number(paise)) / 100, currency);
}

// What an operator typed in rupees ("1,299", "1299.5", "₹ 1,299.50") -> whole
// paise, or null when it is not a non-negative amount with at most 2 decimals.
export function rupeesToPaise(input) {
  const s = String(input ?? "").replace(/[₹,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
