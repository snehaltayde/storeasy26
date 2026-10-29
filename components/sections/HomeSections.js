import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import CollectionCard from "@/components/CollectionCard";

// THE shared home-section renderer (S54 / audit slice 2). Shoppers AND the
// draft preview render through this one component — extracted verbatim from
// app/(storefront)/page.js so visual output is byte-identical, now keyed by
// durable instance id with PER-INSTANCE data (dataById from
// lib/cms/section-data.js). Legacy id-less sections (older live snapshots)
// key by index. The "#new" scroll anchor lands on the FIRST newest-products
// section only (the default secondary CTA links to it).

export default function HomeSections({ sections, dataById }) {
  let newAnchorUsed = false;
  return (
    <>
      {sections.map((s, i) => {
        const key = s.id || `i-${i}`;
        const data = dataById.get(key) || {};
        if (s.kind === "collections" && data.collections?.length > 0) {
          return (
            <section key={key} data-sec={key} className="py-14">
              <div className="mb-6 flex items-end justify-between">
                <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                <Link href="/collections" className="text-sm font-medium text-accent-700 hover:underline">
                  View all →
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.collections.map((c) => (
                  <CollectionCard key={c.handle} collection={c} />
                ))}
              </div>
            </section>
          );
        }
        if (s.kind === "new" && data.products?.length > 0) {
          const anchor = !newAnchorUsed;
          newAnchorUsed = true;
          return (
            <section key={key} data-sec={key} id={anchor ? "new" : undefined} className="scroll-mt-24 py-14">
              <div className="mb-6 flex items-end justify-between">
                <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
              </div>
              <ProductGrid products={data.products} priorityCount={4} />
            </section>
          );
        }
        if (s.kind === "banner") {
          return (
            <section key={key} data-sec={key} className="py-14">
              <div className="rounded-brand bg-accent-100 px-6 py-10 text-center sm:px-10">
                {s.title ? <h2 className="font-display text-2xl font-bold tracking-tight text-accent-900">{s.title}</h2> : null}
                {s.text ? <p className="mx-auto mt-2 max-w-xl text-accent-800">{s.text}</p> : null}
                {s.href && s.label ? (
                  <Link href={s.href} className="mt-5 inline-block rounded-full bg-accent-400 px-6 py-3 text-sm font-bold text-accent-label transition hover:bg-accent-300">
                    {s.label}
                  </Link>
                ) : null}
              </div>
            </section>
          );
        }
        if (s.kind === "rich_text") {
          // html is allowlist-SANITIZED at save (lib/cms/validate.js, S37)
          return (
            <section key={key} data-sec={key} className="py-14">
              {s.title ? <h2 className="mb-4 text-2xl font-bold tracking-tight">{s.title}</h2> : null}
              <div className="rte max-w-3xl" dangerouslySetInnerHTML={{ __html: s.html || "" }} />
            </section>
          );
        }
        return null;
      })}
    </>
  );
}
