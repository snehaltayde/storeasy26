import Link from "next/link";
import CollectionCard from "@/components/CollectionCard";
import { settingsOf } from "./parts";

// The collections grid (registry kind "collections"). Same markup as the old
// HomeSections branch. A collection with no photo shows CollectionCard's
// brand gradient (DOC-03: a token-coloured fallback, never a broken image).
// No collections to show: the section is left out.
function CollectionsSection({ section, data = {}, ctx = {}, attrs = {} }) {
  if (!CollectionsSection.shows(section, data)) return null;
  const s = settingsOf(section);
  return (
    <section data-sec={ctx.secKey} {...attrs} className="py-sf-section">
      <div className="mb-6 flex items-end justify-between">
        <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
        <Link href="/collections" className="text-sm font-medium text-sf-accent-text hover:underline">
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
CollectionsSection.shows = (section, data = {}) => Array.isArray(data.collections) && data.collections.length > 0;

export default CollectionsSection;
