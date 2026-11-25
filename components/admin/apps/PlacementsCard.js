"use client";

// Phase 4 line 2: an installed app's "Where it shows" card, on its detail page
// (components/admin/apps/AppDetail.js, at {/* line 2: placements */}). One row
// per block the app adds: where on the storefront it sits, Live or Off, its
// order in that place, its own settings, and "Preview on store".
//   GET  /api/admin/apps/<id>/placements (apps.read)
//   POST the same, one change at a time (apps.manage)
// A role without apps.manage sees the same rows as plain words, with no
// control that would be refused.
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/kit/toast";
import { roleAllows } from "@/lib/platform/authz";
import { startDocumentsPreview } from "@/components/admin/editor/documentsApi";

const UNREADABLE = "We couldn't load where this app shows. Check your connection and try again.";
const SAVE_FAILED = "That change didn't reach the server, so nothing was saved. Check your connection and try again.";

async function ask(url, init) {
  let res;
  try {
    res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return { ok: false, body: { error: init ? SAVE_FAILED : UNREADABLE } };
  }
  const body = await res.json().catch(() => null);
  return { ok: res.ok && body?.ok === true, body: body || { error: init ? SAVE_FAILED : UNREADABLE } };
}

function SettingsForm({ placement, canManage, busy, onSave, errors }) {
  const [values, setValues] = useState(() => ({ ...placement.settings }));
  useEffect(() => setValues({ ...placement.settings }), [placement.settings]);
  if (!placement.form.length) return null;
  const changed = placement.form.some((f) => (values[f.key] ?? "") !== (placement.settings[f.key] ?? ""));
  if (!canManage) {
    return (
      <dl className="grid gap-2 text-[0.8125rem] sm:grid-cols-[10rem_1fr]">
        {placement.form.map((f) => (
          <div key={f.key} className="contents">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="break-words">{placement.settings[f.key] || <span className="text-muted-foreground">Not set</span>}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const out = {};
        for (const f of placement.form) {
          const v = typeof values[f.key] === "string" ? values[f.key].trim() : values[f.key];
          if (v !== "" && v != null) out[f.key] = v;
        }
        onSave(out);
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {placement.form.map((f) => {
          const id = `pl-${placement.blockId}-${f.key}`;
          const err = errors?.[f.key];
          return (
            <div key={f.key} className="grid gap-1.5">
              <Label htmlFor={id}>
                {f.label}
                {f.required ? null : <span className="font-normal text-muted-foreground"> (optional)</span>}
              </Label>
              <Input id={id} name={f.key} value={values[f.key] ?? ""} maxLength={f.max} placeholder={f.placeholder} aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-err` : undefined} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              {err ? (
                <p id={`${id}-err`} className="text-xs text-destructive">
                  {err}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div>
        <Button type="submit" size="sm" disabled={busy || !changed} data-placement-save={placement.blockId}>
          {busy ? "Saving…" : `Save ${placement.label.toLowerCase()}`}
        </Button>
      </div>
    </form>
  );
}

function PlacementRow({ placement, previewPath, canManage, busy, errors, onChange, onPreview }) {
  const live = placement.state === "live";
  const slotLabel = placement.slots.find((s) => s.id === placement.slot)?.label || placement.slot;
  return (
    <li className="grid gap-4 py-4 first:pt-0 last:pb-0" data-placement={placement.blockId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{placement.label}</p>
          <p className="text-[0.8125rem] text-muted-foreground">{live ? `Shoppers see it: ${slotLabel.toLowerCase()}.` : "Shoppers don't see it."}</p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={`pl-${placement.blockId}-live`} className="text-[0.8125rem] font-medium">
              {live ? "Live" : "Off"}
            </Label>
            <Switch id={`pl-${placement.blockId}-live`} checked={live} disabled={busy} aria-label={`Show ${placement.label.toLowerCase()} on your store`} onCheckedChange={(on) => onChange({ state: on ? "live" : "off" })} />
          </div>
        ) : (
          <Badge variant={live ? "success" : "muted"}>{live ? "Live" : "Off"}</Badge>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-56 gap-1.5">
          <Label htmlFor={`pl-${placement.blockId}-slot`}>Where it shows</Label>
          {canManage && placement.slots.length > 1 ? (
            <Select value={placement.slot} disabled={busy} onValueChange={(slot) => onChange({ slot })}>
              <SelectTrigger id={`pl-${placement.blockId}-slot`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {placement.slots.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p id={`pl-${placement.blockId}-slot`} className="text-sm">
              {slotLabel}
            </p>
          )}
        </div>
        {canManage ? (
          <div className="flex gap-1" role="group" aria-label={`Order of ${placement.label.toLowerCase()} in this place`}>
            <Button type="button" variant="outline" size="icon" disabled={busy || placement.first} aria-label="Move up" onClick={() => onChange({ move: "up" })}>
              <ArrowUp />
            </Button>
            <Button type="button" variant="outline" size="icon" disabled={busy || placement.last} aria-label="Move down" onClick={() => onChange({ move: "down" })}>
              <ArrowDown />
            </Button>
          </div>
        ) : null}
        {previewPath ? (
          <Button type="button" variant="outline" size="sm" data-read-control="" data-placement-preview={placement.blockId} onClick={() => onPreview(previewPath)}>
            <ExternalLink data-icon="inline-start" />
            Preview on store
          </Button>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">
            {placement.slots.find((s) => s.id === placement.slot)?.page === "order" ? "This place is on a shopper's own order page, so it can't be previewed here." : "No preview yet: add a product to your store to see this place."}
          </p>
        )}
      </div>

      <SettingsForm placement={placement} canManage={canManage} busy={busy} errors={errors} onSave={(settings) => onChange({ settings })} />
    </li>
  );
}

export default function PlacementsCard({ installId, role, installOff = false }) {
  const toast = useToast();
  const canManage = roleAllows(role, "apps.manage");
  const url = `/api/admin/apps/${encodeURIComponent(installId)}/placements`;
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null); // { blockId, message, errors }

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await ask(url);
    if (r.ok) setData(r.body);
    else setLoadError(r.body.error || UNREADABLE);
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);

  async function change(placement, patch) {
    setBusy(placement.blockId);
    setRefusal(null);
    const r = await ask(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ block: placement.blockId, ...patch }) });
    setBusy(null);
    if (!r.ok) {
      setRefusal({ blockId: placement.blockId, message: r.body.error || SAVE_FAILED, errors: r.body.errors || null });
      return;
    }
    setData(r.body);
    const words = patch.state ? (patch.state === "live" ? "is live" : "is off") : patch.slot ? "has moved" : patch.move ? "has moved" : "is saved";
    toast.success(`${placement.label} ${words}.`);
  }

  async function preview(path) {
    const r = await startDocumentsPreview();
    if (!r.ok) {
      setRefusal({ blockId: null, message: r.message || "The preview didn't open. Try again." });
      return;
    }
    window.open(path, "_blank", "noopener");
  }

  const off = installOff || (data && data.installStatus !== "enabled");
  return (
    <Card id="app-placements" data-placements-card="">
      <CardHeader>
        <CardTitle>Where it shows</CardTitle>
        <CardDescription>Choose where each part of this app appears on your store. Everything starts off: nothing shows until you turn it on.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {loadError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <Button type="button" size="sm" variant="outline" data-read-control="" onClick={load}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : !data ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading where this app shows">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : !data.placements.length ? (
          <p className="text-sm text-muted-foreground">This app doesn&rsquo;t add anything to your storefront.</p>
        ) : (
          <>
            {off ? (
              <Alert variant="warning">
                <AlertDescription>This app is off, so none of its parts show on your store, even ones set to Live. Turn the app on to show them.</AlertDescription>
              </Alert>
            ) : null}
            {refusal && !refusal.errors ? (
              <Alert variant="destructive" data-placement-refusal="">
                <AlertDescription>{refusal.message}</AlertDescription>
              </Alert>
            ) : null}
            <ul className="divide-y divide-border">
              {data.placements.map((p) => (
                <PlacementRow
                  key={p.blockId}
                  placement={p}
                  previewPath={data.previewPaths?.[p.slot] || null}
                  canManage={canManage}
                  busy={busy === p.blockId}
                  errors={refusal?.blockId === p.blockId ? refusal.errors : null}
                  onChange={(patch) => change(p, patch)}
                  onPreview={preview}
                />
              ))}
            </ul>
            {refusal?.errors ? (
              <Alert variant="destructive" data-placement-refusal="">
                <AlertDescription>{refusal.message}</AlertDescription>
              </Alert>
            ) : null}
            {canManage ? null : <Separator />}
            {canManage ? null : <p className="text-[0.8125rem] text-muted-foreground">Only an owner or admin can change where this app shows.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
