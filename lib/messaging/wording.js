// Phase 9 line 3: the exact words a shopper agrees to for WhatsApp, one
// version per purpose. Pure and client-safe: the checkout box and the account
// toggle show these words, and the server records the same words (and their
// version) on each consent row. Changing a sentence means a new version.
//   updates    order updates (transactional class, still an explicit opt-in)
//   marketing  offers and cart reminders (marketing class)
export const CONSENT_WORDING = Object.freeze({
  updates: Object.freeze({ version: 1, text: "Send my order updates on WhatsApp" }),
  marketing: Object.freeze({ version: 1, text: "Also send me offers and cart reminders on WhatsApp" }),
});
export const PURPOSES = Object.freeze(Object.keys(CONSENT_WORDING));
