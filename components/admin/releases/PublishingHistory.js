"use client";

import { useCallback, useEffect, useState } from "react";
import * as documentsApi from "@/components/admin/editor/documentsApi";
import RecentlyPublished from "@/components/admin/editor/publish/RecentlyPublished";
import { Banner, SkeletonText } from "@/components/admin/editor/fields/parts";
import { editorHref } from "@/lib/admin/editor-entry";

// /admin/releases (PUB-04; Phase 2 line 6 moved it here from DocumentEditor):
// Recently published, with Undo through documentsApi. `access` is passed on:
// staff and support see the reason instead of Undo (the server refuses them
// too). The rows are read from the documents API (listRecentlyPublished), again
// after each Undo and whenever `version` changes (a publish from the Waiting
// list). initialRows: rows already in hand (tests). onUndone: after an Undo.
export function PublishingHistory({ initialRows = null, access = null, api = documentsApi, version = 0, onUndone = null }) {
  const [list, setList] = useState(initialRows ? { status: "ready", rows: initialRows } : { status: "loading", rows: [] });
  const load = useCallback(async () => {
    const r = await api.call("listRecentlyPublished", { limit: 20 });
    setList(r?.ok ? { status: "ready", rows: Array.isArray(r.data?.rows) ? r.data.rows : [] } : { status: "failed", rows: [], message: r?.message });
  }, [api]);
  useEffect(() => {
    if (!initialRows || version > 0) load();
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (list.status === "loading")
    return (
      <div role="status" aria-label="Loading what was published" data-history-loading="">
        <span className="sr-only">Loading what was published…</span>
        <SkeletonText lines={4} />
      </div>
    );
  if (list.status === "failed") return <Banner tone="warning" title={list.message || "We couldn't load what was published. Reload the page."} />;
  return (
    <RecentlyPublished
      rows={list.rows}
      call={api.call}
      access={access}
      editorHref={(id) => editorHref(id)}
      onUndone={() => {
        load();
        onUndone?.();
      }}
    />
  );
}

export default PublishingHistory;
