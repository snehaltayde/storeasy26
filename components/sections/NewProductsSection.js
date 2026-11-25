import ProductGrid from "@/components/ProductGrid";
import { settingsOf } from "./parts";

// Newest products (registry kind "new"). Same markup as the old HomeSections
// branch. The first one on the page carries the "#new" anchor the default
// secondary hero button links to (ctx.newAnchor). The catalog query already
// puts sold-out products last. No products: the section is left out.
function NewProductsSection({ section, data = {}, ctx = {}, attrs = {} }) {
  if (!NewProductsSection.shows(section, data)) return null;
  const s = settingsOf(section);
  return (
    <section data-sec={ctx.secKey} {...attrs} data-part="section" id={ctx.newAnchor ? "new" : undefined} className="scroll-mt-24 py-sf-section">
      <div className="mb-6 flex items-end justify-between">
        <h2 data-part="section-heading" className="text-2xl font-bold tracking-tight">{s.title}</h2>
      </div>
      <ProductGrid products={data.products} priorityCount={4} />
    </section>
  );
}
NewProductsSection.shows = (section, data = {}) => Array.isArray(data.products) && data.products.length > 0;

export default NewProductsSection;
