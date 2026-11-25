// Phase 8 step 0: the checkout form as pure functions, so the address step,
// the pincode lookup (line 1) and saved addresses (line 3) all change the form
// the same way. No React, no imports: unit-tested in scripts/test-checkout-model.js.

export const ADDRESS_KEYS = ["email", "phone", "name", "line1", "line2", "city", "state", "pincode"];

// Where a change came from: the shopper typing, a pincode lookup, or a saved address.
export const ADDRESS_SOURCES = ["typed", "pincode", "saved"];

export function emptyForm() {
  return {
    email: "",
    phone: "",
    name: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    pincode: "",
  };
}

// A new form with `patch` applied. Only the form's own keys are taken, and
// values become strings; an unknown `source` is refused so a caller can't
// slip past the rules later lines attach to it.
export function applyAddress(form, patch, source) {
  if (!ADDRESS_SOURCES.includes(source)) throw new Error(`applyAddress: unknown source "${source}"`);
  const next = { ...form };
  for (const k of ADDRESS_KEYS) {
    if (patch && Object.hasOwn(patch, k)) next[k] = patch[k] == null ? "" : String(patch[k]);
  }
  return next;
}

export function addressValid(form) {
  return (
    form.email.includes("@") &&
    form.phone.trim().length >= 7 &&
    ["name", "line1", "city", "state", "pincode"].every((k) => form[k].trim())
  );
}

// Phase 8 line 1: what a pincode lookup may write. City and state are filled
// only when they are empty or still hold the lookup's own earlier values
// (`filled`, the { city, state } it last wrote); a value the shopper typed or
// picked is never overwritten. → a patch for applyAddress(form, patch, "pincode").
export function pincodePatch(form, place, filled = {}) {
  const patch = {};
  if (!place) return patch;
  for (const k of ["city", "state"]) {
    const now = form[k].trim();
    if (place[k] && (!now || (filled[k] && now === filled[k]))) patch[k] = place[k];
  }
  return patch;
}

// Has the shopper started an address of their own? Judged on the street lines
// only: a PIN, and the city and state its lookup filled (an sf_pin prefill can
// land before the saved-address picker loads), are not an address yet, so the
// picker may still fill the saved default (Phase 8 lines 1 and 3).
export function addressStarted(form) {
  return ["line1", "line2"].some((k) => String(form?.[k] ?? "").trim() !== "");
}
