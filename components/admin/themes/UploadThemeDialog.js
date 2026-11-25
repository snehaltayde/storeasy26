"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleGate } from "@/components/kit/role-gate";
import { UploadIssues } from "@/components/admin/themes/UploadIssues";
import { NO_MANAGE, TEMPLATE_WORDS, postTheme } from "@/components/admin/themes/theme-words";

const MAX_BYTES = 256 * 1024;

// Upload theme (themes.manage; hidden for other roles, the route refuses them
// too): pick a .theme.json file, read it as text here, POST it. The button is
// disabled with a spinner while uploading. Success shows what the theme sets;
// a refusal lists every issue with its place.
export function UploadThemeDialog({ role }) {
  const router = useRouter();
  const input = useRef(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [done, setDone] = useState(null);
  const reset = () => {
    setFile(null);
    setRefusal(null);
    setDone(null);
    setBusy(false);
  };
  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    setRefusal(null);
    if (file.size > MAX_BYTES) return setRefusal({ error: "Theme packages can be up to 256 KB.", issues: null });
    setBusy(true);
    const text = await file.text();
    const r = await postTheme("themes", text);
    setBusy(false);
    if (!r.ok) return setRefusal({ error: r.error, issues: r.issues });
    setDone(r.package);
    router.refresh();
  }
  return (
    <>
      <RoleGate role={role} action="themes.manage" reason={NO_MANAGE} mode="hide">
        <Button type="button" data-themes-action="upload" onClick={() => setOpen(true)}>
          <Upload aria-hidden /> Upload theme
        </Button>
      </RoleGate>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return;
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent data-themes="upload-dialog">
          <DialogHeader>
            <DialogTitle>Upload a theme</DialogTitle>
            <DialogDescription>A theme is one .theme.json file of up to 256 KB. Uploading changes nothing on your store: you choose and publish a theme separately.</DialogDescription>
          </DialogHeader>
          {done ? (
            <div className="space-y-2 text-sm" data-themes="upload-done">
              <p className="font-medium">
                {done.name} {done.version} was uploaded.
              </p>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                <li>Based on {done.baseLabel}</li>
                {Object.entries(done.summary.templates).map(([k, v]) => (
                  <li key={k}>
                    {TEMPLATE_WORDS[k]}: {v}
                  </li>
                ))}
                <li>{done.summary.sections} home page sections</li>
                <li>{done.summary.rules} style rules</li>
              </ul>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={reset}>
                  Upload another
                </Button>
                <Button type="button" onClick={() => router.push(`/admin/themes/${encodeURIComponent(done.id)}`)}>
                  Open theme
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={upload} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="theme-file">Theme file</Label>
                <Input
                  id="theme-file"
                  ref={input}
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setRefusal(null);
                  }}
                />
              </div>
              {refusal ? <UploadIssues error={refusal.error} issues={refusal.issues} /> : null}
              <DialogFooter>
                <Button type="submit" disabled={!file || busy} aria-busy={busy} data-themes-action="upload-submit">
                  {busy ? (
                    <>
                      <Loader2 className="animate-spin" aria-hidden /> Uploading…
                    </>
                  ) : (
                    "Upload"
                  )}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
