// PV-08: the preview's note on a section a running test changes. A server
// component with no hooks (edge-safe). It renders only when the page hands it
// a notice, and pages only get one in a preview (lib/experiments.js
// heroVariantFor), so a shopper never receives it. The purple matches the
// "Draft preview" bar: it is preview chrome, not the store's brand.
// The link opens the test's row in the console; inside the Designer the
// preview bridge turns a click on the section into selecting it instead.
export default function ExperimentNote({ notice }) {
  if (!notice) return null;
  return (
    <p
      data-preview-note="experiment"
      data-experiment={notice.slug}
      className="relative mb-5 max-w-xl rounded-lg bg-purple-700 px-3 py-2 text-xs font-medium leading-snug text-white"
    >
      A test is running on this section: “{notice.name}”. Some visitors see a different version; the preview shows yours.{" "}
      <a href={`/admin/experiments#exp-${notice.slug}`} target="_top" className="whitespace-nowrap underline">
        See the test
      </a>
    </p>
  );
}
