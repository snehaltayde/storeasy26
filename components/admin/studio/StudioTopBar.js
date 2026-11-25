"use client";

import Link from "next/link";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Phase 6 step 0: the studio's top bar, minimal. Line 1 owns this file
// (document switcher, device widths, full screen, the publish dialog, the
// nav guard on Exit). Props:
//   studio       components/admin/studio/Studio.js's context (can, history,
//                undo, redo)
//   label        the open document's name
//   statusLine   the save and preview line (StatusLine)
//   onPublish()  publishes the open document (storefront.publish only)
//   published    the last publish answer, or null
// Roles: Undo and Redo only with storefront.write; Publish only with
// storefront.publish (staff read "Ask an admin to publish."); support and
// operator support get no write control at all.
export const TOP_WORDS = Object.freeze({ exit: "Exit studio", askAdmin: "Ask an admin to publish.", publish: "Publish", published: "Published." });

export default function StudioTopBar({ studio, label = "", statusLine = null, onPublish, published = null }) {
  const can = studio?.can || {};
  const h = studio?.history || { undo: 0, redo: 0 };
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2" data-studio-top="">
      <Link href="/admin/dashboard" className="text-sm font-medium underline-offset-4 hover:underline" data-studio-exit="">
        {TOP_WORDS.exit}
      </Link>
      <h1 className="truncate text-sm font-semibold" data-studio-label="">
        {label}
      </h1>
      <div className="min-w-0 flex-1">{statusLine}</div>
      {can.write && (
        <>
          <Button type="button" size="sm" variant="ghost" disabled={!h.undo} onClick={() => studio.undo()} aria-label="Undo" data-studio-undo="">
            <Undo2 aria-hidden />
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!h.redo} onClick={() => studio.redo()} aria-label="Redo" data-studio-redo="">
            <Redo2 aria-hidden />
          </Button>
        </>
      )}
      {can.publish ? (
        <Button type="button" size="sm" onClick={() => onPublish?.()} data-studio-publish="">
          {TOP_WORDS.publish}
        </Button>
      ) : can.write ? (
        <p className="text-sm text-muted-foreground" data-studio-ask-admin="">
          {TOP_WORDS.askAdmin}
        </p>
      ) : null}
      {published && (
        <p role="status" className="text-sm text-muted-foreground" data-studio-published="">
          {published.ok ? TOP_WORDS.published : published.message || "Couldn't publish."}
        </p>
      )}
    </header>
  );
}
