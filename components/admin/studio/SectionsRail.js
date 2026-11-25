"use client";

import SectionTree from "../editor/tree/SectionTree";
import { groupIssues } from "../editor/tree/treeModel";

// Phase 6 step 0: the studio's Sections tab, minimal. Line 1 owns this file
// (drag handles, insert points, the live region). It gets one prop, `studio`
// (components/admin/studio/Studio.js): state, selection, select, treeChange,
// role, can, post. The tree's write buttons are RoleGate'd on
// storefront.write, so support and operator support only select.
export default function SectionsRail({ studio }) {
  const st = studio?.state;
  const sections = Array.isArray(st?.body?.sections) ? st.body.sections : null;
  if (!sections) return <p className="text-sm text-muted-foreground">This page has no sections to arrange.</p>;
  const issues = st.pending?.issues || st.issues || [];
  return (
    <div data-studio-sections="">
      <SectionTree type={st.type} sections={sections} selectedId={studio.selection} issuesBySection={groupIssues(issues)} onChange={studio.treeChange} onSelect={studio.select} body={st.body} role={studio.role} />
    </div>
  );
}
