// Phase 1 line 7: onboarding step 4, "Open your store". Pure and plain-Node
// (imports only the role map), so lib/onboarding/steps.js, the API, the page
// and the suite read the step the same way.
//
//   openStep(facts, role, { unreadable })  unreadable: the words of a failed read
//     -> { state, words, problem?, facts, actions }
//   facts while closed: { items, testOrderMarked, blocking? }
//     items   the home page line first, then every openingReport() item (ok
//             ones too), each with `fixes`: what the founder can do about it
//             right here, each fix already gated for the role:
//               { kind: "link", label, href, allowed, reason? }
//               { kind: "cod_on", label, allowed, reason? }        PUT settings commerce
//               { kind: "policy_start", policyKind, label, allowed, reason? }
//               { kind: "policy_read", label, docId, revision, editHref,
//                 allowed, reason?, markRead: { label, allowed, reason? } }
//               { kind: "contact_form", label, allowed, reason? } PUT settings identity
//               { kind: "test_order", marked, allowed, reason? }
//               { kind: "step", step, label, allowed: true }      go to another step
//               { kind: "support", label }                        Storeasy's team fixes it
//             and `legalNote` on a privacy or returns page not yet live
//   facts once open: { items: [], testOrderMarked, storeAddress, liveUrl }
//   actions  [{ id, allowed, reason? }] for every OPEN_ACTION_PERMS id;
//            open_store is allowed only with storefront.publish and nothing
//            blocking, and is left out when the store's state couldn't be read
//
// Settings and Billing links carry ?from=onboarding so those pages show
// "Back to onboarding". Payment keys are never taken here: "Add Razorpay keys"
// is a link to Settings.
import { roleAllows } from "../platform/authz.js";

export const READ_ONLY_REASON = "Your role can look at this but not change it.";
export const ADMIN_ONLY_REASON = "Only the owner or an admin can do this.";
export const OPEN_REASON = "Only the owner or an admin can open the store";

// The opening report's links (lib/documents/opening.js uses these).
// checkoutOff and payments are the same tab (Phase 2 line 7), so the checkout-off
// item is told apart by its block level (isCheckoutOff), never by its href alone.
export const FIX_HREFS = Object.freeze({
  billing: "/admin/billing",
  checkoutOff: "/admin/settings/checkout",
  payments: "/admin/settings/checkout",
  catalogSync: "/admin/settings/sync",
  storeProfile: "/admin/settings",
});

// The authz action behind each step 4 action (permissions stay in lib/platform/authz.js).
export const OPEN_ACTION_PERMS = Object.freeze({
  policy_start: "storefront.write",
  policy_read: "storefront.write",
  policy_view: "storefront.read",
  test_order: "settings.write",
  cod_on: "settings.write",
  contact_save: "settings.write",
  settings_link: "settings.read",
  open_store: "storefront.publish",
});
const OPEN_ACTION_IDS = Object.keys(OPEN_ACTION_PERMS);

export const OPEN_WORDS = Object.freeze({
  done: "Your store is open.",
  ready: "Nothing is stopping your store from opening. Open it here when you're ready.",
  blocked: "Before your store can open:",
  fixFirst: "Fix the items marked “Needed” first.",
  settingsReason: "Only the owner or an admin can open Settings.",
  billingReason: "Only the owner or an admin can open Billing.",
  homeTitle: "Home page",
  homeMissing: "Your store opens with its home page, and it doesn't have one yet.",
  homeOk: "Your home page goes live when your store opens.",
  homeFix: "Make your home page in step 3",
  contactMissing: "Shoppers can't reach you yet. Add a support email or phone number here.",
  checkoutOff: "Checkout is turned off, so shoppers can't pay. Turn it on to take cash on delivery. You can add Razorpay keys for cards and UPI later.",
  codOn: "Turn on checkout",
  razorpay: "Add Razorpay keys",
  openBilling: "Open Billing",
  supportFixes: "Storeasy's team fixes this.",
  readIt: "Read it",
  markRead: "I've read it",
  openInEditor: "Open in editor",
  contactForm: "Add contact details",
  openPreview: "Open your preview",
});

// The contact form's identity patch: only the fields the founder filled in,
// so a value another admin saved in Settings is kept (lib/admin/settings.js
// leaves an absent support field as it is).
export function contactIdentity(email, phone) {
  const e = String(email ?? "").trim();
  const p = String(phone ?? "").trim();
  return { ...(e ? { support_email: e } : {}), ...(p ? { support_phone: p } : {}) };
}

// One gate: { allowed: true } or { allowed: false, reason }. A role that
// can't write at all gets the read-only words.
export function gateAction(perm, role, reason = null) {
  if (roleAllows(role, perm)) return { allowed: true };
  if (!roleAllows(role, "storefront.write")) return { allowed: false, reason: READ_ONLY_REASON };
  return { allowed: false, reason: reason || (perm === "storefront.publish" ? OPEN_REASON : ADMIN_ONLY_REASON) };
}
const gate = (id, role, reason) => gateAction(OPEN_ACTION_PERMS[id], role, reason);

const isCheckoutOff = (item) => item.href === FIX_HREFS.checkoutOff && item.level === "block";

const SETTINGS = "/admin/settings";
const BILLING = "/admin/billing";
// a settings tab (/admin/settings/<tab>, Phase 2 line 7) counts as Settings
const isSettings = (href) => typeof href === "string" && (href === SETTINGS || /^\/admin\/settings[#?/]/.test(href));
const isBilling = (href) => typeof href === "string" && (href === BILLING || href.startsWith(`${BILLING}#`) || href.startsWith(`${BILLING}?`));

// "/admin/settings/checkout" -> "/admin/settings/checkout?from=onboarding"; a hash stays last
export function fromOnboarding(href) {
  const at = href.indexOf("#");
  const path = at < 0 ? href : href.slice(0, at);
  const hash = at < 0 ? "" : href.slice(at);
  return `${path}${path.includes("?") ? "&" : "?"}from=onboarding${hash}`;
}

// A link fix: Settings and Billing links are gated on settings.read and come back here.
function linkFix(href, label, role) {
  if (isSettings(href)) return { kind: "link", label, href: fromOnboarding(href), ...gate("settings_link", role, OPEN_WORDS.settingsReason) };
  if (isBilling(href)) return { kind: "link", label, href: fromOnboarding(href), ...gate("settings_link", role, OPEN_WORDS.billingReason) };
  return { kind: "link", label, href, allowed: true };
}

const support = () => ({ kind: "support", label: OPEN_WORDS.supportFixes });

function fixesFor(item, role, f) {
  if (item.who === "support") return [support()];
  const acts = Array.isArray(item.actions) ? item.actions : [];
  if (item.id === "payment") {
    if (item.level === "ok") return [];
    if (isCheckoutOff(item)) return [{ kind: "cod_on", label: OPEN_WORDS.codOn, ...gate("cod_on", role) }, linkFix(FIX_HREFS.payments, OPEN_WORDS.razorpay, role)];
    if (item.href === FIX_HREFS.payments) return [linkFix(FIX_HREFS.payments, OPEN_WORDS.razorpay, role)];
    if (item.href === FIX_HREFS.billing) return [linkFix(FIX_HREFS.billing, OPEN_WORDS.openBilling, role)];
  }
  if (item.id === "privacy" || item.id === "returns") {
    const start = acts.find((a) => a?.type === "startPolicy");
    if (start) return [{ kind: "policy_start", policyKind: start.kind, label: start.label, ...gate("policy_start", role) }];
    const read = acts.find((a) => a?.type === "markPolicyRead");
    if (read) return [{ kind: "policy_read", label: OPEN_WORDS.readIt, docId: read.id, revision: read.revision, editHref: item.href || null, ...gate("policy_view", role), markRead: { label: OPEN_WORDS.markRead, ...gate("policy_read", role) } }];
    if (item.href) return [linkFix(item.href, OPEN_WORDS.openInEditor, role)];
    return [];
  }
  if (item.id === "test_order") {
    const fixes = [];
    if (item.level !== "ok" && item.href) fixes.push(linkFix(item.href, item.linkLabel || OPEN_WORDS.openPreview, role));
    fixes.push({ kind: "test_order", marked: f.testOrderMarked === true, ...gate("test_order", role) });
    return fixes;
  }
  if (item.id === "contact") {
    if (item.level === "ok") return [];
    return [{ kind: "contact_form", label: OPEN_WORDS.contactForm, ...gate("contact_save", role) }];
  }
  if (item.level === "ok" || !item.href) return [];
  return [linkFix(item.href, item.linkLabel || "Fix this", role)];
}

function homeItem(hasHome) {
  if (hasHome === true) return { id: "home", level: "ok", title: OPEN_WORDS.homeTitle, message: OPEN_WORDS.homeOk, fixes: [] };
  return { id: "home", level: "block", title: OPEN_WORDS.homeTitle, message: OPEN_WORDS.homeMissing, fixes: [{ kind: "step", step: "brand", label: OPEN_WORDS.homeFix, allowed: true }] };
}

function shown(item, role, f) {
  // where the fix is right here, the words say so (not "in Settings")
  const own = item.id === "payment" && isCheckoutOff(item) ? OPEN_WORDS.checkoutOff : item.id === "contact" && item.level !== "ok" ? OPEN_WORDS.contactMissing : null;
  const out = { id: item.id, level: item.level, title: item.title, message: own || item.message, fixes: fixesFor(item, role, f) };
  if ((item.id === "privacy" || item.id === "returns") && item.level !== "ok") out.legalNote = true;
  return out;
}

export function openStep(f, role, { unreadable = null } = {}) {
  const testOrderMarked = f.testOrderMarked === true;
  if (f.open === true) {
    return { state: "done", words: OPEN_WORDS.done, facts: { items: [], testOrderMarked, storeAddress: f.storeAddress || null, liveUrl: f.liveUrl || null }, actions: [] };
  }
  const report = f.opening?.items ?? null;
  const all = OPEN_ACTION_IDS.map((id) => ({ id, ...gate(id, role) }));
  if (f.open === null || !report) {
    return { state: "ready", words: OPEN_WORDS.ready, problem: unreadable, facts: { items: [], testOrderMarked }, actions: all.filter((a) => a.id !== "open_store") };
  }
  const items = [homeItem(f.hasHome), ...report.map((i) => shown(i, role, f))];
  const blocking = items.filter((i) => i.level === "block");
  const actions = all.map((a) => (a.id === "open_store" && a.allowed && blocking.length ? { id: a.id, allowed: false, reason: OPEN_WORDS.fixFirst } : a));
  const facts = { items, testOrderMarked };
  if (blocking.length) {
    return { state: "blocked", words: `${OPEN_WORDS.blocked} ${blocking.map((i) => i.title).join(", ")}.`, facts: { ...facts, blocking: blocking.map((i) => ({ id: i.id, title: i.title })) }, actions };
  }
  return { state: "ready", words: OPEN_WORDS.ready, facts, actions };
}
