"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, Trash2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge } from "@/components/kit/status-badge";
import { useToast } from "@/components/kit/toast";
import { ConfirmAction, sendJson, useLeaveGuard } from "@/components/admin/offers/ConfirmAction";
import { RefCombobox, loadVariants } from "@/components/admin/offers/RefCombobox";
import { ScheduleField, isoToZoned, zonedToIso } from "@/components/admin/offers/ScheduleField";
import { offerScheduleStatus } from "@/lib/admin/schedule";
import { BundleCheck, allWords, applyPick, componentLabel, emptyQuantity, isPickedVariant, quantityFrom, rowWords } from "./BundleCheck";

// Create or edit one bundle (Phase 2 line 4) on POST /api/admin/bundles: a
// name, a description, products picked (never typed) with quantities, and a
// price. A debounced live check (POST {check}) says the products' sum, the
// saving, or the reasons it can't be sold, per product row and under the
// price. "Turn on after saving" turns it on with the save (a new bundle is
// created with mustPass, so nothing is saved if it can't be sold). A taken
// link (409) and a refusal with reasons (422) are said in words; nothing
// typed is lost. Support reads the bundle with every field disabled and no
// Save or Delete (POST {check} is offers.write, so the page's own first
// check is what support sees).
const NO_WRITE = "Your role can look at bundles but not change them.";
const HOME_GOES = "Shoppers will stop seeing this bundle on your home page right away.";

const rowsFrom = (items, components) =>
  (items || []).filter((c) => c?.variantId).map((c, i) => ({ variantId: c.variantId, quantity: c.quantity ?? 1, label: componentLabel(components?.[i]) }));

export function BundleEditor({ initial = null, initialCheck = null, currency, timezone = "UTC", role, canWrite }) {
  const router = useRouter();
  const toast = useToast();
  const ro = !canWrite;
  const start = useRef({ title: initial?.title || "", description: initial?.description || "", price: initial?.bundle_price != null ? String(initial.bundle_price) : "", rows: rowsFrom(initial?.items, initialCheck?.components), startsAt: isoToZoned(initial?.starts_at, timezone), endsAt: isoToZoned(initial?.ends_at, timezone) });
  const [title, setTitle] = useState(start.current.title);
  const [description, setDescription] = useState(start.current.description);
  const [price, setPrice] = useState(start.current.price);
  const [rows, setRows] = useState(start.current.rows);
  // Phase 8 line 5: when shoppers see it, in the store's time (ScheduleField),
  // sent as UTC ISO and mirrored onto the bundle's offer row by the server
  const [when, setWhen] = useState({ startsAt: start.current.startsAt, endsAt: start.current.endsAt });
  const win = { starts_at: zonedToIso(when.startsAt, timezone), ends_at: zonedToIso(when.endsAt, timezone) };
  const windowBad = Boolean(win.starts_at && win.ends_at && win.starts_at >= win.ends_at);
  const [turnOn, setTurnOn] = useState(false);
  const key = JSON.stringify([rows.map((r) => [r.variantId, r.quantity]), price]);
  const startKey = useRef(key);
  const [check, setCheck] = useState(initialCheck ? { key, ...initialCheck } : null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState(null);
  const [errors, setErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const seq = useRef(0);
  const dirty = JSON.stringify({ title, description, price, rows, ...when }) !== JSON.stringify(start.current) || turnOn;
  const leaving = useLeaveGuard(dirty && !ro);

  const unpicked = rows.some((r) => !isPickedVariant(r.variantId));
  const blank = rows.some((r) => emptyQuantity(r.quantity));
  const items = () => rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity }));

  // the live check, debounced; only after a change (the page ran the first)
  useEffect(() => {
    if (ro || key === startKey.current) return undefined;
    const n = ++seq.current;
    if (rows.length < 1 || blank || unpicked) {
      setCheck(null);
      setChecking(false);
      setCheckErr(null);
      return undefined;
    }
    setChecking(true);
    const h = setTimeout(() => {
      sendJson("/api/admin/bundles", "POST", { check: { items: items(), bundle_price: price === "" ? null : Number(price) } }).then(
        (r) => {
          if (n !== seq.current) return;
          setCheck({ key, ...(r.compat || {}) });
          setCheckErr(null);
          setChecking(false);
        },
        (e) => {
          if (n !== seq.current) return;
          setCheck(null);
          setCheckErr(e.message);
          setChecking(false);
        },
      );
    }, 400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = check && check.key === key ? check : null;
  const reasons = current?.reasons || [];
  const passes = current?.state === "available";
  const labelOf = (r, i) => r.label || componentLabel(current?.components?.[i]) || null;
  const canSave = !busy && rows.length > 0 && !blank && !unpicked && title.trim() && price !== "" && !windowBad && (initial ? dirty : true);

  const back = (message) => {
    leaving.current = true;
    toast.success(message);
    router.push("/admin/bundles");
    router.refresh();
  };

  async function save() {
    setBusy(true);
    setErrors(null);
    try {
      const base = { title, description, items: items(), bundle_price: Number(price), ...win };
      const r = initial
        ? await sendJson("/api/admin/bundles", "POST", { bundle: { id: initial.id, ...base, ...(turnOn ? { enable: true } : {}) } })
        : await sendJson("/api/admin/bundles", "POST", { create: { ...base, enable: turnOn, mustPass: turnOn } });
      const on = Boolean(r.bundle?.enabled);
      back(initial ? (on ? "Saved. Shoppers see the bundle as it is now." : "Saved. The bundle is off, so shoppers don't see it.") : on ? `“${r.bundle?.title}” is saved and on.` : `“${r.bundle?.title}” is saved and off.`);
    } catch (e) {
      const body = e.body || {};
      if (Array.isArray(body.reasons) && body.reasons.length) setCheck({ key, state: body.state, reasons: body.reasons, components: current?.components, componentsSum: current?.componentsSum });
      const said = allWords(body.reasons, currency);
      setErrors([e.message, ...(said.length && e.status === 422 ? said : [])]);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumb={[{ label: "Bundles", href: "/admin/bundles" }, { label: initial ? "Edit" : "New" }]}
        title={initial ? initial.title : "New bundle"}
        description={initial ? (ro ? "You can look at this bundle but not change it." : undefined) : "Pick the products and a price that saves money. Turn it on now or later."}
        actions={
          initial ? (
            <>
              <span data-bundle-schedule={offerScheduleStatus({ enabled: !!initial.enabled, starts_at: initial.starts_at ?? null, ends_at: initial.ends_at ?? null })}>
                <StatusBadge kind="bundle" status={offerScheduleStatus({ enabled: !!initial.enabled, starts_at: initial.starts_at ?? null, ends_at: initial.ends_at ?? null })} />
              </span>
              <RoleGate role={role} action="offers.write" mode="hide" reason={NO_WRITE}>
                <Button type="button" variant="destructive" onClick={() => setAskDelete(true)}>
                  <Trash2 aria-hidden /> Delete
                </Button>
              </RoleGate>
            </>
          ) : null
        }
      />

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>The bundle</CardTitle>
            {initial?.slug && (
              <CardDescription data-bundle-link>
                Shoppers&rsquo; link: <span className="font-mono text-foreground">/bundles/{initial.slug}</span>
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bundle-name">Name</Label>
              <Input id="bundle-name" disabled={ro} placeholder="Starter set" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bundle-desc">Description</Label>
              <Textarea id="bundle-desc" disabled={ro} rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
              <p className="text-xs text-muted-foreground">Shown on the bundle page.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Products</CardTitle>
            <CardDescription>Pick at least two. Picking one that is already here adds to its quantity.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2" data-bundle-products>
              {rows.map((r, i) => {
                const label = labelOf(r, i);
                const said = [...(isPickedVariant(r.variantId) ? [] : ["Pick this product again with Change: it was saved by its web name."]), ...(emptyQuantity(r.quantity) ? ["Enter how many of this product, 1 or more."] : []), ...rowWords(reasons, i, currency)];
                return (
                  <li key={`${r.variantId}-${i}`} className={cn("rounded-md border p-2", said.length ? "border-warning/50 bg-warning/5" : "border-border")} data-bundle-row={i}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label || (isPickedVariant(r.variantId) ? "A product" : `“${r.variantId}”`)}</span>
                      <RefCombobox label={`Change ${label || `product ${i + 1}`}`} buttonText="Change" disabled={ro || busy} selectedId={r.variantId} load={loadVariants} onPick={(o) => setRows(applyPick(rows, i, { variantId: o.id, label: o.label }))} />
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        disabled={ro}
                        className="w-20"
                        aria-label={`Quantity of ${label || `product ${i + 1}`}`}
                        aria-invalid={emptyQuantity(r.quantity) || !Number.isInteger(Number(r.quantity)) || undefined}
                        value={r.quantity}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: quantityFrom(e.target.value) } : x)))}
                      />
                      {!ro && (
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${label || `product ${i + 1}`}`} disabled={busy} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                          <X aria-hidden />
                        </Button>
                      )}
                    </div>
                    {said.length > 0 && (
                      <p className="mt-1 flex items-start gap-1 px-1 text-xs text-warning-text" data-bundle-row-reason>
                        <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                        <span>{said.join(" · ")}</span>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {rows.length === 0 && <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">{ro ? "No products yet." : "No products yet. Add at least two."}</p>}
            {!ro && <RefCombobox label="Add a product" buttonText="Add a product" disabled={busy} load={loadVariants} onPick={(o) => setRows(applyPick(rows, "new", { variantId: o.id, label: o.label }))} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bundle-price">Bundle price</Label>
              <Input id="bundle-price" type="number" min="1" inputMode="decimal" disabled={ro} className="w-40" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <BundleCheck check={current} price={price} currency={currency} checking={checking} error={checkErr} />
            {!ro && !initial?.enabled && (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox checked={turnOn} onCheckedChange={(v) => setTurnOn(v === true)} aria-describedby="turn-on-hint" />
                Turn on after saving
              </label>
            )}
            {!ro && !initial?.enabled && (
              <p id="turn-on-hint" className="text-xs text-muted-foreground">
                {turnOn ? (passes ? "Shoppers see it as soon as you save." : "It turns on only if the check passes; otherwise nothing is saved and the reasons show here.") : "It is saved turned off. Turn it on from Bundles when you're ready."}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>When shoppers see it</CardTitle>
            <CardDescription>Leave both empty to show it whenever it&rsquo;s on. Outside these dates the bundle&rsquo;s page and cards are hidden and the cart gives no bundle price.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2" data-bundle-window>
            <ScheduleField startsAt={when.startsAt} endsAt={when.endsAt} tz={timezone} disabled={ro} onChange={(patch) => setWhen((w) => ({ ...w, ...patch }))} />
            {windowBad && (
              <p className="text-sm font-medium text-warning-text" data-bundle-window-reason>
                The end must be after the start.
              </p>
            )}
          </CardContent>
        </Card>

        {errors && (
          <div role="alert" className="rounded-card border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-bundle-errors>
            <p className="flex items-center gap-2 font-medium">
              <CircleAlert aria-hidden className="size-4 shrink-0" />
              The bundle didn&rsquo;t save
            </p>
            <ul className="mt-1 space-y-0.5 pl-6">
              {errors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80 sm:mx-0 sm:rounded-card sm:border" data-bundle-actions>
          <Link href="/admin/bundles" data-read-control className={buttonVariants({ variant: "outline" })}>
            {ro ? "Back to bundles" : "Cancel"}
          </Link>
          <RoleGate role={role} action="offers.write" mode="hide" reason={NO_WRITE}>
            <Button type="button" disabled={!canSave} onClick={save} data-bundle-save>
              {busy ? "Saving…" : initial ? "Save changes" : "Save bundle"}
            </Button>
          </RoleGate>
        </div>
      </div>

      {initial && canWrite && (
        <ConfirmAction
          open={askDelete}
          onOpenChange={setAskDelete}
          title="Delete this bundle?"
          destructive
          confirmLabel="Delete bundle"
          body={
            <p>
              Removes “{initial.title}” for good. Its cart offer goes too, so shoppers can no longer buy it as a bundle.
              {initial.usedOnHome ? ` ${HOME_GOES}` : initial.usedOnHome == null ? " We couldn't check whether your home page uses this bundle." : ""}
            </p>
          }
          onConfirm={async () => {
            await sendJson("/api/admin/bundles", "POST", { remove: { id: initial.id } });
            back(`Deleted “${initial.title}”.`);
          }}
        />
      )}
    </div>
  );
}
