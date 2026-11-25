"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, ImageIcon, SearchX, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/kit/page-header";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { MediaToolbar } from "@/components/admin/media/MediaToolbar";
import { MediaGrid } from "@/components/admin/media/MediaGrid";
import { UploadZone } from "@/components/admin/media/UploadZone";
import { MediaSheet } from "@/components/admin/media/MediaSheet";
import { libraryUrl, MEDIA_WORDS } from "@/components/admin/media/media-words";

// The media screen (docs/plans/phase-2.md "Line 5"; docs/UI.md "Media").
// The server sends the first page (newest, active); every later view asks
// GET /api/admin/media?view=library (50 a page, by cursor). Writers get the
// upload zone, alt editing, archive and delete; support (storefront.read
// only) gets the same library with every write hidden (RoleGate "hide"), so
// no write control is in its markup. The server refuses the writes anyway.
//   initial: { items, nextCursor, counts } | null (the first read failed)
//   role: the caller's role; limits: { mime: bytes } for the upload words
const WRITE = "storefront.write";
const DEBOUNCE_MS = 300;

export function MediaLibrary({ initial, role, limits }) {
  const canWrite = roleAllows(role, WRITE);
  const [view, setView] = useState({ tab: "active", q: "", type: "", sort: "newest" });
  const [q, setQ] = useState(""); // what is typed; view.q follows it after a pause
  const [layout, setLayout] = useState("grid");
  const [data, setData] = useState(initial || { items: [], nextCursor: null, counts: { active: 0, archived: 0 } });
  const [status, setStatus] = useState(initial ? "ready" : "error");
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState(null);
  const pick = useRef(null);
  const seq = useRef(0);
  const first = useRef(true);

  async function load(v = view, { cursor = null } = {}) {
    const mine = ++seq.current;
    if (cursor) setLoadingMore(true);
    else setStatus("loading");
    try {
      const res = await fetch(libraryUrl({ ...v, cursor }));
      const json = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok || !json.ok) throw new Error("load");
      setData((d) => (cursor ? { ...json, items: [...d.items, ...json.items] } : json));
      setStatus("ready");
    } catch {
      if (mine !== seq.current) return;
      if (cursor) setLoadingMore(false);
      setStatus(cursor ? "ready" : "error");
    } finally {
      if (mine === seq.current) setLoadingMore(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setView((v) => (v.q === q.trim() ? v : { ...v, q: q.trim() })), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (initial) return;
    }
    load(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const set = (patch) => setView((v) => ({ ...v, ...patch }));
  const clear = () => {
    setQ("");
    set({ q: "", type: "" });
  };
  const filtered = Boolean(view.q || view.type);
  const opened = data.items.find((m) => m.id === openId) || null;
  const total = data.counts?.[view.tab] ?? data.items.length;

  let empty;
  if (filtered)
    empty = (
      <EmptyState
        icon={SearchX}
        title={MEDIA_WORDS.noMatch}
        action={
          <Button type="button" variant="outline" size="sm" data-read-control onClick={clear}>
            Clear search
          </Button>
        }
      />
    );
  else if (view.tab === "archived") empty = <EmptyState icon={ImageIcon} title="No archived files" description={MEDIA_WORDS.emptyArchived} />;
  else
    empty = (
      <EmptyState
        icon={ImageIcon}
        title={canWrite ? MEDIA_WORDS.emptyTitle : "No images yet"}
        description={canWrite ? MEDIA_WORDS.emptyHelp : null}
        action={
          <RoleGate role={role} action={WRITE} mode="hide">
            <Button type="button" size="sm" onClick={() => pick.current?.()}>
              <Upload aria-hidden /> Choose images
            </Button>
          </RoleGate>
        }
      />
    );

  const more = data.nextCursor ? () => load(view, { cursor: data.nextCursor }) : null;

  return (
    <div data-media="library" data-role={role}>
      <PageHeader
        title={MEDIA_WORDS.title}
        description={MEDIA_WORDS.description}
        actions={
          <RoleGate role={role} action={WRITE} mode="hide">
            <Button type="button" onClick={() => pick.current?.()}>
              <Upload aria-hidden /> Upload images
            </Button>
          </RoleGate>
        }
      />
      {!canWrite && <p className="mb-4 text-sm text-muted-foreground">{MEDIA_WORDS.readOnly}</p>}
      {canWrite && <UploadZone role={role} limits={limits} pickRef={pick} onDone={() => (view.tab === "active" ? load(view) : set({ tab: "active" }))} />}
      <MediaToolbar
        tab={view.tab}
        counts={data.counts}
        q={q}
        type={view.type}
        sort={view.sort}
        view={layout}
        onTab={(tab) => set({ tab })}
        onQ={setQ}
        onType={(type) => set({ type })}
        onSort={(sort) => set({ sort })}
        onView={setLayout}
      />
      {status === "error" ? (
        // shaped like the empty states, so the toolbar above (and what was
        // typed in it) stays put while the files can't be shown
        <div role="alert" data-media="error" className="flex flex-col items-center gap-2 rounded-card border border-border bg-card px-6 py-10 text-center">
          <CircleAlert aria-hidden className="size-6 text-danger" />
          <p className="max-w-md text-sm text-foreground">{MEDIA_WORDS.loadFailed}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" data-read-control onClick={() => load(view)}>
            Try again
          </Button>
        </div>
      ) : (
        <MediaGrid
          items={data.items}
          view={layout}
          loading={status === "loading"}
          onOpen={(m) => setOpenId(m.id)}
          empty={empty}
          footer={layout === "list" && data.items.length ? { total, onLoadMore: more || (() => {}), loadingMore } : null}
        />
      )}
      {layout === "grid" && status === "ready" && data.items.length > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span className="font-mono tabular-nums">
            1–{data.items.length} of {total}
          </span>
          {more && (
            <Button type="button" variant="outline" size="sm" data-read-control disabled={loadingMore} onClick={more}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
      <MediaSheet
        item={opened}
        role={role}
        onClose={() => setOpenId(null)}
        onUpdated={(m) => {
          const moved = (m.archived_at != null) !== (view.tab === "archived");
          if (moved) {
            setOpenId(null);
            load(view);
          } else setData((d) => ({ ...d, items: d.items.map((x) => (x.id === m.id ? m : x)) }));
        }}
        onRemoved={() => {
          setOpenId(null);
          load(view);
        }}
      />
    </div>
  );
}
