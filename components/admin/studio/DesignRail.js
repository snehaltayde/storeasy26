"use client";

import { Button } from "@/components/ui/button";

// Phase 6 step 0: the studio's Design tab, minimal. Line 2 owns this file (the
// token controls on doc_design's own store, storeasy:tokens, checkBrand and
// Reset). It gets one prop, `studio` (components/admin/studio/Studio.js):
// api, can, role, readOnly, openDocument, post, model, startingBrand.
// Until then it opens the design in the inspector (the existing design
// form: read-only for support and operator support).
export default function DesignRail({ studio }) {
  const open = studio?.state?.id === "doc_design";
  return (
    <div className="space-y-3" data-studio-design="">
      <p className="text-sm text-muted-foreground">Your colours, type and spacing.</p>
      {!open && (
        <Button type="button" size="sm" variant="outline" onClick={() => studio?.openDocument?.("doc_design")} data-studio-open-design="" data-read-control="">
          Open the design
        </Button>
      )}
    </div>
  );
}
