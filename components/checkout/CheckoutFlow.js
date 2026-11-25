"use client";

import { useEffect, useRef, useState } from "react";
import Image from "@/components/StoreImage";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { friendlyCheckoutError } from "@/lib/shopper-errors";
import { track } from "@/lib/track/client";
import { paymentTerms } from "@/lib/checkout/payment-terms";
import { computeShipping } from "@/lib/shipping";
import AddressStep from "./AddressStep";
import PaymentStep from "./PaymentStep";
import OrderSummary from "./OrderSummary";
import CodOtpDialog from "./CodOtpDialog";
import useQuote from "./useQuote";
import { placeOrder as place, postCheckout } from "./placeOrder";
import { emptyForm, applyAddress, addressValid } from "./checkoutModel";

const STEPS = ["Address", "Review", "Payment"];

export default function CheckoutFlow({ cart: pageCart, razorpayEnabled, storeName = "Store", logo = null, policies = [], shippingConfig: pageShippingConfig, paymentConfig = null, timeZone, countries = [], initialCountry = "IN" }) {
  const [step, setStep] = useState(0);
  // P1-RATES: the cart and rates this page prices with. They start as the
  // page's and are replaced by the server's when it refuses a total that has
  // changed, so the summary and the button show what the server will charge.
  const [cart, setCart] = useState(pageCart);
  const [shippingConfig, setShippingConfig] = useState(pageShippingConfig);
  const [form, setForm] = useState(() => emptyForm(initialCountry));
  const [method, setMethod] = useState("cod");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");
  // Phase 8 line 2: the open code dialog, and the challenge it verified
  const [otp, setOtp] = useState(null); // { challengeId, sentTo, resendIn, sentAt, error, busy }
  const [challenge, setChallenge] = useState(null); // a verified challenge id

  // Phase 8 step 0: the form changes only through applyAddress (./checkoutModel).
  const changeAddress = (patch, source) => setForm((f) => applyAddress(f, patch, source));
  const valid = addressValid(form);

  const contact = { email: form.email, phone: form.phone, name: form.name };
  const address = {
    line1: form.line1,
    line2: form.line2,
    city: form.city,
    state: form.state,
    pincode: form.pincode,
    // Phase 8 line 4: the chosen country decides the market (the server names it)
    country_code: form.country_code,
    country: countries.find((c) => c.country === form.country_code)?.name || "India",
  };
  // Phase 8 line 4: a cart priced in another market carries `market`; COD and
  // the PIN-code zones are the store's own country's only.
  const outsideBase = Boolean(cart.market);
  // the quote moved the market (a new country): redraw from its cart and rates
  const marketMoved = (data) => {
    if (data.cart?.items) setCart(data.cart);
    setShippingConfig(data.shippingConfig ?? undefined);
    paymentKey(true);
    setChallenge(null);
  };

  // Phase 8 line 2 (decision 10): every amount on this page is the server's
  // quote for this cart and PIN code. Until it lands, the same pure function
  // draws with the store's own rates and payment rules from the server (GEN-03:
  // `config: shippingConfig` is this store's, never the code default).
  const quote = useQuote({ cart, address, onMarket: marketMoved });
  const terms = quote.terms || paymentTerms({ cart, shippingConfig, paymentConfig, pincode: outsideBase ? null : form.pincode || null, prepaidAvailable: razorpayEnabled, outsideBase });
  // COD hidden here (zone or limit) → paying online is the method
  const chosen = method === "cod" && !terms.cod.available ? "razorpay" : method;
  const selected = chosen === "cod" ? terms.cod : terms.prepaid;
  // Phase 8 line 1: the store's delivery estimate for this PIN (lib/shipping.js), shown in the summary
  const estimate = outsideBase ? null : computeShipping({ subtotal: 0, pincode: form.pincode || null, config: shippingConfig ?? undefined }).estimate ?? null;
  const shipping = { total: selected.shipping, codFee: chosen === "cod" ? terms.cod.fee : 0, estimate };
  const grandTotal = selected.total;

  const eventItems = () =>
    cart.items.map((it) => ({
      id: it.variantNumericId,
      name: it.title,
      price: it.price,
      quantity: it.quantity,
    }));

  // begin_checkout — once per checkout visit
  const beganRef = useRef(false);
  useEffect(() => {
    if (beganRef.current) return;
    beganRef.current = true;
    track("begin_checkout", {
      value: cart.total,
      currency: cart.currency,
      items: eventItems(),
      params: cart.couponStatus?.valid ? { coupon: cart.couponStatus.code } : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One idempotency key per payment ATTEMPT — minted on first submit, reused by
  // retries (double click, network retry, Razorpay modal reopen) so the server
  // returns the SAME order instead of creating a second one. Rotated only when
  // the server 409s (the key no longer matches the cart).
  const intentKey = useRef(null);
  function paymentKey(rotate = false) {
    if (rotate || !intentKey.current) {
      intentKey.current =
        globalThis.crypto?.randomUUID?.() ||
        `ik-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return intentKey.current;
  }

  // P1-RATES: the server refused because the total changed. Redraw every
  // amount from its cart and rates, say the new total, and wait for the
  // shopper to press the button again. Nothing was created or charged.
  function priceChanged(data) {
    if (data.cart?.items) setCart(data.cart);
    setShippingConfig(data.shippingConfig ?? undefined);
    quote.replace(data.quote, data.cart?.items ? data.cart : cart);
    paymentKey(true);
    setChallenge(null);
    setOtp(null);
    setError(friendlyCheckoutError(data));
    setPlacing(false);
  }

  // What the button says: the server charges this or nothing.
  const shown = { expectedTotal: grandTotal, expectedShipping: shipping.total };
  const orderCtx = (extra = {}) => ({
    method: chosen,
    cart,
    contact,
    address,
    form,
    storeName,
    grandTotal,
    shown,
    otpRequired: chosen === "cod" && terms.cod.otpRequired,
    challenge,
    paymentKey,
    eventItems,
    priceChanged,
    newQuote: (t) => quote.replace(t, cart),
    openOtp: (sent) => {
      setChallenge(null);
      setOtp(sent ? { challengeId: sent.challengeId, sentTo: sent.sentTo, resendIn: sent.resendIn, sentAt: Date.now(), error: "", busy: false } : null);
    },
    setError,
    setPlacing,
    ...extra,
  });
  const placeOrder = (isRetry = false) => place(orderCtx(), isRetry);

  // Phase 8 line 2: the code dialog's three actions.
  async function verifyCode(code) {
    setOtp((o) => ({ ...o, busy: true, error: "" }));
    try {
      const { data } = await postCheckout({ action: "cod_otp_verify", challengeId: otp.challengeId, code, contact, address, idempotencyKey: paymentKey() });
      if (!data.ok) return setOtp((o) => ({ ...o, busy: false, error: friendlyCheckoutError(data) }));
      setChallenge(otp.challengeId);
      setOtp(null);
      await place(orderCtx({ challenge: otp.challengeId }));
    } catch {
      setOtp((o) => o && { ...o, busy: false, error: "Could not reach the store — your cart is untouched. Check your connection and try again." });
    }
  }
  async function resendCode() {
    setOtp((o) => ({ ...o, busy: true, error: "" }));
    try {
      const { data } = await postCheckout({ action: "cod_otp_send", contact, address, idempotencyKey: paymentKey(), ...shown });
      if (data.code === "PRICE_CHANGED") return priceChanged(data);
      if (!data.ok) return setOtp((o) => ({ ...o, busy: false, error: friendlyCheckoutError(data) }));
      setOtp({ challengeId: data.challengeId, sentTo: data.sentTo, resendIn: data.resendIn, sentAt: Date.now(), error: "", busy: false });
    } catch {
      setOtp((o) => o && { ...o, busy: false, error: "Could not reach the store — your cart is untouched. Check your connection and try again." });
    }
  }
  const changeNumber = () => {
    setOtp(null);
    setChallenge(null);
    setStep(0);
  };

  return (
    <div data-protected="checkout" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Link href="/" className="text-xl font-extrabold tracking-tight">
          {/* S55 fix: the tenant's own wordmark — this hardcoded BEASTLIFE on every store */}
          {logo?.text1 || storeName}
          {logo?.text2 ? <span className="text-sf-accent-mark">{logo.text2}</span> : null}
        </Link>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  i <= step ? "bg-sf-inverse text-sf-on-inverse" : "bg-sf-surface-strong text-sf-text-subtle"
                }`}
              >
                {i + 1}
              </span>
              <span className={i === step ? "font-semibold" : "text-sf-text-faint"}>{label}</span>
              {i < STEPS.length - 1 && <span className="hidden text-sf-mark sm:inline">→</span>}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_380px]">
        {/* main column */}
        <div>
          {step === 0 && <AddressStep form={form} valid={valid} onAddress={changeAddress} onContinue={() => setStep(1)} countries={countries} />}

          {step === 1 && (
            <section>
              <h2 className="mb-4 text-lg font-bold">Review your order</h2>
              <div className="rounded-sf-card border border-sf-border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-sf-text-faint">Ship to</p>
                <p className="mt-1 text-sm font-medium">{form.name}</p>
                <p className="text-sm text-sf-text-muted">
                  {form.line1}
                  {form.line2 ? `, ${form.line2}` : ""}, {form.city}, {form.state} {form.pincode}
                </p>
                <p className="text-sm text-sf-text-muted">
                  {form.email} · {form.phone}
                </p>
                <button onClick={() => setStep(0)} className="mt-2 text-xs font-medium text-sf-accent-text hover:underline">
                  Edit
                </button>
              </div>
              <ul className="mt-4 divide-y divide-sf-border-soft">
                {cart.items.map((it) => (
                  <li key={it.variantId} className="flex items-center gap-3 py-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                      {it.image ? <Image src={it.image} alt={it.title} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{it.title}</p>
                      <p className="text-xs text-sf-text-subtle">Qty {it.quantity}</p>
                    </div>
                    <span className="text-sm font-semibold">{formatMoney(it.lineTotal, cart.currency)}</span>
                  </li>
                ))}
                {cart.gifts.map((g) => (
                  <li key={`gift-${g.variantId}`} className="flex items-center gap-3 py-3">
                    <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                      {g.image ? <Image src={g.image} alt={g.title} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{g.title}</p>
                      <p className="text-xs text-sf-text-subtle">Free gift 🎁</p>
                    </div>
                    <span className="text-sm font-semibold text-sf-accent-text">FREE</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex gap-3">
                <button onClick={() => setStep(0)} className="rounded-sf-control border border-sf-border-strong px-5 py-3 text-sm font-semibold hover:bg-sf-surface-muted">
                  Back
                </button>
                <button onClick={() => setStep(2)} className="flex-1 rounded-sf-control bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover">
                  Continue to payment
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <PaymentStep
              cart={cart}
              method={chosen}
              onMethod={setMethod}
              razorpayEnabled={terms.prepaid.available}
              codFee={terms.cod.fee}
              terms={terms}
              grandTotal={grandTotal}
              error={error}
              placing={placing}
              onBack={() => setStep(1)}
              onPlace={placeOrder}
              policies={policies}
            />
          )}
        </div>

        {/* sticky order summary — mirrors the cart drawer exactly */}
        <OrderSummary cart={cart} shipping={shipping} grandTotal={grandTotal} paymentDiscount={chosen === "cod" ? 0 : terms.prepaid.discount} timeZone={timeZone} />
      </div>
      {otp && (
        <CodOtpDialog
          sentTo={otp.sentTo}
          resendIn={otp.resendIn}
          sentAt={otp.sentAt}
          error={otp.error}
          busy={otp.busy}
          onVerify={verifyCode}
          onResend={resendCode}
          onChangeNumber={changeNumber}
          onClose={() => setOtp(null)}
        />
      )}
    </div>
  );
}
