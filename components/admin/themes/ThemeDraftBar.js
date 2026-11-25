"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Palette } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { useToast } from "@/components/kit/toast";
import { NO_PUBLISH, PREVIEW_NOTE, postTheme, putDocuments } from "@/components/admin/themes/theme-words";

// The design draft vs the live store (Phase 5 line 3). Shown while the design
// draft has unpublished changes:
//   Preview  (storefront.read): a preview session with the design draft shown
//            (POST /api/admin/preview-session { create }, then { showDesign:
//            { sid, on: true } }), opened in a new tab; reused while this page
//            stays open
//   Publish  (storefront.publish; staff see "Ask an admin to publish"): a
//            confirm lists every other pending layout or home draft with a
//            checkbox, ticked only when the server suggests it (a layout whose
//            only change is its template; home when the last apply asked for
//            it); the documents publishSet is the design plus exactly the
//            ticked drafts, each at the revision and draft hash shown
//            (release, publish_log and audit in one batch)
//   state: GET /api/admin/themes state; names: { live, draft } look names
export function ThemeDraftBar({ state, names, role }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [ticked, setTicked] = useState({});
  if (!state?.publishSet?.length) return null;
  const extras = state.publishSet.filter((d) => d.id !== "doc_design");
  const openConfirm = () => {
    setError(null);
    setTicked(Object.fromEntries(extras.map((d) => [d.id, d.suggested === true])));
    setConfirming(true);
  };

  async function preview() {
    setBusy("preview");
    setError(null);
    const tab = window.open("", "_blank");
    let s = session;
    if (!s) {
      const r = await postTheme("preview-session", { create: true });
      if (!r.ok) {
        tab?.close();
        setBusy(null);
        return setError(r.error);
      }
      s = { sid: r.sid, url: r.previewUrl };
    }
    const on = await postTheme("preview-session", { showDesign: { sid: s.sid, on: true } });
    setBusy(null);
    if (!on.ok) {
      tab?.close();
      setSession(null);
      return setError(on.error);
    }
    setSession(s);
    if (tab) tab.location.href = s.url;
    else window.open(s.url, "_blank", "noopener");
  }

  async function publish() {
    setBusy("publish");
    setError(null);
    const set = state.publishSet.filter((d) => d.id === "doc_design" || ticked[d.id] === true);
    const r = await putDocuments({ publishSet: set.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) });
    setBusy(null);
    setConfirming(false);
    if (!r.ok) return setError(r.error);
    toast.success(`${names.draft} is live on your store.`);
    router.refresh();
  }

  return (
    <Alert variant="warning" data-themes="draft-bar">
      <Palette aria-hidden="true" />
      <AlertTitle>
        Your draft uses {names.draft}. Your live store uses {names.live}.
      </AlertTitle>
      <AlertDescription>
        <p>
          {PREVIEW_NOTE}
          {extras.length ? " Publishing lets you choose which of your other drafts go live with it." : ""}
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!!busy} aria-busy={busy === "preview"} onClick={preview} data-themes-action="preview" data-read-control>
            <ExternalLink aria-hidden /> Preview
          </Button>
          <RoleGate role={role} action="storefront.publish" reason={NO_PUBLISH}>
            <Button type="button" size="sm" disabled={!!busy} aria-busy={busy === "publish"} onClick={openConfirm} data-themes-action="publish">
              Publish
            </Button>
          </RoleGate>
          {!roleAllows(role, "storefront.publish") ? <span className="self-center text-[0.8125rem] text-muted-foreground">{NO_PUBLISH}</span> : null}
        </div>
      </AlertDescription>
      <AlertDialog open={confirming} onOpenChange={(o) => !busy && setConfirming(o)}>
        <AlertDialogContent data-themes="publish-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Publish {names.draft}?</AlertDialogTitle>
            <AlertDialogDescription>Your design goes live. {extras.length ? "Tick the other drafts to publish with it; the rest stay drafts." : "Nothing else changes."}</AlertDialogDescription>
          </AlertDialogHeader>
          {extras.length ? (
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium">Other drafts</legend>
              <ul className="divide-y divide-border rounded-md border border-border">
                {extras.map((d) => (
                  <li key={d.id} className="flex items-start gap-3 px-3 py-3">
                    <Checkbox id={`pub-${d.id}`} className="mt-0.5" aria-describedby={`pub-${d.id}-why`} checked={ticked[d.id] === true} onCheckedChange={(v) => setTicked((t) => ({ ...t, [d.id]: v === true }))} data-themes-publish-item={d.id} />
                    <div className="min-w-0">
                      <Label htmlFor={`pub-${d.id}`} className="font-medium">
                        {d.label}
                      </Label>
                      <p id={`pub-${d.id}-why`} className="text-[0.8125rem] text-muted-foreground">
                        {d.suggested ? "Changed by the theme" : "Has other edits"}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={!!busy} aria-busy={busy === "publish"} onClick={publish} data-themes-action="publish-confirm">
              Publish
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Alert>
  );
}
