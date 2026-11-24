"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { call } from "@/components/admin/editor/documentsApi";

// Onboarding step 4's reader for a policy starter draft (Phase 1 line 7): the
// draft's text, read with documentsApi getDocument (storefront.read), as plain
// text in a Sheet. "I've read it" sits only at the end of the text; "Edit in
// the editor" beside it, because plain text drops the formatting. The mark
// sends the revision that was read, so a draft changed since is refused.
//   reading     { fix, title } | null (fix: open-step's policy_read fix)
//   onMarkRead(id, revision)  -> { ok }; onClose()

export const READER_WORDS = Object.freeze({
  lead: "This is the draft we started from a template. Read it to the end, change what you need in the editor, then mark it read.",
  loading: "Loading the page…",
  failed: "This page didn't load. Try again, or close this and open it from the list.",
  tryAgain: "Try again",
  notLegalAdvice: "These are starting points, not legal advice.",
  edit: "Edit in the editor",
  close: "Close",
});

const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter((x) => typeof x === "string" && x.trim());

// The draft as plain text: [{ title, paragraphs }]. Text sections, and any
// block with a title, question, body or answer.
export function plainText(body) {
  const out = [];
  for (const s of Array.isArray(body?.sections) ? body.sections : []) {
    if (s?.enabled === false) continue;
    const st = s?.settings || {};
    const paragraphs = [...asList(st.body), ...asList(st.text)];
    if (typeof st.title === "string" || paragraphs.length) out.push({ title: typeof st.title === "string" ? st.title : null, paragraphs });
    for (const b of Array.isArray(s?.blocks) ? s.blocks : []) {
      const bs = b?.settings || {};
      const title = typeof bs.question === "string" ? bs.question : typeof bs.title === "string" ? bs.title : null;
      const para = [...asList(bs.answer), ...asList(bs.body), ...asList(bs.text)];
      if (title || para.length) out.push({ title, paragraphs: para });
    }
  }
  return out;
}

export default function PolicyReader({ reading, onClose, onMarkRead, busy = false }) {
  const [doc, setDoc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const id = reading?.fix?.docId || null;

  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    setDoc(null);
    setFailed(false);
    call("getDocument", id).then((r) => {
      if (!live) return;
      if (r?.ok && r.data?.document) setDoc(r.data.document);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const fix = reading?.fix;
  const parts = doc ? plainText(doc.body) : [];
  return (
    <Sheet open={Boolean(reading)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg" data-onboarding="policy-reader">
        <SheetHeader className="pr-12">
          <SheetTitle>{doc?.label || reading?.title || ""}</SheetTitle>
          <SheetDescription>{READER_WORDS.lead}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-onboarding="policy-text">
          {!doc && !failed && (
            <div role="status" className="space-y-3">
              <span className="sr-only">{READER_WORDS.loading}</span>
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          )}
          {failed && (
            <div role="alert" className="space-y-3">
              <p className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">{READER_WORDS.failed}</span>
              </p>
              <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                {READER_WORDS.tryAgain}
              </Button>
            </div>
          )}
          {doc && (
            <article className="max-w-prose space-y-5 text-sm leading-relaxed text-foreground">
              {parts.map((p, i) => (
                <section key={i} className="space-y-1.5">
                  {p.title && <h3 className="text-sm font-semibold">{p.title}</h3>}
                  {p.paragraphs.map((t, j) => (
                    <p key={j}>{t}</p>
                  ))}
                </section>
              ))}
              <p className="text-xs text-muted-foreground">{READER_WORDS.notLegalAdvice}</p>
              {/* at the end of the text only */}
              <div className="flex flex-wrap items-start gap-2 border-t border-border pt-4" data-onboarding="policy-end">
                {fix?.markRead?.allowed ? (
                  <Button size="sm" disabled={busy} aria-busy={busy || undefined} onClick={() => onMarkRead(doc.id, doc.revision)}>
                    {fix.markRead.label}
                  </Button>
                ) : (
                  <span className="inline-flex flex-col items-start gap-1" data-onboarding="gated">
                    <Button size="sm" disabled aria-describedby="mark-read-reason">
                      {fix?.markRead?.label}
                    </Button>
                    <span id="mark-read-reason" className="text-xs text-muted-foreground" data-onboarding="reason">
                      {fix?.markRead?.reason}
                    </span>
                  </span>
                )}
                {fix?.editHref && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={fix.editHref}>{READER_WORDS.edit}</Link>
                  </Button>
                )}
              </div>
            </article>
          )}
        </div>
        <SheetFooter>
          <Button variant="ghost" onClick={onClose}>
            {READER_WORDS.close}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
