"use client";

// P4-EDITOR (ED-12): one collection's content.
//
//   <CollectionForm body entity readOnly issues context on />
//     body      the draft (collection_content: { settings: { pinned, template } })
//     entity    { inShopify, shopify { title, handle }, shopifyAdminUrl }
//     on.edit({ path, value })
//
// What it shows: the collection's name (Shopify's: a collection has no name
// of its own here), its pinned products (ProductListControl: shown first on
// the collection page, in this order; null for none) and its layout (the
// store's layout, or one of the declared ones). The collection's products,
// name and order rules stay Shopify's, with "Change in Shopify".
import { ExternalLink } from "lucide-react";
import ProductListControl from "./fields/ProductListControl.js";
import { Notes } from "./fields/controls.js";
import { LayoutSelect } from "./ProductForm.js";
import { fieldsOf, idOf, issuesOf, notesAt, notesId, placeIssues, orphanAnchors } from "./fields/inspectorModel.js";
import { PRODUCT_WORDS } from "./editorModel.js";
import { documentType } from "@/lib/registry/index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TYPE = "collection_content";

export const collectionFields = () => fieldsOf(documentType(TYPE)?.settings || [], null);
export const COLLECTION_CONTROLS = Object.freeze({ pinned: "product_ids", template: "layout" });

export const COLLECTION_WORDS = Object.freeze({
  shopifyOwns: "The collection's name, its products and its order rules come from Shopify. Change them in Shopify.",
  gone: "This collection isn't in your Shopify catalog any more, so shoppers can't see it.",
});

export default function CollectionForm({ body, entity = null, readOnly = null, issues = [], context = {}, on = {} }) {
  const settings = isObj(body) && isObj(body.settings) ? body.settings : {};
  const fields = collectionFields();
  const f = (k) => fields.find((x) => x.key === k);
  const e = isObj(entity) ? entity : {};
  const inShopify = e.inShopify !== false;
  const known = new Set([idOf(null, "template"), ...ProductListControl.paths(f("pinned"), settings.pinned ?? null).map((p) => idOf(null, p))]);
  const placed = placeIssues(issuesOf(issues, null), known);
  const leftover = orphanAnchors(placed, known);
  const name = isObj(e.shopify) ? e.shopify.title : null;
  return (
    <div className="space-y-5" data-collection-form="">
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-fg">{name || "Collection"}</h3>
        {name && <p className="text-xs text-fg-muted">{PRODUCT_WORDS.shopifyTitle(name)}</p>}
        {!inShopify && <p className="rounded-ctl border border-warning-edge bg-warning-bg px-3 py-2 text-xs text-fg">{COLLECTION_WORDS.gone}</p>}
        {readOnly && <p className="rounded-ctl bg-surface-sunken px-3 py-2 text-xs text-fg-muted" data-read-only="">{readOnly}</p>}
      </header>
      {leftover.map((a) => (
        <div key={a} id={a} tabIndex={-1} aria-describedby={notesId(a)}>
          <Notes anchor={a} notes={notesAt(placed, a)} />
        </div>
      ))}
      <ProductListControl field={f("pinned")} value={settings.pinned ?? null} onChange={(v) => on.edit?.({ path: "pinned", value: v })} issues={placed} owner={null} context={context} readOnly={Boolean(readOnly)} />
      <LayoutSelect id={idOf(null, "template")} ownerKey="collection_layout" setting={f("template")?.setting} value={settings.template ?? null} onChange={(v) => on.edit?.({ path: "template", value: v })} readOnly={Boolean(readOnly)} notes={notesAt(placed, idOf(null, "template"))} />
      <section aria-label="From Shopify" className="space-y-1 rounded-ctl bg-surface-sunken px-3.5 py-3 text-xs text-fg-muted" data-shopify-owned="">
        <p className="text-fg">{COLLECTION_WORDS.shopifyOwns}</p>
        {e.shopifyAdminUrl ? (
          <a href={e.shopifyAdminUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-fg underline-offset-2 hover:underline focus-ring" data-change-in-shopify="">
            {PRODUCT_WORDS.changeInShopify} <ExternalLink size={12} aria-hidden />
          </a>
        ) : (
          <p>{PRODUCT_WORDS.noAdminLink}</p>
        )}
      </section>
    </div>
  );
}
