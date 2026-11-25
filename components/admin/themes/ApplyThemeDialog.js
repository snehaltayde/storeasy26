"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { NO_WRITE, postTheme } from "@/components/admin/themes/theme-words";

// "Use this theme" (Phase 5 line 3, storefront.write): writes a DRAFT of your
// design only; nothing changes for shoppers until Publish.
//   look: { kind: "package" | "builtin", id, label, sections } (sections: the
//         package's home sections count, 0 for a built-in look)
//   revision: the design's revision this page read (409 if someone else saved)
// A package: POST /api/admin/themes/[id] { apply }. A built-in look: the
// existing POST /api/admin/theme { action: "apply" } (it clears the package).
export function ApplyThemeDialog({ look, role, revision = null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [withBrand, setWithBrand] = useState(true);
  const [withHome, setWithHome] = useState(false);
  const [confirmHome, setConfirmHome] = useState(false);
  const pkg = look.kind === "package";

  async function go() {
    setBusy(true);
    setError(null);
    const r = pkg
      ? await postTheme(`themes/${encodeURIComponent(look.id)}`, { apply: { withBrand, withHome, confirmHome: withHome && confirmHome, ...(Number.isInteger(revision) ? { revision } : {}) } })
      : await postTheme("theme", { action: "apply", kit: look.id, withPresets: false, withBrand, ...(Number.isInteger(revision) ? { revision } : {}) });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "HOME_CONFIRM_NEEDED") setConfirmHome(false);
      return setError(r.error);
    }
    const note = r.applied?.note || r.note;
    toast.success(`${look.label} is in your draft. Preview it, then publish when you're ready.`);
    if (note) toast.info?.(note);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <RoleGate role={role} action="storefront.write" reason={NO_WRITE} mode="hide">
        <Button
          type="button"
          size="sm"
          data-themes-action="use"
          data-themes-look={look.id}
          onClick={() => {
            setError(null);
            setWithBrand(true);
            setWithHome(false);
            setConfirmHome(false);
            setOpen(true);
          }}
        >
          Use this theme
        </Button>
      </RoleGate>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent data-themes="apply-dialog">
          <DialogHeader>
            <DialogTitle>Use {look.label}?</DialogTitle>
            <DialogDescription>It goes into your design draft. Shoppers keep seeing your live store until you publish.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Checkbox id="apply-brand" checked={withBrand} onCheckedChange={(v) => setWithBrand(v === true)} data-themes-option="brand" />
              <Label htmlFor="apply-brand" className="font-normal">
                Also use its colours
              </Label>
            </div>
            {pkg && look.sections > 0 ? (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="apply-home"
                  checked={withHome}
                  onCheckedChange={(v) => {
                    setWithHome(v === true);
                    setConfirmHome(false);
                  }}
                  data-themes-option="home"
                />
                <Label htmlFor="apply-home" className="font-normal">
                  Also use its home layout ({look.sections} sections)
                </Label>
              </div>
            ) : null}
            {withHome ? (
              <div className="flex items-start gap-2 rounded-md bg-muted p-3">
                <Checkbox id="apply-home-confirm" checked={confirmHome} onCheckedChange={(v) => setConfirmHome(v === true)} data-themes-option="home-confirm" />
                <Label htmlFor="apply-home-confirm" className="font-normal">
                  Replace my home page draft with this theme's sections
                </Label>
              </div>
            ) : null}
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || (withHome && !confirmHome)} aria-busy={busy} onClick={go} data-themes-action="use-confirm">
              Put it in my draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
