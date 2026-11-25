"use client";

import { useState } from "react";
import SectionTree from "../editor/tree/SectionTree";
import { groupIssues } from "../editor/tree/treeModel";
import { orderMessage } from "./studioModel";
import LiveRegion from "./LiveRegion";

// Phase 6 line 1 (docs/plans/phase-6.md features 3 to 7, 10, 11): the
// studio's Sections tab. The tree with drag handles and "Add a section here"
// insert points (SectionTree draggable), the one aria-live region, and the
// instant preview: while a section is held or dragged the frame is sent
// storeasy:order with the order shown (and storeasy:select outlines the
// held section) on the same tick; a drop is a normal treeChange (an undo
// step, saved as a draft, which posts the order again and reloads the frame
// on the save's acknowledgement).
// A 409 (the store's conflict) keeps the handles but disables them until the
// founder chooses a version. Without storefront.write (support, operator
// support) there is no handle, insert point, Add or row button: rows only
// select.
export const RAIL_WORDS = Object.freeze({
  empty: "This page has no sections to arrange.",
  conflict: "Choose which version to keep before moving sections.",
});

export default function SectionsRail({ studio }) {
  const [said, setSaid] = useState({ text: "", count: 0 });
  const st = studio?.state;
  const sections = Array.isArray(st?.body?.sections) ? st.body.sections : null;
  if (!sections) return <p className="text-sm text-muted-foreground">{RAIL_WORDS.empty}</p>;
  const issues = st.pending?.issues || st.issues || [];
  const preview = (list, { id } = {}) => {
    studio.post?.(orderMessage(st.id, { sections: list }));
    if (id) studio.post?.({ type: "storeasy:select", sectionId: id });
  };
  return (
    <div data-studio-sections="">
      <SectionTree
        type={st.type}
        sections={sections}
        selectedId={studio.selection}
        issuesBySection={groupIssues(issues)}
        onChange={studio.treeChange}
        onSelect={studio.select}
        body={st.body}
        role={studio.role}
        draggable={studio.can?.write === true}
        dragBlocked={st.conflict ? RAIL_WORDS.conflict : null}
        onPreview={preview}
        onAnnounce={(text) => setSaid((s) => ({ text, count: s.count + 1 }))}
      />
      <LiveRegion text={said.text} count={said.count} />
    </div>
  );
}
