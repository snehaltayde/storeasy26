// P4-EDITOR (ED-12, plan R3 "ED-12"): everything today's Catalog screen
// (components/admin/CatalogAdmin.js) and Upsells screen
// (components/admin/UpsellsAdmin.js) let a founder change, each mapped to the
// new editor's form control that changes it, or to a deliberate difference
// with a plain reason. Pure data and one pure function, no React, no DOM.
// docs/cms-reviews/P4-EDITOR.md and P4-FIX3.md carry the same list as a
// table, and scripts/test-product-editor.js checks that every entry resolves
// to a registered setting of its document type with a control that edits it.
//
//   PARITY[]  { screen, what, type, key, part?, control, where }
//     screen   "CatalogAdmin" | "UpsellsAdmin"
//     what     the old control, in the old screen's words
//     type     the document type that holds it now
//     key      the setting key ("sections" for a product's modules)
//     part     inside the setting (pairs: "title" | "products")
//     control  the control of the new form (ProductForm PRODUCT_CONTROLS,
//              CollectionForm COLLECTION_CONTROLS, or the settings form's
//              control for the cart)
//     where    where the founder finds it now, in plain words
//
//   NOT_CARRIED[]  { screen, what, why }  deliberate differences
//
//   OLD_FORM_CONTROLS  { [screen]: { [identifier]: what } }
//     P4-FIX3 (P4-EDITOR review): every form control the old screens render,
//     by the identifier oldFormControls() reads from the old file's source
//     (its id, else its aria-label or label as written). Each maps to a PARITY
//     entry, a NOT_CARRIED entry or NOT_A_SETTING. The parity test reads the
//     two old files and fails when a control is added to (or removed from)
//     either of them without this list being updated, so a control can't be
//     left out unnoticed.
//
//   OLD_CONTROLS  { [screen]: what[] }  derived from OLD_FORM_CONTROLS plus the
//     old screens' row actions (Delete), so it is never a second hand-written
//     list.
export const PARITY = Object.freeze([
  Object.freeze({ screen: "CatalogAdmin", what: "Badge", type: "product_content", key: "badge", control: "text", where: "Editor › a product › Badge" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Product-page modules (title and text)", type: "product_content", key: "sections", control: "modules", where: "Editor › a product › Modules on this product's page" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Pinned product handles of a collection", type: "collection_content", key: "pinned", control: "product_ids", where: "Editor › a collection › Pinned products" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Product page template", type: "product_content", key: "template", control: "layout", where: "Editor › a product › Layout" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Collection page template", type: "collection_content", key: "template", control: "layout", where: "Editor › a collection › Layout" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Pairs: title", type: "product_content", key: "pairs", part: "title", control: "pairs", where: "Editor › the source product › Goes well with: title" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Pairs: source product and target products", type: "product_content", key: "pairs", part: "products", control: "pairs", where: "Editor › the source product › Goes well with: products" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Pairs: delete", type: "product_content", key: "pairs", control: "pairs", where: "Editor › the source product › Goes well with: remove every product" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Cart slot: title", type: "cart", key: "title", control: "text", where: "Editor › Cart › Suggestions title" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Cart slot: target products", type: "cart", key: "products", control: "products", where: "Editor › Cart › Suggested products" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Cart slot: delete", type: "cart", key: "products", control: "products", where: "Editor › Cart › Suggested products: remove every product" }),
]);

// Deliberate differences, in plain words (also in the packets).
export const NOT_CARRIED = Object.freeze([
  Object.freeze({
    screen: "UpsellsAdmin",
    what: "Upsells: Position",
    why: "Upsells' Position (which of several strips shows first) is not carried: a product now has one Goes well with list.",
  }),
  Object.freeze({
    screen: "UpsellsAdmin",
    what: "Upsells: Kind",
    why: "Upsells' Kind choice is not carried: pairs live on each product, the cart's suggestions on the Cart page.",
  }),
  Object.freeze({
    screen: "UpsellsAdmin",
    what: "Pairs: Enable or Disable switch",
    why: "There is no off switch for a product's Goes well with list that keeps its products. To turn it off, remove every product: shoppers then see the automatic suggestions, as with a strip switched off before. The list you removed stays in Earlier versions, so you can bring it back.",
  }),
  Object.freeze({
    screen: "UpsellsAdmin",
    what: "Cart slot: Enable or Disable switch",
    why: "There is no off switch for the cart's suggestions that keeps its products. To turn them off, remove every suggested product on the Cart page: the cart then shows no suggestions, as with the slot switched off before. The list you removed stays in Earlier versions, so you can bring it back.",
  }),
]);

// A control that finds or picks what to edit, never a setting of its own.
export const NOT_A_SETTING = "(finds what to edit; not a setting)";

export const OLD_FORM_CONTROLS = Object.freeze({
  CatalogAdmin: Object.freeze({
    "cat-badge": "Badge",
    "Module ${i + 1} title": "Product-page modules (title and text)",
    "Module ${i + 1} HTML": "Product-page modules (title and text)",
    "Search catalog": NOT_A_SETTING,
    "cat-col-handle": NOT_A_SETTING,
    "cat-col-pins": "Pinned product handles of a collection",
  }),
  UpsellsAdmin: Object.freeze({
    "upsell-kind": "Upsells: Kind",
    "upsell-source": "Pairs: source product and target products",
    "upsell-position": "Upsells: Position",
    "upsell-targets": ["Pairs: source product and target products", "Cart slot: target products"],
    "upsell-title": ["Pairs: title", "Cart slot: title"],
    // one switch on every row: a pairs strip's and the cart slot's
    '${p.enabled ? "Disable" : "Enable"} ${rowTitle(p)}': ["Pairs: Enable or Disable switch", "Cart slot: Enable or Disable switch"],
  }),
});

// Row actions that are buttons, not form controls (the old screens' Delete).
// Page templates were chosen on the Theme screen and shown on the Catalog
// screen; the editor's Layout replaces both.
const OLD_ACTIONS = Object.freeze({
  CatalogAdmin: Object.freeze(["Product page template", "Collection page template"]),
  UpsellsAdmin: Object.freeze(["Pairs: delete", "Cart slot: delete"]),
});

const flat = (v) => (Array.isArray(v) ? v : [v]);
export const OLD_CONTROLS = Object.freeze(
  Object.fromEntries(
    Object.keys(OLD_FORM_CONTROLS).map((screen) => [
      screen,
      Object.freeze([...new Set([...Object.values(OLD_FORM_CONTROLS[screen]).flatMap(flat), ...(OLD_ACTIONS[screen] || [])])].filter((w) => w !== NOT_A_SETTING)),
    ]),
  ),
);

// The form controls an old screen's source renders, by identifier: each JSX
// <Input>, <Textarea>, <Select>, <Switch> (and lower-case input, textarea,
// select), named by its id, else its aria-label, else its label, as written
// in the source (a template literal's text without the backticks).
const CONTROL_TAG = /<(Input|Textarea|Select|Switch|input|textarea|select)(?=[\s/>])/g;
const ATTR = (name) => new RegExp(`\\s${name}=(?:"([^"]*)"|\\{\`([^\`]*)\`\\}|\\{"([^"]*)"\\})`);
// The opening tag's attributes: up to the first ">" outside braces and quotes
// (so an arrow function's "=>" inside onChange={…} never ends it).
function attrsFrom(src, at) {
  let depth = 0;
  let quote = null;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(at, i);
  }
  return src.slice(at);
}
export function oldFormControls(source) {
  const src = String(source || "");
  const out = [];
  for (const m of src.matchAll(CONTROL_TAG)) {
    const attrs = attrsFrom(src, m.index + m[0].length);
    let name = null;
    for (const a of ["id", "aria-label", "label"]) {
      const x = attrs.match(ATTR(a));
      if (x) {
        name = x[1] ?? x[2] ?? x[3];
        break;
      }
    }
    out.push(name ?? `<${m[1]}> without a name`);
  }
  return out;
}
