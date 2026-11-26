"use client";

import { Globe, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, SELECT_CLASS } from "@/components/admin/settings/SecretField";
import { SaveBar, ReadOnlyNote, useSettingsSection } from "@/components/admin/settings/SaveBar";
import { convertPrice, rateIsStale, ROUNDING_RULES, STALE_RATE_DAYS } from "@/lib/markets";
import { formatMoney } from "@/lib/format";

// Settings → Markets (Phase 8 line 4, decisions 14 and 16). The base market is
// the store itself (read only: its country and Shopify's currency). Each other
// market: its countries, a Razorpay currency, a fixed rate ("1 USD = ₹84.20")
// with the date it was set, how prices round, its own shipping in its own
// currency, on or off, and the Razorpay international tick (refused without
// it). The price example comes from convertPrice, the function the storefront
// prices with.
//   initial: { readOnly, base: { country, name, currency }, markets, currencies, razorpayKeys }
const blank = (v) => (v == null ? "" : String(v));
const ROUNDING_WORDS = { exact: "Exact (no rounding)", whole: "Up to a whole unit", "x.99": "Up to .99" };
const EXAMPLE_PRICE = 1499;

const toState = (v) => ({
  markets: (v.markets || []).map((m) => ({
    id: m.id,
    countries: (m.countries || []).join(", "),
    currency: m.currency || "",
    rate: blank(m.rate),
    rateSetAt: m.rateSetAt || null,
    rounding: m.rounding || "x.99",
    flatRate: blank(m.flatRate),
    freeThreshold: blank(m.freeThreshold),
    enabled: m.enabled === true,
    international: m.international === true,
  })),
});
const toBody = (s) => ({
  markets: s.markets.map((m) => ({
    id: m.id,
    countries: m.countries,
    currency: m.currency,
    rate: m.rate === "" ? null : Number(m.rate),
    rounding: m.rounding,
    flatRate: m.flatRate,
    freeThreshold: m.freeThreshold,
    enabled: m.enabled,
    international: m.international,
  })),
});
const fresh = (currency) => ({ id: null, countries: "", currency, rate: "", rateSetAt: null, rounding: "x.99", flatRate: "", freeThreshold: "", enabled: false, international: false });

export function MarketsForm({ initial, role }) {
  const form = useSettingsSection({ initial, toState, toBody, saved: "Saved. Shoppers see the new markets within a minute." });
  const { state, setState, readOnly } = form;
  const base = initial.base;
  const set = (i, k) => (e) => {
    const value = e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e;
    setState((s) => ({ ...s, markets: s.markets.map((m, j) => (j === i ? { ...m, [k]: value } : m)) }));
  };
  const add = () => setState((s) => ({ ...s, markets: [...s.markets, fresh(initial.currencies[0] || "USD")] }));
  const remove = (i) => setState((s) => ({ ...s, markets: s.markets.filter((_, j) => j !== i) }));

  return (
    <div className="space-y-4" data-settings-tab="markets">
      <form onSubmit={form.save} noValidate className="space-y-4">
        <ReadOnlyNote form={form} />
        <Card data-markets="base">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Your store's own market</CardTitle>
            <CardDescription>
              {base.name} in {base.currency}, the currency of your Shopify store. Prices, cash on delivery and your shipping rates apply here as set on the other tabs.
            </CardDescription>
          </CardHeader>
        </Card>

        {!initial.razorpayKeys && (
          <Alert variant="info">
            <AlertDescription>Shoppers in other markets pay online only. Add your Razorpay keys under Checkout and payments first.</AlertDescription>
          </Alert>
        )}

        {state.markets.map((m, i) => {
          const rate = Number(m.rate);
          const market = rate > 0 && m.currency ? { currency: m.currency, rate, rounding: m.rounding } : null;
          const stale = m.rateSetAt && rate === Number(initial.markets?.find((x) => x.id === m.id)?.rate) && rateIsStale({ rateSetAt: m.rateSetAt });
          const p = `mk-${i}`;
          return (
            <Card key={i} data-market={m.id || `new-${i}`}>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Globe aria-hidden className="size-4 text-muted-foreground" />
                    {m.countries ? m.countries : "New market"}
                  </CardTitle>
                  <CardDescription>Shoppers shipping to these countries see prices and pay in {m.currency || "this currency"}. No cash on delivery.</CardDescription>
                </div>
                {!readOnly && (
                  <Button type="button" variant="ghost" size="sm" className="size-11 shrink-0 md:size-9" onClick={() => remove(i)} aria-label={`Remove market ${i + 1}`}>
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                )}
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <Field id={`${p}-countries`} label="Countries" hint="Two-letter country codes, separated by commas: US, CA." className="md:col-span-2">
                  <Input id={`${p}-countries`} disabled={readOnly} value={m.countries} onChange={set(i, "countries")} placeholder="US" aria-describedby={`${p}-countries-hint`} />
                </Field>
                <Field id={`${p}-currency`} label="Currency" hint="Only currencies Razorpay can charge.">
                  <select id={`${p}-currency`} className={SELECT_CLASS} disabled={readOnly} value={m.currency} onChange={set(i, "currency")} aria-describedby={`${p}-currency-hint`}>
                    {initial.currencies.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  id={`${p}-rate`}
                  label={`1 ${m.currency || "unit"} = ${base.currency}`}
                  hint={m.rateSetAt ? `Set on ${m.rateSetAt.slice(0, 10)}. Prices don't follow live exchange rates; change it here.` : "A fixed rate you choose. Prices don't follow live exchange rates."}
                >
                  <Input id={`${p}-rate`} inputMode="decimal" disabled={readOnly} value={m.rate} onChange={set(i, "rate")} placeholder="84.20" aria-describedby={`${p}-rate-hint`} />
                </Field>
                <Field id={`${p}-rounding`} label="Prices round" hint="Up, so a price never falls below your rate.">
                  <select id={`${p}-rounding`} className={SELECT_CLASS} disabled={readOnly} value={m.rounding} onChange={set(i, "rounding")} aria-describedby={`${p}-rounding-hint`}>
                    {ROUNDING_RULES.map((r) => (
                      <option key={r} value={r}>
                        {ROUNDING_WORDS[r]}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="space-y-1.5 self-end rounded-card border border-dashed border-border bg-muted px-4 py-3 text-sm" data-market-example>
                  {market ? (
                    <p>
                      A {formatMoney(EXAMPLE_PRICE, base.currency)} product shows as <strong className="text-base font-semibold tabular-nums">{formatMoney(convertPrice(EXAMPLE_PRICE, market), m.currency)}</strong>.
                    </p>
                  ) : (
                    <p className="text-muted-foreground">Enter a rate to see a price example.</p>
                  )}
                </div>
                <Field id={`${p}-flat`} label={`Shipping (${m.currency || "currency"})`} hint="Charged on every order below the free-shipping amount.">
                  <Input id={`${p}-flat`} inputMode="decimal" disabled={readOnly} value={m.flatRate} onChange={set(i, "flatRate")} placeholder="10" aria-describedby={`${p}-flat-hint`} />
                </Field>
                <Field id={`${p}-free`} label={`Free shipping from (${m.currency || "currency"})`} hint="Leave empty for no free shipping.">
                  <Input id={`${p}-free`} inputMode="decimal" disabled={readOnly} value={m.freeThreshold} onChange={set(i, "freeThreshold")} placeholder="100" aria-describedby={`${p}-free-hint`} />
                </Field>
                <label className="flex min-h-11 items-start gap-3 py-2 text-sm md:col-span-2 md:min-h-0 md:py-0">
                  <input type="checkbox" className="mt-0.5 size-4" disabled={readOnly} checked={m.international} onChange={set(i, "international")} data-market-international />
                  <span>International payments are on in my Razorpay account</span>
                </label>
                <label className="flex min-h-11 items-start gap-3 py-2 text-sm md:col-span-2 md:min-h-0 md:py-0">
                  <input type="checkbox" className="mt-0.5 size-4" disabled={readOnly} checked={m.enabled} onChange={set(i, "enabled")} data-market-enabled />
                  <span>Sell in this market (shoppers can choose it)</span>
                </label>
                {stale && (
                  <p className="flex items-start gap-2 rounded-card border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground md:col-span-2" data-market-stale>
                    <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                    This rate is more than {STALE_RATE_DAYS} days old. Check it still covers your costs.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}

        {state.markets.length === 0 && (
          <p data-markets="empty" className="rounded-card border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {readOnly ? "No other markets are set up." : "You only sell in your own market. Add a market to show prices and take payment in another currency."}
          </p>
        )}

        {!readOnly && (
          <Button type="button" variant="outline" onClick={add} disabled={!initial.currencies.length}>
            <Plus aria-hidden className="size-4" />
            Add a market
          </Button>
        )}
        <SaveBar form={form} role={role} label="Save markets" />
      </form>
    </div>
  );
}
