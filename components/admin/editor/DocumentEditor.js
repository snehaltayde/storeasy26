"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { Banner } from "@/components/console/Banner";

// P3-ROUTES (ED-02): a PLACEHOLDER for the new editor. It shows which
// document the editor opened (lib/admin/editor-entry.js picks it) and the
// note when it had to open home instead. P3-EDITOR (batch 4) replaces this
// file with the real editor: the switcher, tree, preview, inspector and
// Publish, wired to components/admin/editor/store.js.
//
// Props: document { id, type, label, slug }, note (string or null).
export default function DocumentEditor({ document, note = null }) {
  const label = document?.label || "Home page";
  return (
    <div data-document-editor data-doc={document?.id || ""}>
      <PageHeader title="Editor" description="Edit your store's pages, menus and look here. Changes save as drafts and go live when you publish." />
      {note && (
        <Banner tone="info" className="mb-4">
          {note}
        </Banner>
      )}
      <section aria-label="Open document" className="rounded-card border border-edge bg-surface p-4 shadow-card">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Editing</p>
        <h2 data-document-label className="mt-1 text-lg font-semibold text-fg">
          {label}
        </h2>
        <p className="mt-2 text-sm text-fg-muted">The full editor for this page is on its way. Nothing here changes your store yet.</p>
      </section>
    </div>
  );
}
