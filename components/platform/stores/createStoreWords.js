// Phase 1 line 9: the words of the operator's "New store" screen. Pure (no
// React, no node:*), so scripts/test-operator-create-store.js checks them.

// the order the form shows them in: founder, store, Shopify app
export const FIELD_ORDER = Object.freeze(["email", "founderName", "storeName", "slug", "shop", "app"]);

export const LABELS = Object.freeze({
  title: "New store",
  intro: "Create a store for a founder. We set it up in the background, then email them an invite to finish onboarding.",
  founderTitle: "Founder",
  founderHint: "They become the store's owner.",
  email: "Owner's email",
  emailHint: "The invite goes here.",
  founderName: "Founder's name (optional)",
  founderNameHint: "Used to greet them in the invite.",
  storeTitle: "Store",
  storeName: "Store name",
  shop: "Shopify store",
  shopPlaceholder: "their-store.myshopify.com",
  shopHint: "Their .myshopify.com address, or paste their Shopify admin's address.",
  slug: "Store address (optional)",
  slugHint: "Made from the store name unless you change it.",
  appTitle: "Shopify app (optional)",
  appHint: "Set both now and the founder can connect Shopify straight away. Leave both empty and their step 1 says Storeasy's team is preparing it.",
  clientId: "Client id",
  clientSecret: "Client secret",
  submit: "Create store",
  submitting: "Creating store…",
  summary: (address, email) => `Creates ${address}${email ? ` and emails the invite to ${email}` : ""}. The founder's Shopify store isn't changed.`,
  checking: "Checking…",
  available: "Available",
  back: "Platform operations",
  onboarding: "Signups & onboarding",
});

// Step progress, then the done screen
export const PROGRESS = Object.freeze({
  title: (name) => `Setting up ${name}`,
  working: "This takes about a minute. You can leave this page: the setup carries on, and the store's row on Signups & onboarding shows how it went.",
  failedTitle: "Setup stopped",
  tryAgain: "Try again",
  retrying: "Trying again…",
  doneTitle: (name) => `${name} is ready`,
  address: "Store address",
  invite: "Owner's invite",
  app: "Shopify app",
  redirect: "Redirect URL for the store's Shopify app",
  redirectHint: "Add this to the app's allowed redirection URLs in the Shopify Partner dashboard.",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Couldn't copy. Select the address and copy it yourself.",
  doneIntro: "The founder finishes onboarding from the invite. Nothing else is needed from you unless the app isn't set up.",
  stepWords: Object.freeze({ done: "Done", working: "In progress", failed: "Stopped", waiting: "Waiting" }),
  resend: "Resend invite",
  resending: "Sending…",
  openRow: "Open the store's row",
  another: "Create another store",
  lost: "We lost track of this setup. Open Signups & onboarding to see how it went.",
});

export const FAILURE_WORDS = Object.freeze({
  retry_exhausted: "The hosting provider kept failing, so setup stopped after five tries. Nothing is lost: press Try again.",
  needs_operator: "Setup stopped on something that needs fixing first (an alert names the step). Fix it, then press Try again.",
});
export const failureWords = (kind) => FAILURE_WORDS[kind] || FAILURE_WORDS.needs_operator;

export function inviteWords(done) {
  if (!done) return "";
  if (done.invite === "sent") return `Invite sent to ${done.inviteTo}`;
  if (done.invite === "mock") return `Invite sent to ${done.inviteTo} (local mail: nothing left this machine)`;
  return "Invite not sent. Check the mail provider, then resend it.";
}
export const inviteSent = (done) => done?.invite === "sent" || done?.invite === "mock";

export function appWords(done) {
  if (!done) return "";
  return done.appReady ? `Set up for ${done.shop}. The founder can connect Shopify from step 1.` : `Not set up yet. The founder's step 1 says Storeasy's team is preparing the connection to ${done.shop}.`;
}

// The address made from the store name, as the server makes it (lib/platform/signup.js slugFor).
export function slugPreview(storeName) {
  const s = String(storeName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : "";
}

// The first field with an error, for focus after a refused submit.
export const firstErrorField = (errors) => FIELD_ORDER.find((k) => errors?.[k]) || null;
