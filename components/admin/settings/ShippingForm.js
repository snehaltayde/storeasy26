"use client";

import { Plus, ReceiptText, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
// Phase 8 line 1: dispatch days, default delivery days and, per zone, its own
// delivery days and whether cash on delivery is open there. Blank stays absent,
// so an untouched store saves the JSON it already had.
//   initial: { readOnly, shipping, shipping_is_default, timeZone }
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
      deliveryDays: dayRange(z.deliveryDays),
      cod: z.cod === false ? false : z.cod === true ? true : "",
    })),
    dispatchDays: blank(v.shipping?.dispatchDays),
    deliveryDays: dayRange(v.shipping?.deliveryDays),
  },
});
const dayRange = (d) => ({ min: blank(d?.min), max: blank(d?.max) });
const NEW_ZONE = { label: "", prefixes: "", flatRate: "", freeThreshold: "", deliveryDays: { min: "", max: "" }, cod: "" };
const toBody = (s) => ({ shipping: s.shipping });

// validateShippingConfig's sentences, by the field they are about
const FIELD_OF = [
  ["Flat rate", "flatRate"],
  ["Free-shipping threshold", "freeThreshold"],
  ["COD-fee waiver threshold", "codFeeWaivedAt"],
  ["COD fee", "codFee"],
  ["Basis", "basis"],
  ["Dispatch days", "dispatchDays"],
  ["Delivery days", "deliveryDays"],
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
  const example = shippingExample(sh, { timeZone: initial.timeZone });
  const setDays = (k) => (e) => setState((s) => ({ ...s, shipping: { ...s.shipping, deliveryDays: { ...s.shipping.deliveryDays, [k]: e.target.value } } }));
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
          <CardTitle className="text-base font-semibold">Delivery times</CardTitle>
          <CardDescription>Shoppers see a delivery date on the product page and at checkout. Leave delivery days empty to show no date.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field id="st-dispatchDays" label="Days to dispatch" hint="0 to 10. Days before an order leaves you." error={errs.dispatchDays}>
            <Input
              id="st-dispatchDays"
              inputMode="numeric"
              disabled={readOnly}
              value={sh.dispatchDays}
              onChange={set("dispatchDays")}
              aria-invalid={errs.dispatchDays ? true : undefined}
              aria-describedby={`st-dispatchDays-hint${errs.dispatchDays ? " st-dispatchDays-error" : ""}`}
              className="font-mono"
            />
          </Field>
          {["min", "max"].map((k) => (
            <Field
              key={k}
              id={`st-delivery-${k}`}
              label={k === "min" ? "Delivery takes at least (days)" : "Delivery takes at most (days)"}
              hint="1 to 30, after dispatch."
              error={k === "max" ? errs.deliveryDays : undefined}
            >
              <Input
                id={`st-delivery-${k}`}
                inputMode="numeric"
                disabled={readOnly}
                value={sh.deliveryDays[k]}
                onChange={setDays(k)}
                aria-invalid={errs.deliveryDays ? true : undefined}
                aria-describedby={`st-delivery-${k}-hint${k === "max" && errs.deliveryDays ? ` st-delivery-${k}-error` : ""}`}
                className="font-mono"
              />
            </Field>
          ))}
        </CardContent>
      </Card>

      <section data-settings="shipping-example" aria-labelledby="st-example-title" className="rounded-card border border-dashed border-border bg-muted px-4 py-4">
        <h3 id="st-example-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ReceiptText aria-hidden className="size-4 text-muted-foreground" />
          What a shopper pays
          {dirty && <span className="text-xs font-normal text-muted-foreground">with your unsaved rates</span>}
        </h3>
        {example.length ? (
          <ul className="mt-3 divide-y divide-dashed divide-border text-sm" aria-live="polite">
            {example.map((line) => (
              <li key={line} className="py-2 first:pt-0 last:pb-0">
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Fix the rates above to see an example.</p>
        )}
        {errs.form && <p className="mt-2 text-xs text-destructive">{errs.form}</p>}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Pincode zones</CardTitle>
          <CardDescription>Different rates for some pincodes. The first zone that matches is used; every other pincode pays the rates above.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sh.zones.length === 0 && <p className="text-sm text-muted-foreground">No zones. Every pincode pays the same.</p>}
          {sh.zones.map((z, i) => (
            <div key={i} className="space-y-1">
              <div className="grid grid-cols-2 gap-2 rounded-md border border-dashed border-border p-2 sm:grid-cols-[1fr_1fr_100px_100px_auto] sm:items-center sm:border-0 sm:p-0">
                <Input className="col-span-2 sm:col-span-1" aria-label={`Zone ${i + 1} name`} placeholder="Name, like Remote" disabled={readOnly} value={z.label} onChange={(e) => zone(i, { label: e.target.value })} />
                <Input
                  aria-label={`Zone ${i + 1} pincode starts`}
                  placeholder="Pincode starts, like 19, 18"
                  disabled={readOnly}
                  value={z.prefixes}
                  onChange={(e) => zone(i, { prefixes: e.target.value })}
                  className="col-span-2 font-mono sm:col-span-1"
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
                  className="col-span-2 justify-self-end sm:col-span-1"
                  aria-label={`Remove zone ${z.label || i + 1}`}
                  disabled={readOnly}
                  onClick={() => setState((s) => ({ ...s, shipping: { ...s.shipping, zones: s.shipping.zones.filter((_, j) => j !== i) } }))}
                >
                  <X aria-hidden />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-0.5">
                <Input
                  aria-label={`Zone ${i + 1} delivery days, at least`}
                  placeholder="Days, at least"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={z.deliveryDays.min}
                  onChange={(e) => zone(i, { deliveryDays: { ...z.deliveryDays, min: e.target.value } })}
                  className="w-32 font-mono"
                />
                <Input
                  aria-label={`Zone ${i + 1} delivery days, at most`}
                  placeholder="Days, at most"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={z.deliveryDays.max}
                  onChange={(e) => zone(i, { deliveryDays: { ...z.deliveryDays, max: e.target.value } })}
                  className="w-32 font-mono"
                />
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Checkbox
                    aria-label={`Zone ${i + 1} cash on delivery`}
                    disabled={readOnly}
                    checked={z.cod !== false}
                    onCheckedChange={(c) => zone(i, { cod: c === true ? "" : false })}
                  />
                  Cash on delivery
                </label>
              </div>
              {errs[`zone${i}`] && <p className="text-xs text-destructive">{errs[`zone${i}`]}</p>}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setState((s) => ({ ...s, shipping: { ...s.shipping, zones: [...s.shipping.zones, NEW_ZONE] } }))}
          >
            <Plus aria-hidden />
            Add zone
          </Button>
        </CardContent>
      </Card>

      <SaveBar form={form} role={role} label="Save shipping" />
    </form>
  );
}
