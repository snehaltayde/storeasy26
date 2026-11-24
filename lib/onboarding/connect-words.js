// Phase 1 line 4: what step 1 says when connecting Shopify didn't finish, and
// the panel's fixed words. Pure (no imports): the server, the panel and the
// suites read the same words.
//   connectErrorWords(code) → plain words for ?connect_error=<code>; an
//   unknown code gets the general message.
export const CONNECT_ERROR_CODES = Object.freeze(["denied", "expired", "mismatch", "hmac", "wrong_shop", "other_store", "no_app", "token_failed", "suspended"]);

export const CONNECT_ERROR_WORDS = Object.freeze({
  denied: "Shopify didn't give Storeasy access, so nothing was connected.",
  expired: "That connection took too long, so it was stopped. Press Connect to start again.",
  mismatch: "That connection was started somewhere else (another sign-in, browser or store), so it was stopped. Press Connect to start again from here.",
  hmac: "Shopify's answer couldn't be checked, so nothing was connected. Press Connect to try again.",
  wrong_shop: "You approved a different Shopify store from the one recorded here, so nothing was connected. Sign in to the right store in Shopify, then press Connect again.",
  other_store: "Another Storeasy store is already connected to this Shopify store. Contact Storeasy support.",
  no_app: "Storeasy's team is still preparing your Shopify connection. Try again once they tell you it's ready.",
  token_failed: "Shopify didn't finish the connection. Press Connect to try again.",
  suspended: "This store is paused, so it can't be connected. Contact Storeasy support.",
});
export const CONNECT_GENERAL_WORDS = "Connecting Shopify didn't work, so nothing changed. Press Connect to try again.";
export const DENIED_HINT = "Didn't finish in Shopify? Press Connect again.";

export const connectErrorWords = (code) => (Object.hasOwn(CONNECT_ERROR_WORDS, code) ? CONNECT_ERROR_WORDS[code] : CONNECT_GENERAL_WORDS);

export const CONNECT_WORDS = Object.freeze({
  appNotReady: "Storeasy's team is preparing your Shopify connection.",
  locked: "Wrong store? Contact Storeasy support",
  shopLabel: "Your Shopify store's address",
  shopPlaceholder: "your-store.myshopify.com",
  shopHint: "The address that ends in .myshopify.com. Your own domain (like yourbrand.com) won't work here; pasting your Shopify admin's address will.",
  noDomain: "No Shopify store recorded yet.",
  preparingSave: "Storeasy's team is preparing your Shopify connection. Save your address and there's nothing else for you to do.",
  preparingWait: "Connect turns on here once it's ready. There's nothing for you to do.",
  connectHint: "Shopify asks you to approve Storeasy, then brings you back here.",
  connectedBadge: "Connected",
  save: "Save address",
  connect: "Connect to Shopify",
  reconnect: "Connect again",
  connected: "Connected. Your products are coming in.",
  connectedNote: "Shopify connected. Your products are coming in now.",
  uninstalled: "Storeasy's app was removed from your Shopify store, so products stop updating. Connect again to fix it.",
  reauth: "Shopify asked Storeasy to connect again, so products stop updating. Connect again to fix it.",
  missingScopes: "Shopify didn't give Storeasy every permission it needs. Connect again and approve them all.",
  otherStoreAtStart: "Another Storeasy store is already connected to this Shopify store. Contact Storeasy support.",
});
