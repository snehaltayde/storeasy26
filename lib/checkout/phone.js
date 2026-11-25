// Phase 8 line 2: one strict phone format, so each number has exactly one
// form (and one phone_hash for the COD code's caps). Pure and client-safe.
// Accepted: 10 Indian digits, optionally after +91, 91 or a leading 0; or an
// E.164 number (+, 8 to 15 digits, no leading 0). Spaces, dashes, dots and
// brackets are ignored. Everything else (00 prefixes, letters, a + inside,
// +91 with the wrong length) is refused: → "" .
export function e164(phone) {
  const raw = String(phone ?? "").trim();
  if (!raw || /[^\d\s().+-]/.test(raw) || raw.indexOf("+") > 0 || (raw.match(/\+/g) || []).length > 1) return "";
  const digits = raw.replace(/\D/g, "");
  const india = (ten) => (/^[1-9]\d{9}$/.test(ten) ? `+91${ten}` : "");
  if (raw.startsWith("+")) {
    if (digits.startsWith("91")) return digits.length === 12 ? india(digits.slice(2)) : "";
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : "";
  }
  if (digits.length === 10) return india(digits);
  if (digits.length === 11 && digits.startsWith("0")) return india(digits.slice(1));
  if (digits.length === 12 && digits.startsWith("91")) return india(digits.slice(2));
  return "";
}

export const PHONE_INVALID = "Please enter a valid phone number.";
