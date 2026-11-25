"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { sendJson } from "@/components/admin/offers/ConfirmAction";
import { QUIZ_WORDS, pageLine } from "./quiz-words";

// Deleting a quiz (Phase 2 line 10, docs/UI.md: an AlertDialog for every
// destructive action). A quiz that pages link to can't be deleted: the
// dialog says so with the pages by name and offers "Turn it off instead"
// (when the quiz is On and the role may turn it off). The server checks
// again (409 QUIZ_IN_USE with the pages), so a link added since the page
// loaded turns the dialog into the same refusal. There is no force.
//   onTurnOff: async () => void, or null when not offered
export function DeleteQuizDialog({ open, onOpenChange, quiz, pages, onDeleted, onTurnOff = null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [usedBy, setUsedBy] = useState(null);
  const blocked = usedBy || (pages.length ? pages : null);
  const change = (v) => {
    if (busy) return;
    setError(null);
    if (!v) setUsedBy(null);
    onOpenChange(v);
  };
  async function act(e, fn) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
      onOpenChange(false);
    } catch (err) {
      if (err.body?.code === "QUIZ_IN_USE") setUsedBy(err.body.pages || []);
      else setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent data-quiz-delete={blocked ? "in-use" : "confirm"}>
        <AlertDialogHeader>
          <AlertDialogTitle>{blocked ? "This quiz can't be deleted" : `Delete “${quiz.title}”?`}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {blocked ? (
                <>
                  <p>{QUIZ_WORDS.inUse}</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-foreground" data-quiz-delete-pages>
                    {blocked.map((p) => (
                      <li key={p.document}>{pageLine(p)}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>
                  Removes the quiz for good. <span className="font-mono">/quiz/{quiz.slug}</span> stops working{quiz.enabled ? ", and shoppers can no longer take it" : ""}.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{blocked ? "Close" : "Keep it"}</AlertDialogCancel>
          {blocked ? (
            onTurnOff && (
              <AlertDialogAction variant="default" disabled={busy} onClick={(e) => act(e, onTurnOff)}>
                {busy ? "Working…" : "Turn it off instead"}
              </AlertDialogAction>
            )
          ) : (
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) =>
                act(e, async () => {
                  await sendJson("/api/admin/quiz", "POST", { remove: { slug: quiz.slug } });
                  await onDeleted();
                })
              }
            >
              {busy ? "Deleting…" : "Delete quiz"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
