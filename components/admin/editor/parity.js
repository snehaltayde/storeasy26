// P4-EDITOR (ED-12, plan R3 "ED-12"): everything today's Catalog screen
// (components/admin/CatalogAdmin.js) and Upsells screen
// (components/admin/UpsellsAdmin.js) let a founder change, each mapped to the
// new editor's form control that changes it. Pure data, no React.
// docs/cms-reviews/P4-EDITOR.md carries the same list as a checked table, and
// scripts/test-product-editor.js checks that every entry resolves to a
// registered setting of its document type with a control that edits it.
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
export const PARITY = Object.freeze([
  Object.freeze({ screen: "CatalogAdmin", what: "Badge", type: "product_content", key: "badge", control: "text", where: "Editor › a product › Badge" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Product-page modules (title and text)", type: "product_content", key: "sections", control: "modules", where: "Editor › a product › Modules on this product's page" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Pinned product handles of a collection", type: "collection_content", key: "pinned", control: "product_ids", where: "Editor › a collection › Pinned products" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Product page template", type: "product_content", key: "template", control: "layout", where: "Editor › a product › Layout" }),
  Object.freeze({ screen: "CatalogAdmin", what: "Collection page template", type: "collection_content", key: "template", control: "layout", where: "Editor › a collection › Layout" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Pairs: title", type: "product_content", key: "pairs", part: "title", control: "pairs", where: "Editor › the source product › Goes well with: title" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Pairs: source product and target products", type: "product_content", key: "pairs", part: "products", control: "pairs", where: "Editor › the source product › Goes well with: products" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Pairs: switch off or delete", type: "product_content", key: "pairs", control: "pairs", where: "Editor › the source product › Goes well with: remove every product" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Cart slot: title", type: "cart", key: "title", control: "text", where: "Editor › Cart › Suggestions title" }),
  Object.freeze({ screen: "UpsellsAdmin", what: "Cart slot: target products", type: "cart", key: "products", control: "products", where: "Editor › Cart › Suggested products" }),
]);

// What the old screens offered, by screen, so the test can check none is left
// out: CatalogAdmin's form fields and UpsellsAdmin's.
export const OLD_CONTROLS = Object.freeze({
  CatalogAdmin: Object.freeze(["Badge", "Product-page modules (title and text)", "Pinned product handles of a collection", "Product page template", "Collection page template"]),
  UpsellsAdmin: Object.freeze(["Pairs: title", "Pairs: source product and target products", "Pairs: switch off or delete", "Cart slot: title", "Cart slot: target products"]),
});

// Deliberate differences, in plain words (also in the packet).
export const NOT_CARRIED = Object.freeze([
  "Upsells' Position (which of several strips shows first): a product now has one Goes well with list.",
  "Upsells' Kind choice: pairs live on each product, the cart slot on the Cart page.",
]);
