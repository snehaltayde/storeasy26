"use client";

// P4-PICKER (ED-12, OVL-04): the pairs kind ("Goes well with" on a product):
// { title, products: [Shopify product ids] }, or null for none.
//   title     the heading shoppers see above these products; empty means the
//             default heading, "Pairs well with"
//   products  an ordered list, picked through the catalog picker
//             (ProductPicks: effective titles, Shopify's title under them)
// Props are the inspector's (controls.js). Keyboard: the title is a labelled
// text box and every row action is a button.
import { Input } from "../../../console/fields.js";
import { Notes } from "./controls.js";
import { ProductPicks, picksPaths } from "./ProductListControl.js";
import { idOf, notesId, notesAt, blocks } from "./inspectorModel.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const DEFAULT_PAIRS_TITLE = "Pairs well with";

// The stored value after an edit: null when there is no title and no
// product, an empty title stored as null (the default heading).
export function pairsValue(title, products) {
  const t = typeof title === "string" && title.trim() ? title : null;
  const p = Array.isArray(products) ? products : [];
  return t == null && p.length === 0 ? null : { title: t, products: p };
}

export default function PairsControl({ field, value, onChange, issues, owner = null, context = {}, readOnly = false }) {
  const v = isObj(value) ? value : {};
  const products = Array.isArray(v.products) ? v.products : [];
  const title = typeof v.title === "string" ? v.title : "";
  const id = idOf(owner, field.path);
  const tid = idOf(owner, `${field.path}.title`);
  const tnotes = notesAt(issues, tid);
  return (
    <div id={id} role="group" tabIndex={-1} aria-label={field.label} aria-describedby={notesAt(issues, id).length ? notesId(id) : undefined} className="min-w-0 space-y-2 focus-ring" data-pairs-control="">
      <div className="min-w-0">
        <label htmlFor={tid} className="mb-1 block text-xs font-medium text-fg-muted">
          {`${field.label}: title above these products`}
        </label>
        <Input
          id={tid}
          value={title}
          placeholder={DEFAULT_PAIRS_TITLE}
          disabled={readOnly}
          invalid={blocks(tnotes)}
          aria-describedby={[`${tid}--hint`, tnotes.length ? notesId(tid) : null].filter(Boolean).join(" ")}
          onChange={(e) => onChange(pairsValue(e.target.value, products))}
        />
        <p id={`${tid}--hint`} className="mt-1 text-xs text-fg-subtle">{`Leave it empty to use “${DEFAULT_PAIRS_TITLE}”.`}</p>
        <Notes anchor={tid} notes={tnotes} />
      </div>
      <ProductPicks
        id={idOf(owner, `${field.path}.products`)}
        owner={owner}
        path={`${field.path}.products`}
        label={`${field.label}: products`}
        ids={products}
        onChange={(ids) => onChange(pairsValue(title, ids))}
        issues={issues}
        context={context}
        readOnly={readOnly}
        max={field.setting?.max ?? null}
        hint="Shown on this product's page, in this order."
      />
      <Notes anchor={id} notes={notesAt(issues, id)} />
    </div>
  );
}
PairsControl.paths = (field, value) => [field.path, `${field.path}.title`, ...picksPaths(`${field.path}.products`, isObj(value) ? value.products : [])];
