"use client";

import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, SELECT_CLASS } from "@/components/admin/settings/SecretField";
import { SaveBar, ReadOnlyNote, useSettingsSection } from "@/components/admin/settings/SaveBar";
import { RoleGate } from "@/components/kit/role-gate";
import { validateShippingConfig, shippingExample } from "@/lib/admin/settings";

// Settings → Shipping (Phase 2 line 7): the flat rate, free shipping over, the
// cash-on-delivery fee and when it is waived, the basis, and pincode zones.
// validateShippingConfig (the server's own check) runs as the founder types,
// so each field shows its own problem; the worked example is the shipping
// engine's answer in words. A store still on the starter rates can keep them
// as they are. Saves { shipping } only.
//   initial: { readOnly, shipping, shipping_is_default }
const blank = (v) => (v == null ? "" : String(v));
const toState = (v) => ({
  shipping: {
    currency: v.shipping?.currency || "INR",
    basis: v.shipping?.basis || "net",
    flatRate: blank(v.shipping?.flatRate),
    freeThreshold: blank(v.shipping?.freeThreshold),
    codFee: blank(v.shipping?.codFee),
    codFeeWaivedAt: blank(v.shipping?.codFeeWaivedAt),
    zones: (v.shipping?.zones || []).map((z) => ({
      label: z.label || "",
      prefixes: (z.prefixes || []).join(", "),
      flatRate: blank(z.flatRate),
      freeThreshold: blank(z.freeThreshold),
    })),
  },
});
const toBody = (s) => ({ shipping: s.shipping });

// validateShippingConfig's sentences, by the field they are about
const FIELD_OF = [
  ["Flat rate", "flatRate"],
  ["Free-shipping threshold", "freeThreshold"],
  ["COD-fee waiver threshold", "codFeeWaivedAt"],
  ["COD fee", "codFee"],
  ["Basis", "basis"],
];
function fieldErrors(errors) {
  const out = {};
  for (const e of errors) {
    const zone = /^Zone (\d+)/.exec(e);
    const key = zone ? `zone${Number(zone[1]) - 1}` : FIELD_OF.find(([p]) => e.startsWith(p))?.[1] || "form";
    out[key] = out[key] ? `${out[key]} ${e}.` : `${e}.`;
  }
  return out;
}

const MONEY = [
  { key: "flatRate", label: "Flat rate (₹)", hint: "What an order pays for delivery." },
  { key: "freeThreshold", label: "Free shipping over (₹)", hint: "Leave it empty to never ship free." },
  { key: "codFee", label: "Cash-on-delivery fee (₹)", hint: "Added when the shopper pays on delivery. 0 for none." },
  { key: "codFeeWaivedAt", label: "No cash-on-delivery fee over (₹)", hint: "Leave it empty to always charge it." },
];

export function ShippingForm({ initial, role }) {
  const form = useSettingsSection({ initial, toState, toBody, saved: "Saved. Shoppers pay these rates from their next cart." });
  const { state, setState, view, readOnly, dirty, busy } = form;
  const sh = state.shipping;
  const set = (k) => (e) => setState((s) => ({ ...s, shipping: { ...s.shipping, [k]: e.target.value } }));
  const zone = (i, patch) => setState((s) => ({ ...s, shipping: { ...s.shipping, zones: s.shipping.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) } }));
  const check = validateShippingConfig(sh);
  const errs = dirty ? fieldErrors(check.errors) : {};
  const example = shippingExample(sh);
  const starter = view.shipping_is_default && !dirty;

  return (
    <form onSubmit={form.save} noValidate className="space-y-4" data-settings-tab="shipping">
      <ReadOnlyNote form={form} />
      {starter && (
        <Alert variant="info">
          <AlertTitle>You haven't set your own shipping rates yet</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>Shoppers pay the starter rates below. Change them and save, or keep them as they are.</p>
            {!readOnly && (
              <RoleGate role={role} action="settings.write" reason="Only the owner or an admin can change settings.">
                <Button type="button" size="sm" disabled={busy} onClick={() => form.save(null, toBody(toState(view)))}>
                  Keep these rates
                </Button>
              </RoleGate>
            )}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Rates</CardTitle>
          <CardDescription>What shoppers pay for delivery, in the cart and at checkout.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {MONEY.map((f) => (
            <Field key={f.key} id={`st-${f.key}`} label={f.label} hint={f.hint} error={errs[f.key]}>
              <Input
                id={`st-${f.key}`}
                inputMode="decimal"
                disabled={readOnly}
                value={sh[f.key]}
                onChange={set(f.key)}
                aria-invalid={errs[f.key] ? true : undefined}
                aria-describedby={`st-${f.key}-hint${errs[f.key] ? ` st-${f.key}-error` : ""}`}
                className="font-mono"
              />
            </Field>
          ))}
          <Field id="st-basis" label="Free shipping counts" hint="Whether discounts come off before the free-shipping amount is checked." error={errs.basis}>
            <select id="st-basis" className={SELECT_CLASS} disabled={readOnly} value={sh.basis} onChange={set("basis")} aria-describedby="st-basis-hint">
              <option value="net">The total after discounts</option>
              <option value="gross">The total before discounts</option>
            </select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Pincode zones</CardTitle>
          <CardDescription>Different rates for some pincodes. The first zone that matches is used; every other pincode pays the rates above.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sh.zones.length === 0 && <p className="text-sm text-muted-foreground">No zones. Every pincode pays the same.</p>}
          {sh.zones.map((z, i) => (
            <div key={i} className="space-y-1">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_100px_100px_auto] sm:items-center">
                <Input aria-label={`Zone ${i + 1} name`} placeholder="Name, like Remote" disabled={readOnly} value={z.label} onChange={(e) => zone(i, { label: e.target.value })} />
                <Input
                  aria-label={`Zone ${i + 1} pincode starts`}
                  placeholder="Pincode starts, like 19, 18"
                  disabled={readOnly}
                  value={z.prefixes}
                  onChange={(e) => zone(i, { prefixes: e.target.value })}
                  className="font-mono"
                />
                <Input
                  aria-label={`Zone ${i + 1} rate`}
                  placeholder="Rate"
                  inputMode="decimal"
                  disabled={readOnly}
                  value={z.flatRate}
                  onChange={(e) => zone(i, { flatRate: e.target.value })}
                  className="font-mono"
                />
                <Input
                  aria-label={`Zone ${i + 1} free over`}
                  placeholder="Free over"
                  inputMode="decimal"
                  disabled={readOnly}
                  value={z.freeThreshold}
                  onChange={(e) => zone(i, { freeThreshold: e.target.value })}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove zone ${z.label || i + 1}`}
                  disabled={readOnly}
                  onClick={() => setState((s) => ({ ...s, shipping: { ...s.shipping, zones: s.shipping.zones.filter((_, j) => j !== i) } }))}
                >
                  <X aria-hidden />
                </Button>
              </div>
              {errs[`zone${i}`] && <p className="text-xs text-destructive">{errs[`zone${i}`]}</p>}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setState((s) => ({ ...s, shipping: { ...s.shipping, zones: [...s.shipping.zones, { label: "", prefixes: "", flatRate: "", freeThreshold: "" }] } }))}
          >
            <Plus aria-hidden />
            Add zone
          </Button>
        </CardContent>
      </Card>

      <Card data-settings="shipping-example">
        <CardHeader>
          <CardTitle className="text-base font-semibold">What a shopper pays</CardTitle>
        </CardHeader>
        <CardContent>
          {example.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {example.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Fix the rates above to see an example.</p>
          )}
          {errs.form && <p className="mt-2 text-xs text-destructive">{errs.form}</p>}
        </CardContent>
      </Card>

      <SaveBar form={form} role={role} label="Save shipping" />
    </form>
  );
}
