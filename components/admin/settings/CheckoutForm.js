"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, SecretField, SELECT_CLASS } from "@/components/admin/settings/SecretField";
import { SaveBar, ReadOnlyNote, useSettingsSection } from "@/components/admin/settings/SaveBar";
import { shoppersPayWith } from "@/lib/admin/settings";

// Settings → Checkout and payments (Phase 2 line 7): checkout on or off, the
// store's timezone, the Razorpay key id, and the two Razorpay secrets
// write-only (SecretField). "Test keys" asks POST /api/admin/integrations
// { action: "test", provider: "razorpay" }: a read (settings.read) that
// checks the SAVED keys with Razorpay and stores nothing. The "Shoppers can
// pay with …" line is the open checks' payment item (the page reads it); after a
// save it follows the saved checkout mode and keys, except a block that isn't
// this tab's (billing paused, a checkout Storeasy's team has to turn on).
//   initial: { readOnly, commerce, payments, payment: { level, title, message } }
const toState = (v) => ({
  commerce: { checkout_mode: v.commerce?.checkout_mode || "direct", timezone: v.commerce?.timezone || "Asia/Kolkata" },
  payments: { razorpay_key_id: v.payments?.razorpay_key_id || "", razorpay_key_secret: "", razorpay_webhook_secret: "" },
});
const toBody = (s) => ({ commerce: s.commerce, payments: s.payments });

export function CheckoutForm({ initial, role }) {
  const form = useSettingsSection({ initial, toState, toBody });
  const { state, setState, view, readOnly, dirty } = form;
  const [test, setTest] = useState(null); // { busy } | { ok, words }
  const OFF = "Checkout is turned off";
  const foreign = view.payment?.level === "block" && view.payment.title !== OFF;
  const keys = Boolean(view.payments?.razorpay_key_id && view.payments?.has_key_secret);
  const payWith = view.payment
    ? shoppersPayWith(
        foreign ? view.payment : view.commerce?.checkout_mode === "disabled" ? { level: "block", message: "Turn checkout on below." } : { level: keys ? "ok" : "info" },
      )
    : null;
  const setC = (k) => (e) => setState((s) => ({ ...s, commerce: { ...s.commerce, [k]: e.target.value } }));
  const setP = (k) => (v) => setState((s) => ({ ...s, payments: { ...s.payments, [k]: v } }));

  async function testKeys() {
    setTest({ busy: true });
    try {
      const res = await fetch("/api/admin/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", provider: "razorpay" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setTest({ ok: true, words: "Razorpay accepted your saved keys." });
      else if (data.detail === "keys not configured") setTest({ ok: false, words: "There are no saved keys to test yet. Add the key id and key secret, save, then test." });
      else
        setTest({
          ok: false,
          words: `Razorpay didn't accept your saved keys. Check the key id and key secret in your Razorpay dashboard, then save them again.${data.detail ? ` (${data.detail})` : ""}`,
        });
    } catch {
      setTest({ ok: false, words: "That didn't go through. Check your connection and try again." });
    }
  }

  return (
    <div className="space-y-4" data-settings-tab="checkout">
      <form onSubmit={form.save} noValidate className="space-y-4">
        <ReadOnlyNote form={form} />
        {payWith && (
          <p data-settings="pay-with" className="rounded-card border border-border bg-muted px-4 py-3 text-sm text-foreground">
            {payWith}
          </p>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Checkout</CardTitle>
            <CardDescription>Prices, stock and tax come from Shopify; change them there.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field id="st-checkout-mode" label="Checkout" hint="Turned off, shoppers can still browse and fill their cart, but can't place an order.">
              <select
                id="st-checkout-mode"
                className={SELECT_CLASS}
                disabled={readOnly}
                value={state.commerce.checkout_mode}
                onChange={setC("checkout_mode")}
                aria-describedby="st-checkout-mode-hint"
              >
                <option value="direct">On: Razorpay and cash on delivery</option>
                <option value="disabled">Off</option>
              </select>
            </Field>
            <Field id="st-timezone" label="Your timezone" hint="Offer schedules and reports use it. A name like Asia/Kolkata.">
              <Input
                id="st-timezone"
                disabled={readOnly}
                value={state.commerce.timezone}
                onChange={setC("timezone")}
                placeholder="Asia/Kolkata"
                aria-describedby="st-timezone-hint"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Razorpay</CardTitle>
            <CardDescription>With these, shoppers can pay by card and UPI. Cash on delivery works without them.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field id="st-rzp-key-id" label="Key id" hint={'Starts with "rzp_live_" or "rzp_test_".'} className="md:col-span-2 md:max-w-sm">
              <Input
                id="st-rzp-key-id"
                disabled={readOnly}
                value={state.payments.razorpay_key_id}
                onChange={(e) => setP("razorpay_key_id")(e.target.value)}
                placeholder="rzp_live_…"
                aria-describedby="st-rzp-key-id-hint"
              />
            </Field>
            <SecretField
              id="st-rzp-key-secret"
              label="Key secret"
              isSet={view.payments?.has_key_secret}
              value={state.payments.razorpay_key_secret}
              onChange={setP("razorpay_key_secret")}
              disabled={readOnly}
            />
            <SecretField
              id="st-rzp-webhook-secret"
              label="Webhook secret"
              isSet={view.payments?.has_webhook_secret}
              value={state.payments.razorpay_webhook_secret}
              onChange={setP("razorpay_webhook_secret")}
              disabled={readOnly}
            />
          </CardContent>
        </Card>

        <SaveBar form={form} role={role} label="Save checkout and payments" />
      </form>
      {/* outside the form: a read, never a submit (scripts/support/read-controls.js) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Test your Razorpay keys</CardTitle>
          <CardDescription>
            {dirty ? "Save your changes first; the test uses the saved keys." : "Checks the saved keys with Razorpay. Nothing is charged or changed."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" variant="outline" onClick={testKeys} disabled={test?.busy || dirty} data-read-control>
            {test?.busy ? "Testing…" : "Test keys"}
          </Button>
          {test && !test.busy && (
            <Alert variant={test.ok ? "success" : "warning"}>
              <AlertDescription className="text-current">{test.words}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
