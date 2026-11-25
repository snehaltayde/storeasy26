// Phase 8 step 0: the checkout form model and the payment and delivery
// config shapes (pure; no DB, no network).
//   node scripts/test-checkout-model.js          (pnpm test:checkout-model)
import { emptyForm, applyAddress, addressValid, addressStarted, pincodePatch, ADDRESS_KEYS } from "../components/checkout/checkoutModel.js";
import { validateShippingConfig, shippingFormChanged, validatePaymentConfig } from "../lib/admin/settings.js";
import { computeShipping, SHIPPING_CONFIG } from "../lib/shipping.js";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (v, label) => {
  if (!v) throw new Error(label);
};

const FILLED = { email: "a@b.test", phone: "9999999999", name: "A Shopper", line1: "1 Road", line2: "", city: "Pune", state: "MH", pincode: "411001", country_code: "IN" };

// ---- checkoutModel --------------------------------------------------------------

console.log("— checkoutModel");

t("emptyForm: every address field, blank, and a fresh object each time", () => {
  eq(emptyForm(), { email: "", phone: "", name: "", line1: "", line2: "", city: "", state: "", pincode: "", country_code: "IN" });
  eq(emptyForm("US").country_code, "US", "Phase 8 line 4: the starting country:");
  eq(Object.keys(emptyForm()), ADDRESS_KEYS);
  const a = emptyForm();
  a.city = "Pune";
  eq(emptyForm().city, "", "a caller's change leaks into the next form:");
});

t("applyAddress: sets the patched fields and leaves the form it was given alone", () => {
  const before = emptyForm();
  const after = applyAddress(before, { city: "Pune", pincode: "411001" }, "pincode");
  eq(after.city, "Pune");
  eq(after.pincode, "411001");
  eq(before.city, "", "the input form was changed:");
  ok(after !== before, "applyAddress returned the same object");
});

t("applyAddress: only the form's own keys, as strings; null clears", () => {
  const f = applyAddress({ ...FILLED }, { country: "IN", isAdmin: true, pincode: 411001, line2: null, __proto__: { x: 1 } }, "saved");
  eq(Object.keys(f), ADDRESS_KEYS, "an unknown key got into the form:");
  eq(f.pincode, "411001");
  eq(f.line2, "");
  eq(f.city, "Pune", "an untouched field changed:");
});

t("applyAddress: every source is accepted, an unknown one is refused", () => {
  for (const s of ["typed", "pincode", "saved"]) eq(applyAddress(emptyForm(), { name: "X" }, s).name, "X", `${s}:`);
  for (const s of [undefined, "", "server", "TYPED"]) {
    let threw = false;
    try {
      applyAddress(emptyForm(), { name: "X" }, s);
    } catch {
      threw = true;
    }
    ok(threw, `source ${JSON.stringify(s)} was accepted`);
  }
});

t("applyAddress: typing one field at a time is the old set(k, v)", () => {
  let f = emptyForm();
  for (const [k, v] of Object.entries(FILLED)) f = applyAddress(f, { [k]: v }, "typed");
  eq(f, FILLED);
});

t("addressStarted: a PIN prefill and its looked-up city and state are not an address; a street line is", () => {
  ok(!addressStarted(emptyForm()), "an empty form counts as started");
  // the sf_pin prefill, then its lookup's city and state, before the saved-address picker loads
  let f = applyAddress(emptyForm(), { pincode: "560001" }, "pincode");
  f = applyAddress(f, pincodePatch(f, { city: "Bengaluru", state: "Karnataka" }), "pincode");
  eq([f.city, f.state], ["Bengaluru", "Karnataka"]);
  ok(!addressStarted(f), "the PIN lookup's fill blocks the saved default");
  ok(!addressStarted(applyAddress(f, { email: "a@b.test", phone: "9999999999", name: "A" }, "typed")), "contact fields count as an address");
  ok(addressStarted(applyAddress(f, { line1: "1 Road" }, "typed")), "line 1 typed is an address");
  ok(addressStarted(applyAddress(f, { line2: "Flat 2" }, "typed")), "line 2 typed is an address");
  ok(!addressStarted(applyAddress(f, { line1: "   " }, "typed")), "spaces are not an address");
});

t("addressValid: the same rules as before the split", () => {
  ok(addressValid(FILLED), "a full address is refused");
  ok(!addressValid(emptyForm()), "an empty form passes");
  ok(!addressValid({ ...FILLED, email: "ab.test" }), "an email without @ passes");
  ok(!addressValid({ ...FILLED, phone: "  12345 " }), "a 5-digit phone passes");
  ok(addressValid({ ...FILLED, phone: "1234567" }), "a 7-digit phone is refused");
  ok(addressValid({ ...FILLED, line2: "" }), "line 2 is required");
  for (const k of ["name", "line1", "city", "state", "pincode"]) ok(!addressValid({ ...FILLED, [k]: "   " }), `a blank ${k} passes`);
});

// ---- validateShippingConfig: delivery days and zone COD -------------------------

console.log("— validateShippingConfig");

// What stores hold today (no Phase 8 fields), exactly as saved.
const STORED = [
  SHIPPING_CONFIG,
  { currency: "INR", basis: "net", freeThreshold: 999, flatRate: 79, codFee: 49, codFeeWaivedAt: null, zones: [] },
  { currency: "INR", basis: "gross", freeThreshold: null, flatRate: 50, codFee: 0, codFeeWaivedAt: 1500, zones: [{ label: "North", prefixes: ["11", "12"], flatRate: 40 }, { label: "Zone 2", prefixes: ["4"], freeThreshold: 499 }] },
];

t("a store's existing config saves byte-identical (no new keys appear)", () => {
  for (const cfg of STORED) {
    const res = validateShippingConfig(cfg);
    ok(res.ok, res.errors.join("; "));
    eq(JSON.stringify(res.value), JSON.stringify(cfg), "stored JSON changed:");
    for (const k of ["dispatchDays", "deliveryDays"]) ok(!(k in res.value), `${k} appeared`);
    for (const z of res.value.zones) for (const k of ["deliveryDays", "cod"]) ok(!(k in z), `zone ${k} appeared`);
  }
});

t("shippingFormChanged: an untouched form is still no change, and blank new fields are no change", () => {
  for (const cfg of STORED) {
    eq(shippingFormChanged(cfg, cfg), false, "same form:");
    eq(shippingFormChanged({ ...cfg, dispatchDays: "", deliveryDays: { min: "", max: "" } }, cfg), false, "blank new fields:");
  }
  eq(shippingFormChanged({ ...STORED[1], dispatchDays: 1 }, STORED[1]), true, "setting dispatch days:");
});

t("dispatch and delivery days: coerced, stored after the old keys, and the engine still prices the same", () => {
  const base = STORED[2];
  const res = validateShippingConfig({
    ...base,
    dispatchDays: "1",
    deliveryDays: { min: "2", max: "5" },
    zones: [{ ...base.zones[0], deliveryDays: { min: 1, max: 2 }, cod: false }, base.zones[1]],
  });
  ok(res.ok, res.errors.join("; "));
  eq(res.value.dispatchDays, 1);
  eq(res.value.deliveryDays, { min: 2, max: 5 });
  eq(res.value.zones[0], { label: "North", prefixes: ["11", "12"], flatRate: 40, deliveryDays: { min: 1, max: 2 }, cod: false });
  eq(res.value.zones[1], base.zones[1], "the second zone changed:");
  eq(Object.keys(res.value), [...Object.keys(base), "dispatchDays", "deliveryDays"], "key order:");
  for (const pincode of ["110001", "411001", "560001", null]) {
    for (const paymentMethod of ["cod", "prepaid"]) {
      const a = computeShipping({ subtotal: 700, paymentMethod, pincode, config: base });
      const b = computeShipping({ subtotal: 700, paymentMethod, pincode, config: res.value });
      // Phase 8 line 1: only the estimate and the zone's COD flag may differ
      const money = ({ estimate, zoneCod, ...rest }) => rest;
      eq(money(b), money(a), `${pincode} ${paymentMethod}:`);
    }
  }
});

t("zone cod: true or false is kept; anything else is refused", () => {
  eq(validateShippingConfig({ ...STORED[1], zones: [{ prefixes: "11", cod: true }] }).value.zones[0].cod, true);
  for (const cod of ["no", 0, "false"]) ok(!validateShippingConfig({ ...STORED[1], zones: [{ prefixes: "11", cod }] }).ok, `cod ${JSON.stringify(cod)} passed`);
  ok(!("cod" in validateShippingConfig({ ...STORED[1], zones: [{ prefixes: "11", cod: "" }] }).value.zones[0]), "a blank cod was stored");
});

t("days: dispatch 0–10, delivery 1–30, both ends of a range, max not below min", () => {
  const bad = [
    { dispatchDays: -1 },
    { dispatchDays: 1.5 },
    { dispatchDays: "soon" },
    { dispatchDays: 11 },
    { deliveryDays: { min: 0, max: 2 } },
    { deliveryDays: { min: 1, max: 31 } },
    { deliveryDays: { min: 3 } },
    { deliveryDays: { max: 3 } },
    { deliveryDays: { min: 5, max: 2 } },
    { deliveryDays: "3-5" },
    { zones: [{ prefixes: "11", deliveryDays: { min: 1, max: 0 } }] },
  ];
  for (const extra of bad) ok(!validateShippingConfig({ ...STORED[1], ...extra }).ok, `${JSON.stringify(extra)} passed`);
  const edge = validateShippingConfig({ ...STORED[1], dispatchDays: 0, deliveryDays: { min: 1, max: 1 } });
  ok(edge.ok, edge.errors.join("; "));
  eq([edge.value.dispatchDays, edge.value.deliveryDays], [0, { min: 1, max: 1 }], "same-day dispatch, next-day delivery:");
  const top = validateShippingConfig({ ...STORED[1], dispatchDays: 10, deliveryDays: { min: 30, max: 30 } });
  ok(top.ok, top.errors.join("; "));
});

// ---- validatePaymentConfig --------------------------------------------------------

console.log("— validatePaymentConfig");

t("nothing set → an empty config", () => {
  for (const input of [undefined, {}, { prepaid: null, cod: null }, { prepaid: false }]) {
    const res = validatePaymentConfig(input);
    ok(res.ok, res.errors.join("; "));
    eq(res.value, {}, `${JSON.stringify(input)}:`);
  }
});

t("prepaid: percent up to 20, fixed amounts, an optional cap; blank or zero is off", () => {
  eq(validatePaymentConfig({ prepaid: { kind: "percent", value: "5", max: "100" } }).value, { prepaid: { kind: "percent", value: 5, max: 100 } });
  eq(validatePaymentConfig({ prepaid: { kind: "percent", value: 20 } }).value, { prepaid: { kind: "percent", value: 20 } });
  eq(validatePaymentConfig({ prepaid: { kind: "fixed", value: 50 } }).value, { prepaid: { kind: "fixed", value: 50 } });
  for (const value of ["", 0, null]) {
    const res = validatePaymentConfig({ prepaid: { kind: "percent", value } });
    ok(res.ok, res.errors.join("; "));
    eq(res.value, {}, `value ${JSON.stringify(value)}:`);
  }
  for (const prepaid of [{ kind: "percent", value: 20.5 }, { kind: "percent", value: -5 }, { kind: "bogo", value: 5 }, { value: 5 }, { kind: "fixed", value: "ten" }, { kind: "fixed", value: 10, max: -1 }, "5%"]) {
    ok(!validatePaymentConfig({ prepaid }).ok, `${JSON.stringify(prepaid)} passed`);
  }
});

t("cod: limit, OTP mode, threshold and channel", () => {
  eq(validatePaymentConfig({ cod: {} }).value, { cod: { otp: "off" } });
  eq(validatePaymentConfig({ cod: { maxTotal: "5000", otpChannel: "sms" } }).value, { cod: { otp: "off", maxTotal: 5000 } }, "channel only with an OTP:");
  eq(validatePaymentConfig({ cod: { otp: "always" } }).value, { cod: { otp: "always", otpChannel: "email" } }, "email by default:");
  eq(validatePaymentConfig({ cod: { otp: "always", otpChannel: "sms" } }).value, { cod: { otp: "always", otpChannel: "sms" } });
  eq(validatePaymentConfig({ cod: { otp: "above", otpAbove: "2000", maxTotal: 10000 } }).value, { cod: { otp: "above", maxTotal: 10000, otpAbove: 2000, otpChannel: "email" } });
  for (const cod of [{ otp: "above" }, { otp: "above", otpAbove: -1 }, { otp: "sometimes" }, { otp: "always", otpChannel: "whatsapp" }, { maxTotal: "lots" }, "on"]) {
    ok(!validatePaymentConfig({ cod }).ok, `${JSON.stringify(cod)} passed`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
