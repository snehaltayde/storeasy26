import { gridEmptyLine } from "@/lib/commerce/bundle-words";
import { settingsOf, FounderNote, isFounderPreview } from "./parts";
import { BundleBox, isShown, bundleReason } from "./BundleCardSection";

// P5-BLOCKS (COM-01, COM-02): the bundles the founder picked, side by side
// (registry kind "bundle_grid"). Server component, edge-safe. Its data is one
// entry per picked bundle, in the picked order (the bundles_by_ids source; a
// bundle the read has not got is { id, state: "missing" }).
//
// Each cell follows the bundle card's rule (BundleCardSection.js):
//   available, sold_out, not_ready   a cell (sold-out and not-ready ones say
//                                    "Currently unavailable", add off)
//   no_saving, disabled, missing     no cell for shoppers; in a documents
//                                    preview only, a founder note in its place
//                                    with that bundle's reason
// The grid shows when at least one cell does. When none does, it is hidden,
// and hiddenReason tells the founder "None of the bundles in this grid can be
// shown, so shoppers don't see it." followed by each bundle's reason.

const isText = (v) => typeof v === "string" && v.trim() !== "";
const entriesOf = (data) => (Array.isArray(data?.bundles) ? data.bundles : []);
const nameOf = (b, i) => (isText(b?.title) ? b.title : `Bundle ${i + 1}`);

function BundleGridSection({ section, data = {}, ctx = {}, attrs = {} }) {
  if (!BundleGridSection.shows(section, data)) return null;
  const s = settingsOf(section);
  const preview = isFounderPreview(ctx);
  return (
    <section data-sec={ctx.secKey} {...attrs} className="py-sf-section">
      {isText(s.title) ? <h2 className="mb-6 text-2xl font-bold tracking-tight">{s.title}</h2> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entriesOf(data).map((b, i) =>
          isShown(b) ? (
            <BundleBox key={`b${i}`} bundle={b} />
          ) : preview ? (
            <FounderNote key={`n${i}`} ctx={ctx} title={`${nameOf(b, i)}: hidden from shoppers`} text={bundleReason(b)} attrs={{ "data-bundle-cell": String(i), "data-hidden-reason": "" }} />
          ) : null,
        )}
      </div>
    </section>
  );
}
BundleGridSection.shows = (section, data = {}) => entriesOf(data).some(isShown);
BundleGridSection.hiddenReason = (section, data = {}) => {
  const entries = entriesOf(data);
  if (entries.some(isShown)) return null;
  return [gridEmptyLine(), ...entries.map((b, i) => `${nameOf(b, i)}: ${bundleReason(b)}`)].join(" ");
};

export default BundleGridSection;
