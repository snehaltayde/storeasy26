import { Fragment } from "react";
import { SectionView, sectionShows, hiddenNote } from "./index";
import { EmptyPageNote } from "./parts";

// THE shared home-section renderer (S54 / audit slice 2). Shoppers AND the
// draft preview render through this one component. P2-SECTIONS: every section
// renders through the renderer map (components/sections/index.js), from
// registry-shaped sections ({ id, kind, settings }) with PER-INSTANCE data
// (dataById from lib/cms/section-data.js). The markup is the old branches',
// moved into one component per kind.
//
// Keys: a section's id. A section from an old live snapshot that had no id
// keeps the index key it always had ("i-<n>", carried as legacyKey by
// resolvedHomePage). The key is also the section's data-sec, the preview's
// click target. The "#new" scroll anchor lands on the FIRST newest-products
// section that shows (the default secondary hero button links to it).
//
// emptyNote: the page has nothing else (no hero); when no section shows
// either, shoppers get the neutral DOC-03 message and a link to collections.
//
// P5-HIDDEN (COM-01): a section that doesn't show renders hiddenNote instead
// of nothing: the founder's "why it's hidden" note in a documents preview
// (only for a kind whose component declares hiddenReason), null everywhere
// else, so shoppers and legacy previews get exactly what they got before. The
// preview is read from the request scope a documents preview sets
// (inDocumentsPreview, as SectionView does for this page); the ctx carries
// the same secKey SectionView gets, so the note is the click target. A note
// never takes the #new anchor; in a preview it counts as something shown for
// emptyNote (live it is null, so it never does).
export const sectionKey = (s, i) => s?.legacyKey || s?.id || `i-${i}`;

export default function HomeSections({ sections, dataById, emptyNote = false }) {
  let newAnchorUsed = false;
  const out = sections.map((s, i) => {
    const key = sectionKey(s, i);
    const data = dataById.get(key) || {};
    if (!sectionShows(s, data)) {
      const note = hiddenNote(s, data, { surface: "home", secKey: key });
      return note ? <Fragment key={key}>{note}</Fragment> : null;
    }
    let newAnchor = false;
    if (s.kind === "new") {
      newAnchor = !newAnchorUsed;
      newAnchorUsed = true;
    }
    return <SectionView key={key} section={s} data={data} ctx={{ surface: "home", secKey: key, newAnchor }} />;
  });
  if (emptyNote && !out.some(Boolean)) return <EmptyPageNote />;
  return <>{out}</>;
}
