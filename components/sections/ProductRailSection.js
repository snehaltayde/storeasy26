import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import { sectionType } from "@/lib/registry/index";
import { settingsOf } from "./parts";

// A product rail bound to one collection (registry kind "product_rail"). Same
// markup as the old HomeSections branch, plus the DOC-03 shopper states:
//   · some or all products sold out: each card says "Sold out" (ProductCard)
//     and they move to the end, keeping their order among themselves. When
//     the collection's order is hand-picked (the founder pinned products,
//     data.handPicked), the order is kept as chosen;
//   · fewer products than the rail needs (minItems, declared in the registry,
//     or the founder's own smaller limit): the rail is left out, so a
//     shopper never sees a half-empty row;
//   · bound to an empty collection, or to none: left out.

const collectionHandle = (c) => (typeof c === "string" ? c : c && typeof c === "object" && typeof c.handle === "string" ? c.handle : "");

// In stock first, sold out last; each group keeps its order.
export function soldOutLast(products) {
  return [...products.filter((p) => p?.available !== false), ...products.filter((p) => p?.available === false)];
}

// How many products a rail needs before it shows: the registry's minItems,
// or fewer when the founder asked for fewer (a rail of 2 they chose still
// shows; the editor warns them it looks best with 3).
export function railMinimum(section) {
  const min = sectionType("product_rail")?.minItems ?? 1;
  const limit = Number(settingsOf(section).limit);
  return Number.isInteger(limit) && limit >= 1 ? Math.min(min, limit) : min;
}

function ProductRailSection({ section, data = {}, ctx = {}, attrs = {} }) {
  if (!ProductRailSection.shows(section, data)) return null;
  const s = settingsOf(section);
  const handle = collectionHandle(s.collection);
  const products = data.handPicked ? data.products : soldOutLast(data.products);
  return (
    <section data-sec={ctx.secKey} {...attrs} data-part="section" className="py-sf-section">
      <div className="mb-6 flex items-end justify-between">
        <h2 data-part="section-heading" className="text-2xl font-bold tracking-tight">{s.title}</h2>
        {handle ? (
          <Link href={`/collections/${handle}`} className="text-sm font-medium text-sf-accent-text hover:underline">
            View all →
          </Link>
        ) : null}
      </div>
      <ProductGrid products={products} />
    </section>
  );
}
ProductRailSection.shows = (section, data = {}) => Array.isArray(data.products) && data.products.length > 0 && data.products.length >= railMinimum(section);

export default ProductRailSection;
