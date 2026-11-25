"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
//   Publish  (storefront.publish; staff see "Ask an admin to publish"): the
//            documents publishSet of the design and the layout and home
//            drafts the theme wrote (release, publish_log and audit in one
//            batch; an archived theme is refused there)
//   state: GET /api/admin/themes state; names: { live, draft } look names
export function ThemeDraftBar({ state, names, role }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  if (!state?.publishSet?.length) return null;

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
    const r = await putDocuments({ publishSet: state.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })) });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    toast.success(`${names.draft} is live on your store.`);
    router.refresh();
  }

  const others = state.publishSet.filter((d) => d.id !== "doc_design").map((d) => d.label);
  return (
    <Alert data-themes="draft-bar">
      <AlertTitle>
        Your draft uses {names.draft}. Your live store uses {names.live}.
      </AlertTitle>
      <AlertDescription>
        <p>
          {PREVIEW_NOTE}
          {others.length ? ` Publishing also puts these drafts live: ${others.join(", ")}.` : ""}
        </p>
        {error ? <p className="mt-2 text-destructive">{error}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!!busy} aria-busy={busy === "preview"} onClick={preview} data-themes-action="preview">
            <ExternalLink aria-hidden /> Preview
          </Button>
          <RoleGate role={role} action="storefront.publish" reason={NO_PUBLISH}>
            <Button type="button" size="sm" disabled={!!busy} aria-busy={busy === "publish"} onClick={publish} data-themes-action="publish">
              Publish
            </Button>
          </RoleGate>
          {!roleAllows(role, "storefront.publish") ? <span className="self-center text-sm text-muted-foreground">{NO_PUBLISH}</span> : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
