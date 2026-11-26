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

// What the checkout boxes show (components/checkout/WhatsAppConsent.js), pure:
//   live      the stored state { updates, marketing, phone (masked) }
//   number    the phone typed now in its E.164 form ("" when empty or invalid)
//   syncedFor the number the server last matched (null before any)
//   stale     a save or sync failed
// A box shows the stored consent whenever the typed number isn't matched yet
// (empty after a reload, being typed, or a failed sync), with the number it
// covers; it can be ticked only with a valid number, unticked at any time.
export function consentBoxes({ live = {}, number = "", syncedFor = null, stale = false } = {}) {
  const any = Boolean(live.updates || live.marketing);
  const matched = Boolean(number) && syncedFor === number && !stale;
  return {
    boxes: Object.fromEntries(PURPOSES.map((p) => [p, { checked: Boolean(live[p]), disabled: !number && !live[p] }])),
    savedFor: any && !matched && live.phone ? live.phone : null,
    needPhone: !number && !any,
  };
}
