// Phase 8 line 2: one strict phone format, so each number has exactly one
// form (and one phone_hash for the COD code's caps). Pure and client-safe.
// Accepted: 10 Indian digits, optionally after +91, 91 or a leading 0; or an
// E.164 number (+, 8 to 15 digits, no leading 0). Spaces, dashes, dots and
// brackets are ignored. Everything else (00 prefixes, letters, a + inside,
// +91 with the wrong length) is refused: → "" .
//
// Phase 8 line 4: `country` is the shipping address's (two-letter code). For
// India the rules above. Elsewhere a number with + is E.164 as above; one
// without + takes the country's calling code (one national leading 0
// dropped), and a country not in the table must write the +, so a number
// abroad is never read as an Indian one.
const CALLING_CODES = { US: "1", CA: "1", GB: "44", IE: "353", AE: "971", SA: "966", QA: "974", KW: "965", BH: "973", OM: "968", SG: "65", MY: "60", AU: "61", NZ: "64", JP: "81", DE: "49", FR: "33", NL: "31", IT: "39", ES: "34", CH: "41", SE: "46", NP: "977", LK: "94", BD: "880", HK: "852" };
export function e164(phone, country = "IN") {
  const raw = String(phone ?? "").trim();
  if (!raw || /[^\d\s().+-]/.test(raw) || raw.indexOf("+") > 0 || (raw.match(/\+/g) || []).length > 1) return "";
  const digits = raw.replace(/\D/g, "");
  const cc = String(country || "IN").toUpperCase();
  if (cc !== "IN") {
    if (raw.startsWith("+")) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : "";
    const code = CALLING_CODES[cc];
    if (!code) return "";
    const national = digits.replace(/^0/, "");
    const full = `${code}${national}`;
    return /^[1-9]\d{7,14}$/.test(full) && national.length >= 6 ? `+${full}` : "";
  }
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
