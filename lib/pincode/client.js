// Phase 8 line 1: the browser side of /api/pincode, shared by the checkout's
// PIN field and the product page's "Check delivery". Edge- and client-safe.
export const PIN_KEY = "sf_pin";
export const PIN_RE = /^[1-9]\d{5}$/;
export const BAD_PIN = "Enter a 6-digit PIN code.";
export const NOT_FOUND = "We couldn't find that PIN code. Check it, or type your city and state.";

// → { found, city, state, estimate, cod, freeThreshold, timeZone } | { error }
// found: true, false (show NOT_FOUND) or null (unknown: say nothing)
export async function lookupPin(pin, { signal } = {}) {
  try {
    const res = await fetch(`/api/pincode?pin=${encodeURIComponent(pin)}`, { signal, cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (res.status === 400) return { error: BAD_PIN };
    if (!res.ok || !body) return { found: null, estimate: null };
    return body;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return { found: null, estimate: null };
  }
}

// localStorage can throw (private mode, blocked storage): never let it break a page.
export function savedPin() {
  try {
    const v = window.localStorage.getItem(PIN_KEY);
    return v && PIN_RE.test(v) ? v : "";
  } catch {
    return "";
  }
}
export function savePin(pin) {
  try {
    if (PIN_RE.test(pin)) window.localStorage.setItem(PIN_KEY, pin);
  } catch {
    // ignore
  }
}
