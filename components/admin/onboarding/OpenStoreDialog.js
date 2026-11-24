"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlert, FilePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { call } from "@/components/admin/editor/documentsApi";
import { createPublishFlow, openingWarns, WORDS as PUBLISH_WORDS } from "@/components/admin/editor/publish/publishModel";
import { EDITOR_PUBLISH_HREF } from "@/lib/admin/editor-entry";

// "Open your store" from onboarding step 4 (Phase 1 line 7). It runs the
// editor's own publish flow (createPublishFlow through documentsApi: the
// documents route, publish(), the opening gate), so the checks, the
// publish_log rows, the audit row and "a starter draft is never in the set"
// are the editor's own code. This only renders the flow's state:
//   opening     everything going live (home plus what the flow folds in: the
//               design draft, founder-saved policy pages), each "first
//               version" or its number of changes; the "Worth checking"
//               items; other drafts stay drafts; "Open my store" (or "anyway"
//               with warnings) sends confirmOpen, enabled by canConfirm()
//   offer       the unpublished linked pages, then confirm
//   cannotOpen  shoppers can't pay: the fix is on the step's page
//   blocked, refused, conflict, noHome, error   the server's words, "Open the
//               editor to fix this", "Try again"
//   checking, checked   a lost answer is checked, never shown as a failure
//   done        onOpened(): the step re-reads and shows "Your store is open"
// Esc and Cancel close it before anything is sent; once sent, closing says
// the publish keeps running (the flow still reports a late success).

export const DIALOG_WORDS = Object.freeze({
  title: "Open your store",
  lead: "This is what goes live when your store opens:",
  firstVersion: "First version",
  changes: (n) => (n === 1 ? "1 change" : `${n} changes`),
  loading: "Finding what changed…",
  otherDrafts: "Everything else you're working on stays a draft. Only what's listed here goes live.",
  worth: "Worth checking",
  blocks: "Needed before your store can open",
  offerLead: "Your home page links to these pages, which aren't live yet. They go live together:",
  publishTogether: "Publish them together",
  cannotOpen: "Close this and fix it",
  fixInEditor: "Open the editor to fix this",
  tryAgain: "Try again",
  cancel: "Cancel",
  close: "Close",
  starting: "Checking your store…",
});

const countOf = (list) => (list?.firstPublish || list?.neverPublished ? DIALOG_WORDS.firstVersion : DIALOG_WORDS.changes((list?.rows || []).length));

function Problem({ title, words }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {words && <p>{words}</p>}
      </div>
    </div>
  );
}

// what the founder should look at: Needed (danger) or Worth checking (warning)
function Checklist({ tone, title, items, ...props }) {
  return (
    <div className={cn("space-y-1 rounded-md px-3 py-2", tone === "danger" ? "bg-danger/10" : "bg-warning/10")} {...props}>
      <p className={cn("flex items-center gap-2 text-sm font-medium", tone === "danger" ? "text-danger" : "text-warning-text")}>
        <CircleAlert aria-hidden className={cn("size-4 shrink-0", tone === "warning" && "text-warning")} />
        {title}
      </p>
      <ul className="list-disc space-y-0.5 pl-10 text-[0.8125rem] text-foreground">
        {items.map((i) => (
          <li key={i.id}>{i.title}</li>
        ))}
      </ul>
    </div>
  );
}

// before the flow has its list: rows shaped like the list
function GoingLiveLoading() {
  return (
    <div role="status" className="divide-y divide-border rounded-md border border-border">
      <span className="sr-only">{DIALOG_WORDS.starting}</span>
      {[0, 1, 2].map((n) => (
        <div key={n} aria-hidden className="flex items-center justify-between gap-3 px-3 py-2.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

function GoingLive({ state }) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-onboarding="going-live">
      {state.order.map((id) => {
        const list = state.lists[id];
        const label = list?.label || state.items.find((i) => i.id === id)?.label || id;
        return (
          <li key={id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm" data-going-live={id}>
            <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {!list || list.status === "loading" ? <Skeleton className="h-3 w-16" /> : list.status === "failed" ? <span className="text-danger">{list.message}</span> : countOf(list)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function OpenStoreDialog({ open, onOpenChange, onOpened, onChange }) {
  const flow = useMemo(() => createPublishFlow({ call, onPublished: () => onOpened?.() }), []);
  const [state, setState] = useState(flow.getState());
  const [sent, setSent] = useState(false);
  useEffect(() => flow.subscribe(setState), [flow]);

  const start = () => {
    setSent(false);
    flow.open([{ id: "doc_home" }]);
  };
  useEffect(() => {
    if (open) start();
    else flow.close();
  }, [open]);

  // a lost answer that turned out live is a success
  useEffect(() => {
    if (state.phase === "checked" && state.outcome?.live === true) onOpened?.();
  }, [state.phase, state.outcome?.live]);

  async function confirm() {
    setSent(true);
    await flow.confirm();
  }

  const o = state.outcome || {};
  const report = o.report || null;
  const warns = (report?.items || []).filter((i) => i.level === "warn");
  const blocks = (report?.items || []).filter((i) => i.level === "block");
  const anyway = openingWarns(report);
  const phase = state.phase;
  const failedPhase = ["blocked", "refused", "conflict", "noHome", "error"].includes(phase);
  const failedWords = phase === "noHome" ? o.message : o.words || o.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-onboarding="open-dialog" data-phase={phase}>
        <DialogHeader>
          <DialogTitle>{DIALOG_WORDS.title}</DialogTitle>
          <DialogDescription>{phase === "offer" ? DIALOG_WORDS.offerLead : DIALOG_WORDS.lead}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4" aria-live="polite">
          {(phase === "closed" || phase === "review") && !state.order.length && <GoingLiveLoading />}
          {(phase === "opening" || phase === "offer" || phase === "review") && state.order.length > 0 && (
            <div className="space-y-2">
              <GoingLive state={state} />
              {phase !== "review" && (
                <p className="flex items-start gap-2 text-[0.8125rem] text-muted-foreground" data-onboarding="other-drafts">
                  <FilePen aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">{DIALOG_WORDS.otherDrafts}</span>
                </p>
              )}
            </div>
          )}
          {phase === "opening" && blocks.length > 0 && <Checklist tone="danger" title={DIALOG_WORDS.blocks} items={blocks} />}
          {phase === "opening" && warns.length > 0 && <Checklist tone="warning" title={DIALOG_WORDS.worth} items={warns} data-onboarding="worth-checking" />}
          {phase === "cannotOpen" && <Problem words={o.message || PUBLISH_WORDS.openingCannot} />}
          {failedPhase && <Problem title={o.title || null} words={failedWords} />}
          {(phase === "checking" || phase === "checked") && <p className="text-sm text-muted-foreground">{o.words}</p>}
          {state.notice && <Problem words={state.notice} />}
          {sent && state.busy && <p className="text-xs text-muted-foreground">{PUBLISH_WORDS.keepsRunning}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {sent && state.busy ? DIALOG_WORDS.close : DIALOG_WORDS.cancel}
          </Button>
          {(failedPhase || (phase === "checked" && state.outcome?.live !== true)) && (
            <>
              <Button asChild variant="outline">
                <Link href={EDITOR_PUBLISH_HREF}>{DIALOG_WORDS.fixInEditor}</Link>
              </Button>
              <Button onClick={start}>{DIALOG_WORDS.tryAgain}</Button>
            </>
          )}
          {phase === "cannotOpen" && (
            <Button
              onClick={() => {
                onOpenChange(false);
                onChange?.();
              }}
            >
              {DIALOG_WORDS.cannotOpen}
            </Button>
          )}
          {phase === "offer" && (
            <Button disabled={!flow.canConfirm()} aria-busy={state.busy || undefined} onClick={confirm}>
              {DIALOG_WORDS.publishTogether}
            </Button>
          )}
          {(phase === "opening" || phase === "review") && (
            <Button disabled={!flow.canConfirm()} aria-busy={state.busy || undefined} onClick={confirm} data-onboarding="confirm-open">
              {state.busy && sent ? PUBLISH_WORDS.opening : anyway ? PUBLISH_WORDS.openStoreAnyway : PUBLISH_WORDS.openStore}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
