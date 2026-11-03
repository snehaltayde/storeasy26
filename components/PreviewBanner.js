// P2-PREVIEW (PV-03, spec 8.8): the words inside the founder's preview bar.
// Server component, no client script. The bar itself (its colour) stays in
// app/(storefront)/layout.js; this only says what the preview shows.
//
//   overlay null       a legacy preview, or a documents preview with no
//                      overlay: today's words only
//   overlay.otherTab   the same person opened a newer preview in another tab
//   overlay.designDirty the design document has unpublished changes: say
//                      whether they are shown, with a one-click toggle
//                      (a same-origin form POST to /api/preview)
export default function PreviewBanner({ overlay = null }) {
  return (
    <>
      Draft preview — this is NOT what shoppers see.{" "}
      <a href="/api/preview?exit=1" className="underline">
        Exit preview
      </a>
      {overlay?.otherTab ? (
        <span data-preview-note="other-tab" className="ml-3">
          You opened a newer preview in another tab. Both tabs show all your saved drafts.
        </span>
      ) : null}
      {overlay?.designDirty ? (
        <form data-preview-note="design" method="post" action="/api/preview" className="ml-3 inline">
          <input type="hidden" name="design" value={overlay.showDesign ? "off" : "on"} />
          {overlay.showDesign ? "Your new colours are shown here." : "Your new colours are not shown here."}{" "}
          <button type="submit" className="font-semibold underline">
            {overlay.showDesign ? "Hide them" : "Show them"}
          </button>
        </form>
      ) : null}
    </>
  );
}
