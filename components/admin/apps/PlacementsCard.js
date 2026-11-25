"use client";

// Phase 4 line 2: an installed app's "Where it shows" card, on its detail page
// (components/admin/apps/AppDetail.js, at {/* line 2: placements */}). One row
// per block the app adds: where on the storefront it sits, Live or Off, its
// order in that place, its own settings, and "Preview on store".
//   GET  /api/admin/apps/<id>/blocks (apps.read)
//   POST the same, one change at a time (apps.manage)
// A role without apps.manage sees the same rows with every write control
// gated (RoleGate apps.manage: aria-disabled with the reason) and the
// settings fields natively disabled.
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, ExternalLink, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/kit/toast";
import { RoleGate } from "@/components/kit/role-gate";
import { PlainControl } from "@/components/admin/apps/AppSettingsForm";
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

const NO_MANAGE_WORDS = "Only an owner or admin can change where this app shows.";
const same = (a, b) => (a ?? null) === (b ?? null);

// The block's own settings, each with its proper control (text, number,
// on/off, a choice), natively disabled for a role without apps.manage.
function SettingsForm({ placement, role, canManage, busy, onSave, errors }) {
  const [values, setValues] = useState(() => ({ ...placement.settings }));
  useEffect(() => setValues({ ...placement.settings }), [placement.settings]);
  if (!placement.form.length) return null;
  const changed = placement.form.some((f) => !same(values[f.key], placement.settings[f.key]));
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canManage) return;
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
                {f.required || f.kind === "boolean" ? null : <span className="font-normal text-muted-foreground"> (optional)</span>}
              </Label>
              <PlainControl s={f} id={id} value={values[f.key]} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} disabled={!canManage || busy} error={err} />
              {err ? (
                <p id={`${id}-error`} className="text-[0.8125rem] text-destructive">
                  {err}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div>
        <RoleGate role={role} action="apps.manage" reason={NO_MANAGE_WORDS}>
          <Button type="submit" size="sm" disabled={busy || !changed} data-placement-save={placement.blockId}>
            {busy ? "Saving…" : `Save ${placement.label.toLowerCase()}`}
          </Button>
        </RoleGate>
      </div>
    </form>
  );
}

function PlacementRow({ placement, previewPath, role, canManage, busy, errors, onChange, onPreview }) {
  const live = placement.state === "live";
  const slotLabel = placement.slots.find((s) => s.id === placement.slot)?.label || placement.slot;
  const name = placement.label.toLowerCase();
  return (
    <li className="grid gap-4 py-4 first:pt-0 last:pb-0" data-placement={placement.blockId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{placement.label}</p>
          <p className="text-[0.8125rem] text-muted-foreground">{live ? `Shoppers see it: ${slotLabel.toLowerCase()}.` : "Shoppers don't see it."}</p>
        </div>
        <RoleGate role={role} action="apps.manage" reason={NO_MANAGE_WORDS}>
          <Button
            type="button"
            id={`pl-${placement.blockId}-live`}
            role="switch"
            aria-checked={live}
            aria-label={`Show ${name} on your store`}
            variant={live ? "default" : "outline"}
            size="sm"
            disabled={busy}
            data-placement-state={live ? "live" : "off"}
            onClick={() => onChange({ state: live ? "off" : "live" })}
          >
            {live ? "Live" : "Off"}
          </Button>
        </RoleGate>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-56 gap-1.5">
          <Label htmlFor={`pl-${placement.blockId}-slot`}>Where it shows</Label>
          {placement.slots.length < 2 ? (
            <p id={`pl-${placement.blockId}-slot`} className="text-sm">
              {slotLabel}
            </p>
          ) : canManage ? (
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
            // the gated form of the place picker: the current place, aria-disabled with the reason
            <RoleGate role={role} action="apps.manage" reason={NO_MANAGE_WORDS}>
              <Button type="button" id={`pl-${placement.blockId}-slot`} variant="outline" className="w-full justify-start">
                {slotLabel}
              </Button>
            </RoleGate>
          )}
        </div>
        <div className="flex gap-1" role="group" aria-label={`Order of ${name} in this place`}>
          <RoleGate role={role} action="apps.manage" reason={NO_MANAGE_WORDS}>
            <Button type="button" variant="outline" size="icon" disabled={busy || placement.first} aria-label="Move up" data-placement-move="up" onClick={() => onChange({ move: "up" })}>
              <ArrowUp aria-hidden="true" />
            </Button>
          </RoleGate>
          <RoleGate role={role} action="apps.manage" reason={NO_MANAGE_WORDS}>
            <Button type="button" variant="outline" size="icon" disabled={busy || placement.last} aria-label="Move down" data-placement-move="down" onClick={() => onChange({ move: "down" })}>
              <ArrowDown aria-hidden="true" />
            </Button>
          </RoleGate>
        </div>
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

      <SettingsForm placement={placement} role={role} canManage={canManage} busy={busy} errors={errors} onSave={(settings) => onChange({ settings })} />
    </li>
  );
}

export default function PlacementsCard({ installId, role, installOff = false }) {
  const toast = useToast();
  const canManage = roleAllows(role, "apps.manage");
  const url = `/api/admin/apps/${encodeURIComponent(installId)}/blocks`;
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
    <Card id="app-blocks" data-blocks-card="">
      <CardHeader>
        <CardTitle>Where it shows</CardTitle>
        <CardDescription>Choose where each part of this app appears on your store. Everything starts off: nothing shows until you turn it on.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {loadError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
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
        ) : !data.blocks.length ? (
          <p className="text-sm text-muted-foreground">This app doesn&rsquo;t add anything to your storefront.</p>
        ) : (
          <>
            {off ? (
              <Alert variant="warning">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>This app is off, so none of its parts show on your store, even ones set to Live. Turn the app on to show them.</AlertDescription>
              </Alert>
            ) : null}
            {refusal && !refusal.errors ? (
              <Alert variant="destructive" role="alert" data-placement-refusal="">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{refusal.message}</AlertDescription>
              </Alert>
            ) : null}
            <ul className="divide-y divide-border">
              {data.blocks.map((p) => (
                <PlacementRow
                  key={p.blockId}
                  placement={p}
                  previewPath={data.previewPaths?.[p.slot] || null}
                  role={role}
                  canManage={canManage}
                  busy={busy === p.blockId}
                  errors={refusal?.blockId === p.blockId ? refusal.errors : null}
                  onChange={(patch) => change(p, patch)}
                  onPreview={preview}
                />
              ))}
            </ul>
            {refusal?.errors ? (
              <Alert variant="destructive" role="alert" data-placement-refusal="">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{refusal.message}</AlertDescription>
              </Alert>
            ) : null}
            {canManage ? null : <Separator />}
            {canManage ? null : <p className="text-[0.8125rem] text-muted-foreground">{NO_MANAGE_WORDS}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
