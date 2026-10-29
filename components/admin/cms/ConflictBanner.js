"use client";

import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";

// THE conflict UX (S52): every CMS editor renders the same two honest choices
// on a 409 — take their version, or overwrite with yours. (The old screens
// had two different vocabularies and one path with no button at all.)
export function ConflictBanner({ onTakeTheirs, onOverwrite, busy = false, what = "this content" }) {
  return (
    <Banner
      tone="danger"
      title="Someone else saved first"
      actions={
        <>
          <Button size="sm" onClick={onTakeTheirs} disabled={busy}>
            Load their version
          </Button>
          <Button size="sm" variant="danger" busy={busy} onClick={onOverwrite}>
            Overwrite with mine
          </Button>
        </>
      }
    >
      Another session edited {what} since you loaded it. Load their version (your unsaved edits are discarded), or
      overwrite it with yours.
    </Banner>
  );
}
