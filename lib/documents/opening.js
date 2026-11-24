// P6-OPEN (PUB-12, US-41, PUB-06): "Before you open your store". Node only
// (the documents console API and lib/documents/publish.js). Reads only: this
// module never writes. Rule 3c (making the slate design draft) lives in
// publish.js.
//
//   openingReport({ setIds, setItems? })
//     -> { opening, items, offer }
//   opening   true when the store has no live release yet (the set would open
//             it). On an open store the answer is { opening: false, items: [],
//             offer: null }: there is nothing to open. P6-FIX2: the same answer
//             for a set made only of product and collection content
//             (isLiveRowType) on a closed store, because publishing it opens
//             nothing (publish.js's rowsOnly rule: no home needed, no opening
//             rules run), so no caller is shown a report that does not apply.
//             An unknown id in the set counts as not live-row (the report
//             shows), as does an empty set.
//   items     EVERY item, ok ones included, in this fixed order:
//               payment, maintenance (only while it is on), privacy, returns,
//               test_order, catalog, contact, design
//             each { id, level: 'block'|'warn'|'info'|'ok', title, message,
//                    href: string|null, who: null|'support', linkLabel?,
//                    actions? }
//             linkLabel  the words of the href link ('Fix this' when absent)
//             actions    buttons the editor panel runs through its on.act:
//                        { type: 'startPolicy', kind, label }
//                        { type: 'markPolicyRead', id, revision, label }
//             Every item that is not ok has an href, who 'support', or a
//             non-empty actions list (owner answer OQ-P6-2).
//   offer     { publishSet: [...the set's items, the unpublished doc_design
//             draft when it is left out, each founder-saved policy draft of a
//             kind that is neither live nor in the set] } or null when it would
//             add nothing. Items are { id, revision, draftHash, label }, the
//             FIRST_PUBLISH_NEEDS_HOME offer's shape. A policy starter draft
//             (made by "Start a … page" and never saved by the founder) is
//             never in an offer: the system never publishes legal text the
//             founder hasn't read.
//
// The words are written here, per item, for the founder. checkoutCapability's
// `reason` (developer words) is never shown. Payment is worked out from
// checkoutMode() and billingDegraded() on their own, never from
// checkoutCapability().available, because maintenance is checked first there
// and would hide the real cause. Maintenance is its own warning.
//
// The panel that shows this is only reachable by publishers (owner or admin),
// who can open Settings and Billing, so no staff wording is needed.
import { libsql } from "../db.js";
import { currentTenant, tenantOwnCfg, tenantOwnSecret } from "../tenant-context.js";
import { checkoutMode } from "../commerce/adapter.js";
import { billingDegraded } from "../billing-state.js";
import { policyStatus, readPolicyRows } from "./policy-pages.js";
import { editorHref, EDITOR_PATH } from "../admin/editor-entry.js";
import { TEST_ORDER_CLOSED_HINT } from "../onboarding/steps.js";
import { siteSupport } from "../site.js";
import { isLiveRowType } from "../registry/document-types.js";

export const DESIGN_ID = "doc_design";
export const OPENING_ITEM_IDS = Object.freeze(["payment", "maintenance", "privacy", "returns", "test_order", "catalog", "contact", "design"]);
export const OPENING_LEVELS = Object.freeze(["block", "warn", "info", "ok"]);
export const OPENING_ACTION_TYPES = Object.freeze(["startPolicy", "markPolicyRead"]);
export const DEFAULT_LINK_LABEL = "Fix this";

// ---- the words, per item -------------------------------------------------------------------

export const WORDS = Object.freeze({
  billing: "Your Storeasy plan needs attention before shoppers can pay. Open Billing to fix it.",
  checkoutOff: "Checkout is turned off, so shoppers can't pay. Turn it on in Settings.",
  checkoutShopify: "Ask Storeasy support to turn on checkout for your store.",
  paymentOk: "Shoppers can pay online or with cash on delivery.",
  codOnly: "Add your Razorpay keys to take cards and UPI. Until then shoppers pay cash on delivery.",
  maintenance: "Your store is in maintenance, so checkout is closed, even in your preview. Ask Storeasy support to end it.",
  testOrderOk: "You placed a test order. Thank you for checking.",
  catalogEmpty: "Your store has no products yet, so shoppers will see only your home page. Add products in Shopify, then sync again.",
  contactMissing: "Shoppers can't reach you yet. Add a support email or phone number in Settings.",
  contactOk: "Shoppers can reach you through your support details.",
  designLive: "Your colours and logo go live with your store.",
  designDraft: "Your colours and logo go live too.",
  designSlate: "Your store opens with the starting colours (Slate).",
});

// privacy: "privacy page"; returns: "returns page", with what it covers said once
const POLICY_NOUN = { privacy: "privacy page", returns: "returns page" };
const POLICY_TITLE = { privacy: "Privacy page", returns: "Returns page" };
const nounOnce = (kind) => (kind === "returns" ? "returns page (your terms, returns and refunds)" : POLICY_NOUN[kind]);
export const policyWords = (kind) => ({
  ok: `Your ${nounOnce(kind)} goes live with your store.`,
  saved: `Your ${nounOnce(kind)} goes live too.`,
  starter: `We started a ${nounOnce(kind)} for you from a template. It's a starting point, not legal advice: read it, change what you need and save it before you open.`,
  missing: `Your store needs a ${nounOnce(kind)} before it opens. Start one from a template, then read it and save it.`,
  start: `Start a ${POLICY_NOUN[kind]}`,
});

const quoted = (s) => `“${s}”`;
const item = (id, level, title, message, { href = null, who = null, linkLabel, actions } = {}) => ({
  id,
  level,
  title,
  message,
  href,
  who,
  ...(linkLabel ? { linkLabel } : {}),
  ...(actions && actions.length ? { actions } : {}),
});

// ---- reads ---------------------------------------------------------------------------------

async function livePointer() {
  const r = await libsql.execute("SELECT live_release_id FROM release_state WHERE id = 1");
  const v = r.rows[0]?.live_release_id;
  return v == null ? null : String(v);
}

// The few columns an offer needs (never a draft body): Map id -> row.
async function offerRows(ids) {
  const list = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  if (!list.length) return new Map();
  const r = await libsql.execute({
    sql: `SELECT id, type, label, revision, draft_hash, published_version_id, archived_at FROM documents WHERE id IN (${list.map(() => "?").join(", ")})`,
    args: list,
  });
  return new Map(
    r.rows.map((row) => [
      String(row.id),
      {
        id: String(row.id),
        type: row.type == null ? null : String(row.type),
        label: String(row.label),
        revision: Number(row.revision),
        draftHash: String(row.draft_hash),
        publishedVersionId: row.published_version_id == null ? null : String(row.published_version_id),
        archived: row.archived_at != null,
      },
    ]),
  );
}

const offerItem = (d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash, label: d.label });

async function productCount() {
  const r = await libsql.execute("SELECT COUNT(*) AS n FROM products");
  return Number(r.rows[0]?.n ?? 0);
}

// An order placed while the store had no live release: any order (cancelled
// ones count) older than the store's first release, or any order at all when
// it has none. A store from before the orders table has none.
async function closedStoreOrder() {
  try {
    const r = await libsql.execute(
      "SELECT 1 AS hit FROM orders WHERE (SELECT MIN(created_at) FROM releases) IS NULL OR created_at < (SELECT MIN(created_at) FROM releases) LIMIT 1",
    );
    return r.rows.length > 0;
  } catch (e) {
    if (/no such table: (main\.)?orders/i.test(String(e?.message || ""))) return false;
    throw e;
  }
}

const razorpayKeys = () => Boolean(tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID") && tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET"));

// ---- the items -----------------------------------------------------------------------------

// The payment item alone (also what publish.js's always-on rule a reads).
export function paymentItem() {
  if (billingDegraded(tenantOwnCfg("billing", null, null))) return item("payment", "block", "Payments are paused", WORDS.billing, { href: "/admin/billing", linkLabel: "Open Billing" });
  const mode = checkoutMode();
  if (mode === "disabled") return item("payment", "block", "Checkout is turned off", WORDS.checkoutOff, { href: "/admin/settings#commerce", linkLabel: "Open Settings" });
  if (mode === "shopify") return item("payment", "block", "Checkout isn't on yet", WORDS.checkoutShopify, { who: "support" });
  if (razorpayKeys()) return item("payment", "ok", "Shoppers can pay", WORDS.paymentOk);
  return item("payment", "info", "Cash on delivery only", WORDS.codOnly, { href: "/admin/settings#payments", linkLabel: "Add your Razorpay keys" });
}

function maintenanceItem() {
  if (!tenantOwnCfg("maintenance", null, null)?.enabled) return null;
  return item("maintenance", "warn", "Your store is in maintenance", WORDS.maintenance, { who: "support" });
}

function policyItem(kind, s) {
  const w = policyWords(kind);
  const title = POLICY_TITLE[kind];
  if (s.state === "live" || s.state === "inSet") return item(kind, "ok", title, w.ok);
  if (s.state === "saved") return item(kind, "info", title, w.saved, { href: editorHref(s.doc.id), linkLabel: `Open ${quoted(s.doc.label)}` });
  if (s.state === "starter") {
    return item(kind, "block", title, w.starter, {
      href: editorHref(s.doc.id),
      linkLabel: "Read it",
      actions: [{ type: "markPolicyRead", id: s.doc.id, revision: s.doc.revision, label: "I've read it" }],
    });
  }
  return item(kind, "block", title, w.missing, { actions: [{ type: "startPolicy", kind, label: w.start }] });
}

function testOrderItem(placed) {
  const manual = Boolean(currentTenant()?.config?.onboarding?.manual?.test_order);
  if (placed || manual) return item("test_order", "ok", "Test order", WORDS.testOrderOk);
  return item("test_order", "warn", "No test order yet", TEST_ORDER_CLOSED_HINT, { href: EDITOR_PATH, linkLabel: "Open your preview" });
}

function catalogItem(n) {
  if (n > 0) return item("catalog", "ok", "Products", n === 1 ? "1 product is ready for shoppers." : `${n} products are ready for shoppers.`);
  return item("catalog", "warn", "No products yet", WORDS.catalogEmpty, { href: "/admin/settings#catalog-sync", linkLabel: "Open Settings" });
}

function contactItem() {
  const s = siteSupport();
  if (s.email || s.phone) return item("contact", "ok", "Contact details", WORDS.contactOk);
  return item("contact", "warn", "No contact details", WORDS.contactMissing, { href: "/admin/settings#store-profile", linkLabel: "Open Settings" });
}

// design: { state: 'live' | 'inSet' | 'draft' | 'none', doc }
export function designState(row, inSet) {
  if (!row || row.archived) return { state: "none", doc: null };
  if (row.publishedVersionId) return { state: "live", doc: row };
  if (inSet.has(row.id)) return { state: "inSet", doc: row };
  return { state: "draft", doc: row };
}

function designItem(d) {
  if (d.state === "live" || d.state === "inSet") return item("design", "ok", "Colours and logo", WORDS.designLive);
  if (d.state === "draft") return item("design", "info", "Colours and logo", WORDS.designDraft, { href: editorHref(DESIGN_ID), linkLabel: "See your colours" });
  return item("design", "info", "Colours and logo", WORDS.designSlate, { href: editorHref(DESIGN_ID), linkLabel: "Choose your colours" });
}

// ---- the report ----------------------------------------------------------------------------

// setItems: the set's own offer items ({ id, revision, draftHash, label }),
// when the caller has them (publish.js); otherwise they are read.
export async function openingReport({ setIds = [], setItems = null } = {}) {
  return (await openingState({ setIds, setItems })).report;
}

// The report plus what publish.js's rules need: { report, design, policies }
//   design    designState(): { state: 'live'|'inSet'|'draft'|'none', doc }
//   policies  policyStatus(): { privacy: { state, doc }, returns: { state, doc } }
// On an open store, and for a set of live-row documents only (read here when
// setItems is not given: publish.js, which gives setItems, never asks for
// such a set), design and policies are null.
export async function openingState({ setIds = [], setItems = null } = {}) {
  const ids = (Array.isArray(setIds) ? setIds : []).filter((x) => typeof x === "string" && x);
  if ((await livePointer()) != null) return { report: { opening: false, items: [], offer: null }, design: null, policies: null };
  const inSet = new Set(ids);

  const [policyRows, rows, products, placed] = await Promise.all([readPolicyRows(), offerRows([...(setItems ? [] : ids), DESIGN_ID]), productCount(), closedStoreOrder()]);
  // P6-FIX2: product and collection content alone opens nothing
  if (!setItems && ids.length && ids.every((id) => isLiveRowType(rows.get(id)?.type))) return { report: { opening: false, items: [], offer: null }, design: null, policies: null };
  const policies = policyStatus(policyRows, ids);
  const design = designState(rows.get(DESIGN_ID), inSet);

  const items = [
    paymentItem(),
    maintenanceItem(),
    policyItem("privacy", policies.privacy),
    policyItem("returns", policies.returns),
    testOrderItem(placed),
    catalogItem(products),
    contactItem(),
    designItem(design),
  ].filter(Boolean);

  // the offer: the set, plus the design draft and the founder-saved policy drafts
  const set = setItems ? setItems.map(offerItem) : ids.map((id) => rows.get(id)).filter((d) => d && !d.archived).map(offerItem);
  const add = [];
  if (design.state === "draft") add.push(offerItem(design.doc));
  for (const kind of ["privacy", "returns"]) {
    const s = policies[kind];
    if (s.state === "saved" && !add.some((a) => a.id === s.doc.id)) add.push(offerItem(s.doc));
  }
  const offer = add.length ? { publishSet: [...set, ...add] } : null;
  return { report: { opening: true, items, offer }, design, policies };
}
