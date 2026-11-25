"use client";

import { useCallback, useEffect, useState } from "react";
import * as documentsApi from "@/components/admin/editor/documentsApi";
import { Banner, Button, SkeletonText } from "@/components/admin/editor/fields/parts";
import WaitingList from "./WaitingList";
import { PublishingHistory } from "./PublishingHistory";

// /admin/releases (Phase 2 line 6): "Waiting to publish" (the pages with a
// draft, Publish selected) above "Recently published" (Undo, Undo set). Every
// read is a documents read (listDocuments, listRecentlyPublished; the publish
// panel's getDocument and listChanges); the only writes are publish,
// publishSet and undo, which staff and support never see.
//   access   { canPublish, reason } from the page (roleAllows)
//   api      documentsApi (tests pass a stub)
export default function PublishingPage({ access = null, api = documentsApi, initialDocuments = null, initialRows = null }) {
  const [docs, setDocs] = useState(initialDocuments ? { status: "ready", rows: initialDocuments } : { status: "loading", rows: [] });
  const [version, setVersion] = useState(0);
  const loadDocs = useCallback(async () => {
    const r = await api.call("listDocuments", true);
    setDocs(r?.ok && Array.isArray(r.data?.documents) ? { status: "ready", rows: r.data.documents } : { status: "failed", rows: [], message: r?.message });
  }, [api]);
  useEffect(() => {
    if (!initialDocuments || version > 0) loadDocs();
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  // a publish: both lists again; an Undo: the history reads itself again,
  // the waiting list here
  const published = useCallback(() => setVersion((v) => v + 1), []);
  const undone = useCallback(() => loadDocs(), [loadDocs]);

  return (
    <div className="space-y-8" data-publishing-page="">
      <section aria-labelledby="waiting-heading" className="space-y-3">
        <h2 id="waiting-heading" className="text-base font-semibold text-foreground">
          Waiting to publish
        </h2>
        {docs.status === "loading" && (
          <div role="status" aria-label="Loading the pages waiting to publish">
            <SkeletonText lines={3} />
          </div>
        )}
        {docs.status === "failed" && (
          <Banner
            tone="warning"
            title={docs.message || "We couldn't load the pages waiting to publish."}
            actions={
              <Button size="sm" onClick={loadDocs} data-read-control="">
                Try again
              </Button>
            }
          />
        )}
        {docs.status === "ready" && <WaitingList documents={docs.rows} access={access} call={api.call} onPublished={published} />}
      </section>
      <section aria-labelledby="recent-heading" className="space-y-3">
        <h2 id="recent-heading" className="text-base font-semibold text-foreground">
          Recently published
        </h2>
        <div data-documents-mode="" data-recently-published-page="">
          <PublishingHistory access={access} api={api} initialRows={initialRows} version={version} onUndone={undone} />
        </div>
      </section>
    </div>
  );
}
