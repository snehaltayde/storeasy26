// Phase 8 line 3: what SavedAddressPicker remembers between its own mounts
// (the address step closes on Continue and comes back on Edit). Pure, so
// scripts/test-addresses.js runs it with a fake sessionStorage.
//   - The shopper cache holds only whether they're signed in, the memo's key
//     and the cart's fingerprint: never an address. It is forgotten when the checkout is left or the
//     shopper is found signed out.
//   - The memo (sessionStorage, per cart) holds the Save tick and the id of the
//     address this checkout saved, with the cart's fingerprint. A fresh
//     checkout (nothing cached at mount) starts it again, and a savedId from a
//     different cart (the cart id outlives an order) is never used, so an
//     earlier order's address is never overwritten.

let known = null;
export const knownShopper = () => known;
export const rememberShopper = ({ signedIn, memo, fp }) => {
  known = { signedIn: Boolean(signedIn), memo: memo || null, fp: fp ?? null };
};
export const forgetShopper = () => {
  known = null;
};

export const memoKey = (cartId) => `sf_saved_address:${cartId || "cart"}`;

// The cart's lines and total: a new order on the same cart id differs.
export const cartFingerprint = (cart) =>
  [...(cart?.items || []).map((i) => `${i.variantId}x${i.quantity}`).sort(), `t${Number(cart?.total ?? 0)}`].join(",");

const store = (s) => s ?? globalThis.sessionStorage;
export function readMemo(k, storage) {
  try {
    return JSON.parse(store(storage).getItem(k) || "null") || {};
  } catch {
    return {};
  }
}
export function writeMemo(k, patch, storage) {
  try {
    store(storage).setItem(k, JSON.stringify({ ...readMemo(k, storage), ...patch }));
  } catch {
    // private mode: nothing is remembered
  }
}
export function startMemo(k, storage) {
  try {
    store(storage).removeItem(k);
  } catch {
    // private mode
  }
}

// The address this checkout saved, only for the cart it was saved with.
export const savedIdFor = (memo, fingerprint) => (memo?.savedId && memo.fp === fingerprint ? memo.savedId : null);
