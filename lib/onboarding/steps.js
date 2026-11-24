// Phase 1 line 3: the four onboarding steps, worked out from real store
// state. Pure and plain-Node (no imports beyond the role map), so the API, the
// console layout, the operator console and the suite read the steps the same
// way. Nothing here is stored: the step a founder is on is derived every time.
//
//   deriveSteps(facts, role)
//     -> { supported, open, openKnown, current, doneCount, total: 4,
//          steps: [{ id, label, state, words, blockedBy?, problem?, facts, actions }] }
//   openKnown  false when the live release could not be read: no nudge, no badge
//   a store still on the old editor (cmsMode "legacy", which nothing sets since
//   tenant migration 0026) is supported: false with reason "legacy" and words
//   LEGACY_WORDS: it has no steps here and /admin never sends it to them.
//   pollsWhile(model)  the page re-reads while products are coming in (only)
//   state      "done" | "in_progress" | "ready" | "blocked"
//   blockedBy  a step id, or "updating" (the store is moving to the new editor)
//   problem    plain words when something needs the founder (a failed sync),
//              or UNREADABLE when a read failed: that step is never done on a guess
//   actions    [{ id, allowed, reason? }]: what the role may press (lib/platform/authz.js)
//
// facts (lib/onboarding/service.js reads them; null means the read failed):
//   supported       false for the _default store (environment config)
//   shopDomain      the recorded Shopify domain or null
//   linked          the store has Shopify keys (null: unreadable)
//   connection      lib/onboarding/connect.js connectFacts (line 4): appReady,
//                   tokenHeld, uninstalledAt, reauthNeededAt, missingScopes,
//                   locked; absent or null reads as not connected
//   sync            { hasComplete, anyRun, products, view } | null
//   cmsMode         "legacy" | "migrating" | "documents" | … | null
//   brandRecorded   the brand step was saved or skipped
//   designBranded   the design has a brand or theme of its own (null: unreadable)
//   hasHome         doc_home exists (null: unreadable)
//   open            a live release exists (null: unreadable)
//   opening         openingReport() ({ items }) | null
//   testOrderMarked config.onboarding.manual.test_order is set
//   storeAddress, liveUrl  the store's address and its live home link (step 4's done state)
import { roleAllows } from "../platform/authz.js";
import { OPEN_ACTION_PERMS, OPEN_WORDS, READ_ONLY_REASON, ADMIN_ONLY_REASON, OPEN_REASON, gateAction, openStep } from "./open-step.js";

export const STEP_IDS = Object.freeze(["connect", "import", "brand", "open"]);
export const STEP_LABELS = Object.freeze({
  connect: "Connect Shopify",
  import: "Import products",
  brand: "Brand",
  open: "Open your store",
});
export const STEP_STATES = Object.freeze(["done", "in_progress", "ready", "blocked"]);

export const UNREADABLE = "We couldn't check this just now. Reload this page to try again.";
export const TEST_ORDER_CLOSED_HINT = "Your store is private, so place it from the editor's preview: add a product to the cart and pay cash on delivery. Cancel it after.";

export const LEGACY_WORDS = "This store uses the old editor, so there are no onboarding steps here. Contact Storeasy support to move it to the new editor.";

export { READ_ONLY_REASON, ADMIN_ONLY_REASON, OPEN_REASON };

export const WORDS = Object.freeze({
  connect: {
    done: "Your Shopify store is connected. Storeasy reads your products from it and never changes anything there.",
    in_progress: "Storeasy's team is preparing your Shopify connection.",
    ready: "Enter your Shopify store's address, then connect it. Storeasy reads your products from it and never changes anything in Shopify.",
    readyToConnect: "Press Connect and approve Storeasy in Shopify. Storeasy reads your products and never changes anything in Shopify.",
    reconnect: "Connect again",
  },
  import: {
    done: "Your products are in.",
    in_progress: "Your products are coming in from Shopify. You can keep using the console.",
    ready: "Bring in your products and collections from Shopify. It takes a few minutes for most stores.",
    blockedConnect: "This starts once your Shopify store is connected.",
    blockedUpdating: "Your store is being updated, so bringing in products is paused. It carries on by itself once the update is done.",
    noProducts: "Your Shopify store has no products yet. Add products in Shopify, then bring them in again.",
  },
  brand: {
    done: "Your colours, logo and first home page are ready. Change anything from the editor.",
    in_progress: "You're part way there: pick your colours and logo, and see the first version of your store.",
    ready: "See the first version of your store, made from your products, then pick your colours and logo.",
    blocked: "Your store is being updated. Come back in a few minutes.",
  },
  open: OPEN_WORDS,
});

const STEP_QUERY = new Set(STEP_IDS);
// ?step=<id> → the id, or null when missing or unknown (an unknown step is ignored).
export const parseStep = (q) => (typeof q === "string" && STEP_QUERY.has(q) ? q : null);

// Which step the page opens on: ?step when it is a real step, else `current`.
export const resumeStep = (q, model) => parseStep(q) ?? model?.current ?? STEP_IDS[0];

// The authz action behind each step action. Permissions stay in lib/platform/authz.js.
export const ACTION_PERMS = Object.freeze({
  start_sync: "sync.run",
  retry_sync: "sync.run",
  starter_store: "storefront.write",
  brand_save: "storefront.write",
  brand_skip: "storefront.write",
  brand_description: "settings.write",
  connect_shopify: "settings.write",
  ...OPEN_ACTION_PERMS,
});

const action = (id, role) => ({ id, ...gateAction(ACTION_PERMS[id], role) });

const ACTIVE = new Set(["running", "retrying"]);
const PROBLEM = new Set(["failed", "stalled"]);

// The page's 10 s re-read runs only while a sync is running or retrying (the
// Import step in progress); a connect or brand step in progress waits for the
// founder or an operator, so nothing is polled for it.
export function pollsWhile(model) {
  const s = model?.steps?.find((x) => x.id === "import");
  return s?.state === "in_progress" && ACTIVE.has(s.facts?.sync?.state);
}

// Line 4: done = a token held and not uninstalled, or a sync completed, or
// products exist (client credentials alone no longer count); in progress = a
// domain recorded but the store's Shopify app not set up yet. A broken link
// (uninstalled, Shopify asked to connect again, missing scopes) keeps the
// step's state and says so in `problem`, with reconnect in the facts.
const CONNECT_PROBLEM = {
  uninstalled: "Storeasy's app was removed from your Shopify store, so products stop updating. Connect again to fix it.",
  reauth: "Shopify asked Storeasy to connect again, so products stop updating. Connect again to fix it.",
  scopes: "Shopify didn't give Storeasy every permission it needs. Connect again and approve them all.",
};
function connectStep(f, role) {
  const sync = f.sync;
  const c = f.connection || {};
  const tokenOk = c.tokenHeld === true && !c.uninstalledAt;
  const why = c.uninstalledAt ? "uninstalled" : c.reauthNeededAt ? "reauth" : c.tokenHeld && c.missingScopes?.length ? "scopes" : null;
  const facts = { connected: tokenOk, appReady: c.appReady === true, reconnect: Boolean(why) };
  if (roleAllows(role, "settings.read")) Object.assign(facts, { shopDomain: f.shopDomain || null, locked: c.locked === true });
  const actions = [action("connect_shopify", role)];
  const problem = why ? { problem: CONNECT_PROBLEM[why] } : {};
  const done = tokenOk || sync?.hasComplete === true || (sync?.products ?? 0) > 0;
  if (done) return { state: "done", words: WORDS.connect.done, ...problem, facts, actions };
  if (sync === null) return { state: "ready", words: WORDS.connect.ready, problem: UNREADABLE, facts, actions };
  if (f.shopDomain && !facts.appReady) return { state: "in_progress", words: WORDS.connect.in_progress, ...problem, facts, actions };
  if (f.shopDomain) return { state: "ready", words: WORDS.connect.readyToConnect, ...problem, facts, actions };
  return { state: "ready", words: WORDS.connect.ready, ...problem, facts, actions };
}

function importStep(f, role, connectDone) {
  const sync = f.sync;
  if (!sync) return { state: "ready", words: WORDS.import.ready, problem: UNREADABLE, facts: { sync: null, products: null }, actions: [] };
  const view = sync.view || null;
  const facts = { sync: view, products: sync.products };
  const done = sync.hasComplete || (!sync.anyRun && sync.products > 0);
  if (done) {
    const words = sync.products > 0 ? WORDS.import.done : WORDS.import.noProducts;
    return { state: "done", words, facts, actions: view?.canStart ? [action("start_sync", role)] : [] };
  }
  if (view && ACTIVE.has(view.state)) return { state: "in_progress", words: WORDS.import.in_progress, facts, actions: view.canRetry ? [action("retry_sync", role)] : [] };
  if (f.cmsMode === "migrating") return { state: "blocked", blockedBy: "updating", words: WORDS.import.blockedUpdating, facts, actions: [] };
  if (!connectDone) return { state: "blocked", blockedBy: "connect", words: WORDS.import.blockedConnect, facts, actions: [] };
  if (view && PROBLEM.has(view.state)) return { state: "ready", words: WORDS.import.ready, problem: view.message || view.detail || UNREADABLE, facts, actions: [action("retry_sync", role)] };
  return { state: "ready", words: WORDS.import.ready, facts, actions: [action("start_sync", role)] };
}

function brandStep(f, role) {
  const recorded = f.brandRecorded === true || f.designBranded === true;
  const facts = { brandRecorded: recorded, hasHome: f.hasHome === true };
  const actions = ["starter_store", "brand_save", "brand_skip", "brand_description"].map((id) => action(id, role));
  if (recorded && f.hasHome === true) return { state: "done", words: WORDS.brand.done, facts, actions };
  if (f.cmsMode === null) return { state: "ready", words: WORDS.brand.ready, problem: UNREADABLE, facts, actions: [] };
  if (f.cmsMode !== "documents") return { state: "blocked", blockedBy: "updating", words: WORDS.brand.blocked, facts, actions: [] };
  // a read that failed never counts towards "done", and is said
  const unread = f.hasHome === null || (f.designBranded === null && !recorded);
  if (recorded || f.hasHome === true) return { state: "in_progress", words: WORDS.brand.in_progress, ...(unread ? { problem: UNREADABLE } : {}), facts, actions };
  return { state: "ready", words: WORDS.brand.ready, ...(unread ? { problem: UNREADABLE } : {}), facts, actions };
}

export function deriveSteps(facts, role) {
  const f = facts || {};
  const openKnown = f.open === true || f.open === false;
  const none = { supported: false, open: f.open === true, openKnown, current: null, doneCount: 0, total: STEP_IDS.length, steps: [] };
  if (f.supported === false) return none;
  if (f.cmsMode === "legacy") return { ...none, reason: "legacy", words: LEGACY_WORDS };

  let steps;
  if (f.open === true) {
    // An open store has every step done, whatever else reads.
    const connect = connectStep(f, role);
    steps = [
      { id: "connect", state: "done", words: WORDS.connect.done, facts: connect.facts, actions: [] },
      { id: "import", ...importStep(f, role, true), state: "done", words: WORDS.import.done },
      { id: "brand", ...brandStep(f, role), state: "done", words: WORDS.brand.done },
      { id: "open", ...openStep(f, role) },
    ].map(({ problem, blockedBy, ...s }) => s);
  } else {
    const connect = connectStep(f, role);
    steps = [
      { id: "connect", ...connect },
      { id: "import", ...importStep(f, role, connect.state === "done") },
      { id: "brand", ...brandStep(f, role) },
      { id: "open", ...openStep(f, role, { unreadable: UNREADABLE }) },
    ];
  }
  steps = steps.map((s) => ({ id: s.id, label: STEP_LABELS[s.id], ...s }));
  const doneCount = steps.filter((s) => s.state === "done").length;
  const current = steps.find((s) => s.state !== "done")?.id ?? "open";
  return { supported: true, open: f.open === true, openKnown, current, doneCount, total: STEP_IDS.length, steps };
}
